import { and, eq, gt, isNull, or, type SQL } from 'drizzle-orm';
import type { ClusterGrant } from '@smt/shared';
import { getDb } from '../db/index.js';
import { memberClusterAccess } from '../db/schema.js';
import { authorize, contributionsFor, levelFor } from './access/authorize.js';
import type { ResourceAction } from './access/levels.js';
import { accessibleIds, filterAccessible } from './access/filter.js';
import { resolveAccess, type AccessSubject } from './access/resolve.js';

/**
 * Per-cluster access — the Kubernetes counterpart of auth/server-access.ts,
 * with the same rule and, like it, a thin wrapper over the access engine
 * (auth/access/): owners and admins see every cluster; anyone else sees every
 * cluster when their scope is `all`, and otherwise only the clusters their
 * custom roles and personal grants cover (grants past their expiry no longer
 * count; the sweep in auth/access-grants.ts deletes them and closes what is
 * open). A cluster someone cannot access is reported as not found, never
 * forbidden. Grants may narrow a cluster to some namespaces: see
 * `clusterNamespaces`.
 */

/** WHERE fragment for rows of member_cluster_access still in force at `now`. */
export function activeClusterGrantFilter(now: string = new Date().toISOString()): SQL {
  return or(isNull(memberClusterAccess.expiresAt), gt(memberClusterAccess.expiresAt, now))!;
}

export type ClusterScope = { all: true } | { all: false; clusterIds: string[] };

/** What the subject may see, read from the membership (never a passed role). */
export function clusterScope(who: AccessSubject): ClusterScope {
  const ids = accessibleIds(who, 'cluster');
  return ids.all ? { all: true } : { all: false, clusterIds: ids.ids };
}

/** True when the cluster exists in the subject's org and they may use it. */
export function canAccessCluster(who: AccessSubject, clusterId: string): boolean {
  return levelFor(who, 'cluster', clusterId) !== null;
}

/**
 * The namespaces of a cluster the subject may see: null for every namespace,
 * undefined when they cannot access the cluster at all.
 */
export function clusterNamespaces(who: AccessSubject, clusterId: string): string[] | null | undefined {
  const found = levelFor(who, 'cluster', clusterId);
  return found ? found.namespaces : undefined;
}

/**
 * The namespaces that grants narrowed to some namespaces name on this
 * cluster, whatever else reaches it. For a member who sees the whole cluster
 * (say a viewer by base role) and was raised in a namespace by a custom role,
 * these are where they may do more than on the cluster as a whole.
 */
export function grantedNamespaces(who: AccessSubject, clusterId: string): string[] {
  const access = resolveAccess(who);
  return [...new Set(contributionsFor(access, 'cluster', clusterId).flatMap((c) => c.namespaces ?? []))].sort();
}

/**
 * Why the subject may not do `action` on a cluster, for checks inside a
 * handler; null when they may. With `namespace`, only grants covering that
 * namespace count; without, the cluster as a whole (where a grant narrowed to
 * some namespaces gives `view` at most).
 */
export function clusterDenial(
  who: AccessSubject,
  clusterId: string,
  action: ResourceAction<'cluster'>,
  namespace?: string,
): { status: 403 | 404; error: string } | null {
  const result = authorize(who, 'cluster', clusterId, action, { namespace });
  if (result.ok) return null;
  // A namespace no grant covers is as absent as a cluster they cannot reach
  if (result.status === 404) return { status: 404, error: namespace === undefined ? 'Cluster not found' : 'Not found' };
  return { status: 403, error: `This needs ${result.required} access to the cluster (you have ${result.level})` };
}

/** True when the subject may do `action` on the cluster (in `namespace`, when given). */
export function canOnCluster(
  who: AccessSubject,
  clusterId: string,
  action: ResourceAction<'cluster'>,
  namespace?: string,
): boolean {
  return authorize(who, 'cluster', clusterId, action, { namespace }).ok;
}

/** In-memory filter for rows already loaded. */
export function filterAccessibleClusters<T>(who: AccessSubject, rows: T[], clusterIdOf: (row: T) => string): T[] {
  return filterAccessible(who, 'cluster', rows, clusterIdOf);
}

/** A member's cluster grants in force now, with their details. */
export function activeClusterGrants(orgId: string, userId: string): ClusterGrant[] {
  return getDb()
    .select({
      clusterId: memberClusterAccess.clusterId,
      expiresAt: memberClusterAccess.expiresAt,
      grantedBy: memberClusterAccess.grantedBy,
      reason: memberClusterAccess.reason,
    })
    .from(memberClusterAccess)
    .where(and(eq(memberClusterAccess.orgId, orgId), eq(memberClusterAccess.userId, userId), activeClusterGrantFilter()))
    .all();
}
