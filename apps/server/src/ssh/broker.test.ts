import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

// Fake ssh2: methods only (no class fields — see vitest-mock-class-fields),
// with every client/channel recorded in a shared closure.
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  const state = {
    clients: [] as any[],
    shells: [] as any[],
    execs: [] as any[],
  };

  function makeChannel() {
    const ch: any = new EventEmitter();
    ch.stderr = new EventEmitter();
    ch.writable = true;
    ch.write = vi.fn();
    ch.setWindow = vi.fn();
    ch.close = vi.fn(() => {
      ch.writable = false;
      ch.emit('close');
    });
    return ch;
  }

  class Client extends EventEmitter {
    constructor() {
      super();
      state.clients.push(this);
      (this as any).end = vi.fn();
    }
    connect() {
      setImmediate(() => this.emit('ready'));
      return this;
    }
    shell(_opts: unknown, cb: (err: Error | undefined, ch: any) => void) {
      const ch = makeChannel();
      state.shells.push(ch);
      cb(undefined, ch);
    }
    exec(_cmd: string, cb: (err: Error | undefined, ch: any) => void) {
      const ch = makeChannel();
      state.execs.push(ch);
      cb(undefined, ch);
    }
  }

  return { Client, __state: state };
});

// Connecting looks up the server's jump hosts; none of these servers exist, so all connect directly
await (await import('../db/migrate.js')).runMigrations();
const { SSHBroker, getSessionForUser, DETACHED_GRACE_MS } = await import('./broker.js');
const { __state: state } = (await import('ssh2')) as any;

const flush = () => new Promise((r) => setImmediate(r));

const OWNER = { userId: 'u1', orgId: 'o1' };

function makeReq(owner: { userId: string; orgId: string }) {
  return { user: { id: owner.userId }, orgId: owner.orgId } as unknown as FastifyRequest;
}

function makeSocket() {
  const sock: any = new EventEmitter();
  sock.OPEN = 1;
  sock.readyState = 1;
  sock.send = vi.fn();
  sock.close = vi.fn(() => {
    if (sock.readyState === 3) return;
    sock.readyState = 3;
    sock.emit('close');
  });
  return sock as WebSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

async function newSession() {
  const id = await SSHBroker.createSession({
    server: { id: 's1', host: 'h', port: 22, username: 'root' },
    password: 'pw',
    ...OWNER,
    cols: 80,
    rows: 24,
  });
  await flush();
  await flush();
  return { id, client: state.clients.at(-1), shell: state.shells.at(-1) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session ownership', () => {
  it('only resolves a session for its creator in its org', async () => {
    const { id } = await newSession();
    expect(getSessionForUser(id, 'u1', 'o1')).toMatchObject({ id });
    expect(getSessionForUser(id, 'u2', 'o1')).toBeUndefined();
    expect(getSessionForUser(id, 'u1', 'o2')).toBeUndefined();
  });

  it('refuses to attach another user or org and treats it as not found', async () => {
    const { id } = await newSession();
    for (const other of [
      { userId: 'u2', orgId: 'o1' },
      { userId: 'u1', orgId: 'o2' },
    ]) {
      const sock = makeSocket();
      await SSHBroker.attach(id, sock, makeReq(other));
      expect(sock.close).toHaveBeenCalledWith(4404, 'Session not found');
    }

    const mine = makeSocket();
    await SSHBroker.attach(id, mine, makeReq(OWNER));
    expect(mine.close).not.toHaveBeenCalled();
  });

  it('ignores close and exec from someone other than the owner', async () => {
    const { id, client } = await newSession();
    await SSHBroker.close(id, { userId: 'u2', orgId: 'o1' });
    expect(client.end).not.toHaveBeenCalled();
    await expect(SSHBroker.exec(id, 'id', 1000, { userId: 'u1', orgId: 'o2' })).rejects.toThrow(
      'Session not found',
    );

    await SSHBroker.close(id, OWNER);
    expect(client.end).toHaveBeenCalled();
    expect(getSessionForUser(id, 'u1', 'o1')).toBeUndefined();
  });
});

describe('detached session reaping', () => {
  it('closes a session that is never attached', async () => {
    const { id, client } = await newSession();
    vi.advanceTimersByTime(DETACHED_GRACE_MS);
    expect(client.end).toHaveBeenCalled();
    expect(getSessionForUser(id, 'u1', 'o1')).toBeUndefined();
  });

  it('closes a session once its socket has been gone for the grace period', async () => {
    const { id, client } = await newSession();
    const sock = makeSocket();
    await SSHBroker.attach(id, sock, makeReq(OWNER));

    vi.advanceTimersByTime(DETACHED_GRACE_MS * 2);
    expect(client.end).not.toHaveBeenCalled();

    sock.close();
    vi.advanceTimersByTime(DETACHED_GRACE_MS - 1);
    expect(client.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(client.end).toHaveBeenCalled();
  });

  it('keeps a session that is re-attached within the grace period', async () => {
    const { id, client } = await newSession();
    const first = makeSocket();
    await SSHBroker.attach(id, first, makeReq(OWNER));
    first.close();
    vi.advanceTimersByTime(DETACHED_GRACE_MS / 2);

    await SSHBroker.attach(id, makeSocket(), makeReq(OWNER));
    vi.advanceTimersByTime(DETACHED_GRACE_MS * 2);
    expect(client.end).not.toHaveBeenCalled();
  });
});

describe('shell channel teardown', () => {
  it('does not write input once the channel is no longer writable', async () => {
    const { id, shell } = await newSession();
    const sock = makeSocket();
    await SSHBroker.attach(id, sock, makeReq(OWNER));

    sock.emit('message', Buffer.from('ls\n'));
    expect(shell.write).toHaveBeenCalledTimes(1);

    shell.writable = false;
    sock.emit('message', Buffer.from('more'));
    expect(shell.write).toHaveBeenCalledTimes(1);
  });

  it('handles a channel error by closing the session instead of throwing', async () => {
    const { id, client, shell } = await newSession();
    expect(() => shell.emit('error', new Error('write after end'))).not.toThrow();
    expect(client.end).toHaveBeenCalled();
    expect(getSessionForUser(id, 'u1', 'o1')).toBeUndefined();
  });
});

describe('exec', () => {
  it('caps collected output and marks it truncated', async () => {
    const { id } = await newSession();
    const pending = SSHBroker.exec(id, 'yes', 30_000, OWNER);
    const ch = state.execs.at(-1);
    for (let i = 0; i < 100; i++) ch.emit('data', Buffer.alloc(10_000, 'y'));
    ch.stderr.emit('data', Buffer.from('small'));
    ch.emit('close');

    const result = await pending;
    expect(result.stdout.startsWith('y'.repeat(64_000))).toBe(true);
    expect(result.stdout.endsWith('[output truncated]')).toBe(true);
    expect(result.stdout.length).toBeLessThan(64_100);
    expect(result.stderr).toBe('small');
  });

  it('closes the channel when the command times out', async () => {
    const { id } = await newSession();
    const pending = SSHBroker.exec(id, 'tail -f /var/log/syslog', 1000, OWNER);
    const ch = state.execs.at(-1);
    const assertion = expect(pending).rejects.toThrow('Command timed out');
    vi.advanceTimersByTime(1000);
    await assertion;
    expect(ch.close).toHaveBeenCalled();
  });
});

describe('closeForUser', () => {
  async function sessionFor(userId: string, orgId: string, serverId: string) {
    const id = await SSHBroker.createSession({
      server: { id: serverId, host: 'h', port: 22, username: 'root' },
      password: 'pw',
      userId,
      orgId,
      cols: 80,
      rows: 24,
    });
    await flush();
    await flush();
    const sock = makeSocket();
    await SSHBroker.attach(id, sock, makeReq({ userId, orgId }));
    return { id, client: state.clients.at(-1), sock };
  }

  it('closes every session and socket the user holds, in every org', async () => {
    const a = await sessionFor('rv1', 'oa', 's1');
    const b = await sessionFor('rv1', 'ob', 's2');
    const other = await sessionFor('rv2', 'oa', 's1');

    expect(SSHBroker.closeForUser('rv1')).toBe(2);
    for (const s of [a, b]) {
      expect(s.client.end).toHaveBeenCalled();
      expect(s.sock.close).toHaveBeenCalledWith(4403, 'Access revoked');
    }
    expect(getSessionForUser(a.id, 'rv1', 'oa')).toBeUndefined();
    expect(getSessionForUser(b.id, 'rv1', 'ob')).toBeUndefined();
    // Someone else's session is untouched
    expect(other.client.end).not.toHaveBeenCalled();
    expect(getSessionForUser(other.id, 'rv2', 'oa')).toBeDefined();
  });

  it('limits to one org and keeps sessions on servers still granted', async () => {
    const kept = await sessionFor('rv3', 'oa', 'keep');
    const dropped = await sessionFor('rv3', 'oa', 'drop');
    const elsewhere = await sessionFor('rv3', 'ob', 'drop');

    expect(SSHBroker.closeForUser('rv3', { orgId: 'oa', keepServerIds: ['keep'] })).toBe(1);
    expect(dropped.client.end).toHaveBeenCalled();
    expect(kept.client.end).not.toHaveBeenCalled();
    expect(elsewhere.client.end).not.toHaveBeenCalled();
    expect(getSessionForUser(kept.id, 'rv3', 'oa')).toBeDefined();
  });
});
