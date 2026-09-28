import { describe, it, expect, vi } from 'vitest';

// Fake ssh2 whose clients connect and open SFTP immediately. Methods only —
// class fields in a vi.mock factory break the import (see vitest-mock-class-fields).
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  const clients: any[] = [];
  class Client extends EventEmitter {
    constructor() {
      super();
      clients.push(this);
      (this as any).end = vi.fn();
    }
    connect() {
      setImmediate(() => this.emit('ready'));
      return this;
    }
    sftp(cb: (err: Error | undefined, sftp: unknown) => void) {
      cb(undefined, {});
    }
  }
  return { Client, __clients: clients };
});

// Connecting looks up the server's jump hosts; none of these servers exist, so all connect directly
await (await import('../db/migrate.js')).runMigrations();
const { acquire, evictUser, poolKey } = await import('./sftp.js');
const { __clients: clients } = (await import('ssh2')) as any;

const target = { id: 's1', host: 'h', port: 22, username: 'root' };
const auth = { password: 'pw' };
const flush = () => new Promise((r) => setImmediate(r));

async function open(orgId: string, serverId: string, userId: string) {
  const lease = await acquire(poolKey(orgId, serverId, userId), target, auth);
  lease.release();
  return clients.at(-1);
}

describe('evictUser', () => {
  it('closes the user’s pooled connections in every org, and nobody else’s', async () => {
    const a = await open('o1', 's1', 'u1');
    const b = await open('o2', 's2', 'u1');
    const other = await open('o1', 's1', 'u2');

    expect(evictUser('u1')).toBe(2);
    await flush();
    expect(a.end).toHaveBeenCalled();
    expect(b.end).toHaveBeenCalled();
    expect(other.end).not.toHaveBeenCalled();

    // A later request opens a fresh connection rather than reusing the dropped one
    const again = await open('o1', 's1', 'u1');
    expect(again).not.toBe(a);
  });

  it('limits to one org and keeps servers still granted', async () => {
    const kept = await open('o3', 'keep', 'u3');
    const dropped = await open('o3', 'drop', 'u3');
    const elsewhere = await open('o4', 'drop', 'u3');

    expect(evictUser('u3', { orgId: 'o3', keepServerIds: ['keep'] })).toBe(1);
    await flush();
    expect(dropped.end).toHaveBeenCalled();
    expect(kept.end).not.toHaveBeenCalled();
    expect(elsewhere.end).not.toHaveBeenCalled();
  });
});
