import { PassThrough, Writable, type Readable } from 'node:stream';
import type { FtpEntry } from '@smt/shared';
import type { FolderWalker, WalkEntry } from '../archive/index.js';
import type { FileSession } from './backend.js';
import { FtpError } from './errors.js';
import { FtpPathRefusedError } from './jail.js';
import { joinPath, normalizeRemotePath } from './paths.js';

/**
 * The folder-download walker for FTP/FTPS and SFTP connections (archive/):
 * every listing and read goes through a {@link FileSession}, so the
 * connection's root-path jail (and, over SFTP, its realpath checks) and the
 * backends' own timeouts apply to each step as they do to a click in the
 * browser.
 *
 * One operation at a time, one data connection at a time: an FTP control
 * connection runs a single command, so the next listing or file waits until
 * the previous transfer has finished on the server's side, not only until
 * the archive has read the file's bytes. A session the backend reports as
 * unusable after a failure (a dropped socket, an aborted transfer) is closed
 * and the next step logs in again.
 */

/**
 * Bytes past a file's listed size read and dropped so its transfer ends
 * cleanly (it grew while being read); past this the session is closed
 * instead and the next step logs in again.
 */
const MAX_DISCARD_BYTES = 1024 * 1024;

const STOPPED = 'The archive stopped reading this file';

export interface ConnectionWalkerOptions {
  /** Logged in, and jailed when the connection is restricted to its root. */
  session: FileSession;
  /** Another session like the first, after it was dropped. */
  reconnect: () => Promise<FileSession>;
}

export interface ConnectionWalker extends FolderWalker {
  /** Paths the root-path jail refused during the walk (for the audit log), the first {@link MAX_REFUSED_KEPT}. */
  readonly refused: readonly string[];
  /** How many paths the jail refused. */
  readonly refusedCount: number;
}

const MAX_REFUSED_KEPT = 1000;

/**
 * The remote path of a listed name, or null when the name is not one plain
 * path segment: a server (or a file name) that answers `..`, `a/b` or a line
 * break would otherwise steer the next command somewhere else.
 */
export function childPath(dir: string, name: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (name === '' || name === '.' || name === '..' || /[/\u0000\r\n]/.test(name)) return null;
  const path = joinPath(dir, name);
  try {
    return normalizeRemotePath(path) === path ? path : null;
  } catch {
    return null;
  }
}

/** `rwxr-xr-x` back into permission bits. */
export function permissionBits(permissions: string | null): number | undefined {
  if (!permissions || !/^[rwx-]{9}$/.test(permissions)) return undefined;
  let bits = 0;
  for (let i = 0; i < 9; i++) if (permissions[i] !== '-') bits |= 1 << (8 - i);
  return bits;
}

const TYPES: Record<FtpEntry['type'], WalkEntry['type']> = {
  directory: 'dir',
  file: 'file',
  symlink: 'symlink',
  other: 'other',
};

/** A refusal from the server itself leaves an FTP control connection usable, whatever the backend says. */
function survives(session: FileSession, err: unknown): boolean {
  return session.survives(err) || (err instanceof FtpError && err.statusCode < 500);
}

export function connectionWalker(opts: ConnectionWalkerOptions): ConnectionWalker {
  let session: FileSession | null = opts.session;
  let closed = false;
  // Settles once the previous transfer is over on the server's side
  let idle: Promise<void> = Promise.resolve();
  const refused: string[] = [];
  let refusedCount = 0;

  const ended = () => new FtpError('The folder download has ended', 499);

  function drop(s: FileSession): void {
    if (session === s) session = null;
    s.close();
  }

  async function current(): Promise<FileSession> {
    await idle;
    if (closed) throw ended();
    if (session && !session.closed) return session;
    session?.close();
    session = null;
    const fresh = await opts.reconnect();
    if (closed) {
      fresh.close();
      throw ended();
    }
    session = fresh;
    return fresh;
  }

  function failed(s: FileSession, err: unknown): void {
    if (err instanceof FtpPathRefusedError) {
      if (refusedCount++ < MAX_REFUSED_KEPT) refused.push(err.path);
    } else if (!survives(s, err)) drop(s);
  }

  async function run<T>(fn: (s: FileSession) => Promise<T>): Promise<T> {
    const s = await current();
    try {
      return await fn(s);
    } catch (err) {
      failed(s, err);
      throw err;
    }
  }

  function checkRef(ref: string): void {
    if (!ref) throw new FtpError('The server listed a name that is not a plain file name', 400);
  }

  return {
    get refused() {
      return refused;
    },
    get refusedCount() {
      return refusedCount;
    },

    async list(dir) {
      checkRef(dir);
      const listed = await run((s) => s.list(dir));
      const entries: WalkEntry[] = [];
      for (const e of listed) {
        const ref = childPath(dir, e.name) ?? '';
        let linkTarget = e.link ?? undefined;
        // An SFTP listing reads only so many link targets; ask for the rest
        if (e.type === 'symlink' && linkTarget === undefined && ref && opts.session.realpath) {
          linkTarget = (await run((s) => s.stat(ref)).catch(() => null))?.link ?? undefined;
        }
        const mtime = e.modifiedAt ? new Date(e.modifiedAt) : undefined;
        entries.push({
          name: e.name,
          ref,
          type: TYPES[e.type] ?? 'other',
          size: e.size,
          ...(mtime && { mtime }),
          ...(permissionBits(e.permissions) !== undefined && { mode: permissionBits(e.permissions) }),
          ...(linkTarget !== undefined && { linkTarget }),
        });
      }
      return entries;
    },

    async open(entry, signal) {
      checkRef(entry.ref);
      const s = await current();
      const out = new PassThrough();
      let delivered = 0;
      let discarded = 0;
      let pending: ((err?: Error | null) => void) | null = null;

      // Whether the archive gave up on the file before its listed size
      const early = () => delivered < entry.size || signal.aborted;
      const release = () => {
        const cb = pending;
        pending = null;
        if (!cb) return;
        cb(out.destroyed && early() ? new Error(STOPPED) : null);
      };
      out.on('drain', release);
      out.on('close', release);

      // Between the transfer and the archive: once the archive has all it
      // listed, whatever else arrives is dropped so the transfer can finish.
      // The archive's stream ends only once the transfer has succeeded:
      // basic-ftp ends its destination even when the transfer failed.
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (out.destroyed) {
            if (early()) return callback(new Error(STOPPED));
            discarded += chunk.length;
            return callback(discarded > MAX_DISCARD_BYTES ? new Error(`${STOPPED}: it kept growing`) : null);
          }
          delivered += chunk.length;
          if (out.write(chunk)) callback();
          else pending = callback;
        },
      });

      const transfer = s.download(entry.ref, sink);
      idle = transfer.then(
        () => {},
        (err: unknown) => failed(s, err),
      );
      transfer.then(
        () => {
          if (!out.destroyed) out.end();
        },
        (err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))),
      );
      return out as Readable;
    },

    close() {
      closed = true;
      session?.close();
      session = null;
    },
  };
}
