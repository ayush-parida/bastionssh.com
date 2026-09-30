import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { Client } from 'ssh2';
import type { DockerProbeResult, DockerTransport } from '@smt/shared';
import { canAccessServer } from '../auth/server-access.js';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import { resolveServerAuth } from '../ssh/credentials.js';
import { DockerClient } from './client.js';
import { DockerError, dockerOff } from './errors.js';
import { acquire, poolKey, type DockerLease } from './pool.js';
import { probeDocker, probeStatus, recordProbe } from './probe.js';
import { openDaemonStream, type DaemonEndpoint } from './transport.js';

/**
 * The one way a Docker route reaches a daemon. {@link withDockerClient}:
 *
 * 1. answers 404 for a server the caller cannot access (or that is not in
 *    their org) and 400 when Docker is off for it;
 * 2. leases the caller's pooled SSH connection to it (docker/pool.ts);
 * 3. detects Docker on first use when no probe has run yet;
 * 4. hands the route a {@link DockerClient} pinned to the server's API
 *    version, and releases everything when the route's callback settles —
 *    so a streaming route keeps its lease for as long as it awaits the stream.
 *
 * Later phases (actions, exec, compose, fleet) build on this rather than on
 * the pool directly, so access checks and detection cannot be skipped.
 */

export type ServerRow = typeof servers.$inferSelect;

export interface DockerContext {
  server: ServerRow;
  docker: DockerClient;
  endpoint: DaemonEndpoint;
  /** The pooled SSH connection, for work outside the Engine API (compose CLI). */
  ssh: Client;
}

/** The server row, if the caller may use Docker on it; throws 404 / 400 otherwise. */
export function dockerServer(req: Pick<FastifyRequest, 'orgId' | 'user'>, serverId: string): ServerRow {
  // Not granted reads as not found, so a restricted member cannot probe ids
  if (!canAccessServer(req, serverId)) throw new DockerError('Server not found', 404);
  const row = getDb()
    .select()
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.orgId, req.orgId)))
    .get();
  if (!row) throw new DockerError('Server not found', 404);
  if (row.dockerMode === 'off') throw dockerOff();
  return row;
}

/** Lease the caller's pooled SSH connection to `server`. */
export async function leaseSsh(req: Pick<FastifyRequest, 'orgId' | 'user'>, server: ServerRow): Promise<DockerLease> {
  const { auth } = await resolveServerAuth(req.orgId, server.id);
  return acquire(
    poolKey(req.orgId, server.id, req.user.id),
    { id: server.id, host: server.host, port: server.port, username: server.username },
    auth,
    req.user.id,
  );
}

/** Detection in flight per server and socket override, so a burst of first requests probes once. */
const probing = new Map<string, Promise<DockerProbeResult>>();

/** Probe over `ssh` and record the outcome; concurrent callers for one server share the run. */
export function runProbe(ssh: Client, server: ServerRow): Promise<DockerProbeResult> {
  const override = server.dockerSocketPath;
  // A changed socket path is a different daemon: it never joins a run for the old one
  const key = `${server.id}\0${override ?? ''}`;
  let pending = probing.get(key);
  if (!pending) {
    pending = probeDocker(ssh, { override, username: server.username })
      .then((result) => {
        recordProbe(server.id, result, override);
        return result;
      })
      .finally(() => probing.delete(key));
    probing.set(key, pending);
  }
  return pending;
}

/** The detected endpoint and API version, probing first when nothing was detected yet. */
export async function ensureEndpoint(
  ssh: Client,
  server: ServerRow,
): Promise<{ endpoint: DaemonEndpoint; apiVersion: string }> {
  if (server.dockerTransport && server.dockerDetectedSocketPath && server.dockerApiVersion) {
    return {
      endpoint: { transport: server.dockerTransport as DockerTransport, socketPath: server.dockerDetectedSocketPath },
      apiVersion: server.dockerApiVersion,
    };
  }
  const result = await runProbe(ssh, server);
  if (!result.ok || !result.transport || !result.socketPath || !result.apiVersion) {
    throw new DockerError(
      result.error ?? 'Docker was not found on this server',
      probeStatus(result.problem),
      result.problem ?? 'unreachable',
      result.hint ?? undefined,
    );
  }
  return { endpoint: { transport: result.transport, socketPath: result.socketPath }, apiVersion: result.apiVersion };
}

/**
 * Run `fn` with a Docker client for `serverId` (see the module comment).
 * Everything is released when `fn` settles.
 */
export async function withDockerClient<T>(
  req: Pick<FastifyRequest, 'orgId' | 'user'>,
  serverId: string,
  fn: (ctx: DockerContext) => Promise<T>,
): Promise<T> {
  const server = dockerServer(req, serverId);
  const lease = await leaseSsh(req, server);
  try {
    const { endpoint, apiVersion } = await ensureEndpoint(lease.client, server);
    const docker = new DockerClient(() => openDaemonStream(lease.client, endpoint), apiVersion);
    try {
      return await fn({ server, docker, endpoint, ssh: lease.client });
    } finally {
      docker.close();
    }
  } finally {
    lease.release();
  }
}
