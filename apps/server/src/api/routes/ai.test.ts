import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { AIAgentEvent } from '@smt/shared';

/**
 * The provider is a stub that asks for whatever tool calls `agent.script`
 * lists, one per turn, so the route's approval gate and auditing are what is
 * under test. SSH is mocked the same way as in ai/tools.test.ts.
 */
const agent = vi.hoisted(() => ({
  script: [] as Array<{ name: string; input: Record<string, unknown> }>,
  nextId: 0,
  /** The messages of the last agent loop, system prompt first. */
  messages: [] as Array<{ role: string; content: string }>,
}));
const broker = vi.hoisted(() => ({
  getSessionForUser: vi.fn(),
  exec: vi.fn(),
  execOnServer: vi.fn(),
}));

vi.mock('../../ai/registry.js', () => ({
  getAIProvider: () => ({
    async *chat() {},
    async *agentLoop(
      messages: Array<{ role: string; content: string }>,
      _tools: unknown,
      execute: (name: string, input: Record<string, unknown>, id: string) => Promise<string>,
    ) {
      agent.messages = messages;
      for (const call of agent.script) {
        const id = `call-${++agent.nextId}`;
        yield { type: 'tool_call', id, name: call.name, input: call.input };
        let output: string;
        let isError = false;
        try {
          output = await execute(call.name, call.input, id);
        } catch (err) {
          output = (err as Error).message;
          isError = true;
        }
        yield { type: 'tool_result', id, name: call.name, output, isError };
      }
      yield { type: 'done' };
    },
  }),
}));
vi.mock('../../ssh/broker.js', () => ({
  SSHBroker: { getSessionForUser: broker.getSessionForUser, exec: broker.exec },
  execOnServer: broker.execOnServer,
}));
vi.mock('../../ssh/credentials.js', () => ({
  resolveServerAuth: async (_orgId: string, serverId: string) => ({
    server: { id: serverId, host: `${serverId}.example`, port: 22, username: 'root' },
    auth: { privateKey: 'k' },
  }),
}));

import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, kubeClusters, memberships, resourceGrants, roleMembers, roles } from '../../db/schema.js';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { pendingApprovalCount } from '../../ai/approvals.js';
import { abortAgentStreams, activeAgentStreamCount } from '../../ai/streams.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

function parseEvents(body: string): AIAgentEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
    .filter((line): line is string => !!line)
    .map((line) => JSON.parse(line.slice(6)) as AIAgentEvent);
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe('AI chat command approval', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let operator: ReturnType<typeof seedUser>;
  let colleague: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let serverId: string;

  const chat = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers,
      payload: { messages: [{ role: 'user', content: 'go' }], context: { serverId } },
    });

  const decide = (id: string, headers: Record<string, string>, approved: boolean) =>
    app.inject({ method: 'POST', url: `/api/ai/approvals/${id}`, headers, payload: { approved } });

  const auditRows = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)))
      .all()
      .map((r) => ({ ...r, metadata: JSON.parse(r.metadata ?? '{}') as Record<string, unknown> }));

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-ai-approvals');
    const admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    colleague = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-ai-other'), 'admin');
    serverId = seedServer(orgId, admin.userId, 'prod-web');

    app = await buildApp();
    await app.ready();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ai/providers',
      headers: admin.headers,
      payload: { name: 'stub', provider: 'anthropic', model: 'm', apiKey: 'k', isDefault: true },
    });
    expect(created.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getDb().delete(auditLog).where(eq(auditLog.orgId, orgId)).run();
    broker.execOnServer.mockResolvedValue({ stdout: 'done', stderr: '', exitCode: 0 });
  });

  it('runs read-only commands and other tools without asking', async () => {
    agent.script = [
      { name: 'run_command', input: { command: 'df -h' } },
      { name: 'list_servers', input: {} },
    ];

    const events = parseEvents((await chat(operator.headers)).body);

    expect(events.map((e) => e.type)).toEqual([
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'done',
    ]);
    expect(events[1]).toMatchObject({ output: 'done', isError: false });
    expect(broker.execOnServer).toHaveBeenCalledTimes(1);

    const [run] = auditRows('ai.command_run');
    expect(run).toMatchObject({ resourceId: serverId, resourceName: 'prod-web' });
    expect(run!.metadata).toMatchObject({ command: 'df -h', mutating: false, exitCode: 0 });
    expect(auditRows('ai.command_approved')).toHaveLength(0);
  });

  it('waits for approval, ignores other users, and runs once approved', async () => {
    agent.script = [{ name: 'run_command', input: { command: 'systemctl restart nginx' } }];

    const pending = chat(operator.headers);
    await until(() => pendingApprovalCount() === 1);
    expect(broker.execOnServer).not.toHaveBeenCalled();

    const id = `call-${agent.nextId}`;
    expect((await decide(id, colleague.headers, true)).statusCode).toBe(404);
    expect((await decide(id, outsider.headers, true)).statusCode).toBe(404);
    expect((await decide(id, viewer.headers, true)).statusCode).toBe(403);
    expect(pendingApprovalCount()).toBe(1);

    expect((await decide(id, operator.headers, true)).statusCode).toBe(200);
    const events = parseEvents((await pending).body);

    expect(events.map((e) => e.type)).toEqual([
      'tool_call',
      'approval_required',
      'approval_resolved',
      'tool_result',
      'done',
    ]);
    expect(events[1]).toMatchObject({
      id,
      name: 'run_command',
      input: { command: 'systemctl restart nginx' },
      serverId,
      serverName: 'prod-web',
      sshUser: 'root',
      hostKeyStatus: 'unknown',
    });
    expect((events[1] as { reason: string }).reason).toBeTruthy();
    expect(events[2]).toEqual({ type: 'approval_resolved', id, approved: true });
    expect(events[3]).toMatchObject({ output: 'done', isError: false });
    expect(broker.execOnServer).toHaveBeenCalledTimes(1);
    expect(pendingApprovalCount()).toBe(0);

    expect(auditRows('ai.command_approved')[0]!.metadata).toMatchObject({
      command: 'systemctl restart nginx',
      mutating: true,
    });
    expect(auditRows('ai.command_run')[0]!.metadata).toMatchObject({ mutating: true, exitCode: 0 });
    // Already settled
    expect((await decide(id, operator.headers, false)).statusCode).toBe(404);
  });

  it('tells the model a denied command was declined and keeps going', async () => {
    agent.script = [
      { name: 'run_command', input: { command: 'rm -rf /var/www' } },
      { name: 'run_command', input: { command: 'uptime' } },
    ];

    const pending = chat(operator.headers);
    await until(() => pendingApprovalCount() === 1);
    await decide(`call-${agent.nextId}`, operator.headers, false);
    const events = parseEvents((await pending).body);

    const results = events.filter((e) => e.type === 'tool_result');
    expect(results[0]).toMatchObject({ isError: true });
    expect((results[0] as { output: string }).output).toMatch(/declined/);
    expect(results[1]).toMatchObject({ output: 'done', isError: false });
    expect(events.find((e) => e.type === 'approval_resolved')).toMatchObject({ approved: false });
    // Only the read-only follow-up ran
    expect(broker.execOnServer).toHaveBeenCalledTimes(1);
    expect(broker.execOnServer.mock.calls[0]![2]).toBe('uptime');

    const [denied] = auditRows('ai.command_denied');
    expect(denied!.metadata).toMatchObject({ command: 'rm -rf /var/www', deniedBy: 'user' });
    expect(auditRows('ai.command_run')).toHaveLength(1);
  });

  it('denies and forgets a pending command when the client disconnects', async () => {
    agent.script = [{ name: 'run_command', input: { command: 'reboot' } }];
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
      method: 'POST',
      headers: { ...operator.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }], context: { serverId } }),
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    await until(() => pendingApprovalCount() === 1);

    ctrl.abort();

    await until(() => pendingApprovalCount() === 0);
    await until(() => auditRows('ai.command_denied').length === 1);
    expect(auditRows('ai.command_denied')[0]!.metadata).toMatchObject({ deniedBy: 'disconnect' });
    expect(broker.execOnServer).not.toHaveBeenCalled();
  });

  it('stops the stream and cancels a pending command when the user’s access is revoked', async () => {
    agent.script = [
      { name: 'run_command', input: { command: 'systemctl restart nginx' } },
      { name: 'run_command', input: { command: 'uptime' } },
    ];

    const pending = chat(operator.headers);
    await until(() => pendingApprovalCount() === 1);
    // Someone else's revocation leaves this stream alone
    expect(abortAgentStreams(colleague.userId, { orgId })).toBe(0);
    expect(pendingApprovalCount()).toBe(1);

    expect(abortAgentStreams(operator.userId, { orgId })).toBe(1);
    const events = parseEvents((await pending).body);

    expect(pendingApprovalCount()).toBe(0);
    expect(activeAgentStreamCount()).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: expect.stringMatching(/access has changed/) });
    expect(events.some((e) => e.type === 'done')).toBe(false);
    // Neither the pending command nor anything after it ran
    expect(broker.execOnServer).not.toHaveBeenCalled();
    await until(() => auditRows('ai.command_denied').length === 1);
    expect(auditRows('ai.command_denied')[0]!.metadata).toMatchObject({ deniedBy: 'access_revoked' });
  });

  it('404s an unknown approval id', async () => {
    expect((await decide('nope', operator.headers, true)).statusCode).toBe(404);
  });
});

describe('AI chat for members raised by custom roles', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let operated: string;
  let viewed: string;
  let hidden: string;

  const chat = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers,
      payload: { messages: [{ role: 'user', content: 'go' }] },
    });

  /** A viewer limited to what roles give them, holding a role with `grants`. */
  function member(grants: Array<{ type: 'server' | 'cluster'; id: string; level: 'view' | 'operate'; namespaces?: string[] }>) {
    const who = seedUser(orgId, 'viewer');
    const db = getDb();
    db.update(memberships).set({ scope: 'roles' }).where(and(eq(memberships.userId, who.userId), eq(memberships.orgId, orgId))).run();
    const roleId = nanoid();
    db.insert(roles).values({ id: roleId, orgId, name: `role-${roleId}`, createdBy: admin.userId }).run();
    db.insert(roleMembers).values({ roleId, userId: who.userId, orgId }).run();
    for (const g of grants) {
      db.insert(resourceGrants)
        .values({
          id: nanoid(),
          orgId,
          principalType: 'role',
          principalId: roleId,
          resourceType: g.type,
          selector: 'id',
          resourceId: g.id,
          namespaces: g.namespaces ? JSON.stringify(g.namespaces) : null,
          level: g.level,
          grantedBy: admin.userId,
          createdAt: new Date().toISOString(),
        })
        .run();
    }
    return who;
  }

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-ai-roles');
    admin = seedUser(orgId, 'admin');
    operated = seedServer(orgId, admin.userId, 'ops-web');
    viewed = seedServer(orgId, admin.userId, 'seen-db');
    hidden = seedServer(orgId, admin.userId, 'secret-vault');

    app = await buildApp();
    await app.ready();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ai/providers',
      headers: admin.headers,
      payload: { name: 'stub', provider: 'anthropic', model: 'm', apiKey: 'k', isDefault: true },
    });
    expect(created.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    agent.messages = [];
    broker.execOnServer.mockResolvedValue({ stdout: 'done', stderr: '', exitCode: 0 });
  });

  it('lets a viewer who operates one server chat; each command still needs operate on its server', async () => {
    const raised = member([
      { type: 'server', id: operated, level: 'operate' },
      { type: 'server', id: viewed, level: 'view' },
    ]);
    agent.script = [
      { name: 'run_command', input: { command: 'uptime', server_id: operated } },
      { name: 'run_command', input: { command: 'uptime', server_id: viewed } },
      { name: 'run_command', input: { command: 'uptime', server_id: hidden } },
    ];

    const res = await chat(raised.headers);
    expect(res.statusCode).toBe(200);
    const results = parseEvents(res.body).filter((e) => e.type === 'tool_result');
    expect(results[0]).toMatchObject({ output: 'done', isError: false });
    expect(results[1]).toMatchObject({ isError: true, output: expect.stringMatching(/needs operate access/) });
    // Out of reach reads as not there
    expect(results[2]).toMatchObject({ isError: true, output: 'Server not found' });
    expect(broker.execOnServer).toHaveBeenCalledTimes(1);
    expect(broker.execOnServer.mock.calls[0]![0]).toMatchObject({ id: operated });

    // The prompt lists what they can see, and nothing else
    const prompt = agent.messages[0]!;
    expect(prompt.role).toBe('system');
    expect(prompt.content).toContain('ops-web');
    expect(prompt.content).toContain('seen-db');
    expect(prompt.content).not.toContain('secret-vault');
    expect(prompt.content).not.toContain(hidden);
  });

  it('still asks for approval before a change, and the raised member can give it', async () => {
    const raised = member([{ type: 'server', id: operated, level: 'operate' }]);
    agent.script = [{ name: 'run_command', input: { command: 'systemctl restart nginx', server_id: operated } }];

    const pending = chat(raised.headers);
    await until(() => pendingApprovalCount() === 1);
    expect(broker.execOnServer).not.toHaveBeenCalled();
    const id = `call-${agent.nextId}`;
    const approved = await app.inject({ method: 'POST', url: `/api/ai/approvals/${id}`, headers: raised.headers, payload: { approved: true } });
    expect(approved.statusCode).toBe(200);

    const events = parseEvents((await pending).body);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'approval_required', 'approval_resolved', 'tool_result', 'done']);
    expect(broker.execOnServer).toHaveBeenCalledTimes(1);
  });

  it('lets a viewer who operates one namespace of a cluster chat', async () => {
    const clusterId = nanoid();
    getDb()
      .insert(kubeClusters)
      .values({
        id: clusterId,
        orgId,
        name: 'shop-prod',
        apiUrl: 'https://192.0.2.20:6443',
        authType: 'token',
        encryptedCredential: 'x',
        credentialHint: 'token',
        createdBy: admin.userId,
      })
      .run();
    const raised = member([{ type: 'cluster', id: clusterId, level: 'operate', namespaces: ['shop'] }]);
    expect((await app.inject({ method: 'GET', url: '/api/ai/access', headers: raised.headers })).json()).toEqual({ chat: true });
    agent.script = [];
    const res = await chat(raised.headers);
    expect(res.statusCode).toBe(200);
    expect(agent.messages[0]!.content).toContain('shop-prod');
  });

  it('refuses members who can only view, or whose operate grant points at nothing', async () => {
    const viewing = member([{ type: 'server', id: viewed, level: 'view' }]);
    const dangling = member([{ type: 'server', id: 'deleted-server', level: 'operate' }]);
    const plainViewer = seedUser(orgId, 'viewer');
    agent.script = [];
    for (const who of [viewing, dangling, plainViewer]) {
      // The web hides the assistant from them
      const access = await app.inject({ method: 'GET', url: '/api/ai/access', headers: who.headers });
      expect(access.json()).toEqual({ chat: false });
      const res = await chat(who.headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/operate access/);
      const decided = await app.inject({ method: 'POST', url: '/api/ai/approvals/x', headers: who.headers, payload: { approved: true } });
      expect(decided.statusCode).toBe(403);
    }
    expect(agent.messages).toEqual([]);
  });
});
