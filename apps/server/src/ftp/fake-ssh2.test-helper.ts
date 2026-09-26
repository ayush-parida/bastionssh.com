import { EventEmitter } from 'node:events';
import posix from 'node:path/posix';
import { Readable, Writable } from 'node:stream';

/**
 * An in-memory stand-in for ssh2, for the SFTP backend and route suites. The
 * handshake runs the configured hostVerifier on `state.presented` and fails
 * the way ssh2 does; the SFTP channel serves a small filesystem held in
 * `state.fs` with SFTP v3 status codes. Load it from a vi.mock factory:
 *
 *   vi.mock('ssh2', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('ssh2')>()),
 *     ...(await import('../ftp/fake-ssh2.test-helper.js')).fakeSsh2(),
 *   }));
 *
 * Methods only, state in closures (see vitest-mock-class-fields).
 */

export interface FakeNode {
  type: 'file' | 'dir' | 'link';
  data?: Buffer;
  target?: string;
  mode?: number;
  mtime?: number;
}

export interface FakeClientRecord {
  config: any;
  ended: boolean;
  /** Simulate the socket dying under an open session. */
  drop(): void;
}

export interface FakeSsh2State {
  fs: Map<string, FakeNode>;
  /** What realpath('.') answers — the login directory. */
  home: string;
  presented: Buffer;
  authFail: boolean;
  /** Authenticate over keyboard-interactive with these prompts; answers land in `keyboardAnswers`. */
  keyboardPrompts: { prompt: string; echo: boolean }[] | null;
  keyboardAnswers: string[] | null;
  /** Never answer the handshake; ssh2's readyTimeout fires instead. */
  hang: boolean;
  /** Emitted instead of 'ready' (e.g. ECONNREFUSED). */
  connectError: (Error & { code?: string; level?: string }) | null;
  /** Refuse the SFTP subsystem after login. */
  sftpError: Error | null;
  /** Paths (and everything below them) that answer PERMISSION_DENIED. */
  denied: Set<string>;
  clients: FakeClientRecord[];
  /** Every SFTP request as [op, ...paths]. */
  calls: unknown[][];
  /** Paths whose write stream was destroyed before finishing. */
  abortedWrites: string[];
  reset(): void;
}

export function statusError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

const noSuchFile = () => statusError(2, 'No such file');
const denied = () => statusError(3, 'Permission denied');
const failure = () => statusError(4, 'Failure');

function createState(): FakeSsh2State {
  const state: FakeSsh2State = {
    fs: new Map(),
    home: '/home/deploy',
    presented: Buffer.alloc(0),
    authFail: false,
    keyboardPrompts: null,
    keyboardAnswers: null,
    hang: false,
    connectError: null,
    sftpError: null,
    denied: new Set(),
    clients: [],
    calls: [],
    abortedWrites: [],
    reset() {
      state.fs.clear();
      state.home = '/home/deploy';
      state.authFail = false;
      state.keyboardPrompts = null;
      state.keyboardAnswers = null;
      state.hang = false;
      state.connectError = null;
      state.sftpError = null;
      state.denied.clear();
      state.calls.length = 0;
      state.abortedWrites.length = 0;
    },
  };
  return state;
}

function later(cb: (...args: any[]) => void, err?: Error, value?: unknown) {
  setImmediate(() => cb(err, value));
}

function makeSftp(state: FakeSsh2State) {
  const sftp: any = new EventEmitter();

  const isDenied = (p: string) =>
    [...state.denied].some((d) => p === d || p.startsWith(`${d}/`));

  /** Follow links in the last component, like stat. */
  const follow = (p: string, depth = 0): [string, FakeNode] | undefined => {
    const node = state.fs.get(p);
    if (!node) return undefined;
    if (node.type !== 'link') return [p, node];
    if (depth > 8) return undefined;
    return follow(posix.resolve(posix.dirname(p), node.target!), depth + 1);
  };

  const attrs = (node: FakeNode) => {
    const kind = node.type === 'dir' ? 0o040000 : node.type === 'link' ? 0o120000 : 0o100000;
    const perm = node.mode ?? (node.type === 'dir' ? 0o755 : node.type === 'link' ? 0o777 : 0o644);
    return {
      mode: kind | perm,
      size: node.type === 'file' ? (node.data?.length ?? 0) : node.type === 'link' ? node.target!.length : 4096,
      uid: 1000,
      gid: 1000,
      atime: node.mtime ?? 1_700_000_000,
      mtime: node.mtime ?? 1_700_000_000,
    };
  };

  const children = (dir: string) => {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    return [...state.fs.keys()].filter(
      (k) => k !== dir && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'),
    );
  };

  /** Record the call; answer PERMISSION_DENIED for a denied path. */
  const enter = (op: string, cb: (...args: any[]) => void, ...paths: string[]) => {
    state.calls.push([op, ...paths]);
    if (paths.some(isDenied)) {
      later(cb, denied());
      return false;
    }
    return true;
  };

  sftp.readdir = (p: string, cb: (...args: any[]) => void) => {
    if (!enter('readdir', cb, p)) return;
    const found = follow(p);
    if (!found) return later(cb, noSuchFile());
    const [real, node] = found;
    if (node.type !== 'dir') return later(cb, failure());
    const dot = { filename: '.', longname: '', attrs: attrs(node) };
    const rows = children(real).map((k) => ({
      filename: posix.basename(k),
      longname: '',
      attrs: attrs(state.fs.get(k)!),
    }));
    later(cb, undefined, [dot, { ...dot, filename: '..' }, ...rows]);
  };

  sftp.lstat = (p: string, cb: (...args: any[]) => void) => {
    if (!enter('lstat', cb, p)) return;
    const node = state.fs.get(p);
    if (!node) return later(cb, noSuchFile());
    later(cb, undefined, attrs(node));
  };

  sftp.stat = (p: string, cb: (...args: any[]) => void) => {
    if (!enter('stat', cb, p)) return;
    const found = follow(p);
    if (!found) return later(cb, noSuchFile());
    // Following a link into a denied directory is denied too
    if (isDenied(found[0])) return later(cb, denied());
    later(cb, undefined, attrs(found[1]));
  };

  sftp.readlink = (p: string, cb: (...args: any[]) => void) => {
    if (!enter('readlink', cb, p)) return;
    const node = state.fs.get(p);
    if (!node) return later(cb, noSuchFile());
    if (node.type !== 'link') return later(cb, failure());
    later(cb, undefined, node.target);
  };

  sftp.realpath = (p: string, cb: (...args: any[]) => void) => {
    if (!enter('realpath', cb, p)) return;
    const abs = p === '.' ? state.home : posix.resolve(state.home, p);
    const found = follow(abs);
    if (!found) return later(cb, noSuchFile());
    later(cb, undefined, found[0]);
  };

  sftp.mkdir = (p: string, cb: (...args: any[]) => void) => {
    if (!enter('mkdir', cb, p)) return;
    if (state.fs.has(p)) return later(cb, failure());
    if (!state.fs.has(posix.dirname(p))) return later(cb, noSuchFile());
    state.fs.set(p, { type: 'dir' });
    later(cb);
  };

  sftp.rename = (from: string, to: string, cb: (...args: any[]) => void) => {
    if (!enter('rename', cb, from, to)) return;
    if (!state.fs.has(from)) return later(cb, noSuchFile());
    if (state.fs.has(to)) return later(cb, failure());
    for (const [k, v] of [...state.fs]) {
      if (k === from || k.startsWith(`${from}/`)) {
        state.fs.delete(k);
        state.fs.set(to + k.slice(from.length), v);
      }
    }
    later(cb);
  };

  sftp.unlink = (p: string, cb: (...args: any[]) => void) => {
    if (!enter('unlink', cb, p)) return;
    const node = state.fs.get(p);
    if (!node) return later(cb, noSuchFile());
    if (node.type === 'dir') return later(cb, failure());
    state.fs.delete(p);
    later(cb);
  };

  sftp.rmdir = (p: string, cb: (...args: any[]) => void) => {
    if (!enter('rmdir', cb, p)) return;
    const node = state.fs.get(p);
    if (!node) return later(cb, noSuchFile());
    if (node.type !== 'dir' || children(p).length > 0) return later(cb, failure());
    state.fs.delete(p);
    later(cb);
  };

  sftp.createReadStream = (p: string) => {
    state.calls.push(['createReadStream', p]);
    let done = false;
    return new Readable({
      read() {
        if (done) return;
        done = true;
        if (isDenied(p)) return this.destroy(denied());
        const found = follow(p);
        if (!found) return this.destroy(noSuchFile());
        if (found[1].type !== 'file') return this.destroy(failure());
        this.push(found[1].data ?? Buffer.alloc(0));
        this.push(null);
      },
    });
  };

  sftp.createWriteStream = (p: string) => {
    state.calls.push(['createWriteStream', p]);
    const chunks: Buffer[] = [];
    let finished = false;
    return new Writable({
      construct(cb) {
        if (isDenied(p)) return cb(denied());
        if (!state.fs.has(posix.dirname(p))) return cb(noSuchFile());
        cb();
      },
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        finished = true;
        state.fs.set(p, { type: 'file', data: Buffer.concat(chunks) });
        cb();
      },
      destroy(err, cb) {
        if (!finished) state.abortedWrites.push(p);
        cb(err);
      },
    });
  };

  return sftp;
}

export function fakeSsh2(): { Client: unknown; __state: FakeSsh2State } {
  const state = createState();
  // Per-instance data lives here, not in class fields
  const records = new WeakMap<object, FakeClientRecord>();

  class Client extends EventEmitter {
    connect(config: any) {
      const self = this;
      const record: FakeClientRecord = {
        config,
        ended: false,
        drop() {
          self.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
          self.emit('close');
        },
      };
      records.set(this, record);
      state.clients.push(record);
      setImmediate(() => {
        if (record.ended) return;
        if (state.connectError) {
          this.emit('error', state.connectError);
          this.emit('close');
          return;
        }
        if (state.hang) {
          setTimeout(() => {
            if (record.ended) return;
            this.emit(
              'error',
              Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' }),
            );
            this.emit('close');
          }, config.readyTimeout ?? 20_000);
          return;
        }
        if (typeof config.hostVerifier === 'function' && config.hostVerifier(state.presented) === false) {
          this.emit('error', new Error('Host denied (verification failed)'));
          this.emit('close');
          return;
        }
        if (state.authFail) {
          this.emit(
            'error',
            Object.assign(new Error('All configured authentication methods failed'), {
              level: 'client-authentication',
            }),
          );
          this.emit('close');
          return;
        }
        if (state.keyboardPrompts && config.tryKeyboard) {
          this.emit('keyboard-interactive', '', '', '', state.keyboardPrompts, (answers: string[]) => {
            state.keyboardAnswers = answers;
            setImmediate(() => this.emit('ready'));
          });
          return;
        }
        this.emit('ready');
      });
      return this;
    }

    end() {
      const record = records.get(this);
      if (!record || record.ended) return this;
      record.ended = true;
      setImmediate(() => this.emit('close'));
      return this;
    }

    sftp(cb: (err: Error | undefined, sftp?: unknown) => void) {
      setImmediate(() => {
        if (state.sftpError) cb(state.sftpError);
        else cb(undefined, makeSftp(state));
      });
      return this;
    }

    exec() {
      throw new Error('exec must never be used for SFTP file connections');
    }

    shell() {
      throw new Error('shell must never be used for SFTP file connections');
    }
  }

  return { Client, __state: state };
}
