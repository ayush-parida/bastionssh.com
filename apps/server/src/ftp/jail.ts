import { FtpError } from './errors.js';
import { normalizeRemotePath, parentOf } from './paths.js';
import type { FileSession } from './backend.js';

/**
 * "Restrict to root": a FileSession wrapper that refuses every path outside
 * the connection's root — its configured start directory, else the login
 * directory. Routes already normalize paths, so `..` has been collapsed by the
 * time a path gets here and the lexical check is a plain prefix test.
 *
 * FTP can only be checked lexically: the protocol has no way to ask where a
 * symlink leads. SFTP also asks the server (realpath) where a path really is,
 * so a link inside the root that points out of it is refused too:
 *
 * - an operation that follows the path (list, download) resolves the path
 *   itself;
 * - one that acts on the entry, not what it points to (stat, delete, rename,
 *   mkdir), resolves its parent directory — a link in the root may be removed
 *   or renamed, but no directory above it may be a way out;
 * - an upload does both when the target already exists as a link, because
 *   writing opens the file the link points at. A link that cannot be resolved
 *   (dangling) is refused rather than written through.
 *
 * What is resolved is checked, then the operation runs: a user who can also
 * swap links on the server between the two can still race it. The jail is
 * about what this app lets people reach, not a replacement for a chroot.
 */

export class FtpPathRefusedError extends FtpError {
  constructor(
    readonly path: string,
    message = 'Path is outside the directory this connection is restricted to',
  ) {
    super(message, 403);
    this.name = 'FtpPathRefusedError';
  }
}

/** True when `path` is `root` or below it. Both must be normalized. */
export function isWithin(root: string, path: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}

function absolute(path: string): string {
  return normalizeRemotePath(path.startsWith('/') ? path : `/${path}`);
}

interface Roots {
  /** The root as paths are written by clients. */
  lexical: string;
  /** Where the server says the root really is (SFTP only). */
  real: string | null;
}

export function jailSession(inner: FileSession, rootPath: string | null): FileSession {
  let pending: Promise<Roots> | undefined;

  function roots(): Promise<Roots> {
    pending ??= (async () => {
      const lexical = await inner.home(rootPath);
      const real = inner.realpath ? absolute(await inner.realpath(lexical)) : null;
      return { lexical, real };
    })().catch((err: unknown) => {
      // A failed lookup (a dropped connection) is retried by the next call
      pending = undefined;
      throw err;
    });
    return pending;
  }

  async function lexical(path: string): Promise<Roots> {
    const r = await roots();
    if (!isWithin(r.lexical, path)) throw new FtpPathRefusedError(path);
    return r;
  }

  /** Where `path` really is must be inside the real root. */
  async function resolves(r: Roots, path: string): Promise<void> {
    if (r.real === null || !inner.realpath) return;
    const real = absolute(await inner.realpath(path));
    if (!isWithin(r.real, real)) {
      throw new FtpPathRefusedError(path, 'Path leads outside the directory this connection is restricted to');
    }
  }

  /** For operations that follow `path` to whatever it points at. */
  async function following(path: string): Promise<void> {
    await resolves(await lexical(path), path);
  }

  /** For operations on the entry itself: only the directory holding it is resolved. */
  async function entry(path: string): Promise<Roots> {
    const r = await lexical(path);
    const parent = parentOf(path);
    if (path !== r.lexical && parent !== null) await resolves(r, parent);
    return r;
  }

  /** The root itself may be listed and written into, never removed or moved. */
  async function notRoot(path: string, action: string): Promise<void> {
    const r = await entry(path);
    if (path === r.lexical) {
      throw new FtpPathRefusedError(path, `Cannot ${action} the directory this connection is restricted to`);
    }
  }

  return {
    get closed() {
      return inner.closed;
    },
    close: () => inner.close(),
    // A refusal is ours; the session behind it is untouched
    survives: (err) => err instanceof FtpPathRefusedError || inner.survives(err),

    home: async () => (await roots()).lexical,
    jailRoot: async () => (await roots()).lexical,
    ...(inner.realpath && { realpath: inner.realpath.bind(inner) }),

    async list(dir) {
      await following(dir);
      return inner.list(dir);
    },
    async stat(path) {
      await entry(path);
      return inner.stat(path);
    },
    async linkTargetSize(path) {
      await following(path);
      return inner.linkTargetSize(path);
    },
    async download(path, destination) {
      await following(path);
      return inner.download(path, destination);
    },
    async upload(source, path) {
      const r = await entry(path);
      if (r.real !== null) {
        let existing: Awaited<ReturnType<FileSession['stat']>> | undefined;
        try {
          existing = await inner.stat(path);
        } catch (err) {
          if (!(err instanceof FtpError) || err.statusCode !== 404) throw err;
        }
        if (existing?.type === 'symlink') {
          try {
            await resolves(r, path);
          } catch (err) {
            if (err instanceof FtpPathRefusedError) throw err;
            throw new FtpPathRefusedError(path, 'Refusing to write through a link that cannot be resolved');
          }
        }
      }
      return inner.upload(source, path);
    },
    async mkdir(path) {
      await entry(path);
      return inner.mkdir(path);
    },
    async rename(from, to) {
      await notRoot(from, 'rename');
      await notRoot(to, 'replace');
      return inner.rename(from, to);
    },
    async removeFile(path) {
      await notRoot(path, 'delete');
      return inner.removeFile(path);
    },
    async removeEmptyDir(path) {
      await notRoot(path, 'delete');
      return inner.removeEmptyDir(path);
    },
    async removeDirRecursive(path) {
      await notRoot(path, 'delete');
      return inner.removeDirRecursive(path);
    },
  };
}
