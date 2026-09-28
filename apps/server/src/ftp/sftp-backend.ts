import { Client } from 'ssh2';
import type { Attributes, FileEntry, SFTPWrapper } from 'ssh2';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable, type Writable } from 'node:stream';
import type { FtpEntry, FtpEntryType, FtpTestResult } from '@smt/shared';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { HostKeyMismatchError, sshConnectConfig } from '../ssh/host-keys.js';
import { FtpError } from './errors.js';
import { ftpHostKeyStore } from './host-keys.js';
import { MAX_RESOLVED_LINKS, sortEntries } from './ops.js';
import { baseName, joinPath, normalizeRemotePath } from './paths.js';
import type { FileBackend, FileCredentials, FileSession, FtpConnectionRow } from './backend.js';

/**
 * SFTP file connections over ssh2. Only the `sftp` subsystem is ever opened —
 * never exec or a shell — so SFTP-only accounts (ForceCommand internal-sftp,
 * chrooted) work. Password auth, answered over keyboard-interactive too, since
 * some servers only offer that (one hidden password prompt only; see
 * keyboardAnswers), or public key auth with an org SSH key. The host key is
 * checked against the one pinned on the connection row (trust on first use,
 * refuse on mismatch).
 *
 * Every request is bounded by SMT_SFTP_OP_TIMEOUT_MS, and a transfer by the
 * same timeout between chunks. A server that stops answering gets a 504 and
 * the session is closed, so the next call reconnects instead of queueing
 * behind a request that will never finish.
 */

/** Handshake plus authentication must finish within this. */
export const READY_TIMEOUT_MS = 20_000;
/** Opening the SFTP subsystem after login gets a little longer on top. */
const SUBSYSTEM_TIMEOUT_MS = 10_000;
/** A keepalive every 15s; three unanswered ones and the connection is dropped. */
export const KEEPALIVE_INTERVAL_MS = 15_000;
export const KEEPALIVE_COUNT_MAX = 3;
/** A recursive delete refuses a tree deeper or bigger than this before removing anything. */
export const MAX_DELETE_DEPTH = 64;
export const MAX_DELETE_ENTRIES = 10_000;

// ── Errors ───────────────────────────────────────────────────────────────────

/** SFTP v3 status codes (draft-ietf-secsh-filexfer-02 §7). */
const STATUS = {
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

interface ErrorLike {
  code?: unknown;
  level?: unknown;
  message?: string;
}

function statusCodeOf(err: unknown): number | undefined {
  const code = (err && typeof err === 'object' ? (err as ErrorLike).code : undefined);
  return typeof code === 'number' ? code : undefined;
}

/**
 * Map an SFTP status onto the statuses the FTP path uses: a missing path is a
 * 404, a refusal a 403, and FAILURE — SFTP's catch-all for "directory not
 * empty", "file exists" and the like — a 400, like a permanent FTP 5xx reply.
 */
function statusForSftp(code: number): number {
  switch (code) {
    case STATUS.NO_SUCH_FILE:
      return 404;
    case STATUS.PERMISSION_DENIED:
      return 403;
    case STATUS.FAILURE:
    case STATUS.OP_UNSUPPORTED:
      return 400;
    default:
      return 502;
  }
}

const STATUS_TEXT: Record<number, string> = {
  [STATUS.NO_SUCH_FILE]: 'No such file or directory',
  [STATUS.PERMISSION_DENIED]: 'Permission denied',
  [STATUS.FAILURE]: 'The server refused the operation',
  [STATUS.OP_UNSUPPORTED]: 'The server does not support this operation',
};

/** Turn whatever ssh2 threw during an operation into an FtpError. */
export function toSftpError(err: unknown, fallback = 'SFTP request failed'): FtpError {
  if (err instanceof FtpError) return err;
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  const code = statusCodeOf(err);
  if (code !== undefined) {
    const detail = e.message?.trim() || STATUS_TEXT[code] || `status ${code}`;
    return new FtpError(`${fallback}: ${detail}`, statusForSftp(code));
  }
  const message = e.message?.trim() || fallback;
  if (typeof e.code === 'string' && e.code === 'ETIMEDOUT') {
    return new FtpError(`SFTP request timed out: ${message}`, 504);
  }
  return new FtpError(`SFTP connection lost: ${message}`, 502);
}

/** Map a failure to connect or log in. A refused host key passes through untouched. */
export function toSftpConnectError(err: unknown): Error {
  if (err instanceof HostKeyMismatchError || err instanceof FtpError) return err;
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  const message = e.message?.trim() || 'unknown error';
  // 403, not 401: a 401 from the API means the app session is gone
  if (e.level === 'client-authentication') {
    return new FtpError('Authentication failed: the server rejected the username, password or key', 403);
  }
  if (e.level === 'client-timeout' || e.code === 'ETIMEDOUT' || /timed out/i.test(message)) {
    return new FtpError(`SFTP connection timed out: ${message}`, 504);
  }
  if (typeof e.code === 'string') return new FtpError(`Could not reach SFTP server: ${message}`, 502);
  return new FtpError(`Could not connect to SFTP server: ${message}`, 502);
}

// ── Listing ──────────────────────────────────────────────────────────────────

const S_IFMT = 0o170000;

function entryType(mode: number | undefined): FtpEntryType {
  switch ((mode ?? 0) & S_IFMT) {
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
export function sftpPermissionString(mode: number | undefined): string | null {
  if (mode === undefined) return null;
  const bits = ['r', 'w', 'x'];
  let out = '';
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let i = 0; i < 3; i++) out += (mode >> (shift + 2 - i)) & 1 ? bits[i] : '-';
  }
  return out;
}

/** Shape one readdir/lstat row into what the browser renders. Pure. */
export function toSftpEntry(dir: string, name: string, attrs: Partial<Attributes>): FtpEntry {
  return {
    name,
    path: joinPath(dir, name),
    type: entryType(attrs.mode),
    size: attrs.size ?? 0,
    permissions: sftpPermissionString(attrs.mode),
    // ssh2 reports mtime in seconds since the epoch
    modifiedAt: typeof attrs.mtime === 'number' ? new Date(attrs.mtime * 1000).toISOString() : null,
    rawModifiedAt: '',
    link: null,
    targetType: null,
  };
}

// ── ssh2 callbacks as promises ───────────────────────────────────────────────

function call<T>(
  fallback: string,
  fn: (cb: (err: Error | null | undefined, value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      fn((err, value) => (err ? reject(toSftpError(err, fallback)) : resolve(value)));
    } catch (err) {
      reject(toSftpError(err, fallback));
    }
  });
}

/**
 * Routes normalize every path before it gets here; refuse anything else
 * outright rather than hand the server a relative or `..` path.
 */
function checked(path: string): string {
  if (normalizeRemotePath(path) !== path) throw new FtpError('Path must be normalized', 400);
  return path;
}

// ── Session ──────────────────────────────────────────────────────────────────

export interface SftpFileSession extends FileSession {
  /** Canonical absolute form of `path`, as the server resolves it. */
  realpath(path: string): Promise<string>;
}

export interface SftpSessionOptions {
  /** Longest one request, or the gap between two chunks of a transfer, may take. */
  opTimeoutMs?: number;
}

export function sftpSession(
  client: Client,
  sftp: SFTPWrapper,
  options: SftpSessionOptions = {},
): SftpFileSession {
  const opTimeoutMs = options.opTimeoutMs ?? config.sftpOpTimeoutMs;
  let closed = false;
  const markClosed = () => {
    closed = true;
  };

  /**
   * A request that outlives the timeout means the server (or the path to it)
   * has stalled. One SFTP request cannot be cancelled, so the whole session
   * goes: anything queued after it would only wait behind it.
   */
  const timedOut = (what: string) => {
    markClosed();
    client.end();
    return new FtpError(`SFTP ${what} timed out after ${opTimeoutMs}ms; the session was closed`, 504);
  };

  function bounded<T>(
    fallback: string,
    fn: (cb: (err: Error | null | undefined, value: T) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(timedOut('request')), opTimeoutMs);
      timer.unref?.();
      call(fallback, fn).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Run a transfer, failing it once no chunk has moved for the operation
   * timeout — whichever side stalled: a server that stops sending, or a
   * browser that stops reading or uploading. The clock keeps running after the
   * last chunk until the far side has taken it all, so a small upload whose
   * open never returns, or a download the browser stops reading near its end,
   * still times out. The race does not rely on the streams noticing: an ssh2
   * stream waiting on an unanswered open never finishes being destroyed.
   */
  async function transfer(source: Readable, destination: Writable): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let fail!: (err: FtpError) => void;
    const stalled = new Promise<never>((_resolve, reject) => (fail = reject));
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const err = timedOut('transfer');
        fail(err);
        source.destroy(err);
        destination.destroy(err);
      }, opTimeoutMs);
      timer.unref?.();
    };
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        arm();
        callback(null, chunk);
      },
    });
    arm();
    try {
      await Promise.race([pipeline(source, meter, destination), stalled]);
    } finally {
      clearTimeout(timer);
    }
  }
  client.on('close', markClosed);
  client.on('end', markClosed);
  // The pool closes a broken session; this only keeps the error from being unhandled
  client.on('error', (err: Error) => {
    markClosed();
    logger.warn({ err }, 'SFTP connection error');
  });
  sftp.on('close', () => {
    markClosed();
    client.end();
  });

  const readdir = (dir: string) =>
    bounded<FileEntry[]>('Could not list directory', (cb) => sftp.readdir(dir, cb));
  const lstat = (path: string) =>
    bounded<Attributes>('Could not read file details', (cb) => sftp.lstat(path, cb));
  const stat = (path: string) =>
    bounded<Attributes>('Could not read file details', (cb) => sftp.stat(path, cb));
  const readlink = (path: string) =>
    bounded<string>('Could not read link', (cb) => sftp.readlink(path, cb));
  const unlink = (path: string) =>
    bounded<void>('Could not delete file', (cb) => sftp.unlink(path, cb));
  const rmdir = (path: string) =>
    bounded<void>('Could not delete directory', (cb) => sftp.rmdir(path, cb));
  const realpath = (path: string) =>
    bounded<string>('Could not resolve path', (cb) => sftp.realpath(path, cb));

  /**
   * Fill in where each link points and whether that is a directory. readdir
   * describes links themselves (lstat); stat follows them. Capped like the FTP
   * path so a folder full of links cannot stall the listing.
   */
  async function resolveLinks(entries: FtpEntry[]): Promise<void> {
    const links = entries.filter((e) => e.type === 'symlink').slice(0, MAX_RESOLVED_LINKS);
    await Promise.all(
      links.map(async (link) => {
        try {
          link.link = await readlink(link.path);
        } catch (err) {
          if (!(err instanceof FtpError) || err.statusCode >= 500) throw err;
        }
        try {
          link.targetType = entryType((await stat(link.path)).mode) === 'directory' ? 'directory' : 'file';
        } catch (err) {
          if (!(err instanceof FtpError) || err.statusCode >= 500) throw err;
          // A dangling link counts as a file; a refusal says nothing about the target
          if (err.statusCode === 404) link.targetType = 'file';
        }
      }),
    );
  }

  async function list(dir: string): Promise<FtpEntry[]> {
    const rows = await readdir(checked(dir));
    const entries = sortEntries(
      rows
        .filter((f) => f.filename !== '.' && f.filename !== '..')
        .map((f) => toSftpEntry(dir, f.filename, f.attrs)),
    );
    await resolveLinks(entries);
    return entries;
  }

  /**
   * Walk the whole tree first and return the removals depth-first (children
   * before their directory). Nothing is deleted until the walk has stayed
   * within MAX_DELETE_DEPTH and MAX_DELETE_ENTRIES, so an oversized tree is
   * refused whole rather than left half-deleted.
   */
  async function planRemoval(root: string): Promise<{ path: string; dir: boolean }[]> {
    const plan: { path: string; dir: boolean }[] = [];
    let entries = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DELETE_DEPTH) {
        throw new FtpError(
          `Refusing to delete: the tree is more than ${MAX_DELETE_DEPTH} levels deep`,
          400,
        );
      }
      for (const row of await readdir(dir)) {
        if (row.filename === '.' || row.filename === '..') continue;
        if (++entries > MAX_DELETE_ENTRIES) {
          throw new FtpError(
            `Refusing to delete: the tree has more than ${MAX_DELETE_ENTRIES} entries`,
            400,
          );
        }
        const child = joinPath(dir, row.filename);
        // readdir rows carry lstat attributes, so a link to a directory is a link here
        const type = entryType(row.attrs.mode ?? (await lstat(child)).mode);
        if (type === 'directory') await walk(child, depth + 1);
        else plan.push({ path: child, dir: false });
      }
      plan.push({ path: dir, dir: true });
    };
    await walk(root, 1);
    return plan;
  }

  async function removeTree(path: string): Promise<void> {
    for (const step of await planRemoval(path)) {
      if (step.dir) await rmdir(step.path);
      else await unlink(step.path);
    }
  }

  return {
    get closed() {
      return closed;
    },
    close() {
      markClosed();
      client.end();
    },
    // SFTP requests are independent; a refused one leaves the channel healthy
    survives: () => !closed,
    realpath,

    async home(rootPath) {
      if (rootPath) return normalizeRemotePath(rootPath);
      const cwd = await realpath('.');
      return normalizeRemotePath(cwd.startsWith('/') ? cwd : `/${cwd}`);
    },

    list,

    async stat(path) {
      checked(path);
      const attrs = await lstat(path);
      const entry = toSftpEntry(path, baseName(path) || '/', attrs);
      entry.path = path;
      if (entry.type === 'symlink') {
        entry.link = await readlink(path).catch(() => null);
      }
      return entry;
    },

    async linkTargetSize(path) {
      let attrs: Attributes;
      try {
        attrs = await stat(checked(path));
      } catch (err) {
        if (err instanceof FtpError && err.statusCode === 404) {
          throw new FtpError('Link does not point to a downloadable file', 400);
        }
        throw err;
      }
      if (entryType(attrs.mode) !== 'file') {
        throw new FtpError('Link does not point to a downloadable file', 400);
      }
      return attrs.size ?? 0;
    },

    async download(path, destination: Writable) {
      try {
        await transfer(sftp.createReadStream(checked(path)), destination);
      } catch (err) {
        throw toSftpError(err, 'Could not download file');
      }
    },

    async upload(source: Readable, path) {
      try {
        await transfer(source, sftp.createWriteStream(checked(path)));
      } catch (err) {
        throw toSftpError(err, 'Could not upload file');
      }
    },

    mkdir: (path) =>
      bounded<void>('Could not create directory', (cb) => sftp.mkdir(checked(path), cb)),
    rename: (from, to) =>
      bounded<void>('Could not rename', (cb) => sftp.rename(checked(from), checked(to), cb)),
    // unlink never follows a link, so a link is removed rather than its target
    removeFile: async (path) => unlink(checked(path)),
    removeEmptyDir: async (path) => rmdir(checked(path)),

    async removeDirRecursive(path) {
      const attrs = await lstat(checked(path));
      if (entryType(attrs.mode) !== 'directory') await unlink(path);
      else await removeTree(path);
    },
  };
}

// ── Connecting ───────────────────────────────────────────────────────────────

/** Prompts that ask for a second factor, never the account password. */
const SECOND_FACTOR_PROMPT = /code|otp|token|verification|one[- ]?time|2fa|authenticator/i;

/**
 * Answers for one keyboard-interactive round. The password only goes to a
 * single hidden prompt that is not asking for a one-time code, and only once
 * per connection: a server that asks again, asks several questions, or wants
 * an OTP gets blank answers (which fail the login) rather than the password
 * typed into the wrong field.
 */
export function keyboardAnswers(
  prompts: readonly { prompt: string; echo?: boolean }[],
  password: string,
  passwordSent: boolean,
): string[] {
  const decline = prompts.map(() => '');
  const only = prompts.length === 1 ? prompts[0] : undefined;
  if (!only || passwordSent) return decline;
  if (only.echo || SECOND_FACTOR_PROMPT.test(only.prompt)) return decline;
  return [password];
}

export interface SftpOpenOptions extends SftpSessionOptions {
  readyTimeoutMs?: number;
}

/**
 * Connect, verify the host key, log in and open the SFTP subsystem. With a
 * private key only public key auth is offered: there is no password to send,
 * so keyboard-interactive stays off.
 */
export function openSftp(
  connection: FtpConnectionRow,
  credentials: FileCredentials,
  options: SftpOpenOptions = {},
): Promise<SftpFileSession> {
  const readyTimeout = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const password = credentials.privateKey ? undefined : credentials.password;
  return new Promise((resolve, reject) => {
    const client = new Client();
    const { config: connectConfig, guard } = sshConnectConfig(
      {
        id: connection.id,
        host: connection.host,
        port: connection.port,
        username: connection.username,
      },
      credentials.privateKey ? { privateKey: credentials.privateKey } : { password },
      'sftp',
      {
        readyTimeout,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        tryKeyboard: password !== undefined,
      },
      ftpHostKeyStore,
    );

    let settled = false;
    // keyboard-interactive gets the password at most once
    let passwordSent = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      reject(err);
    };

    // Backstop for a server that authenticates but never answers the subsystem request
    const timer = setTimeout(() => {
      fail(new FtpError(`SFTP connection timed out after ${readyTimeout + SUBSYSTEM_TIMEOUT_MS}ms`, 504));
    }, readyTimeout + SUBSYSTEM_TIMEOUT_MS);
    timer.unref?.();

    client
      .on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        if (password === undefined) {
          finish(prompts.map(() => ''));
          return;
        }
        const answers = keyboardAnswers(prompts, password, passwordSent);
        if (answers.includes(password)) passwordSent = true;
        finish(answers);
      })
      .on('ready', () => {
        client.sftp((err, sftp) => {
          if (settled) {
            client.end();
            return;
          }
          if (err) {
            fail(new FtpError(`The server did not open an SFTP session: ${err.message}`, 502));
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(sftpSession(client, sftp, options));
        });
      })
      .on('error', (err: Error) => fail(toSftpConnectError(guard.error(err))))
      .on('close', () => fail(new FtpError('SFTP connection closed before login finished', 502)));

    try {
      client.connect(connectConfig);
    } catch (err) {
      fail(toSftpConnectError(err));
    }
  });
}

/**
 * Log in, resolve the root (or the login directory) and count what is in it.
 * A changed host key is thrown rather than reported, so the route can answer
 * with the same 409 every other SFTP request gives.
 */
export async function testSftpConnection(
  connection: FtpConnectionRow,
  credentials: FileCredentials,
): Promise<FtpTestResult> {
  let session: SftpFileSession | undefined;
  try {
    session = await openSftp(connection, credentials);
    const resolved = await session.realpath(connection.rootPath ?? '.');
    const workingDirectory = normalizeRemotePath(resolved.startsWith('/') ? resolved : `/${resolved}`);
    const entries = await session.list(workingDirectory);
    return { ok: true, workingDirectory, entryCount: entries.length };
  } catch (err) {
    if (err instanceof HostKeyMismatchError) throw err;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.close();
  }
}

export const sftpBackend: FileBackend = {
  open: (connection, credentials) => openSftp(connection, credentials),
  testConnection: testSftpConnection,
};
