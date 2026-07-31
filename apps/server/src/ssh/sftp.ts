import { Client } from 'ssh2';
import type { SFTPWrapper, FileEntry, Attributes, Stats } from 'ssh2';
import posix from 'node:path/posix';
import type { Readable, Writable } from 'node:stream';
import type { SftpEntry, SftpEntryType } from '@smt/shared';
import logger from '../logger.js';

/** Close a pooled connection after this long with no in-flight operations. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000;

export interface SftpTarget {
  host: string;
  port: number;
  username: string;
}

export interface SftpAuth {
  privateKey?: string;
  password?: string;
}

interface PooledConnection {
  client: Client;
  sftp: SFTPWrapper;
  /** Number of in-flight operations; the idle timer only fires at 0. */
  active: number;
  idleTimer?: NodeJS.Timeout;
}

export interface SftpLease {
  sftp: SFTPWrapper;
  /** Must be called exactly once, in a `finally` or on stream close. */
  release: () => void;
}

/** Keyed by `${orgId}:${serverId}:${userId}` so connections are never shared across users. */
const pool = new Map<string, Promise<PooledConnection>>();

// ── Path handling ────────────────────────────────────────────────────────────

/**
 * Normalize a client-supplied remote path. Only absolute POSIX paths are
 * accepted — `..` segments are collapsed by `normalize`, and a traversal that
 * would escape the root simply resolves to `/`.
 */
export function normalizeRemotePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new SftpError('Path is required', 400);
  }
  if (input.includes('\0')) {
    throw new SftpError('Path contains a null byte', 400);
  }
  if (!input.startsWith('/')) {
    throw new SftpError('Path must be absolute', 400);
  }
  const normalized = posix.normalize(input);
  // Strip a trailing slash except on the root itself
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : '/';
}

export function parentOf(path: string): string | null {
  if (path === '/') return null;
  return posix.dirname(path);
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class SftpError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
  ) {
    super(message);
    this.name = 'SftpError';
  }
}

/** Map ssh2 SFTP status codes onto HTTP statuses so routes can surface them directly. */
function toSftpError(err: unknown, fallback: string): SftpError {
  const code = (err as { code?: number } | undefined)?.code;
  const message = err instanceof Error ? err.message : fallback;
  switch (code) {
    case 2: // NO_SUCH_FILE
      return new SftpError(message || 'No such file or directory', 404);
    case 3: // PERMISSION_DENIED
      return new SftpError(message || 'Permission denied', 403);
    case 4: // FAILURE — covers "directory not empty", "file exists", etc.
      return new SftpError(message || 'Operation failed', 400);
    default:
      return new SftpError(message || fallback, 500);
  }
}

// ── Connection pool ──────────────────────────────────────────────────────────

function scheduleIdleClose(key: string, conn: PooledConnection) {
  clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => {
    if (conn.active > 0) return; // still busy; the next release() reschedules
    pool.delete(key);
    conn.client.end();
  }, IDLE_TIMEOUT_MS);
  conn.idleTimer.unref?.();
}

function openConnection(
  key: string,
  target: SftpTarget,
  auth: SftpAuth,
): Promise<PooledConnection> {
  return new Promise<PooledConnection>((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new SftpError('SFTP connection timed out', 504));
    }, CONNECT_TIMEOUT_MS);

    client
      .on('ready', () => {
        client.sftp((err, sftp) => {
          clearTimeout(timer);
          if (err) {
            client.end();
            pool.delete(key);
            reject(new SftpError(`Failed to open SFTP subsystem: ${err.message}`, 502));
            return;
          }
          const conn: PooledConnection = { client, sftp, active: 0 };
          scheduleIdleClose(key, conn);
          resolve(conn);
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        // Drop the cached promise so the next request retries a fresh connection
        pool.delete(key);
        logger.error({ err, host: target.host }, 'SFTP connection error');
        reject(new SftpError(`SFTP connection failed: ${err.message}`, 502));
      })
      .on('close', () => {
        clearTimeout(timer);
        pool.delete(key);
      })
      .connect({
        host: target.host,
        port: target.port,
        username: target.username,
        ...(auth.privateKey ? { privateKey: auth.privateKey } : { password: auth.password }),
      });
  });
}

/**
 * Get a pooled SFTP channel for this user+server, opening one if needed.
 * The caller owns the returned lease and must `release()` it.
 */
export async function acquire(
  key: string,
  target: SftpTarget,
  auth: SftpAuth,
): Promise<SftpLease> {
  if (!auth.privateKey && !auth.password) {
    throw new SftpError('No authentication method available', 400);
  }

  let pending = pool.get(key);
  if (!pending) {
    pending = openConnection(key, target, auth);
    pool.set(key, pending);
  }

  let conn: PooledConnection;
  try {
    conn = await pending;
  } catch (err) {
    pool.delete(key);
    throw err;
  }

  conn.active += 1;
  clearTimeout(conn.idleTimer);

  let released = false;
  return {
    sftp: conn.sftp,
    release: () => {
      if (released) return;
      released = true;
      conn.active = Math.max(0, conn.active - 1);
      if (conn.active === 0) scheduleIdleClose(key, conn);
    },
  };
}

/** Drop every pooled connection for a server (e.g. after its credentials change). */
export function evictServer(orgId: string, serverId: string) {
  const prefix = `${orgId}:${serverId}:`;
  for (const [key, pending] of pool) {
    if (!key.startsWith(prefix)) continue;
    pool.delete(key);
    pending.then((conn) => conn.client.end()).catch(() => {});
  }
}

export function poolKey(orgId: string, serverId: string, userId: string) {
  return `${orgId}:${serverId}:${userId}`;
}

// ── Attribute helpers ────────────────────────────────────────────────────────

const S_IFMT = 0o170000;

function entryType(mode: number): SftpEntryType {
  switch (mode & S_IFMT) {
    case 0o040000:
      return 'directory';
    case 0o120000:
      return 'symlink';
    case 0o100000:
      return 'file';
    default:
      return 'other';
  }
}

/** Render the low 9 mode bits as `rwxr-xr-x`. */
function permissionString(mode: number): string {
  const bits = ['r', 'w', 'x'];
  let out = '';
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let i = 0; i < 3; i++) {
      out += (mode >> (shift + (2 - i))) & 1 ? bits[i] : '-';
    }
  }
  return out;
}

function toEntry(name: string, dir: string, attrs: Attributes): SftpEntry {
  const mode = attrs.mode ?? 0;
  return {
    name,
    path: dir === '/' ? `/${name}` : `${dir}/${name}`,
    type: entryType(mode),
    size: attrs.size ?? 0,
    mode,
    permissions: permissionString(mode),
    uid: attrs.uid ?? 0,
    gid: attrs.gid ?? 0,
    // ssh2 reports mtime in seconds since the epoch
    modifiedAt: new Date((attrs.mtime ?? 0) * 1000).toISOString(),
  };
}

// ── Operations ───────────────────────────────────────────────────────────────

export function realpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (err, resolved) => {
      if (err) reject(toSftpError(err, 'Failed to resolve path'));
      else resolve(resolved);
    });
  });
}

export function stat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, attrs) => {
      if (err) reject(toSftpError(err, 'Failed to stat path'));
      else resolve(attrs);
    });
  });
}

export async function list(sftp: SFTPWrapper, path: string): Promise<SftpEntry[]> {
  const files = await new Promise<FileEntry[]>((resolve, reject) => {
    sftp.readdir(path, (err, entries) => {
      if (err) reject(toSftpError(err, 'Failed to list directory'));
      else resolve(entries);
    });
  });

  return files
    .filter((f) => f.filename !== '.' && f.filename !== '..')
    .map((f) => toEntry(f.filename, path, f.attrs))
    .sort((a, b) => {
      // Directories first, then case-insensitive by name
      const aDir = a.type === 'directory' ? 0 : 1;
      const bDir = b.type === 'directory' ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

export function mkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      if (err) reject(toSftpError(err, 'Failed to create directory'));
      else resolve();
    });
  });
}

export function rename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => {
      if (err) reject(toSftpError(err, 'Failed to rename'));
      else resolve();
    });
  });
}

export function unlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => {
      if (err) reject(toSftpError(err, 'Failed to delete file'));
      else resolve();
    });
  });
}

export function rmdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => {
      if (err) reject(toSftpError(err, 'Failed to delete directory'));
      else resolve();
    });
  });
}

/** Depth-first recursive delete. Used only when the caller opts in. */
export async function removeRecursive(sftp: SFTPWrapper, path: string): Promise<void> {
  const attrs = await stat(sftp, path);
  if (!attrs.isDirectory()) {
    await unlink(sftp, path);
    return;
  }
  for (const entry of await list(sftp, path)) {
    if (entry.type === 'directory') await removeRecursive(sftp, entry.path);
    else await unlink(sftp, entry.path);
  }
  await rmdir(sftp, path);
}

/** Read a whole file into memory, refusing anything past `maxBytes`. */
export function readFile(sftp: SFTPWrapper, path: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createReadStream(path);
    const chunks: Buffer[] = [];
    let total = 0;

    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(new SftpError(`File is larger than ${maxBytes} bytes`, 413));
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', (err: unknown) => reject(toSftpError(err, 'Failed to read file')));
  });
}

export function createReadStream(sftp: SFTPWrapper, path: string): Readable {
  return sftp.createReadStream(path);
}

export function createWriteStream(sftp: SFTPWrapper, path: string): Writable {
  return sftp.createWriteStream(path);
}
