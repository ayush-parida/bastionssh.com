import { and, eq, gt, isNull, or, type SQL } from 'drizzle-orm';
import type { ClusterGrant } from '@smt/shared';
import { getDb } from '../db/index.js';
import { kubeClusters, memberClusterAccess, memberships } from '../db/schema.js';
import { rank } from './middleware.js';
import type { AccessSubject } from './server-access.js';

/**
 * Per-cluster access for `restricted` members — the Kubernetes counterpart of
 * auth/server-access.ts, with the same rule: owners and admins see every
 * cluster; anyone else sees every cluster unless their membership is
 * `restricted`, in which case only the clusters granted in
 * `member_cluster_access` (grants past their expiry no longer count; the
 * sweep in auth/access-grants.ts deletes them and closes what is open). A
 * cluster someone cannot access is reported as not found, never forbidden.
 */

/** WHERE fragment for cluster grants still in force at `now`. */
export function activeClusterGrantFilter(now: string = new Date().toISOString()): SQL {
  return or(isNull(memberClusterAccess.expiresAt), gt(memberClusterAccess.expiresAt, now))!;
}

function subjectOf(who: AccessSubject): { orgId: string; userId: string } {
  return 'userId' in who ? { orgId: who.orgId, userId: who.userId } : { orgId: who.orgId, userId: who.user.id };
}

export type ClusterScope = { all: true } | { all: false; clusterIds: string[] };

/** What the subject may see, read from the membership (never a passed role). */
export function clusterScope(who: AccessSubject): ClusterScope {
  const { orgId, userId } = subjectOf(who);
  const db = getDb();
  const membership = db
    .select({ role: memberships.role, status: memberships.status, serverAccess: memberships.serverAccess })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .get();

  if (!membership || membership.status !== 'active') return { all: false, clusterIds: [] };
  if (rank(membership.role) >= rank('admin') || membership.serverAccess !== 'restricted') return { all: true };

  const clusterIds = db
    .select({ clusterId: memberClusterAccess.clusterId })
    .from(memberClusterAccess)
    .where(and(eq(memberClusterAccess.orgId, orgId), eq(memberClusterAccess.userId, userId), activeClusterGrantFilter()))
    .all()
    .map((row) => row.clusterId);
  return { all: false, clusterIds };
}

/** True when the cluster exists in the subject's org and they may use it. */
export function canAccessCluster(who: AccessSubject, clusterId: string): boolean {
  const { orgId } = subjectOf(who);
  const exists = getDb()
    .select({ id: kubeClusters.id })
    .from(kubeClusters)
    .where(and(eq(kubeClusters.id, clusterId), eq(kubeClusters.orgId, orgId)))
    .get();
  if (!exists) return false;
  const scope = clusterScope(who);
  return scope.all || scope.clusterIds.includes(clusterId);
}

/** In-memory filter for rows already loaded. */
export function filterAccessibleClusters<T>(who: AccessSubject, rows: T[], clusterIdOf: (row: T) => string): T[] {
  const scope = clusterScope(who);
  if (scope.all) return rows;
  const allowed = new Set(scope.clusterIds);
  return rows.filter((row) => allowed.has(clusterIdOf(row)));
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
