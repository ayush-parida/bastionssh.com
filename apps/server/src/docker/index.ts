import { evictServer, evictUser } from './pool.js';
import { abortDockerStreams } from './sse.js';

/**
 * Docker on managed servers over their SSH connection. Layout:
 *
 * - transport.ts — byte streams to the daemon (streamlocal, dial-stdio)
 * - pool.ts — pooled SSH connections per (org, server, user)
 * - client.ts — the Engine API client, API version negotiation
 * - probe.ts — detection and diagnosis
 * - service.ts — `withDockerClient`: access, lease, detection, client
 * - permissions.ts / settings.ts — the role matrix and org settings
 * - sse.ts — event streams (caps, heartbeats, revocation)
 * - actions.ts, exec.ts — actions (D2) and shells in containers (D3)
 * - compose.ts — Compose projects from labels, `docker compose` actions over SSH
 * - demux.ts, redact.ts, validation.ts, shell.ts, objects.ts, errors.ts — helpers
 */

/**
 * End a user's Docker access that is already open: their pooled connections
 * and their event streams (in one org when `orgId` is given; servers in
 * `keepServerIds` are spared). Returns how many were closed.
 */
export function closeDockerForUser(
  userId: string,
  scope: { orgId?: string; keepServerIds?: Iterable<string> } = {},
): number {
  const keepServerIds = scope.keepServerIds ? [...scope.keepServerIds] : undefined;
  return abortDockerStreams(userId, { orgId: scope.orgId, keepServerIds }) + evictUser(userId, { orgId: scope.orgId, keepServerIds });
}

/** Drop pooled Docker connections to a server after it changed (route, credentials, host key) or went away. */
export function evictDockerServer(orgId: string, serverId: string): number {
  return evictServer(orgId, serverId);
}
