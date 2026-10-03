import { and, eq } from 'drizzle-orm';
import { Client } from 'ssh2';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import logger from '../logger.js';
import { resolveServerAuth } from '../ssh/credentials.js';
import { HostKeyMismatchError, sshConnectConfig } from '../ssh/host-keys.js';
import { connectSsh } from '../ssh/jump.js';
import { KubeError } from './errors.js';

/**
 * SSH connections to the managed servers clusters are reached through
 * (`connect_via = 'server'`): the API server's port is opened with
 * `forwardOut` on one of these (kube/transport.ts). Each is opened through
 * `sshConnectConfig` + `connectSsh` — host key checks, jump hosts and agents
 * included — with the server's own stored credential.
 *
 * Unlike Docker's pool these are per (org, server), not per user: the server
 * is infrastructure an admin chose for the cluster, the watch cache serving
 * every viewer runs over it, and per-cluster access decides who may use it.
 * A connection closes {@link IDLE_TIMEOUT_MS} after its last lease; editing
 * the server, a host key change or deleting it evicts it at once.
 */

export const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000;

interface PooledSsh {
  client: Client;
  active: number;
  idleTimer?: NodeJS.Timeout;
  entry?: Promise<PooledSsh>;
}

export interface SshLease {
  client: Client;
  /** Call exactly once, when the API connection over it has closed. */
  release: () => void;
}

const pool = new Map<string, Promise<PooledSsh>>();

const keyOf = (orgId: string, serverId: string) => `${orgId}:${serverId}`;

function endQuietly(conn: PooledSsh) {
  clearTimeout(conn.idleTimer);
  try {
    conn.client.end();
  } catch {
    // already torn down
  }
}

function forget(key: string, conn: PooledSsh) {
  if (conn.entry && pool.get(key) === conn.entry) pool.delete(key);
}

function scheduleIdleClose(key: string, conn: PooledSsh) {
  clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => {
    if (conn.active > 0) return;
    forget(key, conn);
    endQuietly(conn);
  }, IDLE_TIMEOUT_MS);
  conn.idleTimer.unref?.();
}

async function openConnection(key: string, orgId: string, serverId: string, actorUserId?: string): Promise<PooledSsh> {
  const server = getDb()
    .select()
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.orgId, orgId)))
    .get();
  if (!server) throw new KubeError('The server this cluster is reached through no longer exists; pick another route', 400);
  const { auth } = await resolveServerAuth(orgId, server.id);
  if (!auth.privateKey && !auth.password) throw new KubeError(`${server.name} has no SSH credential to connect with`, 400);
  const target = { id: server.id, host: server.host, port: server.port, username: server.username };

  const client = new Client();
  const conn: PooledSsh = { client, active: 0 };
  conn.entry = new Promise<PooledSsh>((resolve, reject) => {
    const { config, guard } = sshConnectConfig(target, auth, 'kube', { readyTimeout: CONNECT_TIMEOUT_MS });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      forget(key, conn);
      client.end();
      reject(new KubeError(`SSH connection to ${server.name} timed out`, 504));
    }, CONNECT_TIMEOUT_MS + 1_000);

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
          logger.warn({ err: cause, serverId }, 'Kubernetes tunnel SSH connection error');
          return;
        }
        settled = true;
        clearTimeout(timer);
        forget(key, conn);
        if (cause instanceof HostKeyMismatchError) return reject(cause);
        if (typeof (cause as { statusCode?: unknown }).statusCode === 'number') return reject(cause);
        reject(new KubeError(`SSH connection to ${server.name} failed: ${cause.message}`, 502));
      })
      .on('close', () => {
        clearTimeout(timer);
        clearTimeout(conn.idleTimer);
        forget(key, conn);
        if (!settled) {
          settled = true;
          reject(new KubeError(`SSH connection to ${server.name} closed before it was ready`, 502));
        }
      });
    connectSsh(client, target, config, 'kube', { actorUserId });
  });
  return conn.entry;
}

/** A pooled SSH connection to `serverId`, opened if needed. The caller must `release()` it. */
export async function acquireServerSsh(orgId: string, serverId: string, actorUserId?: string): Promise<SshLease> {
  const key = keyOf(orgId, serverId);
  let pending = pool.get(key);
  if (!pending) {
    pending = openConnection(key, orgId, serverId, actorUserId);
    pool.set(key, pending);
  }
  let conn: PooledSsh;
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
      if (conn.active === 0 && pool.get(key) === conn.entry) scheduleIdleClose(key, conn);
    },
  };
}

/** Close the pooled connection to a server (edited, deleted, host key changed). */
export function evictKubeServer(orgId: string, serverId: string): number {
  const key = keyOf(orgId, serverId);
  const pending = pool.get(key);
  if (!pending) return 0;
  pool.delete(key);
  pending.then(endQuietly, () => {});
  return 1;
}

/** Open pooled connections (tests). */
export function kubeSshConnectionCount(): number {
  return pool.size;
}
