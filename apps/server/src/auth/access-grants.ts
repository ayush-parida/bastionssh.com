import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { ServerGrant } from '@smt/shared';
import { getDb } from '../db/index.js';
import { accessRequests, memberServerAccess, users } from '../db/schema.js';
import { auditSystem } from '../audit/index.js';
import logger from '../logger.js';
import { activeGrantFilter, serverScope } from './server-access.js';
import { revokeLiveAccess } from './revoke.js';

/**
 * Time-bound server grants. `member_server_access.expires_at` null means
 * permanent; a grant past its expiry stops counting in `serverScope` at once,
 * and the sweep here deletes it and closes what is still open on the server.
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
  /** Grants removed because their time was up. */
  grants: number;
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

  const byMember = new Map<string, { orgId: string; userId: string; serverIds: string[] }>();
  for (const row of expired) {
    const key = `${row.orgId}\u0000${row.userId}`;
    const entry = byMember.get(key) ?? { orgId: row.orgId, userId: row.userId, serverIds: [] };
    entry.serverIds.push(row.serverId);
    byMember.set(key, entry);
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

  for (const { orgId, userId, serverIds } of byMember.values()) {
    // Someone who (now) sees every server lost nothing usable
    const scope = serverScope({ orgId, userId });
    const live = scope.all ? undefined : revokeLiveAccess(userId, { orgId, keepServerIds: scope.serverIds });
    auditSystem(orgId, 'member.access_expired', 'member', userId, emails.get(userId), {
      servers: serverIds,
      ...(live && { live }),
    });
  }

  const lapsed = db
    .update(accessRequests)
    .set({ status: 'expired' })
    .where(and(eq(accessRequests.status, 'pending'), lte(accessRequests.expiresAt, nowIso)))
    .run().changes;

  return { grants: expired.length, requests: lapsed };
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
