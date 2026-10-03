import type { AlertSeverity, KubeClusterAlert, KubeClusterAlertType, KubeConnectVia } from '@smt/shared';
import { getDb } from '../db/index.js';
import { kubeClusters } from '../db/schema.js';
import logger from '../logger.js';
import { mapPooled } from '../docker/fleet.js';
import { RESTART_THRESHOLD, RESTART_WINDOW_MS } from '../monitoring/containers.js';
import { notifyAlertsChanged, type AlertEvent } from '../notifications/index.js';
import { snapshotKube, type CacheSource } from './cache.js';
import type { KubeObject } from './client.js';
import { podHealth, workloadHealth } from './health.js';
import { apiEndpoint } from './kubeconfig.js';
import { kubeSettings } from './settings.js';
import { clientFor, clusterCredential, parseAllowlist, type ClusterRow } from './service.js';
import { fleetSpecs, objectsOf, type ClusterObjects } from './fleet.js';

/**
 * Cluster alerts (spec §13.4): when an org turns `clusterAlerts` on (off by
 * default), the health monitor's sweep also reads each of its clusters —
 * nodes, pods and replicated workloads, from the shared watch cache — and
 * raises alerts through the same notification channels as server alerts:
 *
 * - `kube_cluster_unreachable` — the cluster could not be read for
 *   {@link UNREACHABLE_SWEEPS} sweeps in a row (its other alerts then stay
 *   as they are rather than resolving on a hiccup);
 * - `kube_node_not_ready` — a node's Ready condition is not True;
 * - `kube_workload_unavailable` — a Deployment, StatefulSet or DaemonSet
 *   has no ready replicas (or its rollout passed its deadline);
 * - `kube_pod_crashloop` — pods in CrashLoopBackOff, or restarted
 *   {@link RESTART_THRESHOLD}+ times within the Docker alerts' window;
 * - `kube_pod_pending` — pods pending longer than {@link PENDING_THRESHOLD_MS}.
 *
 * Pod alerts are grouped by the workload that owns the pods, so ten crashing
 * replicas are one incident. Dedupe works like the server alerts': one open
 * alert per (cluster, type, object), notifications only when it opens or
 * resolves, and the channels' dedup key (`smt:<cluster>:<type>:<object>`)
 * stays stable, so paging tools keep one incident each. On top of that, an
 * alert that reopens within {@link REOPEN_COOLDOWN_MS} of resolving (a
 * flapping pod) reopens quietly, and its next resolution is quiet too.
 *
 * `server_alerts` belongs to servers (its `server_id` is a foreign key), so
 * cluster alert state is kept in memory; after a restart, alerts still firing
 * are announced again under the same dedup key. The namespace allowlist
 * applies; impersonation does not (nobody is asking — the cluster's own
 * credential reads).
 */

export const UNREACHABLE_SWEEPS = 3;
export const PENDING_THRESHOLD_MS = 10 * 60 * 1000;
export const REOPEN_COOLDOWN_MS = 30 * 60 * 1000;
/** Open alerts per cluster at most (critical first), so a broken cluster cannot flood a channel. */
export const MAX_ALERTS_PER_CLUSTER = 25;

/** Tunables; tests shorten them. */
export const clusterAlertLimits = {
  concurrency: 5,
  timeoutMs: 10_000,
};

export interface ClusterCondition {
  type: KubeClusterAlertType;
  severity: AlertSeverity;
  /** `Node worker-1`, `shop/Deployment web`; '' for the cluster itself. */
  object: string;
  message: string;
  value?: number;
  threshold?: number;
}

interface OpenAlert {
  condition: ClusterCondition;
  openedAt: string;
  /** False when it opened quietly (within the reopen cooldown): its resolution is quiet too. */
  notified: boolean;
}

interface ClusterState {
  orgId: string;
  alerts: Map<string, OpenAlert>;
  /** When each key last resolved, for the reopen cooldown. */
  resolvedAt: Map<string, number>;
  failures: number;
  /** Restart counts per pod (by uid), oldest first. */
  restarts: Map<string, { at: number; count: number }[]>;
}

const state = new Map<string, ClusterState>();

function stateOf(clusterId: string, orgId: string): ClusterState {
  let s = state.get(clusterId);
  if (!s) state.set(clusterId, (s = { orgId, alerts: new Map(), resolvedAt: new Map(), failures: 0, restarts: new Map() }));
  return s;
}

const keyOf = (c: Pick<ClusterCondition, 'type' | 'object'>) => `${c.type}\0${c.object}`;

/** Forget everything about one cluster (or all), without telling anyone. */
export function forgetClusterAlerts(clusterId?: string): void {
  if (clusterId) state.delete(clusterId);
  else state.clear();
}

/** Open alerts of a cluster, most severe first (the fleet overview). */
export function openClusterAlerts(clusterId: string): KubeClusterAlert[] {
  const s = state.get(clusterId);
  if (!s) return [];
  return [...s.alerts.values()]
    .map((a) => ({ type: a.condition.type, severity: a.condition.severity, object: a.condition.object, message: a.condition.message, openedAt: a.openedAt }))
    .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || a.object.localeCompare(b.object));
}

// ── Evaluation ────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v) as Json[]) : []);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * The workload a pod belongs to, for grouping: its controller, with a
 * Deployment's ReplicaSet (`web-7d4f9c`, labelled `pod-template-hash=7d4f9c`)
 * read as the Deployment. A bare pod stands for itself.
 */
export function podOwner(pod: KubeObject): string {
  const ns = pod.metadata.namespace ?? '';
  const refs = pod.metadata.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  if (!ref) return `${ns}/Pod ${pod.metadata.name}`;
  const hash = pod.metadata.labels?.['pod-template-hash'];
  if (ref.kind === 'ReplicaSet' && hash && ref.name.endsWith(`-${hash}`)) {
    return `${ns}/Deployment ${ref.name.slice(0, -hash.length - 1)}`;
  }
  return `${ns}/${ref.kind} ${ref.name}`;
}

/** Restarts of a pod within the window, from the counts seen on earlier sweeps (kept as a side effect). */
function restartsInWindow(history: ClusterState['restarts'], key: string, count: number, now: number): number {
  let samples = history.get(key);
  if (!samples) history.set(key, (samples = []));
  samples.push({ at: now, count });
  while (samples.length > 1 && samples[1]!.at <= now - RESTART_WINDOW_MS) samples.shift();
  return count - samples[0]!.count;
}

/** Since when a pending pod has been waiting: its PodScheduled condition, else its creation. */
function pendingSince(pod: KubeObject): number | null {
  const scheduled = arr(obj(pod.status).conditions).find((c) => c.type === 'PodScheduled');
  const at = str(scheduled?.status === 'False' ? scheduled.lastTransitionTime : null) ?? pod.metadata.creationTimestamp;
  const t = at ? Date.parse(at) : NaN;
  return Number.isNaN(t) ? null : t;
}

interface PodGroup {
  pods: { name: string; detail: string }[];
}

function addTo(groups: Map<string, PodGroup>, owner: string, name: string, detail: string) {
  let g = groups.get(owner);
  if (!g) groups.set(owner, (g = { pods: [] }));
  g.pods.push({ name, detail });
}

function groupMessage(object: string, what: string, group: PodGroup): string {
  const n = group.pods.length;
  const [first] = group.pods;
  return `${object}: ${n} pod${n === 1 ? '' : 's'} ${what} — ${first!.name}: ${first!.detail}${n > 1 ? ` (and ${n - 1} more)` : ''}`;
}

/**
 * The conditions that hold for a cluster now. Updates the restart history
 * kept for `clusterId`, so call it once per sample.
 */
export function evaluateCluster(clusterId: string, orgId: string, input: ClusterObjects, now = Date.now()): ClusterCondition[] {
  const s = stateOf(clusterId, orgId);
  const conditions: ClusterCondition[] = [];

  for (const node of input.nodes ?? []) {
    const ready = arr(obj(node.status).conditions).find((c) => c.type === 'Ready');
    if (ready?.status === 'True') continue;
    const why = str(ready?.reason) ?? (ready ? `Ready is ${str(ready.status) ?? 'Unknown'}` : 'no Ready condition');
    conditions.push({
      type: 'kube_node_not_ready',
      severity: 'critical',
      object: `Node ${node.metadata.name}`,
      message: `Node ${node.metadata.name} is not ready (${why})${str(ready?.message) ? ` — ${str(ready?.message)}` : ''}`,
    });
  }

  for (const { kind, object } of input.workloads) {
    const h = workloadHealth(kind, object);
    if (h.health !== 'failed') continue;
    const name = `${object.metadata.namespace ?? ''}/${kind} ${object.metadata.name}`;
    conditions.push({
      type: 'kube_workload_unavailable',
      severity: 'critical',
      object: name,
      message: `${name}: ${h.summary}`,
      ...(h.desired !== null && { value: h.ready ?? 0, threshold: h.desired }),
    });
  }

  const crashing = new Map<string, PodGroup>();
  const pending = new Map<string, PodGroup>();
  const seen = new Set<string>();
  for (const pod of input.pods) {
    if (pod.metadata.deletionTimestamp) continue;
    const key = pod.metadata.uid ?? `${pod.metadata.namespace}/${pod.metadata.name}`;
    seen.add(key);
    const h = podHealth(pod);
    const recent = restartsInWindow(s.restarts, key, h.restarts, now);
    if (h.reason === 'CrashLoopBackOff' || recent >= RESTART_THRESHOLD) {
      addTo(crashing, podOwner(pod), pod.metadata.name, `${h.reason ?? 'restarting'}, restarted ${h.restarts} times${recent > 0 ? ` (${recent} in the last ${RESTART_WINDOW_MS / 60_000} minutes)` : ''}`);
      continue;
    }
    if (str(obj(pod.status).phase) === 'Pending') {
      const since = pendingSince(pod);
      if (since !== null && now - since >= PENDING_THRESHOLD_MS) {
        const minutes = Math.floor((now - since) / 60_000);
        addTo(pending, podOwner(pod), pod.metadata.name, `${h.reason ?? 'Pending'} for ${minutes} min${h.message ? ` — ${h.message}` : ''}`);
      }
    }
  }
  // Pods that are gone take their history with them
  for (const key of [...s.restarts.keys()]) if (!seen.has(key)) s.restarts.delete(key);

  for (const [object, group] of crashing) {
    conditions.push({
      type: 'kube_pod_crashloop',
      severity: 'critical',
      object,
      message: groupMessage(object, 'crash-looping', group),
      value: group.pods.length,
    });
  }
  for (const [object, group] of pending) {
    conditions.push({
      type: 'kube_pod_pending',
      severity: 'warning',
      object,
      message: groupMessage(object, `pending for over ${PENDING_THRESHOLD_MS / 60_000} minutes`, group),
      value: group.pods.length,
    });
  }

  conditions.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || keyOf(a).localeCompare(keyOf(b)));
  return conditions.slice(0, MAX_ALERTS_PER_CLUSTER);
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export interface ClusterRef {
  id: string;
  orgId: string;
  name: string;
  apiUrl: string;
}

function subjectOf(cluster: ClusterRef) {
  let host = cluster.apiUrl;
  try {
    host = apiEndpoint(cluster.apiUrl).host;
  } catch {
    // keep the URL as it is
  }
  return { id: cluster.id, name: cluster.name, host };
}

function eventOf(cluster: ClusterRef, kind: 'opened' | 'resolved', c: ClusterCondition, openedAt?: string): AlertEvent {
  return {
    kind,
    orgId: cluster.orgId,
    serverId: cluster.id,
    type: c.type,
    severity: c.severity,
    message: c.message,
    ...(c.value !== undefined && { value: c.value }),
    ...(c.threshold !== undefined && { threshold: c.threshold }),
    ...(openedAt && { openedAt }),
    ...(c.object && { container: c.object }),
    subject: subjectOf(cluster),
  };
}

/**
 * Open what started firing, refresh what still fires, resolve the rest —
 * one open alert per (type, object), notifications only on the transitions
 * (and not for quiet reopens, see the module comment).
 */
export function reconcileClusterAlerts(
  cluster: ClusterRef,
  conditions: ClusterCondition[],
  options: { notify?: boolean; now?: number } = {},
): { opened: ClusterCondition[]; resolved: ClusterCondition[] } {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const s = stateOf(cluster.id, cluster.orgId);
  const opened: ClusterCondition[] = [];
  const events: AlertEvent[] = [];
  const firing = new Set<string>();

  for (const c of conditions) {
    const key = keyOf(c);
    if (firing.has(key)) continue;
    firing.add(key);
    const existing = s.alerts.get(key);
    if (existing) {
      existing.condition = {
        ...c,
        // Still firing: a critical alert does not quietly drop to a warning
        severity: existing.condition.severity === 'critical' ? 'critical' : c.severity,
      };
      continue;
    }
    const lastResolved = s.resolvedAt.get(key);
    const notified = lastResolved === undefined || now - lastResolved >= REOPEN_COOLDOWN_MS;
    s.alerts.set(key, { condition: c, openedAt: at, notified });
    opened.push(c);
    if (notified) events.push(eventOf(cluster, 'opened', c));
  }

  const resolved: ClusterCondition[] = [];
  for (const [key, alert] of [...s.alerts]) {
    if (firing.has(key)) continue;
    s.alerts.delete(key);
    s.resolvedAt.set(key, now);
    resolved.push(alert.condition);
    if (alert.notified) events.push(eventOf(cluster, 'resolved', alert.condition, alert.openedAt));
  }
  for (const [key, t] of [...s.resolvedAt]) if (now - t >= REOPEN_COOLDOWN_MS) s.resolvedAt.delete(key);

  if (opened.length || resolved.length) {
    logger.info(
      {
        clusterId: cluster.id,
        opened: opened.map((c) => `${c.type}:${c.object}`),
        resolved: resolved.map((c) => `${c.type}:${c.object}`),
      },
      'Cluster alerts changed',
    );
  }
  if (options.notify !== false) notifyAlertsChanged(events);
  return { opened, resolved };
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

/**
 * The cache source the sweep reads a cluster through: the cluster's own
 * credential, no impersonation. For clusters without impersonation that is
 * the same cache the viewers share, so the sweep keeps it warm.
 */
export async function systemCacheSource(row: ClusterRow): Promise<CacheSource> {
  const credential = await clusterCredential(row);
  return {
    key: `${row.id}@${row.updatedAt}`,
    orgId: row.orgId,
    clusterId: row.id,
    identityUserId: null,
    client: () =>
      clientFor({
        orgId: row.orgId,
        apiUrl: row.apiUrl,
        caData: row.caData,
        credential,
        connectVia: row.connectVia as KubeConnectVia,
        viaServerId: row.viaServerId,
        viaAgentId: row.viaAgentId,
        impersonate: null,
      }),
  };
}

/**
 * Read one cluster for the sweep within the deadline: its objects, or null
 * when it could not be read (a scope the credential may not list is simply
 * left out, as on the map).
 */
async function readForAlerts(row: ClusterRow): Promise<ClusterObjects | null> {
  const allowlist = parseAllowlist(row.namespacesAllowlist);
  const allowed = allowlist ? new Set(allowlist) : null;
  const specs = fleetSpecs(allowlist);
  let timer: NodeJS.Timeout | undefined;
  try {
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), clusterAlertLimits.timeoutMs);
    });
    const read = (async () => {
      const snap = await snapshotKube(await systemCacheSource(row), specs, clusterAlertLimits.timeoutMs);
      return objectsOf(specs, snap, (ns) => !allowed || !ns || allowed.has(ns));
    })();
    read.catch(() => {});
    return await Promise.race([read, timedOut]);
  } catch (err) {
    logger.debug({ clusterId: row.id, err: err instanceof Error ? err.message : String(err) }, 'Cluster alert read failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One cluster's sweep: evaluate what it shows, or count a failed read. */
export async function sweepCluster(row: ClusterRow, read: (row: ClusterRow) => Promise<ClusterObjects | null> = readForAlerts): Promise<void> {
  const s = stateOf(row.id, row.orgId);
  const objects = await read(row);
  const cluster: ClusterRef = { id: row.id, orgId: row.orgId, name: row.name, apiUrl: row.apiUrl };
  if (!objects) {
    s.failures++;
    if (s.failures < UNREACHABLE_SWEEPS) return;
    // Unreachable: what was firing stays as it was; the cluster itself is the alert
    const kept = [...s.alerts.values()].map((a) => a.condition).filter((c) => c.type !== 'kube_cluster_unreachable');
    reconcileClusterAlerts(cluster, [
      {
        type: 'kube_cluster_unreachable',
        severity: 'critical',
        object: '',
        message: `The cluster could not be read for ${s.failures} checks in a row`,
        value: s.failures,
        threshold: UNREACHABLE_SWEEPS,
      },
      ...kept,
    ]);
    return;
  }
  s.failures = 0;
  reconcileClusterAlerts(cluster, evaluateCluster(row.id, row.orgId, objects));
}

let sweeping = false;

/**
 * Check every cluster of the orgs that turned cluster alerts on, a few at a
 * time. Clusters of other orgs, and removed clusters, are forgotten quietly
 * (turning alerts off is not an all-clear). Called from the health monitor.
 */
export async function sweepClusterAlerts(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const rows = getDb().select().from(kubeClusters).all();
    const enabled = new Map<string, boolean>();
    const wanted = rows.filter((row) => {
      if (!enabled.has(row.orgId)) enabled.set(row.orgId, kubeSettings(row.orgId).clusterAlerts);
      return enabled.get(row.orgId);
    });
    const ids = new Set(wanted.map((r) => r.id));
    for (const id of [...state.keys()]) if (!ids.has(id)) state.delete(id);
    if (!wanted.length) return;
    await mapPooled(wanted, clusterAlertLimits.concurrency, (row) =>
      sweepCluster(row).catch((err: unknown) => logger.warn({ clusterId: row.id, err }, 'Cluster alert sweep failed')),
    );
  } finally {
    sweeping = false;
  }
}
