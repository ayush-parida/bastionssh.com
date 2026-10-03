import { dropClusterCache, dropIdentityCaches } from './cache.js';
import { abortClusterStreams, abortKubeStreams } from './sse.js';
import { evictKubeServer } from './ssh-pool.js';

/**
 * Kubernetes clusters, understood visually (spec 2026-10-03). Layout:
 *
 * - kubeconfig.ts — uploaded kubeconfigs: contexts, refusals, credentials
 * - transport.ts — sockets to the API server (direct, SSH forwardOut, agent) + verified TLS
 * - ssh-pool.ts — the SSH connections clusters are reached through
 * - client.ts — the typed API client (get/list/watch/patch/delete; logs/exec in K4)
 * - cache.ts — the shared watch cache (refcounts, 410 relist, memory cap, idle stop)
 * - service.ts — `withKubeClient`: access, credential, impersonation, namespace rules
 * - connection-test.ts — "Test connection" steps and the credential's capabilities
 * - health.ts / views.ts / quantity.ts — health in a word and the view shapes
 * - metrics.ts — optional metrics.k8s.io usage
 * - permissions.ts / settings.ts — the §7 matrix and org settings
 * - sse.ts — event streams (caps, heartbeats, revocation)
 * - redact.ts, validation.ts, errors.ts — helpers
 * - diagnose.ts — the "Kubernetes API" Diagnose step
 */

/**
 * End a user's open Kubernetes access: their streams, and their own caches
 * when a cluster impersonates them (in one org when `orgId` is given;
 * clusters in `keepClusterIds` are spared). Returns how many were closed.
 */
export function closeKubeForUser(userId: string, scope: { orgId?: string; keepClusterIds?: Iterable<string> } = {}): number {
  const keepClusterIds = scope.keepClusterIds ? [...scope.keepClusterIds] : undefined;
  return abortKubeStreams(userId, { orgId: scope.orgId, keepClusterIds }) + dropIdentityCaches(userId, { orgId: scope.orgId, keepClusterIds });
}

/** A cluster was edited or removed: stop its watches and streams; viewers reconnect to the new settings. */
export function resetCluster(clusterId: string, why: string): void {
  dropClusterCache(clusterId, why);
  abortClusterStreams(clusterId, why);
}

/** Drop the SSH connection used to reach clusters through a server (edited, deleted, host key changed). */
export { evictKubeServer };
