import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { and, eq } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import { nanoid } from 'nanoid';
import WebSocket from 'ws';
import { AGENT_PORTS_HEADER, AGENT_VERSION_HEADER, encodeOpen } from '@smt/agent';

const { buildApp } = await import('../app.js');
const { runMigrations } = await import('../../db/migrate.js');
const { getDb } = await import('../../db/index.js');
const { agents, auditLog, memberships, servers } = await import('../../db/schema.js');
const { generateAgentToken } = await import('../../agents/token.js');
const { isAgentOnline } = await import('../../agents/hub.js');
const { seedOrg, seedServer, seedUser } = await import('./test-utils.js');

type WsClient = WebSocket;

describe('agent routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let foreignAdmin: ReturnType<typeof seedUser>;
  const open: WsClient[] = [];
  let connectUrl: string;

  const audited = (id: string, action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, id), eq(auditLog.action, action)))
      .all();

  /** Straight into the table: creation through the API is rate limited per IP. */
  async function createAgent(name = 'edge', headers = admin.headers) {
    const owner = headers === foreignAdmin.headers ? foreignAdmin : admin;
    const org = getDb().select().from(memberships).where(eq(memberships.userId, owner.userId)).get()!.orgId;
    const id = nanoid();
    const { token, tokenHash } = generateAgentToken();
    getDb().insert(agents).values({ id, orgId: org, name, tokenHash, createdBy: owner.userId }).run();
    return { id, token };
  }

  async function waitFor(check: () => boolean) {
    const until = Date.now() + 2_000;
    while (!check()) {
      if (Date.now() > until) throw new Error('Timed out waiting');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** A real WebSocket to the listening app, as the agent opens it. Rejects with the HTTP status when refused. */
  function connect(token: string | undefined, extra: Record<string, string> = {}): Promise<WsClient> {
    const ws = new WebSocket(connectUrl, {
      headers: { ...(token !== undefined && { authorization: `Bearer ${token}` }), ...extra },
    });
    open.push(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        ws.terminate();
        reject(new Error(`Unexpected server response: ${res.statusCode}`));
      });
      ws.once('error', reject);
    });
  }

  function closed(ws: WsClient): Promise<number> {
    return once(ws, 'close').then(([code]) => code as number);
  }

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('agents');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    foreignAdmin = seedUser(seedOrg('agents-other'), 'admin');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    connectUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/agents/connect`;
  });

  afterAll(async () => {
    for (const ws of open) ws.terminate();
    await app?.close();
  });

  it('is the Agents module: not there at all for an operator, who has it off', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: operator.headers })).statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: '/api/agents', headers: operator.headers, payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(401);
  });

  it('shows the token and install command once and stores only its hash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: admin.headers,
      payload: { name: 'dc-1', allowedPorts: [22, 2222] },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.token).toMatch(/^bsa_[A-Za-z0-9_-]{43}$/);
    expect(created.status).toBe('offline');
    expect(created.installCommand).toContain('http://localhost:8080/api/agents/install.sh');
    expect(created.installCommand).toContain(`BASTION_ALLOWED_PORTS='22,2222'`);
    // The token travels in a here-doc (stdin), never on the command line itself
    const [commandLine, tokenLine] = created.installCommand.split('\n');
    expect(commandLine).not.toContain(created.token);
    expect(tokenLine).toBe(created.token);

    const row = getDb().select().from(agents).where(eq(agents.id, created.id)).get()!;
    expect(row.tokenHash).toBe(createHash('sha256').update(created.token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(created.token);

    const list = (await app.inject({ method: 'GET', url: '/api/agents', headers: admin.headers })).json();
    const listed = list.find((a: { id: string }) => a.id === created.id);
    expect(listed).toMatchObject({ name: 'dc-1', status: 'offline', serverCount: 0 });
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect(listed).not.toHaveProperty('tokenHash');

    const [entry] = audited(created.id, 'agent.create');
    expect(entry).toBeTruthy();
    expect(entry!.metadata ?? '').not.toContain(created.token);
  });

  it('keeps agents to their org', async () => {
    const mine = await createAgent('mine');
    const list = (await app.inject({ method: 'GET', url: '/api/agents', headers: foreignAdmin.headers })).json();
    expect(list.map((a: { id: string }) => a.id)).not.toContain(mine.id);
    const revoke = await app.inject({ method: 'POST', url: `/api/agents/${mine.id}/revoke`, headers: foreignAdmin.headers });
    expect(revoke.statusCode).toBe(404);
  });

  it('refuses a connection without a valid token', async () => {
    await expect(connect(undefined)).rejects.toThrow(/401/);
    await expect(connect('bsa_' + 'x'.repeat(43))).rejects.toThrow(/401/);
    await expect(connect('not-a-token')).rejects.toThrow(/401/);
  });

  it('refuses a plain HTTP request to the connect endpoint', async () => {
    const { token } = await createAgent('plain');
    const res = await app.inject({ method: 'GET', url: '/api/agents/connect', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).not.toBe(101);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('accepts a valid token, records the connection and shows the agent online', async () => {
    const { id, token } = await createAgent('live');
    const ws = await connect(token, { [AGENT_VERSION_HEADER]: '1.2.3', [AGENT_PORTS_HEADER]: '22,2222' });
    expect(isAgentOnline(id)).toBe(true);

    const listed = (await app.inject({ method: 'GET', url: '/api/agents', headers: admin.headers }))
      .json()
      .find((a: { id: string }) => a.id === id);
    expect(listed).toMatchObject({ status: 'online', version: '1.2.3' });
    expect(listed.connection.allowedPorts).toEqual([22, 2222]);
    expect(audited(id, 'agent.connect')).toHaveLength(1);

    const code = closed(ws);
    ws.close(1000);
    await code;
    await waitFor(() => !isAgentOnline(id));
    expect(audited(id, 'agent.disconnect')).toHaveLength(1);
    expect(getDb().select().from(agents).where(eq(agents.id, id)).get()!.lastSeenAt).toBeTruthy();
  });

  it('ignores a malformed version header', async () => {
    const { id, token } = await createAgent('odd-version');
    await connect(token, { [AGENT_VERSION_HEADER]: '<script>' });
    expect(getDb().select().from(agents).where(eq(agents.id, id)).get()!.version).toBeNull();
  });

  it('keeps one connection per agent: a new one replaces the old', async () => {
    const { id, token } = await createAgent('dup');
    const first = await connect(token);
    const firstClosed = closed(first);
    await connect(token);
    expect(await firstClosed).toBe(4409);
    expect(isAgentOnline(id)).toBe(true);
  });

  it('drops an agent that tries to open a stream itself', async () => {
    const { id, token } = await createAgent('rogue');
    const ws = await connect(token);
    const code = closed(ws);
    ws.send(encodeOpen(1, 22));
    expect(await code).toBe(4400);
    await waitFor(() => !isAgentOnline(id));
  });

  it('drops an agent that sends a text message', async () => {
    const { token } = await createAgent('chatty');
    const ws = await connect(token);
    const code = closed(ws);
    ws.send('hello');
    expect(await code).toBe(4400);
  });

  it('revokes: drops the live connection, audits, and refuses the token after', async () => {
    const { id, token } = await createAgent('to-revoke');
    const ws = await connect(token);
    const code = closed(ws);

    const res = await app.inject({ method: 'POST', url: `/api/agents/${id}/revoke`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'revoked' });
    expect(res.json().revokedAt).toBeTruthy();
    expect(await code).toBe(4401);
    expect(isAgentOnline(id)).toBe(false);
    await waitFor(() => audited(id, 'agent.disconnect').length === 1);

    const [entry] = audited(id, 'agent.revoke');
    expect(JSON.parse(entry!.metadata!)).toMatchObject({ wasOnline: true });

    await expect(connect(token)).rejects.toThrow(/401/);

    // Revoking again is a no-op, not a second audit row
    await app.inject({ method: 'POST', url: `/api/agents/${id}/revoke`, headers: admin.headers });
    expect(audited(id, 'agent.revoke')).toHaveLength(1);
  });

  describe('assigning agents to servers', () => {
    it('routes a server through an agent of its own org', async () => {
      const { id: agentId } = await createAgent('assign');
      const serverId = seedServer(orgId, admin.userId, 'private-1');
      const pinned = `SHA256:${'B'.repeat(43)}`;
      getDb().update(servers).set({ hostKeyFingerprint: pinned }).where(eq(servers.id, serverId)).run();

      const res = await app.inject({ method: 'PATCH', url: `/api/servers/${serverId}`, headers: admin.headers, payload: { agentId } });
      expect(res.statusCode).toBe(200);
      // The agent is untrusted transport: the pinned key must still match through it
      expect(res.json()).toMatchObject({ agentId, hostKeyFingerprint: pinned });
      expect(audited(serverId, 'server.host_key_cleared')).toHaveLength(0);
      const [entry] = audited(serverId, 'server.update');
      expect(JSON.parse(entry!.metadata!)).toEqual({ agentId: { from: null, to: agentId } });

      const listed = (await app.inject({ method: 'GET', url: '/api/agents', headers: admin.headers }))
        .json()
        .find((a: { id: string }) => a.id === agentId);
      expect(listed.serverCount).toBe(1);

      // Back to a direct connection
      const direct = await app.inject({ method: 'PATCH', url: `/api/servers/${serverId}`, headers: admin.headers, payload: { agentId: null } });
      expect(direct.json().agentId).toBeNull();
    });

    it("refuses another org's agent, an unknown one, and a revoked one", async () => {
      const foreign = await createAgent('foreign', foreignAdmin.headers);
      const revoked = await createAgent('gone');
      await app.inject({ method: 'POST', url: `/api/agents/${revoked.id}/revoke`, headers: admin.headers });

      for (const agentId of [foreign.id, 'nope', revoked.id]) {
        const create = await app.inject({
          method: 'POST',
          url: '/api/servers',
          headers: admin.headers,
          payload: { name: 's', host: 'h', username: 'root', agentId },
        });
        expect(create.statusCode).toBe(400);
        const serverId = seedServer(orgId, admin.userId);
        const patch = await app.inject({ method: 'PATCH', url: `/api/servers/${serverId}`, headers: admin.headers, payload: { agentId } });
        expect(patch.statusCode).toBe(400);
      }
    });

    it('lets an edit re-send the agent a server already has after it was revoked', async () => {
      const { id: agentId } = await createAgent('kept');
      const serverId = seedServer(orgId, admin.userId);
      await app.inject({ method: 'PATCH', url: `/api/servers/${serverId}`, headers: admin.headers, payload: { agentId } });
      await app.inject({ method: 'POST', url: `/api/agents/${agentId}/revoke`, headers: admin.headers });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}`,
        headers: admin.headers,
        payload: { name: 'renamed', agentId },
      });
      expect(res.statusCode).toBe(200);
      // Still pointing at the revoked agent: it fails closed rather than going direct
      expect(res.json()).toMatchObject({ name: 'renamed', agentId });
    });

    it('does not let an operator assign agents', async () => {
      const { id: agentId } = await createAgent('op');
      const serverId = seedServer(orgId, admin.userId);
      const res = await app.inject({ method: 'PATCH', url: `/api/servers/${serverId}`, headers: operator.headers, payload: { agentId } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('install files', () => {
    it('serves the install script and the agent it checks', async () => {
      const bundle = await app.inject({ method: 'GET', url: '/api/agents/bastion-agent.cjs' });
      expect(bundle.statusCode).toBe(200);
      const sha = createHash('sha256').update(bundle.rawPayload).digest('hex');
      expect(bundle.headers['x-content-sha256']).toBe(sha);

      const script = await app.inject({ method: 'GET', url: '/api/agents/install.sh' });
      expect(script.statusCode).toBe(200);
      expect(script.body).toContain(`AGENT_SHA256='${sha}'`);
      expect(script.body).toContain("BASTION_URL='http://localhost:8080'");
      expect(script.body).toContain('ExecStart=@NODE@ /opt/bastion-agent/bastion-agent.cjs');
      expect(script.body).not.toMatch(/bsa_[A-Za-z0-9_-]{43}/);
    });
  });
});
