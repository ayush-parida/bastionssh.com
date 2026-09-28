import { describe, it, expect, beforeAll } from 'vitest';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { auditLog, organizations } from '../db/schema.js';
import { seedOrg } from '../api/routes/test-utils.js';
import { pruneAuditLogs, runMaintenance } from './retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-28T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

function row(orgId: string, createdAt: string, action = 'server.create') {
  getDb()
    .insert(auditLog)
    .values({ id: nanoid(), orgId, actorId: 'u', actorEmail: 'u@t.test', action, resourceType: 'server', createdAt })
    .run();
}

const actionsOf = (orgId: string) =>
  getDb()
    .select({ action: auditLog.action, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .all();

describe('audit retention', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it('prunes each org by its own retention, and records the prune', () => {
    const yearly = seedOrg('ret-yearly');
    const monthly = seedOrg('ret-monthly');
    getDb().update(organizations).set({ auditRetentionDays: 30 }).where(eq(organizations.id, monthly)).run();
    for (const org of [yearly, monthly]) {
      row(org, daysAgo(400));
      row(org, daysAgo(100));
      row(org, daysAgo(10));
    }

    pruneAuditLogs(NOW);

    expect(actionsOf(yearly).filter((a) => a.action === 'server.create').map((a) => a.createdAt)).toEqual([
      daysAgo(100),
      daysAgo(10),
    ]);
    expect(actionsOf(monthly).filter((a) => a.action === 'server.create').map((a) => a.createdAt)).toEqual([daysAgo(10)]);

    const pruned = getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, monthly), eq(auditLog.action, 'audit.pruned')))
      .get();
    expect(pruned?.actorId).toBe('system');
    expect(JSON.parse(pruned!.metadata!)).toEqual({ deleted: 2, retentionDays: 30, olderThan: daysAgo(30) });
  });

  it('records nothing when there was nothing to prune', () => {
    const org = seedOrg('ret-quiet');
    row(org, daysAgo(1));
    pruneAuditLogs(NOW);
    expect(actionsOf(org).map((a) => a.action)).toEqual(['server.create']);
  });

  it('eventually drops rows of an org that no longer exists', () => {
    const gone = `deleted-${nanoid()}`;
    row(gone, daysAgo(400));
    row(gone, daysAgo(10));
    const result = runMaintenance(NOW);
    expect(result.orphans).toBeGreaterThanOrEqual(1);
    expect(actionsOf(gone).map((a) => a.createdAt)).toEqual([daysAgo(10)]);
  });
});
