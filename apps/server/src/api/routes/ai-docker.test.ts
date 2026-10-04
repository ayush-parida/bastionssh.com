import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AIAgentEvent } from '@smt/shared';

/**
 * The AI assistant's read-only Docker tools, through the chat route (so the
 * auditing and the absence of an approval step are covered) and through
 * ToolExecutor directly for roles the chat route turns away. The provider is
 * the scripted stub from ai.test.ts; Docker is the fake daemon behind the
 * ssh2 stand-in from docker.test.ts.
 */
const agent = vi.hoisted(() => ({
  script: [] as Array<{ name: string; input: Record<string, unknown> }>,
  nextId: 0,
}));
const fake = vi.hoisted(() => ({
  options: { daemonSocket: '', cli: true } as import('../../docker/fake-daemon.test-helper.js').FakeSshOptions,
  log: { streamlocal: [] as string[], exec: [] as string[] },
}));

vi.mock('../../ai/registry.js', () => ({
  getAIProvider: () => ({
    async *chat() {},
    async *agentLoop(
      _messages: unknown,
      _tools: unknown,
      execute: (name: string, input: Record<string, unknown>, id: string) => Promise<string>,
    ) {
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

vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const { fakeSshMethods } = await import('../../docker/fake-daemon.test-helper.js');
  // Methods and a closure map only — class fields in a vi.mock factory break the import
  const channels = new WeakMap<object, Set<import('node:net').Socket>>();
  class Client extends EventEmitter {
    constructor() {
      super();
      const open = new Set<import('node:net').Socket>();
      channels.set(this, open);
      Object.assign(
        this,
        fakeSshMethods(
          () => fake.options,
          fake.log,
          (s) => {
            open.add(s);
            s.on('close', () => open.delete(s));
          },
        ),
      );
    }
    connect() {
      setImmediate(() => this.emit('ready'));
      return this;
    }
    end() {
      for (const s of channels.get(this) ?? []) s.destroy();
      setImmediate(() => this.emit('close'));
      return this;
    }
  }
  return { ...actual, default: { ...(actual as { default?: object }).default, Client }, Client };
});

import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, memberships, resourceGrants, servers } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { AGENT_TOOLS, ToolExecutor } from '../../ai/tools.js';
import { startFakeDaemon, type FakeDaemon } from '../../docker/fake-daemon.test-helper.js';
import { AI_MAX_OUTPUT, formatContainers, keepHead, keepTail, TRUNCATED_MARKER } from '../../docker/ai-tools.js';
import { addModuleRole, seedOrg, seedServer, seedUser } from './test-utils.js';

function parseEvents(body: string): AIAgentEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
    .filter((line): line is string => !!line)
    .map((line) => JSON.parse(line.slice(6)) as AIAgentEvent);
}

const results = (events: AIAgentEvent[]) =>
  events.filter((e): e is Extract<AIAgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');

describe('AI Docker tools', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let daemon: FakeDaemon;
  let orgId: string;
  let operator: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let restricted: ReturnType<typeof seedUser>;
  let alpha: string;
  let bravo: string;
  let off: string;

  const chat = (headers: Record<string, string>, serverId = alpha) =>
    app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers,
      payload: { messages: [{ role: 'user', content: 'go' }], context: { serverId }, agentMode: true },
    });

  const auditRows = () =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'ai.docker_read')))
      .all()
      .map((r) => ({ ...r, metadata: JSON.parse(r.metadata ?? '{}') as Record<string, unknown> }));

  async function server(name: string, createdBy: string, patch: Partial<typeof servers.$inferInsert> = {}) {
    const id = seedServer(orgId, createdBy, name);
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', id), ...patch })
      .where(eq(servers.id, id))
      .run();
    return id;
  }

  beforeAll(async () => {
    daemon = await startFakeDaemon();
    fake.options.daemonSocket = daemon.socketPath;
    await runMigrations();
    orgId = seedOrg('org-ai-docker');
    const admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');
    alpha = await server('alpha', admin.userId);
    bravo = await server('bravo', admin.userId);
    off = await server('off', admin.userId, { dockerMode: 'off' });

    app = await buildApp();
    await app.ready();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ai/providers',
      headers: admin.headers,
      payload: { name: 'stub', provider: 'anthropic', model: 'm', apiKey: 'k', isDefault: true },
    });
    expect(created.statusCode).toBe(201);
    const grant = await app.inject({
      method: 'PUT',
      url: `/api/team/members/${restricted.userId}/access`,
      headers: admin.headers,
      payload: { serverAccess: 'restricted', serverIds: [bravo] },
    });
    expect(grant.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await daemon.close();
  });

  beforeEach(() => {
    fake.options = { daemonSocket: daemon.socketPath, cli: true };
    getDb().delete(auditLog).where(eq(auditLog.orgId, orgId)).run();
  });

  it('are offered to the model as read-only tools with clear descriptions', () => {
    for (const name of ['docker_list_containers', 'docker_container_logs', 'docker_inspect']) {
      const tool = AGENT_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.description).toMatch(/read-only/i);
    }
    expect(AGENT_TOOLS.find((t) => t.name === 'docker_inspect')!.description).toMatch(/redacted/);
  });

  it('list, read logs and inspect without asking for approval, each read audited', async () => {
    agent.script = [
      { name: 'docker_list_containers', input: { all: true } },
      { name: 'docker_container_logs', input: { container: 'web', tail: 20 } },
      { name: 'docker_inspect', input: { container: 'web', server_id: alpha } },
    ];
    const res = await chat(operator.headers);
    const events = parseEvents(res.body);
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    const [list, logs, inspect] = results(events);

    expect(list).toMatchObject({ isError: false });
    expect(list!.output).toContain('- web (aaaaaaaaaaaa) · image nginx:1.27 · state running, healthy');
    expect(list!.output).toContain('- worker');
    expect(logs!.output).toBe('hello stdout\n[stderr] oops stderr');
    // The daemon never sees a follow request from the assistant
    expect(daemon.requests.find((r) => r.includes('/logs'))).toMatch(/follow=0.*tail=20/);
    // Environment values never reach the model
    expect(inspect!.output).toContain('DB_PASSWORD=••••');
    expect(inspect!.output).not.toContain('hunter2');

    const rows = auditRows();
    expect(rows.map((r) => r.metadata.tool)).toEqual(['docker_list_containers', 'docker_container_logs', 'docker_inspect']);
    expect(rows.every((r) => r.resourceId === alpha && r.resourceName === 'alpha')).toBe(true);
    expect(rows[1]!.metadata).toMatchObject({ container: 'web' });
    expect(rows.some((r) => 'error' in r.metadata)).toBe(false);
  });

  it('caps the log tail at 500 lines', async () => {
    agent.script = [{ name: 'docker_container_logs', input: { container: 'worker', tail: 100_000 } }];
    const events = parseEvents((await chat(operator.headers)).body);
    expect(results(events)[0]).toMatchObject({ isError: false, output: 'tty line one\ntty line two' });
    expect(daemon.requests.filter((r) => r.includes('/logs')).at(-1)).toContain('tail=500');
  });

  it('refuse servers the member cannot access, bad names and Docker off — audited with the error', async () => {
    agent.script = [
      { name: 'docker_list_containers', input: {} },
      { name: 'docker_container_logs', input: { container: 'web', server_id: bravo } },
      { name: 'docker_inspect', input: { container: '../etc', server_id: bravo } },
      { name: 'docker_list_containers', input: { server_id: off } },
    ];
    const events = parseEvents((await chat(restricted.headers, bravo)).body);
    const out = results(events);
    // The chat's own server is bravo; alpha is not granted
    expect(out[0]).toMatchObject({ isError: false });
    expect(out[1]).toMatchObject({ isError: false });
    expect(out[2]).toMatchObject({ isError: true, output: 'Invalid container name or id' });
    expect(out[3]).toMatchObject({ isError: true, output: 'Server not found' });

    agent.script = [{ name: 'docker_list_containers', input: { server_id: alpha } }];
    const denied = results(parseEvents((await chat(restricted.headers, bravo)).body));
    expect(denied[0]).toMatchObject({ isError: true, output: 'Server not found' });

    agent.script = [{ name: 'docker_list_containers', input: { server_id: off } }];
    const disabled = results(parseEvents((await chat(operator.headers)).body));
    expect(disabled[0]).toMatchObject({ isError: true, output: 'Docker is turned off for this server' });

    const errors = auditRows().filter((r) => 'error' in r.metadata);
    expect(errors.map((r) => r.metadata.error)).toEqual(
      expect.arrayContaining(['Invalid container name or id', 'Server not found', 'Docker is turned off for this server']),
    );
  });

  it('keep logs and inspect from viewers, like the Docker tab', async () => {
    const tools = new ToolExecutor(orgId, viewer.userId, undefined, alpha);
    // Viewers have no AI Assistant: the agent does nothing for them
    await expect(tools.execute('docker_list_containers', {})).rejects.toThrow(/not available/);
    // Given the module, the Docker matrix still reads at their level on the server
    addModuleRole(orgId, viewer.userId, { ai: 'view' });
    expect(await tools.execute('docker_list_containers', {})).toContain('- web');
    await expect(tools.execute('docker_container_logs', { container: 'web' })).rejects.toThrow(/role does not allow/);
    await expect(tools.execute('docker_inspect', { container: 'web' })).rejects.toThrow(/role does not allow/);
  });

  it('read the Docker matrix at the member’s level on the server, not their base role', async () => {
    // A role-scoped operator holding only view on alpha (custom roles): no logs or inspect there
    const member = seedUser(orgId, 'operator');
    getDb().update(memberships).set({ serverAccess: 'restricted' }).where(eq(memberships.userId, member.userId)).run();
    getDb()
      .insert(resourceGrants)
      .values({
        id: `ai-view-${member.userId}`,
        orgId,
        principalType: 'user',
        principalId: member.userId,
        resourceType: 'server',
        selector: 'id',
        resourceId: alpha,
        level: 'view',
        createdAt: new Date().toISOString(),
      })
      .run();
    const tools = new ToolExecutor(orgId, member.userId, undefined, alpha);
    expect(await tools.execute('docker_list_containers', {})).toContain('- web');
    await expect(tools.execute('docker_container_logs', { container: 'web' })).rejects.toThrow(/role does not allow/);
    await expect(tools.execute('docker_inspect', { container: 'web' })).rejects.toThrow(/role does not allow/);
  });

  it('need a server to read from', async () => {
    const tools = new ToolExecutor(orgId, operator.userId);
    await expect(tools.execute('docker_list_containers', {})).rejects.toThrow('No server specified');
  });
});

describe('AI Docker tool output', () => {
  it('keeps the newest log lines and the start of inspect output when over the cap', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n');
    const kept = keepTail(lines);
    expect(kept.startsWith(`${TRUNCATED_MARKER}\n`)).toBe(true);
    expect(kept.endsWith('line 19999')).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(AI_MAX_OUTPUT + TRUNCATED_MARKER.length + 1);
    // Cut on a line boundary
    expect(kept.split('\n')[1]).toMatch(/^line \d+$/);

    const head = keepHead('x'.repeat(AI_MAX_OUTPUT + 10));
    expect(head.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(keepTail('short')).toBe('short');
  });

  it('says when there is nothing to list', () => {
    expect(formatContainers([], false)).toBe('No running containers.');
    expect(formatContainers([], true)).toBe('No containers.');
  });
});
