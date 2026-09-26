import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

// Fake ssh2 that behaves like the real handshake around host keys: connect()
// hands `state.presented` to the configured hostVerifier and fails with ssh2's
// own error when it is refused. A config without a verifier is recorded and
// connects anyway — the assertions below catch that. Methods only, state in a
// closure (see vitest-mock-class-fields).
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  const state = { presented: Buffer.alloc(0), configs: [] as any[] };

  function channel(output: string) {
    const ch: any = new EventEmitter();
    ch.stderr = new EventEmitter();
    ch.writable = true;
    ch.write = () => {};
    ch.close = () => {};
    setImmediate(() => {
      ch.emit('data', Buffer.from(output));
      ch.emit('exit', 0);
      ch.emit('close', 0);
    });
    return ch;
  }

  class Client extends EventEmitter {
    connect(cfg: any) {
      state.configs.push(cfg);
      setImmediate(() => {
        if (typeof cfg.hostVerifier === 'function' && cfg.hostVerifier(state.presented) === false) {
          this.emit('error', new Error('Host denied (verification failed)'));
          this.emit('close');
          return;
        }
        this.emit('ready');
      });
      return this;
    }
    end() {}
    exec(_cmd: string, cb: (err: Error | undefined, ch: any) => void) {
      cb(undefined, channel('hostname fake\nuptime 100 50\n'));
    }
    shell(_opts: unknown, cb: (err: Error | undefined, ch: any) => void) {
      const ch: any = new EventEmitter();
      ch.stderr = new EventEmitter();
      cb(undefined, ch);
    }
    sftp(cb: (err: Error | undefined, sftp: unknown) => void) {
      cb(undefined, {});
    }
  }
  return { Client, __state: state };
});

const { __state: state } = (await import('ssh2')) as any;
const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { serverAlerts, serverHealth, servers } = await import('../db/schema.js');
const { seedOrg, seedUser, seedServer } = await import('../api/routes/test-utils.js');
const { HostKeyMismatchError, pinnedColumns } = await import('./host-keys.js');
const { SSHBroker, execOnServer, WS_CLOSE_HOST_KEY_MISMATCH } = await import('./broker.js');
const sftp = await import('./sftp.js');
const { runProbe } = await import('../monitoring/probe.js');
const { checkServer } = await import('../monitoring/collector.js');
const { vault } = await import('../vault/index.js');

const PINNED_LINE = 'AAAAC3NzaC1lZDI1NTE5AAAAIElIFDlvr3BbqwqJML2vALk7zEJk8g6g/KL13zhz+dh8';
const PINNED_FP = 'SHA256:7RzRboFL75PCBozdMj7VbF+Y5sel8sTZxSqUkmATKNk';
const IMPOSTOR_LINE =
  'AAAAB3NzaC1yc2EAAAADAQABAAABAQDBzrp2STH2pmmNlq1rKViosIU1Jn76TBXiFnLSIpPseBjWjL39HNtoWHk8WMGC4dkqftSt4H56RUCtWNflzAoZau9xNp5x0X3m36igPHLTqLU369J9MaNPx8Fl9V9uX5MZg5sYUQPlm/39pR6lbrN3kSvbmMUPTBjsDCnzMm07DOG8cUcPgP6ozDjDG97WmWoaCjnNbY1naclVjaYvRDGqxxheg0ZOXukugTAPj/bfzTtUA8WrQ2jwSknnI2j3I8+0fKcNlJlwUO/samY+A4D6DaUgQw28dlrRcQL9X9Z02+rzObOA9zx0OogotKH2lZsSeuPsq9UuB0nLeAbksrMx';
const IMPOSTOR_FP = 'SHA256:S7Axguai+B29/IGiF9tcSRxdklcSxD2vNoSLuUdBD8U';

const flush = () => new Promise((r) => setImmediate(r));

let orgId: string;
let userId: string;
let serverId: string;

function target() {
  return { id: serverId, host: '10.0.0.1', port: 22, username: 'root' };
}

function lastConfig() {
  return state.configs.at(-1);
}

beforeAll(async () => {
  await runMigrations();
  orgId = seedOrg('hostkey-paths');
  userId = seedUser(orgId, 'admin').userId;
});

beforeEach(async () => {
  // A fresh server with a pinned key for each test; the host presents another one
  serverId = seedServer(orgId, userId);
  getDb()
    .update(servers)
    .set({
      ...pinnedColumns(PINNED_FP, 'ssh-ed25519', userId),
      encryptedPassword: await vault.encrypt('pw', serverId),
    })
    .where(eq(servers.id, serverId))
    .run();
  state.presented = Buffer.from(IMPOSTOR_LINE, 'base64');
});

async function expectMismatch(promise: Promise<unknown>) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HostKeyMismatchError);
  expect(err).toMatchObject({ expected: PINNED_FP, presented: IMPOSTOR_FP });
  expect(typeof lastConfig().hostVerifier).toBe('function');
}

describe('every SSH connection path verifies the host key', () => {
  it('execOnServer (AI tools, saved commands, cron) refuses a changed key', async () => {
    await expectMismatch(execOnServer(target(), { password: 'pw' }, 'uptime'));
    expect(lastConfig().password).toBe('pw');
  });

  it('execOnServer runs when the key matches', async () => {
    state.presented = Buffer.from(PINNED_LINE, 'base64');
    const result = await execOnServer(target(), { password: 'pw' }, 'uptime');
    expect(result.exitCode).toBe(0);
    expect(typeof lastConfig().hostVerifier).toBe('function');
  });

  it('the SFTP pool refuses a changed key and does not cache the failure', async () => {
    const key = sftp.poolKey(orgId, serverId, userId);
    await expectMismatch(sftp.acquire(key, target(), { password: 'pw' }));

    // Once the key is right again the next request connects fresh
    state.presented = Buffer.from(PINNED_LINE, 'base64');
    const lease = await sftp.acquire(key, target(), { password: 'pw' });
    lease.release();
    sftp.evictServer(orgId, serverId);
  });

  it('the health probe refuses a changed key', async () => {
    await expectMismatch(runProbe(target(), { password: 'pw' }, 1_000));
  });

  it('a terminal session tells the browser why and closes with a dedicated code', async () => {
    const id = await SSHBroker.createSession({
      server: target(),
      password: 'pw',
      userId,
      orgId,
      cols: 80,
      rows: 24,
    });
    expect(typeof lastConfig().hostVerifier).toBe('function');

    const socket: any = new EventEmitter();
    socket.OPEN = 1;
    socket.readyState = 1;
    socket.send = vi.fn();
    socket.close = vi.fn();
    await SSHBroker.attach(id, socket as WebSocket, {
      user: { id: userId },
      orgId,
    } as unknown as FastifyRequest);

    expect(socket.send).toHaveBeenCalledTimes(1);
    const text = String(socket.send.mock.calls[0][0]);
    expect(text).toContain('Host key verification failed');
    expect(text).toContain(PINNED_FP);
    expect(text).toContain(IMPOSTOR_FP);
    expect(socket.close).toHaveBeenCalledWith(WS_CLOSE_HOST_KEY_MISMATCH, 'HOST_KEY_MISMATCH');
    expect(SSHBroker.getSessionForUser(id, userId, orgId)).toBeUndefined();
  });

  it('a health check marks the server as a host key problem, not offline', async () => {
    const server = getDb().select().from(servers).where(eq(servers.id, serverId)).get()!;
    // Past the offline threshold, it still must not read as "unreachable"
    for (let i = 0; i < 4; i++) {
      const outcome = await checkServer(server);
      expect(outcome.status).toBe('host_key_mismatch');
      await flush();
    }

    const health = getDb().select().from(serverHealth).where(eq(serverHealth.serverId, serverId)).get()!;
    expect(health.status).toBe('host_key_mismatch');
    expect(health.lastError).toContain(IMPOSTOR_FP);

    const open = getDb()
      .select()
      .from(serverAlerts)
      .where(and(eq(serverAlerts.serverId, serverId), isNull(serverAlerts.resolvedAt)))
      .all();
    expect(open.map((a) => a.type)).toEqual(['host_key_mismatch']);
  });

  it('the mismatch alert stays open after the host goes back to the pinned key', async () => {
    const server = getDb().select().from(servers).where(eq(servers.id, serverId)).get()!;
    await checkServer(server);

    state.presented = Buffer.from(PINNED_LINE, 'base64');
    const outcome = await checkServer(server);
    expect(outcome.status).toBe('online');
    const open = getDb()
      .select()
      .from(serverAlerts)
      .where(and(eq(serverAlerts.serverId, serverId), isNull(serverAlerts.resolvedAt)))
      .all();
    expect(open.map((a) => a.type)).toEqual(['host_key_mismatch']);
  });
});
