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
    /** When set, the next connect() fails with this error instead of becoming ready. */
    connectError: null as Error | null,
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
      const err = state.connectError;
      state.connectError = null;
      setImmediate(() => (err ? this.emit('error', err) : this.emit('ready')));
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

// Connecting reads the server row and its jump hosts (they decide whether the
// connection goes through an agent or a jump host); an empty schema means every
// server connects directly.
const { runMigrations } = await import('../db/migrate.js');
await runMigrations();

const { SSHBroker, getSessionForUser, DETACHED_GRACE_MS, FAILED_SESSION_TTL_MS, WS_CLOSE_HOST_KEY_MISMATCH } =
  await import('./broker.js');
const { HostKeyMismatchError } = await import('./host-keys.js');
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

describe('session recording', () => {
  function fakeRecording() {
    return {
      id: 'rec-1',
      inputRecorded: true,
      output: vi.fn(),
      input: vi.fn(),
      resize: vi.fn(),
      command: vi.fn(),
      finish: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    };
  }

  async function recordedSession(recording: ReturnType<typeof fakeRecording>) {
    const id = await SSHBroker.createSession({
      server: { id: 's1', host: 'h', port: 22, username: 'root' },
      password: 'pw',
      ...OWNER,
      cols: 80,
      rows: 24,
      recording,
    });
    await flush();
    await flush();
    return { id, client: state.clients.at(-1), shell: state.shells.at(-1) };
  }

  it('records output whether or not a socket is attached, plus input and resizes', async () => {
    const recording = fakeRecording();
    const { id, shell } = await recordedSession(recording);

    shell.emit('data', Buffer.from('motd'));
    const sock = makeSocket();
    await SSHBroker.attach(id, sock, makeReq(OWNER));
    shell.emit('data', Buffer.from('$ '));
    shell.stderr.emit('data', Buffer.from('warn'));
    sock.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })));
    sock.emit('message', Buffer.from('ls\r'));

    expect(recording.output.mock.calls.map(([d]) => String(d))).toEqual(['motd', '$ ', 'warn']);
    expect(recording.resize).toHaveBeenCalledWith(120, 40);
    expect(recording.input.mock.calls.map(([d]) => String(d))).toEqual(['ls\r']);
    expect(shell.write).toHaveBeenCalledTimes(1);
  });

  it('finishes the recording when the session closes, however it closes', async () => {
    const closed = fakeRecording();
    const a = await recordedSession(closed);
    await SSHBroker.close(a.id, OWNER);
    expect(closed.finish).toHaveBeenCalled();
    expect(closed.discard).not.toHaveBeenCalled();

    const exited = fakeRecording();
    const b = await recordedSession(exited);
    b.shell.emit('close');
    expect(exited.finish).toHaveBeenCalled();

    const reaped = fakeRecording();
    await recordedSession(reaped);
    vi.advanceTimersByTime(DETACHED_GRACE_MS);
    expect(reaped.finish).toHaveBeenCalled();
  });

  it('discards the recording when the connection fails before a shell opens', async () => {
    const recording = fakeRecording();
    await SSHBroker.createSession({
      server: { id: 's1', host: 'h', port: 22, username: 'root' },
      password: 'pw',
      ...OWNER,
      cols: 80,
      rows: 24,
      recording,
    });
    state.clients.at(-1).emit('error', new Error('ECONNREFUSED'));
    await flush();
    await flush();
    expect(recording.discard).toHaveBeenCalled();
    expect(recording.finish).not.toHaveBeenCalled();
  });

  it('logs commands run over the session on its recording', async () => {
    const recording = fakeRecording();
    const { id } = await recordedSession(recording);
    const pending = SSHBroker.exec(id, 'df -h', 30_000, OWNER, 'ai');
    const ch = state.execs.at(-1);
    ch.emit('data', Buffer.from('/dev/sda1'));
    ch.emit('exit', 0);
    ch.emit('close');

    const result = await pending;
    expect(result.recordingId).toBe('rec-1');
    expect(recording.command).toHaveBeenCalledWith({ source: 'ai', command: 'df -h', exitCode: 0 });
  });

  it('logs a command that timed out, without an exit code', async () => {
    const recording = fakeRecording();
    const { id } = await recordedSession(recording);
    const pending = SSHBroker.exec(id, 'sleep 999', 1000, OWNER, 'ai');
    const assertion = expect(pending).rejects.toThrow('Command timed out');
    vi.advanceTimersByTime(1000);
    await assertion;
    expect(recording.command).toHaveBeenCalledWith({ source: 'ai', command: 'sleep 999', exitCode: null });
  });
});

describe('connection refused before the socket attaches', () => {
  const mismatch = () =>
    new HostKeyMismatchError('s1', 'SHA256:expected', 'SHA256:presented', 'ssh-ed25519', 'web (h:22)');

  it('tells the socket about a changed host key instead of "Session not found"', async () => {
    state.connectError = mismatch();
    const { id } = await newSession();
    expect(getSessionForUser(id, 'u1', 'o1')).toBeUndefined();

    const sock = makeSocket();
    await SSHBroker.attach(id, sock, makeReq(OWNER));
    expect(sock.send).toHaveBeenCalledWith(expect.stringContaining('SHA256:presented'));
    expect(sock.close).toHaveBeenCalledWith(WS_CLOSE_HOST_KEY_MISMATCH, 'HOST_KEY_MISMATCH');

    // Collected once; a later attach finds nothing
    const again = makeSocket();
    await SSHBroker.attach(id, again, makeReq(OWNER));
    expect(again.close).toHaveBeenCalledWith(4404, 'Session not found');
  });

  it('reports any other connection error with its message', async () => {
    state.connectError = new Error('All configured authentication methods failed');
    const { id } = await newSession();
    const sock = makeSocket();
    await SSHBroker.attach(id, sock, makeReq(OWNER));
    expect(sock.close).toHaveBeenCalledWith(4500, 'All configured authentication methods failed');
  });

  it('keeps the reason only for the owner', async () => {
    state.connectError = mismatch();
    const { id } = await newSession();
    for (const other of [
      { userId: 'u2', orgId: 'o1' },
      { userId: 'u1', orgId: 'o2' },
    ]) {
      const sock = makeSocket();
      await SSHBroker.attach(id, sock, makeReq(other));
      expect(sock.send).not.toHaveBeenCalled();
      expect(sock.close).toHaveBeenCalledWith(4404, 'Session not found');
    }
    // A stranger's attempt does not use it up
    const mine = makeSocket();
    await SSHBroker.attach(id, mine, makeReq(OWNER));
    expect(mine.close).toHaveBeenCalledWith(WS_CLOSE_HOST_KEY_MISMATCH, 'HOST_KEY_MISMATCH');
  });

  it('forgets the reason after a short while', async () => {
    state.connectError = mismatch();
    const { id } = await newSession();
    vi.advanceTimersByTime(FAILED_SESSION_TTL_MS);
    const sock = makeSocket();
    await SSHBroker.attach(id, sock, makeReq(OWNER));
    expect(sock.close).toHaveBeenCalledWith(4404, 'Session not found');
  });

  it('keeps the reason when the waiting socket closed before the handshake failed', async () => {
    state.connectError = mismatch();
    const id = await SSHBroker.createSession({
      server: { id: 's1', host: 'h', port: 22, username: 'root' },
      password: 'pw',
      ...OWNER,
      cols: 80,
      rows: 24,
    });
    const gone = makeSocket();
    const attached = SSHBroker.attach(id, gone, makeReq(OWNER));
    // The browser gives up (a reload, a StrictMode remount) while SSH connects
    gone.close();
    await flush();
    await attached;
    await flush();
    const retry = makeSocket();
    await SSHBroker.attach(id, retry, makeReq(OWNER));
    expect(retry.close).toHaveBeenCalledWith(WS_CLOSE_HOST_KEY_MISMATCH, 'HOST_KEY_MISMATCH');
  });

  it('still reports straight to a socket that was already waiting', async () => {
    state.connectError = mismatch();
    const id = await SSHBroker.createSession({
      server: { id: 's1', host: 'h', port: 22, username: 'root' },
      password: 'pw',
      ...OWNER,
      cols: 80,
      rows: 24,
    });
    const sock = makeSocket();
    const attached = SSHBroker.attach(id, sock, makeReq(OWNER));
    await flush();
    await attached;
    expect(sock.close).toHaveBeenCalledWith(WS_CLOSE_HOST_KEY_MISMATCH, 'HOST_KEY_MISMATCH');
    await flush();
    // Nothing left behind for a later attach
    const later = makeSocket();
    await SSHBroker.attach(id, later, makeReq(OWNER));
    expect(later.close).toHaveBeenCalledWith(4404, 'Session not found');
  });
});

describe('adopted sessions (a shell in a container)', () => {
  /** A terminal channel opened elsewhere, as docker/exec.ts hands it over. */
  function makeChannel() {
    const ch: any = new EventEmitter();
    ch.stderr = new EventEmitter();
    ch.writable = true;
    ch.write = vi.fn();
    ch.setWindow = vi.fn();
    return ch;
  }

  function adopt(owner = OWNER) {
    const channel = makeChannel();
    const end = vi.fn();
    const recording = {
      id: 'r1',
      inputRecorded: false,
      output: vi.fn(),
      input: vi.fn(),
      resize: vi.fn(),
      command: vi.fn(),
      finish: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    };
    const id = SSHBroker.adoptSession(
      {
        server: { id: 's1', host: 'h', port: 22, username: 'root' },
        ...owner,
        cols: 80,
        rows: 24,
        recording,
        container: { id: 'c'.repeat(64), name: 'web' },
      },
      channel,
      end,
    );
    return { id, channel, end, recording };
  }

  it('attaches like an SSH shell: buffered output, input, resize, recording', async () => {
    const { id, channel, recording } = adopt();
    await flush();
    channel.emit('data', Buffer.from('before attach'));
    expect(getSessionForUser(id, 'u1', 'o1')).toMatchObject({ container: { name: 'web' } });

    const sock = makeSocket();
    await SSHBroker.attach(id, sock, makeReq(OWNER));
    expect(sock.send).toHaveBeenCalledWith(Buffer.from('before attach'));
    sock.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })));
    expect(channel.setWindow).toHaveBeenCalledWith(30, 100, 0, 0);
    expect(recording.resize).toHaveBeenCalledWith(100, 30);
    sock.emit('message', Buffer.from('ls\r'));
    expect(channel.write).toHaveBeenCalledWith(Buffer.from('ls\r'));
    expect(recording.output).toHaveBeenCalledWith(Buffer.from('before attach'));
  });

  it('ends once when the shell exits, keeping the recording', async () => {
    const { id, channel, end, recording } = adopt();
    await flush();
    const sock = makeSocket();
    await SSHBroker.attach(id, sock, makeReq(OWNER));
    channel.emit('close');
    expect(end).toHaveBeenCalledTimes(1);
    expect(recording.finish).toHaveBeenCalled();
    expect(sock.close).toHaveBeenCalled();
    await SSHBroker.close(id, OWNER);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('is closed on revocation and by closeWhere, and runs no commands', async () => {
    const first = adopt();
    await flush();
    await expect(SSHBroker.exec(first.id, 'id', 1000, OWNER)).rejects.toThrow(/container shell/);
    expect(SSHBroker.closeForUser('u1', { orgId: 'o1' })).toBeGreaterThanOrEqual(1);
    expect(first.end).toHaveBeenCalled();

    const mine = adopt();
    const theirs = adopt({ userId: 'u2', orgId: 'o1' });
    await flush();
    expect(SSHBroker.closeWhere((s) => s.container !== null && s.userId === 'u2')).toBe(1);
    expect(theirs.end).toHaveBeenCalled();
    expect(mine.end).not.toHaveBeenCalled();
    await SSHBroker.close(mine.id, OWNER);
  });

  it('is reaped when never attached', async () => {
    const { end } = adopt();
    await flush();
    vi.advanceTimersByTime(DETACHED_GRACE_MS);
    expect(end).toHaveBeenCalled();
  });
});
