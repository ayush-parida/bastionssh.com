import { and, desc, eq, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { ServerStatus } from '@smt/shared';
import { getDb } from '../db/index.js';
import { serverHealth, serverMetrics, servers } from '../db/schema.js';
import { CredentialError, resolveServerAuth } from '../ssh/credentials.js';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { cpuPercentBetween, ProbeError, round2, runProbe, type ProbeSample } from './probe.js';
import { evaluateConditions, reconcileAlerts } from './alerts.js';

export interface CheckOutcome {
  serverId: string;
  status: ServerStatus;
  latencyMs?: number;
  error?: string;
}

function percent(used?: number, total?: number): number | undefined {
  if (!total || used === undefined) return undefined;
  return round2((used / total) * 100);
}

/** Most recent sample for a server, used for the CPU jiffy delta. */
function previousSample(serverId: string) {
  const db = getDb();
  return db
    .select({
      totalJiffies: serverMetrics.cpuTotalJiffies,
      idleJiffies: serverMetrics.cpuIdleJiffies,
    })
    .from(serverMetrics)
    .where(and(eq(serverMetrics.serverId, serverId), eq(serverMetrics.status, 'online')))
    .orderBy(desc(serverMetrics.collectedAt))
    .limit(1)
    .get();
}

function upsertHealth(row: typeof serverHealth.$inferInsert) {
  const db = getDb();
  const existing = db
    .select({ serverId: serverHealth.serverId })
    .from(serverHealth)
    .where(eq(serverHealth.serverId, row.serverId))
    .get();

  if (existing) {
    const { serverId, ...rest } = row;
    db.update(serverHealth).set(rest).where(eq(serverHealth.serverId, serverId)).run();
  } else {
    db.insert(serverHealth).values(row).run();
  }
}

function recordSuccess(
  server: typeof servers.$inferSelect,
  sample: ProbeSample,
  latencyMs: number,
): CheckOutcome {
  const db = getDb();
  const now = new Date().toISOString();
  const cpuPercent = cpuPercentBetween(previousSample(server.id), sample);
  const memPercent = percent(sample.memUsedKb, sample.memTotalKb);
  const diskPercent = percent(sample.diskUsedKb, sample.diskTotalKb);

  db.insert(serverMetrics)
    .values({
      id: nanoid(),
      orgId: server.orgId,
      serverId: server.id,
      collectedAt: now,
      status: 'online',
      latencyMs,
      uptimeSeconds: sample.uptimeSeconds,
      load1: sample.load1,
      load5: sample.load5,
      load15: sample.load15,
      cpuCores: sample.cpuCores,
      cpuPercent,
      cpuTotalJiffies: sample.cpuTotalJiffies,
      cpuIdleJiffies: sample.cpuIdleJiffies,
      memTotalKb: sample.memTotalKb,
      memUsedKb: sample.memUsedKb,
      swapTotalKb: sample.swapTotalKb,
      swapUsedKb: sample.swapUsedKb,
      diskTotalKb: sample.diskTotalKb,
      diskUsedKb: sample.diskUsedKb,
      processCount: sample.processCount,
      loggedInUsers: sample.loggedInUsers,
      disks: sample.disks.length ? JSON.stringify(sample.disks) : null,
    })
    .run();

  upsertHealth({
    serverId: server.id,
    orgId: server.orgId,
    status: 'online',
    lastCheckedAt: now,
    lastOnlineAt: now,
    lastError: null,
    consecutiveFailures: 0,
    latencyMs,
    uptimeSeconds: sample.uptimeSeconds,
    cpuPercent,
    memPercent,
    diskPercent,
    load1: sample.load1,
    cpuCores: sample.cpuCores,
    osName: sample.osName,
    kernel: sample.kernel,
    hostname: sample.hostname,
    updatedAt: now,
  });

  reconcileAlerts(
    server.orgId,
    server.id,
    evaluateConditions({ status: 'online', consecutiveFailures: 0, cpuPercent, sample }),
  );

  return { serverId: server.id, status: 'online', latencyMs };
}

function recordFailure(
  server: typeof servers.$inferSelect,
  status: Exclude<ServerStatus, 'online' | 'unknown' | 'paused'>,
  message: string,
): CheckOutcome {
  const db = getDb();
  const now = new Date().toISOString();

  const previous = db
    .select()
    .from(serverHealth)
    .where(eq(serverHealth.serverId, server.id))
    .get();
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;

  db.insert(serverMetrics)
    .values({
      id: nanoid(),
      orgId: server.orgId,
      serverId: server.id,
      collectedAt: now,
      status,
      error: message.slice(0, 500),
    })
    .run();

  upsertHealth({
    serverId: server.id,
    orgId: server.orgId,
    status,
    lastCheckedAt: now,
    lastOnlineAt: previous?.lastOnlineAt ?? null,
    lastError: message.slice(0, 500),
    consecutiveFailures,
    // Resource readings are stale the moment a host stops answering.
    latencyMs: null,
    cpuPercent: null,
    memPercent: null,
    diskPercent: null,
    load1: null,
    uptimeSeconds: null,
    cpuCores: previous?.cpuCores ?? null,
    osName: previous?.osName ?? null,
    kernel: previous?.kernel ?? null,
    hostname: previous?.hostname ?? null,
    updatedAt: now,
  });

  reconcileAlerts(
    server.orgId,
    server.id,
    evaluateConditions({ status, consecutiveFailures, lastError: message }),
  );

  return { serverId: server.id, status, error: message };
}

/**
 * Probe one server and persist the result. Never throws — a failed check is a
 * recorded data point, not an exception for the caller to handle.
 */
export async function checkServer(server: typeof servers.$inferSelect): Promise<CheckOutcome> {
  try {
    const { auth } = await resolveServerAuth(server.orgId, server.id);
    const { sample, latencyMs } = await runProbe(
      { host: server.host, port: server.port, username: server.username },
      auth,
      config.monitoring.timeoutMs,
    );
    return recordSuccess(server, sample, latencyMs);
  } catch (err) {
    if (err instanceof ProbeError) {
      return recordFailure(server, err.kind, err.message);
    }
    if (err instanceof CredentialError) {
      return recordFailure(server, 'error', err.message);
    }
    logger.error({ err, serverId: server.id }, 'Health check failed unexpectedly');
    return recordFailure(server, 'error', err instanceof Error ? err.message : String(err));
  }
}

/** Check a single server by id, scoped to an org. Returns null if it does not exist. */
export async function checkServerById(
  orgId: string,
  serverId: string,
): Promise<CheckOutcome | null> {
  const db = getDb();
  const server = db
    .select()
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.orgId, orgId)))
    .get();
  if (!server) return null;
  return checkServer(server);
}

/** Mark a server as excluded from monitoring without losing its history. */
export function pauseHealth(server: typeof servers.$inferSelect) {
  const now = new Date().toISOString();
  const existing = getDb()
    .select()
    .from(serverHealth)
    .where(eq(serverHealth.serverId, server.id))
    .get();

  upsertHealth({
    ...(existing ?? { orgId: server.orgId, consecutiveFailures: 0 }),
    serverId: server.id,
    orgId: server.orgId,
    status: 'paused',
    updatedAt: now,
  });
  // A paused server should not keep firing alerts nobody is watching. Closing
  // them is bookkeeping, not an all-clear, so it goes out silently.
  reconcileAlerts(server.orgId, server.id, [], { notify: false });
}

/**
 * Bring a paused server back into rotation. Its stored status would otherwise
 * stay `paused` until the next sweep overwrites it, which reads as "still off"
 * in the UI right after the user turned monitoring back on.
 */
export function resumeHealth(server: typeof servers.$inferSelect) {
  const existing = getDb()
    .select()
    .from(serverHealth)
    .where(eq(serverHealth.serverId, server.id))
    .get();
  if (!existing || existing.status !== 'paused') return;

  upsertHealth({
    ...existing,
    status: 'unknown',
    updatedAt: new Date().toISOString(),
  });
}

/** Drop samples older than the retention window. Returns rows removed. */
export function pruneMetrics(retentionHours = config.monitoring.retentionHours): number {
  const cutoff = new Date(Date.now() - retentionHours * 3600_000).toISOString();
  const result = getDb()
    .delete(serverMetrics)
    .where(lt(serverMetrics.collectedAt, cutoff))
    .run();
  return Number(result.changes ?? 0);
}
