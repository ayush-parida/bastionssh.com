import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { auditLog, organizations } from '../db/schema.js';
import { pruneLoginFailures, pruneStaleDevices } from '../auth/login-security.js';
import logger from '../logger.js';
import { auditSystem } from './index.js';

/**
 * The daily maintenance job: drops audit rows past each org's retention, and
 * the sign-in bookkeeping that no longer matters. In-process on a plain
 * interval like the health monitor, so it needs no Redis.
 */

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const MIN_AUDIT_RETENTION_DAYS = 7;
export const MAX_AUDIT_RETENTION_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows deleted per statement, so a first prune of a large log does not hold the write lock for long. */
const DELETE_CHUNK = 5_000;
const FIRST_RUN_DELAY_MS = 60_000;

/** Delete one org's rows older than its retention. Returns how many went. */
export function pruneOrgAuditLog(orgId: string, retentionDays: number, now = new Date()): number {
  const db = getDb();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  let deleted = 0;
  for (;;) {
    const ids = db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), lt(auditLog.createdAt, cutoff)))
      .limit(DELETE_CHUNK)
      .all()
      .map((r) => r.id);
    if (!ids.length) break;
    deleted += db.delete(auditLog).where(inArray(auditLog.id, ids)).run().changes;
    if (ids.length < DELETE_CHUNK) break;
  }
  if (deleted) {
    // Recorded after the delete, so the record of the prune is itself kept
    auditSystem(orgId, 'audit.pruned', 'audit_log', undefined, undefined, {
      deleted,
      retentionDays,
      olderThan: cutoff,
    });
  }
  return deleted;
}

export function pruneAuditLogs(now = new Date()): number {
  const orgs = getDb()
    .select({ id: organizations.id, retentionDays: organizations.auditRetentionDays })
    .from(organizations)
    .all();
  let total = 0;
  for (const org of orgs) {
    try {
      total += pruneOrgAuditLog(org.id, org.retentionDays, now);
    } catch (err) {
      logger.error({ err, orgId: org.id }, 'Audit log prune failed for org');
    }
  }
  return total;
}

/**
 * Rows whose org no longer exists (audit_log has no foreign key, so deleting
 * an org leaves them behind) are dropped once they are older than the default
 * retention.
 */
function pruneOrphans(now: Date): number {
  const cutoff = new Date(now.getTime() - DEFAULT_AUDIT_RETENTION_DAYS * DAY_MS).toISOString();
  return getDb()
    .delete(auditLog)
    .where(
      and(
        lt(auditLog.createdAt, cutoff),
        sql`${auditLog.orgId} NOT IN (SELECT ${organizations.id} FROM ${organizations})`,
      ),
    )
    .run().changes;
}

export function runMaintenance(now = new Date()) {
  const audit = pruneAuditLogs(now);
  const orphans = pruneOrphans(now);
  const loginFailures = pruneLoginFailures(now);
  const devices = pruneStaleDevices(now);
  if (audit || orphans || loginFailures || devices) {
    logger.info({ audit, orphans, loginFailures, devices }, 'Daily maintenance pruned old rows');
  }
  return { audit, orphans, loginFailures, devices };
}

let timer: NodeJS.Timeout | null = null;

function tick() {
  try {
    runMaintenance();
  } catch (err) {
    logger.error({ err }, 'Daily maintenance failed');
  }
}

export function startMaintenance() {
  if (timer) return;
  timer = setInterval(tick, DAY_MS);
  timer.unref?.();
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();
}

export function stopMaintenance() {
  if (timer) clearInterval(timer);
  timer = null;
}
