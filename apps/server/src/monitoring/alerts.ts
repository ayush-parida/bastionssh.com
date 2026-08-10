import { and, eq, isNull, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AlertSeverity, AlertType, ServerStatus } from '@smt/shared';
import { getDb } from '../db/index.js';
import { serverAlerts } from '../db/schema.js';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { notifyAlertsChanged, type AlertEvent } from '../notifications/index.js';
import { round2, type ProbeSample } from './probe.js';

export interface AlertCondition {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  value?: number;
  threshold?: number;
}

interface EvaluateInput {
  status: ServerStatus;
  consecutiveFailures: number;
  lastError?: string | null;
  cpuPercent?: number;
  sample?: ProbeSample;
}

/**
 * Escalate a warning to critical once the value is well past the threshold.
 *
 * For metrics with a ceiling (percentages) that means halfway between the
 * threshold and the ceiling — a 1.15× multiplier would land above 100% for the
 * default thresholds and could never fire. Unbounded metrics keep the multiplier.
 */
function severityFor(value: number, threshold: number, ceiling?: number): AlertSeverity {
  const critical =
    ceiling !== undefined ? threshold + (ceiling - threshold) / 2 : threshold * 1.15;
  return value >= critical ? 'critical' : 'warning';
}

/**
 * Decide which alert conditions currently hold for a server. Pure — the caller
 * reconciles the result against what is already open.
 */
export function evaluateConditions(input: EvaluateInput): AlertCondition[] {
  const t = config.monitoring.thresholds;
  const conditions: AlertCondition[] = [];

  if (input.status !== 'online') {
    if (input.consecutiveFailures >= t.offlineFailures) {
      conditions.push({
        type: 'offline',
        severity: 'critical',
        message:
          input.status === 'offline'
            ? `Unreachable for ${input.consecutiveFailures} consecutive checks${input.lastError ? ` — ${input.lastError}` : ''}`
            : `Health check failing: ${input.lastError ?? 'unknown error'}`,
        value: input.consecutiveFailures,
        threshold: t.offlineFailures,
      });
    }
    // A host we cannot reach has no usable resource metrics — stop here.
    return conditions;
  }

  const sample = input.sample;
  if (!sample) return conditions;

  if (input.cpuPercent !== undefined && input.cpuPercent >= t.cpuPercent) {
    conditions.push({
      type: 'cpu_high',
      severity: severityFor(input.cpuPercent, t.cpuPercent, 100),
      message: `CPU at ${input.cpuPercent.toFixed(1)}% (threshold ${t.cpuPercent}%)`,
      value: input.cpuPercent,
      threshold: t.cpuPercent,
    });
  }

  if (sample.memTotalKb && sample.memUsedKb !== undefined) {
    const memPercent = round2((sample.memUsedKb / sample.memTotalKb) * 100);
    if (memPercent >= t.memoryPercent) {
      conditions.push({
        type: 'memory_high',
        severity: severityFor(memPercent, t.memoryPercent, 100),
        message: `Memory at ${memPercent.toFixed(1)}% (threshold ${t.memoryPercent}%)`,
        value: memPercent,
        threshold: t.memoryPercent,
      });
    }
  }

  // Disk alerts consider every real mount, not just the headline one — a full
  // /var matters even when / has room.
  const worstDisk = [...sample.disks].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (worstDisk && worstDisk.usedPercent >= t.diskPercent) {
    conditions.push({
      type: 'disk_high',
      severity: severityFor(worstDisk.usedPercent, t.diskPercent, 100),
      message: `${worstDisk.mount} at ${worstDisk.usedPercent.toFixed(1)}% full (threshold ${t.diskPercent}%)`,
      value: worstDisk.usedPercent,
      threshold: t.diskPercent,
    });
  }

  if (sample.load1 !== undefined && sample.cpuCores) {
    const perCore = round2(sample.load1 / sample.cpuCores);
    if (perCore >= t.loadPerCore) {
      conditions.push({
        type: 'load_high',
        severity: severityFor(perCore, t.loadPerCore),
        message: `Load average ${sample.load1.toFixed(2)} across ${sample.cpuCores} core(s) — ${perCore.toFixed(2)} per core`,
        value: perCore,
        threshold: t.loadPerCore,
      });
    }
  }

  return conditions;
}

export interface ReconcileOptions {
  /** Set false to change alert state without telling anyone (e.g. pausing a server). */
  notify?: boolean;
}

/**
 * Open alerts that just started firing, refresh ones still firing, and resolve
 * the rest. One open row per (server, type) so a flapping metric does not
 * generate a new alert on every sweep.
 *
 * Notifications go out only on the transitions — open and resolve — so a
 * condition that stays true for an hour does not re-notify every sweep.
 */
export function reconcileAlerts(
  orgId: string,
  serverId: string,
  conditions: AlertCondition[],
  options: ReconcileOptions = {},
): { opened: AlertCondition[]; resolved: AlertType[] } {
  const db = getDb();
  const now = new Date().toISOString();

  const open = db
    .select()
    .from(serverAlerts)
    .where(and(eq(serverAlerts.serverId, serverId), isNull(serverAlerts.resolvedAt)))
    .all();

  const openByType = new Map(open.map((a) => [a.type as AlertType, a]));
  const opened: AlertCondition[] = [];
  const resolved: AlertType[] = [];

  for (const condition of conditions) {
    const existing = openByType.get(condition.type);
    if (existing) {
      // Still firing — keep the original openedAt so duration stays meaningful,
      // but track the latest value and any escalation in severity.
      db.update(serverAlerts)
        .set({
          value: condition.value,
          message: condition.message,
          severity:
            existing.severity === 'critical' && condition.severity === 'warning'
              ? 'critical'
              : condition.severity,
        })
        .where(eq(serverAlerts.id, existing.id))
        .run();
      continue;
    }

    db.insert(serverAlerts)
      .values({
        id: nanoid(),
        orgId,
        serverId,
        type: condition.type,
        severity: condition.severity,
        message: condition.message,
        value: condition.value,
        threshold: condition.threshold,
        openedAt: now,
      })
      .run();
    opened.push(condition);
  }

  const firing = new Set(conditions.map((c) => c.type));
  const resolvedRows: typeof open = [];
  for (const alert of open) {
    if (firing.has(alert.type as AlertType)) continue;
    db.update(serverAlerts)
      .set({ resolvedAt: now })
      .where(eq(serverAlerts.id, alert.id))
      .run();
    resolved.push(alert.type as AlertType);
    resolvedRows.push(alert);
  }

  if (opened.length || resolved.length) {
    logger.info(
      { serverId, opened: opened.map((c) => c.type), resolved },
      'Server alerts changed',
    );
  }

  if (options.notify !== false) {
    const events: AlertEvent[] = [
      ...opened.map((c) => ({
        kind: 'opened' as const,
        orgId,
        serverId,
        type: c.type,
        severity: c.severity,
        message: c.message,
        value: c.value,
        threshold: c.threshold,
      })),
      ...resolvedRows.map((a) => ({
        kind: 'resolved' as const,
        orgId,
        serverId,
        type: a.type as AlertType,
        severity: a.severity as AlertSeverity,
        message: a.message,
        openedAt: a.openedAt,
      })),
    ];
    notifyAlertsChanged(events);
  }

  return { opened, resolved };
}

/** Open alerts for an org, newest first. */
export function listActiveAlerts(orgId: string, limit = 50) {
  const db = getDb();
  return db
    .select()
    .from(serverAlerts)
    .where(and(eq(serverAlerts.orgId, orgId), isNull(serverAlerts.resolvedAt)))
    .orderBy(desc(serverAlerts.openedAt))
    .limit(limit)
    .all();
}
