import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { ftpConnections } from '../db/schema.js';
import { vault } from '../vault/index.js';
import logger from '../logger.js';
import { FtpError, toFtpError } from './errors.js';
import type { FileBackend, FileSession, FtpConnectionRow } from './backend.js';
import { ftpBackend } from './ftp-backend.js';
import { sftpBackend } from './sftp-backend.js';

export * from './errors.js';
export * from './paths.js';
export * as ops from './ops.js';
export { toTarget } from './ftp-backend.js';
export type { FileBackend, FileSession, FtpConnectionRow } from './backend.js';

/** SFTP goes through ssh2; every other protocol is basic-ftp. */
export function backendFor(protocol: string): FileBackend {
  return protocol === 'sftp' ? sftpBackend : ftpBackend;
}

/** Close a pooled connection after this long with nothing in flight. */
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * An FTP control connection runs one command at a time, so each pooled session
 * carries a promise chain that serializes the operations queued against it.
 * SFTP sessions go through the same queue: one user rarely has two requests in
 * flight, and it keeps the lifecycle identical for both backends.
 * Pools are keyed per user so a channel is never shared across people, and
 * `updatedAt` is part of the check so editing a connection reconnects.
 */
interface Slot {
  updatedAt: string;
  queue: Promise<unknown>;
  session?: FileSession;
  idleTimer?: NodeJS.Timeout;
}

const pool = new Map<string, Slot>();

export function poolKey(orgId: string, connectionId: string, userId: string): string {
  return `${orgId}:${connectionId}:${userId}`;
}

function closeSlot(slot: Slot): void {
  clearTimeout(slot.idleTimer);
  slot.session?.close();
  slot.session = undefined;
}

function scheduleIdleClose(key: string, slot: Slot): void {
  clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    if (pool.get(key) === slot) pool.delete(key);
    closeSlot(slot);
  }, IDLE_TIMEOUT_MS);
  slot.idleTimer.unref?.();
}

/** Drop every pooled client for a connection (after an edit, delete, or a broken session). */
export function evictConnection(connectionId: string): void {
  for (const [key, slot] of pool) {
    if (key.split(':')[1] !== connectionId) continue;
    pool.delete(key);
    closeSlot(slot);
  }
}

/** Load a connection scoped to the caller's org. */
export function loadConnection(orgId: string, id: string): FtpConnectionRow {
  const connection = getDb()
    .select()
    .from(ftpConnections)
    .where(and(eq(ftpConnections.id, id), eq(ftpConnections.orgId, orgId)))
    .get();
  if (!connection) throw new FtpError('FTP connection not found', 404);
  return connection;
}

export async function decryptPassword(connection: FtpConnectionRow): Promise<string> {
  return vault.decrypt(connection.encryptedPassword, connection.id);
}

/**
 * Run `fn` against a logged-in session for this user and connection, opening
 * one if needed and waiting for any operation already queued on it. A failure
 * that is not a plain server refusal (a dropped socket, a timeout, an aborted
 * transfer) leaves the connection in an unknown state, so the session is
 * closed and the next call reconnects.
 */
export async function withSession<T>(
  orgId: string,
  connectionId: string,
  userId: string,
  fn: (session: FileSession, connection: FtpConnectionRow) => Promise<T>,
): Promise<T> {
  const connection = loadConnection(orgId, connectionId);
  const key = poolKey(orgId, connectionId, userId);

  let slot = pool.get(key);
  if (slot && slot.updatedAt !== connection.updatedAt) {
    pool.delete(key);
    closeSlot(slot);
    slot = undefined;
  }
  if (!slot) {
    slot = { updatedAt: connection.updatedAt, queue: Promise.resolve() };
    pool.set(key, slot);
  }
  const current = slot;

  const task = async (): Promise<T> => {
    clearTimeout(current.idleTimer);
    try {
      if (!current.session || current.session.closed) {
        // Release whatever is left of a session the server dropped
        current.session?.close();
        current.session = undefined;
        current.session = await backendFor(connection.protocol).open(
          connection,
          await decryptPassword(connection),
        );
      }
      const session = current.session;
      try {
        return await fn(session, connection);
      } catch (err) {
        if (!session.survives(err)) {
          logger.warn(
            { err, host: connection.host, protocol: connection.protocol },
            'FTP session dropped; reconnecting next time',
          );
          closeSlot(current);
        }
        throw toFtpError(err);
      }
    } finally {
      // An edit or delete may have evicted this slot while the session was
      // still opening; nothing would ever close it after that.
      if (pool.get(key) === current) scheduleIdleClose(key, current);
      else closeSlot(current);
    }
  };

  // Queue behind whatever is already running, whether or not it succeeded
  const result = current.queue.then(task, task);
  current.queue = result.catch(() => {});
  return result;
}
