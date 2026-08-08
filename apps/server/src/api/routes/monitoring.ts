import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, gte, isNull, inArray } from 'drizzle-orm';
import type {
  DiskUsage,
  MetricRange,
  MonitoringOverview,
  ServerAlert,
  ServerHealth,
  ServerHealthDetail,
  ServerHealthWithServer,
  ServerMetric,
  ServerStatus,
} from '@smt/shared';
import { METRIC_RANGES } from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { serverAlerts, serverHealth, serverMetrics, servers } from '../../db/schema.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { checkServerById, pauseHealth, resumeHealth } from '../../monitoring/collector.js';

const RANGE_HOURS: Record<MetricRange, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };

/** Cap on points returned per series; longer ranges are thinned, never truncated. */
const MAX_POINTS = 240;

/** Window and length of the CPU sparkline shown on the overview cards. */
const TREND_WINDOW_HOURS = 3;
const TREND_POINTS = 30;

const metricsQuerySchema = z.object({
  range: z.enum(METRIC_RANGES).default('24h'),
});

const alertsQuerySchema = z.object({
  status: z.enum(['active', 'all']).default('active'),
  limit: z.coerce.number().min(1).max(200).default(50),
});

const monitoringSettingsSchema = z.object({ enabled: z.boolean() });

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseDisks(raw: string | null): DiskUsage[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type NullToUndefined<T> = {
  [K in keyof T]: null extends T[K] ? Exclude<T[K], null> | undefined : T[K];
};

/** Drizzle returns `null` for empty columns; the shared types use optionals. */
function nullsToUndefined<T extends Record<string, unknown>>(row: T): NullToUndefined<T> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v === null ? undefined : v]),
  ) as NullToUndefined<T>;
}

function toMetric(row: typeof serverMetrics.$inferSelect): ServerMetric {
  const memPercent =
    row.memTotalKb && row.memUsedKb != null ? (row.memUsedKb / row.memTotalKb) * 100 : undefined;
  const diskPercent =
    row.diskTotalKb && row.diskUsedKb != null ? (row.diskUsedKb / row.diskTotalKb) * 100 : undefined;

  return {
    ...nullsToUndefined({
      id: row.id,
      serverId: row.serverId,
      collectedAt: row.collectedAt,
      latencyMs: row.latencyMs,
      uptimeSeconds: row.uptimeSeconds,
      load1: row.load1,
      load5: row.load5,
      load15: row.load15,
      cpuCores: row.cpuCores,
      cpuPercent: row.cpuPercent,
      memTotalKb: row.memTotalKb,
      memUsedKb: row.memUsedKb,
      swapTotalKb: row.swapTotalKb,
      swapUsedKb: row.swapUsedKb,
      diskTotalKb: row.diskTotalKb,
      diskUsedKb: row.diskUsedKb,
      processCount: row.processCount,
      loggedInUsers: row.loggedInUsers,
      error: row.error,
    }),
    status: row.status as ServerStatus,
    memPercent: memPercent !== undefined ? Math.round(memPercent * 100) / 100 : undefined,
    diskPercent: diskPercent !== undefined ? Math.round(diskPercent * 100) / 100 : undefined,
    disks: parseDisks(row.disks),
  };
}

function toAlert(
  row: typeof serverAlerts.$inferSelect,
  serverName?: string,
): ServerAlert {
  return {
    ...nullsToUndefined({
      id: row.id,
      serverId: row.serverId,
      message: row.message,
      value: row.value,
      threshold: row.threshold,
      openedAt: row.openedAt,
      resolvedAt: row.resolvedAt,
      acknowledgedAt: row.acknowledgedAt,
      acknowledgedBy: row.acknowledgedBy,
    }),
    type: row.type as ServerAlert['type'],
    severity: row.severity as ServerAlert['severity'],
    serverName,
  };
}

/** Health for a server that has never been checked yet. */
function unknownHealth(serverId: string, monitoringEnabled: boolean): ServerHealth {
  return {
    serverId,
    status: monitoringEnabled ? 'unknown' : 'paused',
    monitoringEnabled,
    consecutiveFailures: 0,
  };
}

function healthFor(
  server: typeof servers.$inferSelect,
  row: typeof serverHealth.$inferSelect | undefined,
  cpuTrend?: (number | null)[],
): ServerHealthWithServer {
  const base: ServerHealth = row
    ? {
        ...nullsToUndefined({
          serverId: row.serverId,
          lastCheckedAt: row.lastCheckedAt,
          lastOnlineAt: row.lastOnlineAt,
          lastError: row.lastError,
          latencyMs: row.latencyMs,
          uptimeSeconds: row.uptimeSeconds,
          cpuPercent: row.cpuPercent,
          memPercent: row.memPercent,
          diskPercent: row.diskPercent,
          load1: row.load1,
          cpuCores: row.cpuCores,
          osName: row.osName,
          kernel: row.kernel,
          hostname: row.hostname,
          updatedAt: row.updatedAt,
        }),
        status: (server.monitoringEnabled ? row.status : 'paused') as ServerStatus,
        consecutiveFailures: row.consecutiveFailures,
        monitoringEnabled: server.monitoringEnabled,
      }
    : unknownHealth(server.id, server.monitoringEnabled);

  return {
    ...base,
    serverName: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    tags: parseTags(server.tags),
    ...(cpuTrend?.length ? { cpuTrend } : {}),
  };
}

/**
 * Thin a series down to at most `max` points by taking every Nth sample. Keeps
 * the newest point so the chart always ends at "now".
 */
function downsample<T>(rows: T[], max = MAX_POINTS): T[] {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  const kept = rows.filter((_, i) => i % step === 0);
  const last = rows[rows.length - 1]!;
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

export async function monitoringRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** Fleet-wide health, alert feed and counts — the Monitoring page's single fetch. */
  app.get('/overview', async (req): Promise<MonitoringOverview> => {
    const db = getDb();
    const orgServers = db.select().from(servers).where(eq(servers.orgId, req.orgId)).all();

    const healthRows = orgServers.length
      ? db
          .select()
          .from(serverHealth)
          .where(
            inArray(
              serverHealth.serverId,
              orgServers.map((s) => s.id),
            ),
          )
          .all()
      : [];
    const healthByServer = new Map(healthRows.map((h) => [h.serverId, h]));

    // One query for every server's recent CPU readings, grouped in memory —
    // cheaper than a per-server round trip on a fleet of any size.
    const trendFrom = new Date(Date.now() - TREND_WINDOW_HOURS * 3600_000).toISOString();
    const trendRows = orgServers.length
      ? db
          .select({
            serverId: serverMetrics.serverId,
            status: serverMetrics.status,
            cpuPercent: serverMetrics.cpuPercent,
          })
          .from(serverMetrics)
          .where(
            and(eq(serverMetrics.orgId, req.orgId), gte(serverMetrics.collectedAt, trendFrom)),
          )
          .orderBy(asc(serverMetrics.collectedAt))
          .all()
      : [];

    const trendByServer = new Map<string, (number | null)[]>();
    for (const row of trendRows) {
      const points = trendByServer.get(row.serverId) ?? [];
      points.push(row.status === 'online' ? row.cpuPercent : null);
      trendByServer.set(row.serverId, points);
    }

    const list = orgServers
      .map((s) => healthFor(s, healthByServer.get(s.id), trendByServer.get(s.id)?.slice(-TREND_POINTS)))
      .sort((a, b) => a.serverName.localeCompare(b.serverName));

    const openAlerts = db
      .select()
      .from(serverAlerts)
      .where(and(eq(serverAlerts.orgId, req.orgId), isNull(serverAlerts.resolvedAt)))
      .orderBy(desc(serverAlerts.openedAt))
      .limit(50)
      .all();

    const nameById = new Map(orgServers.map((s) => [s.id, s.name]));
    const count = (status: ServerStatus) => list.filter((h) => h.status === status).length;

    return {
      summary: {
        total: list.length,
        online: count('online'),
        offline: count('offline'),
        error: count('error'),
        unknown: count('unknown'),
        paused: count('paused'),
        activeAlerts: openAlerts.length,
      },
      servers: list,
      alerts: openAlerts.map((a) => toAlert(a, nameById.get(a.serverId))),
      intervalSeconds: config.monitoring.intervalSeconds,
    };
  });

  /** Current health plus the newest full sample for one server. */
  app.get('/servers/:id', async (req, reply): Promise<ServerHealthDetail | undefined> => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const server = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!server) return reply.status(404).send({ error: 'Not found' });

    const health = db.select().from(serverHealth).where(eq(serverHealth.serverId, id)).get();
    const latest = db
      .select()
      .from(serverMetrics)
      .where(eq(serverMetrics.serverId, id))
      .orderBy(desc(serverMetrics.collectedAt))
      .limit(1)
      .get();

    const alerts = db
      .select()
      .from(serverAlerts)
      .where(eq(serverAlerts.serverId, id))
      .orderBy(desc(serverAlerts.openedAt))
      .limit(20)
      .all();

    return {
      health: healthFor(server, health),
      latest: latest ? toMetric(latest) : undefined,
      alerts: alerts.map((a) => toAlert(a, server.name)),
    };
  });

  /** Time series for the charts on the server health page. */
  app.get('/servers/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { range } = metricsQuerySchema.parse(req.query);
    const db = getDb();

    const server = db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!server) return reply.status(404).send({ error: 'Not found' });

    const from = new Date(Date.now() - RANGE_HOURS[range] * 3600_000).toISOString();
    const rows = db
      .select()
      .from(serverMetrics)
      .where(and(eq(serverMetrics.serverId, id), gte(serverMetrics.collectedAt, from)))
      .orderBy(asc(serverMetrics.collectedAt))
      .all();

    return { range, from, samples: downsample(rows).map(toMetric) };
  });

  /** Probe a server right now instead of waiting for the next sweep. */
  app.post('/servers/:id/check', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const outcome = await checkServerById(req.orgId, id);
    if (!outcome) return reply.status(404).send({ error: 'Not found' });

    await audit(req, 'server.health_check', 'server', id, undefined, { status: outcome.status });
    return outcome;
  });

  /** Turn monitoring on or off for a server. */
  app.patch('/servers/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = monitoringSettingsSchema.parse(req.body);
    const db = getDb();

    const server = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!server) return reply.status(404).send({ error: 'Not found' });

    db.update(servers)
      .set({ monitoringEnabled: enabled, updatedAt: new Date().toISOString() })
      .where(eq(servers.id, id))
      .run();

    const updated = { ...server, monitoringEnabled: enabled };
    if (enabled) resumeHealth(updated);
    else pauseHealth(updated);

    await audit(req, 'monitoring.update', 'server', id, server.name, { enabled });

    const health = db.select().from(serverHealth).where(eq(serverHealth.serverId, id)).get();
    return healthFor(updated, health);
  });

  app.get('/alerts', async (req) => {
    const { status, limit } = alertsQuerySchema.parse(req.query);
    const db = getDb();

    const where =
      status === 'active'
        ? and(eq(serverAlerts.orgId, req.orgId), isNull(serverAlerts.resolvedAt))
        : eq(serverAlerts.orgId, req.orgId);

    const rows = db
      .select()
      .from(serverAlerts)
      .where(where)
      .orderBy(desc(serverAlerts.openedAt))
      .limit(limit)
      .all();

    const names = new Map(
      db
        .select({ id: servers.id, name: servers.name })
        .from(servers)
        .where(eq(servers.orgId, req.orgId))
        .all()
        .map((s) => [s.id, s.name]),
    );

    return rows.map((a) => toAlert(a, names.get(a.serverId)));
  });

  /** Acknowledge an alert — it stays open but stops demanding attention. */
  app.post('/alerts/:id/acknowledge', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const alert = db
      .select()
      .from(serverAlerts)
      .where(and(eq(serverAlerts.id, id), eq(serverAlerts.orgId, req.orgId)))
      .get();
    if (!alert) return reply.status(404).send({ error: 'Not found' });

    db.update(serverAlerts)
      .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: req.user.email })
      .where(eq(serverAlerts.id, id))
      .run();

    await audit(req, 'alert.acknowledge', 'alert', id, alert.type);
    return toAlert(db.select().from(serverAlerts).where(eq(serverAlerts.id, id)).get()!);
  });
}
