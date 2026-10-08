import posix from 'node:path/posix';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FileInfo, FileType, FTPError } from 'basic-ftp';

/**
 * An in-memory stand-in for a basic-ftp Client, for suites that want the real
 * FTP ops (ftp/ops.ts) on top. Replace openClient from a vi.mock factory:
 *
 *   vi.mock('../../ftp/client.js', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('../../ftp/client.js')>()),
 *     ...(await import('../../ftp/fake-ftp.test-helper.js')).fakeFtp(),
 *   }));
 *
 * Like basic-ftp, a client runs one task at a time: starting another while
 * one is running fails (and is counted in `overlaps`). Downloads arrive in
 * 64 KiB chunks with backpressure. Methods only, state in closures (see
 * vitest-mock-class-fields).
 */

export interface FakeFtpNode {
  type: 'file' | 'dir' | 'link';
  data?: Buffer;
  target?: string;
}

/** A listing row the server makes up, whatever is on disk (hostile or odd names). */
export interface FakeFtpRow {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size?: number;
}

export interface FakeFtpState {
  fs: Map<string, FakeFtpNode>;
  /** Extra rows listed in a folder. */
  extra: Map<string, FakeFtpRow[]>;
  /** Paths (and everything below) answered with 550 Permission denied. */
  denied: Set<string>;
  /** Folders that cannot be listed, though what is below them can (mode 0711). */
  unlistable: Set<string>;
  /** Downloads that send nothing until the client is closed. */
  stall: Set<string>;
  /** Downloads whose data connection is reset after this many bytes. */
  dropAfter: Map<string, number>;
  /** Downloads that send this many bytes more than the file holds (it grew). */
  grow: Map<string, number>;
  /** Every task as [op, path]. */
  calls: [string, string][];
  /** Tasks started while another was running on the same client. */
  overlaps: number;
  logins: number;
  /** Clients not closed yet. */
  open: number;
  reset(): void;
}

const CHUNK = 64 * 1024;

export function fakeFtp(): { openClient: unknown; __state: FakeFtpState } {
  const state: FakeFtpState = {
    fs: new Map(),
    extra: new Map(),
    denied: new Set(),
    unlistable: new Set(),
    stall: new Set(),
    dropAfter: new Map(),
    grow: new Map(),
    calls: [],
    overlaps: 0,
    logins: 0,
    open: 0,
    reset() {
      state.fs.clear();
      state.extra.clear();
      state.denied.clear();
      state.unlistable.clear();
      state.stall.clear();
      state.dropAfter.clear();
      state.grow.clear();
      state.calls.length = 0;
      state.overlaps = 0;
      state.logins = 0;
      state.open = 0;
    },
  };

  const reply = (code: number, message: string) => new FTPError({ code, message } as never);
  const isDenied = (p: string) => [...state.denied].some((d) => p === d || p.startsWith(`${d}/`));

  const follow = (p: string, depth = 0): [string, FakeFtpNode] | undefined => {
    const node = state.fs.get(p);
    if (!node) return undefined;
    if (node.type !== 'link') return [p, node];
    if (depth > 8) return undefined;
    return follow(posix.resolve(posix.dirname(p), node.target!), depth + 1);
  };

  const info = (name: string, type: FakeFtpRow['type'], size: number, link?: string) => {
    const f = new FileInfo(name);
    f.type =
      type === 'file'
        ? FileType.File
        : type === 'dir'
          ? FileType.Directory
          : type === 'link'
            ? FileType.SymbolicLink
            : FileType.Unknown;
    f.size = size;
    f.permissions = type === 'dir' ? { user: 7, group: 5, world: 5 } : { user: 6, group: 4, world: 4 };
    if (link) f.link = link;
    return f;
  };

  const rowFor = (name: string, node: FakeFtpNode) =>
    info(name, node.type, node.type === 'file' ? (node.data?.length ?? 0) : 0, node.target);

  const openClient = async () => {
    state.logins++;
    state.open++;
    let closed = false;
    let busy = false;
    // Ends the running task when the client is closed under it
    let interrupt: ((err: Error) => void) | null = null;

    async function task<T>(op: string, path: string, fn: () => Promise<T>): Promise<T> {
      if (closed) throw new Error('Client is closed');
      if (busy) {
        state.overlaps++;
        throw new Error('User launched a task while another one is still running');
      }
      busy = true;
      state.calls.push([op, path]);
      try {
        return await new Promise<T>((resolve, reject) => {
          interrupt = reject;
          setImmediate(() => fn().then(resolve, reject));
        });
      } finally {
        interrupt = null;
        busy = false;
      }
    }

    return {
      get closed() {
        return closed;
      },
      close() {
        if (closed) return;
        closed = true;
        state.open--;
        interrupt?.(new Error('Client is closed'));
      },
      pwd: () => task('pwd', '', async () => '/home/deploy'),
      cd: (p: string) =>
        task('cd', p, async () => {
          if (follow(p)?.[1].type !== 'dir') throw reply(550, 'Not a directory');
        }),
      size: (p: string) =>
        task('size', p, async () => {
          const found = follow(p);
          if (found?.[1].type !== 'file') throw reply(550, 'Not a plain file');
          return found[1].data?.length ?? 0;
        }),
      list: (p: string) =>
        task('list', p, async () => {
          if (isDenied(p) || state.unlistable.has(p)) throw reply(550, 'Permission denied');
          const found = follow(p);
          if (!found) throw reply(550, 'No such file or directory');
          const [real, node] = found;
          if (node.type === 'file') return [rowFor(posix.basename(p), node)];
          const prefix = real === '/' ? '/' : `${real}/`;
          const rows = [...state.fs.keys()]
            .filter((k) => k !== real && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
            .map((k) => rowFor(posix.basename(k), state.fs.get(k)!));
          const extra = (state.extra.get(p) ?? []).map((r) => info(r.name, r.type, r.size ?? 0));
          return [info('.', 'dir', 0), info('..', 'dir', 0), ...rows, ...extra];
        }),
      downloadTo: (destination: Writable, p: string) =>
        task('downloadTo', p, async () => {
          try {
            if (isDenied(p)) throw reply(550, 'Permission denied');
            const found = follow(p);
            if (found?.[1].type !== 'file') throw reply(550, 'No such file');
            let data = found[1].data ?? Buffer.alloc(0);
            if (state.grow.has(p)) data = Buffer.concat([data, Buffer.alloc(state.grow.get(p)!, 1)]);
            const stall = state.stall.has(p);
            const dropAt = state.dropAfter.get(p);
            const source = new Readable({
              read() {},
            });
            if (!stall) {
              const end = dropAt ?? data.length;
              for (let at = 0; at < end; at += CHUNK) source.push(data.subarray(at, Math.min(end, at + CHUNK)));
              if (dropAt === undefined) source.push(null);
              else setImmediate(() => source.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
            }
            const prev = interrupt;
            interrupt = (err) => {
              source.destroy(err);
              prev?.(err);
            };
            await pipeline(source, destination);
          } catch (err) {
            // A reset data connection takes the control connection with it
            if ((err as { code?: string }).code === 'ECONNRESET' && !closed) {
              closed = true;
              state.open--;
            }
            throw err;
          } finally {
            destination.end();
          }
        }),
    };
  };

  return { openClient, __state: state };
}
