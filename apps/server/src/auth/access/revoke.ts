import { eq } from 'drizzle-orm';
import { RESOURCE_TYPES, type ResourceType } from '@smt/shared';
import { getDb } from '../../db/index.js';
import { closeDisallowedPodShells } from '../../kube/exec.js';
import { revokeLiveAccess, type LiveAccessRevoked, type LiveAccessScope } from '../revoke.js';
import { accessibleIds, RESOURCE_TABLES, type AccessibleIds } from './filter.js';
import { baseAllowsAtView } from './levels.js';
import { resolveAccess, type AccessSubject } from './resolve.js';

/**
 * Revocation after an access change (spec §2.8, §4 revoke.ts): work out what
 * a member can still reach, and close whatever they have open on anything
 * else — terminals, SFTP/FTP sessions, Docker and Kubernetes streams and
 * shells — keeping what they still have. Shells (terminals, SFTP, pod and
 * container shells) need `operate`, so they also close where the member
 * keeps only `view`. Pod shells are weighed in their own namespace, which the
 * per-type sets cannot show: a grant narrowed to `shop` operates there and
 * nowhere else, and narrowing it further changes no set at all. Pooled
 * FTP/SFTP-connection sessions follow browsing (`ftpSessionIds`).
 *
 *   const before = snapshotAccess(orgId, userIds);
 *   …change roles, grants, memberships or scope…
 *   revokeAfterChange(orgId, userIds, before);
 */

/**
 * What one member reaches, per type: seeing it, and operating it. `sessions`
 * (FTP/SFTP connections) is where they may keep a pooled session open.
 */
export type AccessSnapshot = Record<
  ResourceType,
  { view: AccessibleIds; operate: AccessibleIds; sessions?: AccessibleIds }
>;

/**
 * The FTP/SFTP connections a member may hold a session on: those they may
 * browse — `operate`, or every one they see through their base role (scope
 * `all`), which has always allowed browsing (levels.ts BASE_VIEW_ACTIONS).
 */
function ftpSessionIds(who: AccessSubject): AccessibleIds {
  const access = resolveAccess(who);
  if (access.active && access.scope === 'all' && baseAllowsAtView('ftp_connection', 'browse')) {
    return accessibleIds(who, 'ftp_connection');
  }
  return accessibleIds(who, 'ftp_connection', 'operate');
}

/** A member's accessible sets right now, read afresh (never a request's memo). */
export function accessSnapshot(orgId: string, userId: string): AccessSnapshot {
  const who = { orgId, userId };
  const snapshot = Object.fromEntries(
    RESOURCE_TYPES.map((type) => [type, { view: accessibleIds(who, type), operate: accessibleIds(who, type, 'operate') }]),
  ) as AccessSnapshot;
  snapshot.ftp_connection.sessions = ftpSessionIds(who);
  return snapshot;
}

/** Snapshots for several members, to hand to `revokeAfterChange` once the change is made. */
export function snapshotAccess(orgId: string, userIds: Iterable<string>): Map<string, AccessSnapshot> {
  return new Map([...new Set(userIds)].map((userId) => [userId, accessSnapshot(orgId, userId)]));
}

/** True when `after` reaches nothing that `before` did not — nothing to close. */
function covers(after: AccessibleIds, before: AccessibleIds): boolean {
  if (after.all) return true;
  if (before.all) return false;
  const kept = new Set(after.ids);
  return before.ids.every((id) => kept.has(id));
}

/** The types (and levels) where `after` lost something `before` had; empty when nothing was lost. */
export function lostAccess(before: AccessSnapshot, after: AccessSnapshot): { type: ResourceType; level: 'view' | 'operate' }[] {
  const lost: { type: ResourceType; level: 'view' | 'operate' }[] = [];
  for (const type of RESOURCE_TYPES) {
    const { sessions: kept } = after[type];
    const { sessions: had } = before[type];
    if (!covers(after[type].view, before[type].view)) lost.push({ type, level: 'view' });
    else if (!covers(after[type].operate, before[type].operate)) lost.push({ type, level: 'operate' });
    // e.g. scope `all` → `roles` with view on every connection: browsing (and so sessions) went
    else if (had && kept && !covers(kept, had)) lost.push({ type, level: 'operate' });
  }
  return lost;
}

/** Every id of `type` in the org (for a type the member reaches entirely). */
function allIds(orgId: string, type: ResourceType): string[] {
  const { table, id, orgId: orgColumn } = RESOURCE_TABLES[type];
  return getDb()
    .select({ id })
    .from(table)
    .where(eq(orgColumn, orgId))
    .all()
    .map((row) => row.id as string);
}

/** The `revokeLiveAccess` keep sets for what `after` still reaches. */
export function keepSets(orgId: string, after: AccessSnapshot): LiveAccessScope {
  const ids = (set: AccessibleIds, type: ResourceType) => (set.all ? allIds(orgId, type) : set.ids);
  return {
    orgId,
    keepServerIds: ids(after.server.view, 'server'),
    keepClusterIds: ids(after.cluster.view, 'cluster'),
    keepShellServerIds: ids(after.server.operate, 'server'),
    // On a cluster still seen, pod shells stay here and are weighed in their namespace (closeDisallowedPodShells)
    keepShellClusterIds: ids(after.cluster.view, 'cluster'),
    keepFtpConnectionIds: ids(after.ftp_connection.sessions ?? after.ftp_connection.operate, 'ftp_connection'),
  };
}

/** True when the member reaches every resource of every type at every level — nothing could be open that they lost. */
function unrestricted(snapshot: AccessSnapshot): boolean {
  return RESOURCE_TYPES.every(
    (type) => snapshot[type].view.all && snapshot[type].operate.all && (snapshot[type].sessions?.all ?? true),
  );
}

/**
 * Close what each member has open on resources they no longer reach. With
 * `before` snapshots only members who lost something are touched; without,
 * every member who is not unrestricted is (the expiry sweep's way). Returns
 * what was closed, per member.
 */
export function revokeAfterChange(
  orgId: string,
  userIds: Iterable<string>,
  before?: Map<string, AccessSnapshot>,
): Map<string, LiveAccessRevoked> {
  const closed = new Map<string, LiveAccessRevoked>();
  for (const userId of new Set(userIds)) {
    const after = accessSnapshot(orgId, userId);
    const previous = before?.get(userId);
    // Pod shells in a namespace the member no longer operates in, whatever the sets say
    const podShells = closeDisallowedPodShells(orgId, userId);
    if (previous ? lostAccess(previous, after).length === 0 : unrestricted(after)) {
      if (podShells) closed.set(userId, { terminals: podShells, sftp: 0, docker: 0, kube: 0, agents: 0 });
      continue;
    }
    const revoked = revokeLiveAccess(userId, keepSets(orgId, after));
    closed.set(userId, podShells ? { ...revoked, terminals: revoked.terminals + podShells } : revoked);
  }
  return closed;
}
