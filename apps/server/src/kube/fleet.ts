import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type {
  AlertSeverity,
  KubeFleetCluster,
  KubeFleetOverview,
  KubeFleetProblem,
  KubePodTileStatus,
  KubeResource,
  KubeWorkloadHealth,
  KubeWorkloadKind,
} from '@smt/shared';
import { filterAccessibleClusters } from '../auth/cluster-access.js';
import { getDb } from '../db/index.js';
import { kubeClusters } from '../db/schema.js';
import { mapPooled } from '../docker/fleet.js';
import { openClusterAlerts } from './alerts.js';
import { snapshotKube, type ScopeSpec } from './cache.js';
import type { KubeClient, KubeObject } from './client.js';
import { KubeError } from './errors.js';
import { workloadHealth } from './health.js';
import { kubeSettings } from './settings.js';
import { withKubeClient, type ClusterRow, type KubeContext } from './service.js';
import { resourcePath } from './validation.js';
import { toNodeCard, toPodTile } from './views.js';

/**
 * The fleet overview (spec §4.2 `GET /api/kube/overview`): every cluster the
 * caller may use, in numbers — nodes ready, pods by tile colour, workloads by
 * health, the worst few problems and any open cluster alerts. Like the Docker
 * fleet view (docker/fleet.ts, whose pool it reuses) it asks a few clusters at
 * a time, each with its own deadline, and answers with whatever came back: a
 * slow or broken cluster is an error on its own row, never a failed page.
 *
 * Each cluster is read through `withKubeClient` and the shared watch cache,
 * so access, impersonation and the namespace allowlist apply as on the
 * cluster's own map, and a cluster someone is already looking at is served
 * from memory.
 */

/** Tunables; tests shorten the deadline. */
export const kubeFleetLimits = {
  /** Clusters asked at once. */
  concurrency: 5,
  /** Per cluster: the route (SSH, agent), the lists and the summary. */
  timeoutMs: 10_000,
  /** Problems listed per cluster. */
  problems: 8,
};

type Caller = Pick<FastifyRequest, 'orgId' | 'user'> & Partial<Pick<FastifyRequest, 'apiTokenReadOnly'>>;

/** Health kinds with replicas worth counting on the overview (Jobs and CronJobs come and go by design). */
export const FLEET_WORKLOADS: { kind: KubeWorkloadKind; resource: KubeResource }[] = [
  { kind: 'Deployment', resource: 'deployments' },
  { kind: 'StatefulSet', resource: 'statefulsets' },
  { kind: 'DaemonSet', resource: 'daemonsets' },
];

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1 };

export interface ClusterObjects {
  /** Null when nodes could not be listed with this credential. */
  nodes: KubeObject[] | null;
  pods: KubeObject[];
  workloads: { kind: KubeWorkloadKind; object: KubeObject }[];
}

/** One cluster's numbers and its worst problems, from its objects. Pure. */
export function summarizeCluster(input: ClusterObjects): Pick<KubeFleetCluster, 'nodes' | 'pods' | 'workloads' | 'problems'> {
  const problems: KubeFleetProblem[] = [];
  const nodes = { total: 0, ready: 0, cordoned: 0 };
  for (const node of input.nodes ?? []) {
    const card = toNodeCard(node, null);
    nodes.total++;
    if (card.ready) nodes.ready++;
    else problems.push({ ref: { resource: 'nodes', kind: 'Node', namespace: null, name: card.name }, severity: 'critical', reason: 'NotReady' });
    if (card.unschedulable) nodes.cordoned++;
    if (card.ready && card.pressures.length) {
      problems.push({ ref: { resource: 'nodes', kind: 'Node', namespace: null, name: card.name }, severity: 'warning', reason: card.pressures.join(', ') });
    }
  }

  const pods: Record<KubePodTileStatus, number> = { running: 0, pending: 0, failing: 0, completed: 0, terminating: 0 };
  for (const pod of input.pods) {
    const tile = toPodTile(pod);
    pods[tile.status]++;
    // Pending pods are often just starting; only those no node will take are a problem worth listing
    if (tile.status === 'failing' || (tile.status === 'pending' && !tile.nodeName)) {
      problems.push({
        ref: { resource: 'pods', kind: 'Pod', namespace: tile.namespace, name: tile.name },
        severity: tile.status === 'failing' ? 'critical' : 'warning',
        reason: tile.reason ?? tile.phase,
      });
    }
  }

  const workloads: Partial<Record<KubeWorkloadHealth, number>> = {};
  for (const { kind, object } of input.workloads) {
    const h = workloadHealth(kind, object);
    workloads[h.health] = (workloads[h.health] ?? 0) + 1;
    if (h.health === 'failed' || h.health === 'degraded') {
      problems.push({
        ref: { resource: FLEET_WORKLOADS.find((w) => w.kind === kind)!.resource, kind, namespace: object.metadata.namespace ?? null, name: object.metadata.name },
        severity: h.health === 'failed' ? 'critical' : 'warning',
        reason: h.summary,
      });
    }
  }

  problems.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      // Nodes and workloads before the pods they explain
      Number(a.ref.kind === 'Pod') - Number(b.ref.kind === 'Pod') ||
      (a.ref.namespace ?? '').localeCompare(b.ref.namespace ?? '') ||
      a.ref.name.localeCompare(b.ref.name),
  );
  return { nodes, pods, workloads, problems: problems.slice(0, kubeFleetLimits.problems) };
}

/** Each allowlisted namespace, or the whole cluster. */
export function clusterScopes(allowlist: string[] | null, resource: KubeResource): ScopeSpec[] {
  return allowlist ? allowlist.map((namespace) => ({ resource, namespace })) : [{ resource, namespace: null }];
}

/** What the overview (and the alert sweep) lists of a cluster: nodes, pods, replicated workloads. */
export function fleetSpecs(allowlist: string[] | null): (ScopeSpec & { kind: KubeWorkloadKind | null })[] {
  return [
    { resource: 'nodes', namespace: null, kind: null },
    ...clusterScopes(allowlist, 'pods').map((s) => ({ ...s, kind: null })),
    ...FLEET_WORKLOADS.flatMap((w) => clusterScopes(allowlist, w.resource).map((s) => ({ ...s, kind: w.kind }))),
  ];
}

const isForbidden = (err: Error | null) => err instanceof KubeError && err.statusCode === 403;

/**
 * Ask the API server now, past the watch cache: once a scope has data, the
 * cache keeps serving its last known objects while it retries a broken watch
 * (cache.ts, rule 4), so a cluster that went away — or a credential that was
 * revoked — would otherwise still read as healthy, from a stale picture. One
 * object of the first scope is enough; a 403 still proves the API server and
 * the credential answer (that scope is then left out, as on the map).
 */
export async function probeCluster(client: KubeClient, specs: ScopeSpec[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const [first] = specs;
  if (!first) return;
  try {
    await client.text({ path: resourcePath(first.resource, { namespace: first.namespace }), query: { limit: 1 }, timeoutMs, signal });
  } catch (err) {
    if (!isForbidden(err as Error)) throw err;
  }
}

/**
 * Read a cluster's objects from a snapshot of {@link fleetSpecs}. Scopes the
 * credential may not list are left out with a warning; any other failure throws.
 */
export function objectsOf(
  specs: ReturnType<typeof fleetSpecs>,
  snap: { items: (KubeObject[] | null)[]; errors: (Error | null)[] },
  namespaceAllowed: (ns: string | null | undefined) => boolean,
): ClusterObjects & { warnings: string[] } {
  const out: ClusterObjects & { warnings: string[] } = { nodes: null, pods: [], workloads: [], warnings: [] };
  const forbidden = new Set<string>();
  specs.forEach((spec, i) => {
    const items = snap.items[i];
    if (!items) {
      const err = snap.errors[i] ?? null;
      if (!isForbidden(err)) throw err ?? new KubeError('The Kubernetes API did not answer', 502);
      forbidden.add(spec.resource);
      return;
    }
    if (spec.resource === 'nodes') out.nodes = items;
    else {
      const visible = items.filter((o) => namespaceAllowed(o.metadata.namespace));
      if (spec.kind) out.workloads.push(...visible.map((object) => ({ kind: spec.kind!, object })));
      else out.pods.push(...visible);
    }
  });
  if (forbidden.size) out.warnings.push(`The cluster credential may not list ${[...forbidden].join(', ')}; they are left out.`);
  return out;
}

function failure(err: unknown): { error: string; code?: string } {
  if (err instanceof KubeError) {
    const body = err.toJSON();
    return { error: body.error, ...('code' in body && body.code ? { code: body.code } : {}) };
  }
  return { error: err instanceof Error ? err.message : 'Could not read the cluster' };
}

function emptyRow(row: ClusterRow): Omit<KubeFleetCluster, 'ok' | 'durationMs'> {
  return {
    clusterId: row.id,
    name: row.name,
    serverVersion: row.serverVersion,
    nodes: { total: 0, ready: 0, cordoned: 0 },
    pods: { running: 0, pending: 0, failing: 0, completed: 0, terminating: 0 },
    workloads: {},
    problems: [],
    alerts: openClusterAlerts(row.id),
    warnings: [],
  };
}

/** One cluster within the deadline, or the reason it could not be read. */
async function readOne(req: Caller, row: ClusterRow, signal?: AbortSignal): Promise<KubeFleetCluster> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let stop = () => {};
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KubeError(`No answer within ${kubeFleetLimits.timeoutMs / 1000} s`, 504)), kubeFleetLimits.timeoutMs);
    stop = () => reject(new KubeError('Request cancelled', 499));
  });
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  try {
    // The race covers the route (an SSH connection or agent tunnel) too; the cache keeps loading
    // in the background, so the next look at this cluster is served from memory
    const summary = await Promise.race([
      withKubeClient(req, row.id, async (ctx: KubeContext) => {
        const specs = fleetSpecs(ctx.allowlist);
        const [snap] = await Promise.all([
          snapshotKube(ctx.source, specs, kubeFleetLimits.timeoutMs),
          probeCluster(ctx.client, specs, kubeFleetLimits.timeoutMs, signal),
        ]);
        const objects = objectsOf(specs, snap, ctx.namespaceAllowed);
        return { ...summarizeCluster(objects), warnings: objects.warnings };
      }),
      timedOut,
    ]);
    return { ...emptyRow(row), ...summary, ok: true, durationMs: Date.now() - started };
  } catch (err) {
    return { ...emptyRow(row), ok: false, ...failure(err), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    timedOut.catch(() => {});
  }
}

/**
 * Every cluster the caller may use, read {@link kubeFleetLimits}.concurrency
 * at a time. `signal` aborts when the browser leaves: clusters not yet asked
 * are not asked at all.
 */
export async function fleetOverview(req: Caller, opts: { signal?: AbortSignal } = {}): Promise<KubeFleetOverview> {
  const rows = filterAccessibleClusters(
    req,
    getDb().select().from(kubeClusters).where(eq(kubeClusters.orgId, req.orgId)).all(),
    (r) => r.id,
  ).sort((a, b) => a.name.localeCompare(b.name));
  const clusters = await mapPooled(
    rows,
    kubeFleetLimits.concurrency,
    (row) => readOne(req, row, opts.signal),
    opts.signal,
    (row) => ({ ...emptyRow(row), ok: false, error: 'Request cancelled', durationMs: 0 }),
  );
  return { clusters, alertsEnabled: kubeSettings(req.orgId).clusterAlerts, generatedAt: new Date().toISOString() };
}
