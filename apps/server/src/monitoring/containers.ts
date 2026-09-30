import { and, eq, inArray, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Client } from 'ssh2';
import type { AlertSeverity, AlertType, DockerContainerState, DockerHealth, DockerTransport } from '@smt/shared';
import { getDb } from '../db/index.js';
import { serverAlerts, servers } from '../db/schema.js';
import logger from '../logger.js';
import { notifyAlertsChanged, type AlertEvent } from '../notifications/index.js';
import { DockerClient } from '../docker/client.js';
import { toContainer } from '../docker/objects.js';
import { dockerSettings } from '../docker/settings.js';
import { openDaemonStream } from '../docker/transport.js';
import { apiPath } from '../docker/validation.js';
import type { AlertCondition } from './alerts.js';

/**
 * Container alerts (Docker §4.5). When an org turns them on
 * (`DockerSettings.containerAlerts`, off by default), the health check samples
 * `GET /containers/json?all=1` on servers where Docker was detected, over the
 * probe's own SSH connection (monitoring/probe.ts) — nothing is detected in
 * the background, and a server without Docker is never asked. Three alerts,
 * one open row per (server, container name, type):
 *
 * - `container_unhealthy` — the healthcheck says `unhealthy`;
 * - `container_restarting` — the restart count grew by ≥ 3 within 10 minutes;
 * - `container_exited` — exited non-zero while its restart policy says it
 *   should be running (not `no`). A plain `docker stop` (SIGTERM, or SIGKILL
 *   without an OOM kill) is not a failure.
 *
 * `server_alerts` has no column for the container, so the name leads the
 * message (`web: …`); Docker names cannot contain `:` or spaces, which keeps
 * that unambiguous. Opening and resolving go through the same notification
 * pipeline as host alerts, keyed per container so paging tools keep one
 * incident each.
 */

export const CONTAINER_ALERT_TYPES = ['container_unhealthy', 'container_restarting', 'container_exited'] as const;
export type ContainerAlertType = (typeof CONTAINER_ALERT_TYPES)[number];

export function isContainerAlert(type: string): type is ContainerAlertType {
  return (CONTAINER_ALERT_TYPES as readonly string[]).includes(type);
}

/** Restarts within {@link RESTART_WINDOW_MS} that count as a crash loop. */
export const RESTART_THRESHOLD = 3;
export const RESTART_WINDOW_MS = 10 * 60 * 1000;
/** Containers inspected per server and sweep, at most (the list itself is one call). */
export const MAX_INSPECTS_PER_SWEEP = 20;
/** Leave the probe this much of its time budget, so a slow daemon never makes a host look offline. */
const SAMPLE_TIMEOUT_MS = 10_000;

export interface ContainerCondition extends AlertCondition {
  type: ContainerAlertType;
  container: string;
}

/** One container as the sweep saw it; inspect facts only where it was inspected. */
export interface ContainerSnapshot {
  id: string;
  name: string;
  state: DockerContainerState;
  status: string;
  health: DockerHealth;
  restartCount?: number;
  restartPolicy?: string;
  exitCode?: number | null;
  oomKilled?: boolean;
}

// ── Sampling ──────────────────────────────────────────────────────────────────

/** Restart policy per container id, per server: it rarely changes, so exited containers are inspected once. */
const policies = new Map<string, Map<string, string>>();
/** Restart counts seen per server and container name, oldest first. */
const restartHistory = new Map<string, Map<string, { id: string; samples: { at: number; count: number }[] }>>();

/** Forget what the sweep remembered about a server's containers (alerts turned off, Docker gone). */
export function forgetContainers(serverId: string) {
  policies.delete(serverId);
  restartHistory.delete(serverId);
}

/** `Exited (1) 3 minutes ago` → 1; null when the status does not say. */
export function exitCodeFromStatus(status: string): number | null {
  const m = /^Exited \((-?\d+)\)/.exec(status);
  return m ? Number(m[1]) : null;
}

/**
 * Started within the restart window, going by Docker's status text (`Up 5
 * minutes`). A container up longer cannot have restarted inside the window,
 * so its restart count needs no inspect.
 */
export function startedRecently(status: string): boolean {
  const m = /^Up (Less than a second|About a minute|(\d+) seconds?|(\d+) minutes?)/.exec(status);
  if (!m) return false;
  if (m[3] !== undefined) return Number(m[3]) <= RESTART_WINDOW_MS / 60_000;
  return true;
}

type Json = Record<string, unknown>;

/** Which listed containers need an inspect this sweep, most telling first. */
function toInspect(serverId: string, list: ContainerSnapshot[]): ContainerSnapshot[] {
  const known = policies.get(serverId);
  const rank = (c: ContainerSnapshot): number => {
    if (c.state === 'restarting') return 0;
    if (c.state === 'running' && startedRecently(c.status)) return 1;
    if (c.state === 'exited' || c.state === 'dead') {
      const code = exitCodeFromStatus(c.status);
      if (code === 0) return -1;
      // Exited with a known `no` policy never alerts: nothing to learn
      if (known?.get(c.id) === 'no') return -1;
      return 2;
    }
    return -1;
  };
  return list
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .slice(0, MAX_INSPECTS_PER_SWEEP)
    .map((x) => x.c);
}

/**
 * List the server's containers and inspect the few whose restart count,
 * policy or exit reason matters (see {@link toInspect}). `docker` is any
 * client with `json`, so tests can hand in a stub.
 */
export async function sampleContainers(
  serverId: string,
  docker: Pick<DockerClient, 'json'>,
  signal?: AbortSignal,
): Promise<ContainerSnapshot[]> {
  const raw = await docker.json<Json[]>({ path: '/containers/json', query: { all: true }, signal });
  const list: ContainerSnapshot[] = raw.map((r) => {
    const c = toContainer(r);
    return { id: c.id, name: c.name, state: c.state, status: c.status, health: c.health };
  });

  let known = policies.get(serverId);
  if (!known) policies.set(serverId, (known = new Map()));
  for (const c of toInspect(serverId, list)) {
    try {
      const info = await docker.json<Json>({ path: apiPath('containers', c.id, 'json'), signal });
      const state = (info.State ?? {}) as Json;
      const policy = ((info.HostConfig as Json | undefined)?.RestartPolicy as Json | undefined)?.Name;
      c.restartCount = typeof info.RestartCount === 'number' ? info.RestartCount : undefined;
      c.restartPolicy = typeof policy === 'string' ? policy || 'no' : undefined;
      c.exitCode = typeof state.ExitCode === 'number' ? state.ExitCode : exitCodeFromStatus(c.status);
      c.oomKilled = state.OOMKilled === true;
      if (c.restartPolicy) known.set(c.id, c.restartPolicy);
    } catch (err) {
      // Removed between the list and the inspect, most likely; the next sweep sees it
      if (signal?.aborted) throw err;
    }
  }
  // Fill in what inspects taught earlier sweeps, and drop containers that are gone
  const ids = new Set(list.map((c) => c.id));
  for (const id of [...known.keys()]) if (!ids.has(id)) known.delete(id);
  for (const c of list) if (c.restartPolicy === undefined && known.has(c.id)) c.restartPolicy = known.get(c.id);
  return list;
}

/**
 * Sample containers over the health probe's SSH connection, within its time
 * budget. Resolves null when the daemon did not answer: container alerts then
 * stay as they are rather than resolving on a hiccup.
 */
export async function sampleOverSsh(
  ssh: Client,
  server: { id: string; dockerTransport: string | null; dockerDetectedSocketPath: string | null; dockerApiVersion: string | null },
  timeoutMs = SAMPLE_TIMEOUT_MS,
): Promise<ContainerSnapshot[] | null> {
  if (!server.dockerTransport || !server.dockerDetectedSocketPath || !server.dockerApiVersion) return null;
  const endpoint = { transport: server.dockerTransport as DockerTransport, socketPath: server.dockerDetectedSocketPath };
  const docker = new DockerClient(() => openDaemonStream(ssh, endpoint), server.dockerApiVersion);
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    return await sampleContainers(server.id, docker, deadline);
  } catch (err) {
    logger.debug({ serverId: server.id, err: err instanceof Error ? err.message : String(err) }, 'Container sample failed');
    return null;
  } finally {
    docker.close();
  }
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Restarts of `c` within the window, from its restart counts over the last
 * sweeps. Keeps the history as a side effect: a container not inspected this
 * sweep has not restarted since its last count (it has been up longer than
 * the window), and a new id under the same name (recreated) starts afresh.
 */
function restartsInWindow(serverId: string, c: ContainerSnapshot, now: number): number {
  let byName = restartHistory.get(serverId);
  if (!byName) restartHistory.set(serverId, (byName = new Map()));
  let entry = byName.get(c.name);
  if (!entry || entry.id !== c.id) {
    entry = { id: c.id, samples: [] };
    byName.set(c.name, entry);
  }
  const last = entry.samples.at(-1);
  const count = c.restartCount ?? last?.count;
  if (count === undefined) return 0;
  entry.samples.push({ at: now, count });
  // The oldest sample kept is the baseline: at the window's start, or the first after it
  while (entry.samples.length > 1 && entry.samples[1]!.at <= now - RESTART_WINDOW_MS) entry.samples.shift();
  return count - entry.samples[0]!.count;
}

/** Signals a stop rather than a crash: SIGTERM, or SIGKILL that was not the OOM killer. */
function isStopExit(code: number, oomKilled: boolean | undefined): boolean {
  return code === 143 || (code === 137 && !oomKilled);
}

/**
 * The container conditions that hold now. Updates the restart history kept
 * for `serverId`, so call it once per sample.
 */
export function evaluateContainers(serverId: string, list: ContainerSnapshot[], now = Date.now()): ContainerCondition[] {
  const conditions: ContainerCondition[] = [];
  const names = new Set(list.map((c) => c.name));
  const byName = restartHistory.get(serverId);
  if (byName) for (const name of [...byName.keys()]) if (!names.has(name)) byName.delete(name);

  for (const c of list) {
    if (c.health === 'unhealthy' && c.state === 'running') {
      conditions.push({
        type: 'container_unhealthy',
        container: c.name,
        severity: 'warning',
        message: `${c.name}: health check failing (${c.status})`,
      });
    }

    const restarts = restartsInWindow(serverId, c, now);
    if (restarts >= RESTART_THRESHOLD) {
      conditions.push({
        type: 'container_restarting',
        container: c.name,
        severity: 'critical',
        message: `${c.name}: restarted ${restarts} times in the last ${RESTART_WINDOW_MS / 60_000} minutes`,
        value: restarts,
        threshold: RESTART_THRESHOLD,
      });
    }

    if ((c.state === 'exited' || c.state === 'dead') && c.restartPolicy && c.restartPolicy !== 'no') {
      const code = c.exitCode ?? exitCodeFromStatus(c.status);
      if (code !== null && code !== 0 && !isStopExit(code, c.oomKilled)) {
        conditions.push({
          type: 'container_exited',
          container: c.name,
          severity: 'critical',
          message: `${c.name}: exited with code ${code}${c.oomKilled ? ' (out of memory)' : ''} (restart policy ${c.restartPolicy})`,
          value: code,
        });
      }
    }
  }
  return conditions;
}

// ── Reconciliation ────────────────────────────────────────────────────────────

/** The container an alert row is about: the message's leading `name:`. */
export function containerOfMessage(message: string): string {
  const at = message.indexOf(':');
  return at === -1 ? message : message.slice(0, at);
}

const keyOf = (type: string, container: string) => `${type}\0${container}`;

/**
 * Container alerts for a server, like {@link reconcileAlerts} for host ones:
 * open what started firing, refresh what still fires, resolve the rest — one
 * open row per (container name, type), and notifications only on open and
 * resolve.
 */
export function reconcileContainerAlerts(
  orgId: string,
  serverId: string,
  conditions: ContainerCondition[],
  options: { notify?: boolean } = {},
): { opened: ContainerCondition[]; resolved: { type: ContainerAlertType; container: string }[] } {
  const db = getDb();
  const now = new Date().toISOString();
  const open = db
    .select()
    .from(serverAlerts)
    .where(
      and(
        eq(serverAlerts.serverId, serverId),
        inArray(serverAlerts.type, [...CONTAINER_ALERT_TYPES]),
        isNull(serverAlerts.resolvedAt),
      ),
    )
    .all();
  const openByKey = new Map(open.map((a) => [keyOf(a.type, containerOfMessage(a.message)), a]));
  const opened: ContainerCondition[] = [];
  const firing = new Set<string>();

  for (const condition of conditions) {
    const key = keyOf(condition.type, condition.container);
    if (firing.has(key)) continue;
    firing.add(key);
    const existing = openByKey.get(key);
    if (existing) {
      db.update(serverAlerts)
        .set({ value: condition.value, message: condition.message, severity: condition.severity })
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

  const resolvedRows = open.filter((a) => !firing.has(keyOf(a.type, containerOfMessage(a.message))));
  for (const alert of resolvedRows) {
    db.update(serverAlerts).set({ resolvedAt: now }).where(eq(serverAlerts.id, alert.id)).run();
  }
  const resolved = resolvedRows.map((a) => ({ type: a.type as ContainerAlertType, container: containerOfMessage(a.message) }));

  if (opened.length || resolved.length) {
    logger.info(
      {
        serverId,
        opened: opened.map((c) => `${c.type}:${c.container}`),
        resolved: resolved.map((r) => `${r.type}:${r.container}`),
      },
      'Container alerts changed',
    );
  }

  if (options.notify !== false) {
    const events: AlertEvent[] = [
      ...opened.map((c) => ({
        kind: 'opened' as const,
        orgId,
        serverId,
        type: c.type as AlertType,
        severity: c.severity,
        message: c.message,
        value: c.value,
        threshold: c.threshold,
        container: c.container,
      })),
      ...resolvedRows.map((a) => ({
        kind: 'resolved' as const,
        orgId,
        serverId,
        type: a.type as AlertType,
        severity: a.severity as AlertSeverity,
        message: a.message,
        openedAt: a.openedAt,
        container: containerOfMessage(a.message),
      })),
    ];
    notifyAlertsChanged(events);
  }
  return { opened, resolved };
}

// ── Health check hook ────────────────────────────────────────────────────────

type ServerRow = typeof servers.$inferSelect;

/**
 * Whether this sweep samples the server's containers: the org turned container
 * alerts on, Docker is not off for the server, and it was detected (by
 * someone opening its Docker tab or an admin's probe — never by the sweep).
 */
export function wantsContainerSample(server: ServerRow): boolean {
  if (server.dockerMode !== 'auto') return false;
  if (!server.dockerDetectedAt || !server.dockerTransport || !server.dockerApiVersion) return false;
  return dockerSettings(server.orgId).containerAlerts;
}

/**
 * After a successful health check: evaluate the sample, or, when the server
 * is no longer sampled, close its container alerts quietly (turning the
 * feature off is not an all-clear). `sample` undefined means sampling was
 * wanted but the daemon did not answer — nothing changes then.
 */
export function applyContainerSample(server: ServerRow, wanted: boolean, sample: ContainerSnapshot[] | null | undefined) {
  if (!wanted) {
    forgetContainers(server.id);
    reconcileContainerAlerts(server.orgId, server.id, [], { notify: false });
    return;
  }
  if (!sample) return;
  reconcileContainerAlerts(server.orgId, server.id, evaluateContainers(server.id, sample));
}
