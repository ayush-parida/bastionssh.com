import { Client } from 'ssh2';
import logger from '../logger.js';
import { HostKeyMismatchError, sshConnectConfig, type SshAuth, type SshTarget } from '../ssh/host-keys.js';
import { connectSsh } from '../ssh/jump.js';
import { DockerError } from './errors.js';

/**
 * SSH connections used for Docker, pooled per (org, server, user) like SFTP
 * and never shared across users. Each is opened through `sshConnectConfig` +
 * `connectSsh` — host key checks, jump hosts and agents included — and
 * carries any number of daemon streams (docker/transport.ts) at once.
 *
 * A connection closes after {@link IDLE_TIMEOUT_MS} with no lease out.
 * Revoking a user's access (auth/revoke.ts), editing or deleting the server,
 * or a host key change evicts it at once; every stream on it ends with it.
 */

export const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000;

interface PooledConnection {
  client: Client;
  /** Leases out (requests and open streams); the idle timer only runs at 0. */
  active: number;
  idleTimer?: NodeJS.Timeout;
}

export interface DockerLease {
  client: Client;
  /** Call exactly once, when the request or stream is done. */
  release: () => void;
}

const pool = new Map<string, Promise<PooledConnection>>();

export function poolKey(orgId: string, serverId: string, userId: string) {
  return `${orgId}:${serverId}:${userId}`;
}

function endQuietly(conn: PooledConnection) {
  clearTimeout(conn.idleTimer);
  try {
    conn.client.end();
  } catch {
    // already torn down
  }
}

function scheduleIdleClose(key: string, conn: PooledConnection) {
  clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => {
    if (conn.active > 0) return; // the last release reschedules
    if (pool.get(key) !== undefined) pool.delete(key);
    endQuietly(conn);
  }, IDLE_TIMEOUT_MS);
  conn.idleTimer.unref?.();
}

function openConnection(key: string, target: SshTarget, auth: SshAuth, actorUserId?: string): Promise<PooledConnection> {
  return new Promise<PooledConnection>((resolve, reject) => {
    const client = new Client();
    const { config, guard } = sshConnectConfig(target, auth, 'docker', { readyTimeout: CONNECT_TIMEOUT_MS });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pool.delete(key);
      client.end();
      reject(new DockerError('SSH connection for Docker timed out', 504));
    }, CONNECT_TIMEOUT_MS + 1_000);

    const conn: PooledConnection = { client, active: 0 };
    client
      .on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        scheduleIdleClose(key, conn);
        resolve(conn);
      })
      .on('error', (err: Error) => {
        const cause = guard.error(err);
        if (settled) {
          logger.warn({ err: cause, serverId: target.id }, 'Docker SSH connection error');
          return;
        }
        settled = true;
        clearTimeout(timer);
        pool.delete(key);
        if (cause instanceof HostKeyMismatchError) return reject(cause);
        // A jump host failure already says where the route broke
        if (typeof (cause as { statusCode?: unknown }).statusCode === 'number') return reject(cause);
        reject(new DockerError(`SSH connection failed: ${cause.message}`, 502));
      })
      .on('close', () => {
        clearTimeout(timer);
        clearTimeout(conn.idleTimer);
        // Only forget this connection, not a newer one opened under the same key
        void pool.get(key)?.then(
          (current) => {
            if (current === conn) pool.delete(key);
          },
          () => {},
        );
        if (!settled) {
          settled = true;
          pool.delete(key);
          reject(new DockerError('SSH connection closed before it was ready', 502));
        }
      });
    connectSsh(client, target, config, 'docker', { actorUserId });
  });
}

/**
 * A pooled SSH connection for this user and server, opened if needed. The
 * caller owns the lease and must `release()` it.
 */
export async function acquire(
  key: string,
  target: SshTarget,
  auth: SshAuth,
  /** A jump hop on a fresh connection is audited under them. */
  actorUserId?: string,
): Promise<DockerLease> {
  if (!auth.privateKey && !auth.password) throw new DockerError('No authentication method available', 400);

  let pending = pool.get(key);
  if (!pending) {
    pending = openConnection(key, target, auth, actorUserId);
    pool.set(key, pending);
  }

  let conn: PooledConnection;
  try {
    conn = await pending;
  } catch (err) {
    if (pool.get(key) === pending) pool.delete(key);
    throw err;
  }

  conn.active += 1;
  clearTimeout(conn.idleTimer);
  let released = false;
  return {
    client: conn.client,
    release: () => {
      if (released) return;
      released = true;
      conn.active = Math.max(0, conn.active - 1);
      if (conn.active === 0) scheduleIdleClose(key, conn);
    },
  };
}

function evict(key: string, pending: Promise<PooledConnection>) {
  pool.delete(key);
  pending.then(endQuietly, () => {});
}

/** Drop every pooled connection to a server (edited, deleted, host key changed). */
export function evictServer(orgId: string, serverId: string): number {
  const prefix = `${orgId}:${serverId}:`;
  let closed = 0;
  for (const [key, pending] of [...pool]) {
    if (!key.startsWith(prefix)) continue;
    evict(key, pending);
    closed++;
  }
  return closed;
}

/**
 * Drop a user's pooled connections after their access is revoked — in one org
 * when `orgId` is given, keeping servers in `keepServerIds`. Returns how many
 * closed.
 */
export function evictUser(userId: string, scope: { orgId?: string; keepServerIds?: Iterable<string> } = {}): number {
  const keep = new Set(scope.keepServerIds ?? []);
  let closed = 0;
  for (const [key, pending] of [...pool]) {
    const [orgId, serverId, owner] = key.split(':');
    if (owner !== userId) continue;
    if (scope.orgId && orgId !== scope.orgId) continue;
    if (serverId && keep.has(serverId)) continue;
    evict(key, pending);
    closed++;
  }
  return closed;
}

/** Open pooled connections (tests and diagnostics). */
export function pooledConnectionCount(): number {
  return pool.size;
}
