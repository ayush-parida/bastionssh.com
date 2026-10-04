import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { ServerGrant } from '@smt/shared';
import { getDb } from '../db/index.js';
import {
  accessRequests,
  memberClusterAccess,
  memberServerAccess,
  resourceGrants,
  roleMembers,
  roles,
  users,
} from '../db/schema.js';
import { auditSystem } from '../audit/index.js';
import logger from '../logger.js';
import { activeGrantFilter } from './server-access.js';
import { revokeAfterChange } from './access/revoke.js';

/**
 * Time-bound server grants. `member_server_access.expires_at` null means
 * permanent; a grant past its expiry stops counting in `serverScope` at once,
 * and the sweep here deletes it and closes what is still open on the server.
 * Kubernetes cluster grants (`member_cluster_access`) expire the same way, as
 * do custom-role memberships (`role_members`) and every other grant in
 * `resource_grants` (auth/access/).
 */

/** Longest time-bound grant an admin may give directly: a year. Anything longer should be permanent. */
export const MAX_GRANT_MINUTES = 365 * 24 * 60;

/** A pending request lapses if nobody decides it within this long. */
export const REQUEST_TTL_MS = 3 * 24 * 60 * 60_000;

export function minutesFromNow(minutes: number, now = Date.now()): string {
  return new Date(now + minutes * 60_000).toISOString();
}

/** A member's grants in force now, with their details. */
export function activeGrants(orgId: string, userId: string): ServerGrant[] {
  return getDb()
    .select({
      serverId: memberServerAccess.serverId,
      expiresAt: memberServerAccess.expiresAt,
      grantedBy: memberServerAccess.grantedBy,
      reason: memberServerAccess.reason,
    })
    .from(memberServerAccess)
    .where(
      and(eq(memberServerAccess.orgId, orgId), eq(memberServerAccess.userId, userId), activeGrantFilter()),
    )
    .all();
}

/**
 * Add time-bound grants without ever shortening access: a server already
 * granted permanently, or until later than `expiresAt`, is left as it is.
 * Returns the servers whose grant was created or extended.
 */
export function extendGrants(
  orgId: string,
  userId: string,
  serverIds: string[],
  grant: { expiresAt: string; grantedBy: string; reason: string | null },
): string[] {
  const db = getDb();
  const changed: string[] = [];
  db.transaction(() => {
    for (const serverId of serverIds) {
      const where = and(
        eq(memberServerAccess.orgId, orgId),
        eq(memberServerAccess.userId, userId),
        eq(memberServerAccess.serverId, serverId),
      );
      const existing = db.select().from(memberServerAccess).where(where).get();
      if (!existing) {
        db.insert(memberServerAccess).values({ orgId, userId, serverId, ...grant }).run();
        changed.push(serverId);
      } else if (existing.expiresAt !== null && existing.expiresAt < grant.expiresAt) {
        db.update(memberServerAccess).set(grant).where(where).run();
        changed.push(serverId);
      }
    }
  });
  return changed;
}

/**
 * Cancel a member's pending access requests in an org, when they are suspended
 * or removed: nobody should approve access for someone who can no longer use
 * it (and a reactivated member can simply ask again). Returns how many.
 */
export function cancelPendingAccessRequests(
  orgId: string,
  userId: string,
  decidedBy: string,
  why: 'suspended' | 'removed',
): number {
  return getDb()
    .update(accessRequests)
    .set({
      status: 'cancelled',
      decidedBy,
      decidedAt: new Date().toISOString(),
      decisionNote: `Cancelled automatically: the member was ${why}`,
    })
    .where(
      and(eq(accessRequests.orgId, orgId), eq(accessRequests.userId, userId), eq(accessRequests.status, 'pending')),
    )
    .run().changes;
}

export interface ExpirySweepResult {
  /** Grants removed because their time was up (servers, clusters, and any other resource grant). */
  grants: number;
  /** Custom-role memberships removed because their time was up. */
  roleMembers?: number;
  /** Pending requests nobody decided in time. */
  requests: number;
}

/**
 * Remove every grant past its expiry and end what the member still has open
 * on those servers — terminals and SFTP on other servers they can still use
 * are kept, as when an admin narrows access. Pending requests past their
 * deadline become `expired`.
 */
export function sweepExpiredAccess(now: Date = new Date()): ExpirySweepResult {
  const db = getDb();
  const nowIso = now.toISOString();

  const expired = db
    .delete(memberServerAccess)
    .where(and(isNotNull(memberServerAccess.expiresAt), lte(memberServerAccess.expiresAt, nowIso)))
    .returning({
      orgId: memberServerAccess.orgId,
      userId: memberServerAccess.userId,
      serverId: memberServerAccess.serverId,
      expiresAt: memberServerAccess.expiresAt,
    })
    .all();

  const expiredClusters = db
    .delete(memberClusterAccess)
    .where(and(isNotNull(memberClusterAccess.expiresAt), lte(memberClusterAccess.expiresAt, nowIso)))
    .returning({
      orgId: memberClusterAccess.orgId,
      userId: memberClusterAccess.userId,
      clusterId: memberClusterAccess.clusterId,
    })
    .all();

  // Mirrored rows of the two tables above went with them (migration 0023's
  // triggers); what is left is every other grant, personal or a role's.
  const expiredGrants = db
    .delete(resourceGrants)
    .where(and(isNotNull(resourceGrants.expiresAt), lte(resourceGrants.expiresAt, nowIso)))
    .returning()
    .all();

  const expiredMembers = db
    .delete(roleMembers)
    .where(and(isNotNull(roleMembers.expiresAt), lte(roleMembers.expiresAt, nowIso)))
    .returning({ orgId: roleMembers.orgId, userId: roleMembers.userId, roleId: roleMembers.roleId })
    .all();

  interface Lost {
    orgId: string;
    userId: string;
    serverIds: string[];
    clusterIds: string[];
    /** Personal grants other than the two tables above. */
    grants: { type: string; selector: string; resourceId: string | null; tag: string | null; level: string }[];
    /** Role memberships that ended. */
    roleIds: string[];
  }
  const byMember = new Map<string, Lost>();
  const entryFor = (orgId: string, userId: string) => {
    const key = `${orgId}\u0000${userId}`;
    const entry = byMember.get(key) ?? { orgId, userId, serverIds: [], clusterIds: [], grants: [], roleIds: [] };
    byMember.set(key, entry);
    return entry;
  };
  for (const row of expired) entryFor(row.orgId, row.userId).serverIds.push(row.serverId);
  for (const row of expiredClusters) entryFor(row.orgId, row.userId).clusterIds.push(row.clusterId);
  for (const row of expiredMembers) entryFor(row.orgId, row.userId).roleIds.push(row.roleId);

  // A role's grant ending touches every current member of the role
  const roleGrants = expiredGrants.filter((g) => g.principalType === 'role');
  const roleNames = new Map<string, string>();
  const roleIds = [...new Set([...roleGrants.map((g) => g.principalId), ...expiredMembers.map((m) => m.roleId)])];
  if (roleIds.length) {
    for (const r of db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds)).all()) {
      roleNames.set(r.id, r.name);
    }
  }
  const roleMembersOf = new Map<string, string[]>();
  if (roleGrants.length) {
    const held = db
      .select({ roleId: roleMembers.roleId, userId: roleMembers.userId })
      .from(roleMembers)
      .where(inArray(roleMembers.roleId, [...new Set(roleGrants.map((g) => g.principalId))]))
      .all();
    for (const { roleId, userId } of held) roleMembersOf.set(roleId, [...(roleMembersOf.get(roleId) ?? []), userId]);
  }
  for (const grant of expiredGrants) {
    const detail = {
      type: grant.resourceType,
      selector: grant.selector,
      resourceId: grant.resourceId,
      tag: grant.tag,
      level: grant.level,
    };
    if (grant.principalType === 'user') {
      entryFor(grant.orgId, grant.principalId).grants.push(detail);
    } else {
      auditSystem(grant.orgId, 'role.grant_expired', 'role', grant.principalId, roleNames.get(grant.principalId), detail);
      for (const userId of roleMembersOf.get(grant.principalId) ?? []) entryFor(grant.orgId, userId);
    }
  }

  const emails = new Map(
    byMember.size
      ? db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, [...new Set([...byMember.values()].map((m) => m.userId))]))
          .all()
          .map((u) => [u.id, u.email])
      : [],
  );

  for (const { orgId, userId, serverIds, clusterIds, grants, roleIds: endedRoles } of byMember.values()) {
    // Someone who (now) reaches everything lost nothing usable; anyone else
    // keeps exactly what they still reach
    const live = revokeAfterChange(orgId, [userId]).get(userId);
    for (const roleId of endedRoles) {
      auditSystem(orgId, 'role.member_expired', 'role', roleId, roleNames.get(roleId), {
        userId,
        email: emails.get(userId),
      });
    }
    // Only touched through a role's grant, which is audited on the role: say so only if something closed
    const personal = serverIds.length || clusterIds.length || grants.length || endedRoles.length;
    if (!personal && !live) continue;
    auditSystem(orgId, 'member.access_expired', 'member', userId, emails.get(userId), {
      servers: serverIds,
      ...(clusterIds.length && { clusters: clusterIds }),
      ...(grants.length && { grants }),
      ...(endedRoles.length && { roles: endedRoles.map((id) => ({ id, name: roleNames.get(id) ?? null })) }),
      ...(live && { live }),
    });
  }

  const lapsed = db
    .update(accessRequests)
    .set({ status: 'expired' })
    .where(and(eq(accessRequests.status, 'pending'), lte(accessRequests.expiresAt, nowIso)))
    .run().changes;

  return {
    // Mirrored rows were deleted with their source rows, so nothing is counted twice
    grants: expired.length + expiredClusters.length + expiredGrants.length,
    ...(expiredMembers.length && { roleMembers: expiredMembers.length }),
    requests: lapsed,
  };
}

let timer: NodeJS.Timeout | null = null;

const SWEEP_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 5_000;

function tick() {
  try {
    const result = sweepExpiredAccess();
    if (result.grants || result.requests) logger.info(result, 'Expired server access swept');
  } catch (err) {
    logger.error({ err }, 'Server access expiry sweep failed');
  }
}

/**
 * Runs in-process every minute, like the health monitor — no Redis needed.
 * Access checks already ignore expired grants, so the sweep only bounds how
 * long an already-open terminal or file session outlives its grant.
 */
export function startAccessExpiry() {
  if (timer) return;
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();
  logger.info('Server access expiry sweep started');
}

export function stopAccessExpiry() {
  if (timer) clearInterval(timer);
  timer = null;
}
