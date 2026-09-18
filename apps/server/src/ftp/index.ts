import { and, eq } from 'drizzle-orm';
import type { Client } from 'basic-ftp';
import type { FtpProtocol } from '@smt/shared';
import { getDb } from '../db/index.js';
import { ftpConnections } from '../db/schema.js';
import { vault } from '../vault/index.js';
import logger from '../logger.js';
import { openClient, type FtpTarget } from './client.js';
import { FtpError, isReplyError, toFtpError } from './errors.js';

export * from './errors.js';
export * from './paths.js';
export * as ops from './ops.js';

export type FtpConnectionRow = typeof ftpConnections.$inferSelect;

/** Close a pooled connection after this long with nothing in flight. */
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * An FTP control connection runs one command at a time, so each pooled client
 * carries a promise chain that serializes the operations queued against it.
 * Pools are keyed per user so a channel is never shared across people, and
 * `updatedAt` is part of the check so editing a connection reconnects.
 */
interface Slot {
  updatedAt: string;
  queue: Promise<unknown>;
  client?: Client;
  idleTimer?: NodeJS.Timeout;
}

const pool = new Map<string, Slot>();

export function poolKey(orgId: string, connectionId: string, userId: string): string {
  return `${orgId}:${connectionId}:${userId}`;
}

function closeSlot(slot: Slot): void {
  clearTimeout(slot.idleTimer);
  slot.client?.close();
  slot.client = undefined;
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

export function toTarget(connection: FtpConnectionRow): FtpTarget {
  return {
    host: connection.host,
    port: connection.port,
    protocol: connection.protocol as FtpProtocol,
    username: connection.username,
    verifyTls: connection.verifyTls,
  };
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
 * Run `fn` against a logged-in client for this user and connection, opening
 * one if needed and waiting for any operation already queued on it. A failure
 * that is not a plain FTP reply (a dropped socket, a timeout, an aborted
 * transfer) leaves the control connection in an unknown state, so the client
 * is closed and the next call reconnects.
 */
export async function withClient<T>(
  orgId: string,
  connectionId: string,
  userId: string,
  fn: (client: Client, connection: FtpConnectionRow) => Promise<T>,
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
      if (!current.client || current.client.closed) {
        current.client = await openClient(toTarget(connection), await decryptPassword(connection));
      }
      try {
        return await fn(current.client, connection);
      } catch (err) {
        if (!isReplyError(err)) {
          logger.warn(
            { err, host: connection.host },
            'FTP session dropped; reconnecting next time',
          );
          closeSlot(current);
        }
        throw toFtpError(err);
      }
    } finally {
      if (pool.get(key) === current) scheduleIdleClose(key, current);
    }
  };

  // Queue behind whatever is already running, whether or not it succeeded
  const result = current.queue.then(task, task);
  current.queue = result.catch(() => {});
  return result;
}
