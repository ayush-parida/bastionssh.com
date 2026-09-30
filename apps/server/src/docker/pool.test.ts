import { describe, it, expect, vi, afterEach } from 'vitest';

// Fake ssh2 whose clients connect at once. Methods only — class fields in a
// vi.mock factory break the import (see vitest-mock-class-fields).
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  const clients: any[] = [];
  const configs: any[] = [];
  class Client extends EventEmitter {
    constructor() {
      super();
      clients.push(this);
      (this as any).end = vi.fn(() => this.emit('close'));
    }
    connect(config: unknown) {
      configs.push(config);
      setImmediate(() => this.emit('ready'));
      return this;
    }
  }
  return { Client, __clients: clients, __configs: configs };
});

// Connecting reads the server row (agent, jump hosts); an empty schema means direct
const { runMigrations } = await import('../db/migrate.js');
await runMigrations();

const { IDLE_TIMEOUT_MS, acquire, evictServer, evictUser, poolKey, pooledConnectionCount } = await import('./pool.js');
const { __clients: clients, __configs: configs } = (await import('ssh2')) as any;

const target = { id: 's1', host: 'h', port: 22, username: 'root' };
const auth = { password: 'pw' };
const flush = () => new Promise((r) => setImmediate(r));

async function open(orgId: string, serverId: string, userId: string) {
  const lease = await acquire(poolKey(orgId, serverId, userId), target, auth);
  lease.release();
  return clients.at(-1);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Docker connection pool', () => {
  it('connects through sshConnectConfig, with a host key verifier', async () => {
    await open('o0', 's0', 'u0');
    expect(typeof configs.at(-1).hostVerifier).toBe('function');
  });

  it('reuses one connection per (org, server, user) and never shares across users', async () => {
    const a = await acquire(poolKey('o1', 's1', 'u1'), target, auth);
    const b = await acquire(poolKey('o1', 's1', 'u1'), target, auth);
    const other = await acquire(poolKey('o1', 's1', 'u2'), target, auth);
    expect(a.client).toBe(b.client);
    expect(other.client).not.toBe(a.client);
    a.release();
    b.release();
    other.release();
  });

  it('closes a connection after two idle minutes, not while a lease is out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lease = await acquire(poolKey('o2', 's1', 'u1'), target, auth);
    const client = lease.client as any;
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2);
    expect(client.end).not.toHaveBeenCalled();
    lease.release();
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
    expect(client.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(client.end).toHaveBeenCalled();
  });

  it('evicts a user’s connections, scoped to an org and sparing kept servers', async () => {
    const kept = await open('o3', 'keep', 'u3');
    const dropped = await open('o3', 'drop', 'u3');
    const elsewhere = await open('o4', 'drop', 'u3');
    const someoneElse = await open('o3', 'drop', 'u4');

    expect(evictUser('u3', { orgId: 'o3', keepServerIds: ['keep'] })).toBe(1);
    await flush();
    expect(dropped.end).toHaveBeenCalled();
    expect(kept.end).not.toHaveBeenCalled();
    expect(elsewhere.end).not.toHaveBeenCalled();
    expect(someoneElse.end).not.toHaveBeenCalled();

    expect(evictUser('u3')).toBe(2);
    await flush();
    expect(kept.end).toHaveBeenCalled();
    expect(elsewhere.end).toHaveBeenCalled();
  });

  it('evicts every user’s connection to a server', async () => {
    const a = await open('o5', 's9', 'u1');
    const b = await open('o5', 's9', 'u2');
    const other = await open('o5', 's8', 'u1');
    expect(evictServer('o5', 's9')).toBe(2);
    await flush();
    expect(a.end).toHaveBeenCalled();
    expect(b.end).toHaveBeenCalled();
    expect(other.end).not.toHaveBeenCalled();

    // The next request opens a fresh connection
    const again = await open('o5', 's9', 'u1');
    expect(again).not.toBe(a);
    expect(pooledConnectionCount()).toBeGreaterThan(0);
  });

  it('needs a credential', async () => {
    await expect(acquire(poolKey('o6', 's1', 'u1'), target, {})).rejects.toMatchObject({ statusCode: 400 });
  });
});
