import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Server as SshServer, utils as sshUtils } from 'ssh2';
import { eq } from 'drizzle-orm';
import type { AgentHandle } from '@smt/agent/agent';

/**
 * Loopback integration: the real agent (packages/agent) dials an in-process
 * app over a real WebSocket and tunnels to TCP servers on this machine — an
 * echo server, and an ssh2 server standing in for a private host's sshd.
 */

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { auditLog, servers } = await import('../db/schema.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { openAgentTunnel, isAgentOnline, disconnectAgent } = await import('./hub.js');
const { execOnServer } = await import('../ssh/broker.js');
const { runProbe, ProbeError } = await import('../monitoring/probe.js');
const { hostKeyFingerprint, HostKeyMismatchError } = await import('../ssh/host-keys.js');
const { startAgent } = await import('@smt/agent/agent');

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

async function waitFor(check: () => boolean, ms = 5_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Send `payload` over a tunnel and collect everything that comes back until it closes. */
async function roundTrip(socket: ReturnType<typeof openAgentTunnel>, payload: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on('data', (c: Buffer) => chunks.push(c));
  socket.open();
  await once(socket, 'connect');
  socket.write(payload);
  await waitFor(() => Buffer.concat(chunks).length >= payload.length);
  socket.end();
  await once(socket, 'close');
  return Buffer.concat(chunks);
}

describe('agent tunnel (loopback)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let agentId: string;
  let token: string;
  let agent: AgentHandle;
  let echo: net.Server;
  let echoPort: number;
  let ssh: SshServer;
  let sshPort: number;
  let deadPort: number;
  let serverId: string;
  const hostKey = sshUtils.generateKeyPairSync('ed25519');
  const logs: string[] = [];

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('agent-loopback');
    admin = seedUser(orgId, 'admin');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const appPort = (app.server.address() as AddressInfo).port;

    echo = net.createServer((s) => s.pipe(s));
    echoPort = await listen(echo);

    ssh = new SshServer({ hostKeys: [hostKey.private] }, (client) => {
      client
        .on('authentication', (ctx) => {
          if (ctx.method === 'password' && ctx.username === 'deploy' && ctx.password === 'pw') ctx.accept();
          else ctx.reject(['password']);
        })
        .on('ready', () => {
          client.on('session', (accept) => {
            accept().on('exec', (acceptExec, _reject, info) => {
              const stream = acceptExec();
              stream.write(`ran: ${info.command}\n`);
              stream.exit(0);
              stream.end();
            });
          });
        })
        .on('error', () => {});
    });
    sshPort = await new Promise<number>((resolve) =>
      ssh.listen(0, '127.0.0.1', () => resolve((ssh.address() as AddressInfo).port)),
    );
    deadPort = await closedPort();

    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: admin.headers,
      payload: { name: 'private-dc', allowedPorts: [echoPort, sshPort, deadPort] },
    });
    expect(created.statusCode).toBe(201);
    ({ id: agentId, token } = created.json());

    const srv = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: admin.headers,
      // Never resolved or dialled: the agent connects to its own loopback
      payload: {
        name: 'behind-nat',
        host: 'db.internal.invalid',
        port: sshPort,
        username: 'deploy',
        authType: 'password',
        password: 'pw',
        agentId,
      },
    });
    expect(srv.statusCode).toBe(201);
    serverId = srv.json().id;

    agent = startAgent({
      url: `http://127.0.0.1:${appPort}`,
      token,
      allowedPorts: [echoPort, sshPort, deadPort],
      backoff: { initialMs: 50, maxMs: 200 },
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      version: '9.9.9-test',
    });
    await agent.connected();
    await waitFor(() => isAgentOnline(agentId));
  });

  afterAll(async () => {
    await agent?.stop();
    await app?.close();
    await new Promise((r) => echo?.close(r));
    await new Promise((r) => ssh?.close(r));
  });

  it('reports the agent online with its version and allowlist', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/agents', headers: admin.headers })).json();
    const row = list.find((a: { id: string }) => a.id === agentId);
    expect(row).toMatchObject({ status: 'online', version: '9.9.9-test', serverCount: 1 });
    expect(row.connection.allowedPorts).toEqual([echoPort, sshPort, deadPort]);
    expect(row.lastSeenAt).toBeTruthy();
    expect(row).not.toHaveProperty('token');
  });

  it('pipes bytes both ways, including writes larger than one frame', async () => {
    const payload = Buffer.alloc(300_000);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const back = await roundTrip(openAgentTunnel({ orgId, agentId }, echoPort), payload);
    expect(back.equals(payload)).toBe(true);
    await waitFor(() => agent.openStreams === 0);
  });

  it('carries many streams at once without mixing them up', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        roundTrip(openAgentTunnel({ orgId, agentId }, echoPort), Buffer.from(`stream-${i}-`.repeat(1000))),
      ),
    );
    results.forEach((r, i) => expect(r.toString()).toBe(`stream-${i}-`.repeat(1000)));
  });

  it('refuses a port that is not on the agent allowlist', async () => {
    const socket = openAgentTunnel({ orgId, agentId }, 25).open();
    const [err] = await once(socket, 'error');
    expect(err).toMatchObject({ code: 'EPORTNOTALLOWED' });
    expect(logs.some((l) => l.includes('Refused to open local port 25'))).toBe(true);
  });

  it("passes on the agent's own connect failure", async () => {
    const socket = openAgentTunnel({ orgId, agentId }, deadPort).open();
    const [err] = await once(socket, 'error');
    expect(err).toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('never lets an agent of one org carry another org’s connection', async () => {
    const socket = openAgentTunnel({ orgId: seedOrg('someone-else'), agentId }, echoPort).open();
    const [err] = await once(socket, 'error');
    expect(err).toMatchObject({ code: 'EAGENTOFFLINE' });
  });

  it('runs SSH end to end through the agent and trusts the host key on first use', async () => {
    const target = { id: serverId, host: 'db.internal.invalid', port: sshPort, username: 'deploy' };
    const result = await execOnServer(target, { password: 'pw' }, 'uptime');
    expect(result.stdout).toBe('ran: uptime\n');

    const row = getDb().select().from(servers).where(eq(servers.id, serverId)).get()!;
    const parsed = sshUtils.parseKey(hostKey.public);
    const expected = hostKeyFingerprint((Array.isArray(parsed) ? parsed[0] : parsed as { getPublicSSH(): Buffer }).getPublicSSH());
    expect(row.hostKeyFingerprint).toBe(expected);
    expect(row.hostKeyType).toBe('ssh-ed25519');
  });

  it('scans the host key through the agent', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/servers/${serverId}/host-key/scan`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    const row = getDb().select().from(servers).where(eq(servers.id, serverId)).get()!;
    expect(res.json()).toEqual({ fingerprint: row.hostKeyFingerprint, type: 'ssh-ed25519' });
  });

  it('still refuses a host key that does not match — the agent is only transport', async () => {
    const row = getDb().select().from(servers).where(eq(servers.id, serverId)).get()!;
    const pinned = row.hostKeyFingerprint;
    const wrong = `SHA256:${'A'.repeat(43)}`;
    getDb().update(servers).set({ hostKeyFingerprint: wrong }).where(eq(servers.id, serverId)).run();
    try {
      const target = { id: serverId, host: row.host, port: row.port, username: 'deploy' };
      await expect(execOnServer(target, { password: 'pw' }, 'id')).rejects.toBeInstanceOf(HostKeyMismatchError);
    } finally {
      getDb()
        .update(servers)
        .set({ hostKeyFingerprint: pinned, hostKeyMismatchFingerprint: null, hostKeyMismatchType: null, hostKeyMismatchAt: null })
        .where(eq(servers.id, serverId))
        .run();
    }
  });

  it('health-checks through the agent', async () => {
    // The fake sshd answers any command, so the probe parses nothing useful —
    // but it got there and back through the agent, which is the point.
    const target = { id: serverId, host: 'db.internal.invalid', port: sshPort, username: 'deploy' };
    const err = await runProbe(target, { password: 'pw' }, 5_000).catch((e) => e);
    expect(err).not.toMatchObject({ kind: 'offline' });
  });

  it('reconnects on its own after the app drops it', async () => {
    expect(disconnectAgent(agentId, 1012, 'Service restart')).toBe(true);
    expect(isAgentOnline(agentId)).toBe(false);
    await waitFor(() => isAgentOnline(agentId));
    await agent.connected();
    const back = await roundTrip(openAgentTunnel({ orgId, agentId }, echoPort), Buffer.from('again'));
    expect(back.toString()).toBe('again');
  });

  it('drops the connection and its streams on revoke, and the token stops working', async () => {
    const socket = openAgentTunnel({ orgId, agentId }, echoPort).open();
    await once(socket, 'connect');
    const failed = once(socket, 'error');

    const res = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/revoke`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'revoked', connection: null });

    const [err] = await failed;
    expect(err).toMatchObject({ code: 'ECONNRESET' });
    expect(isAgentOnline(agentId)).toBe(false);
    await waitFor(() => logs.some((l) => l.includes('revoked by an administrator')));
    expect(agent.state).toBe('waiting');

    // A server routed through a revoked agent fails closed: no direct fallback
    const target = { id: serverId, host: 'db.internal.invalid', port: sshPort, username: 'deploy' };
    const probe = await runProbe(target, { password: 'pw' }, 5_000).catch((e) => e);
    expect(probe).toBeInstanceOf(ProbeError);
    expect(probe).toMatchObject({ kind: 'offline' });

    await waitFor(() =>
      getDb()
        .select()
        .from(auditLog)
        .all()
        .some((r) => r.action === 'agent.disconnect' && r.resourceId === agentId),
    );
    const actions = getDb()
      .select()
      .from(auditLog)
      .all()
      .filter((r) => r.resourceId === agentId)
      .map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['agent.create', 'agent.connect', 'agent.revoke', 'agent.disconnect']));
  });
});
