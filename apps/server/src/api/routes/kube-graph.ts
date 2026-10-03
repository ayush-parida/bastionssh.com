import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  KUBE_RESOURCES,
  type KubeAttentionList,
  type KubeDiagnosis,
  type KubeEventList,
  type KubeGraph,
  type KubeObjectInsight,
  type KubeResource,
} from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { snapshotKube } from '../../kube/cache.js';
import type { KubeClient, KubeObject } from '../../kube/client.js';
import { KubeError } from '../../kube/errors.js';
import { EventIndex, collapseEvents, groupEvents } from '../../kube/events.js';
import { DIAGNOSIS_RESOURCES, GRAPH_RESOURCES, buildGraph, diagnosisInput, type ObjectsByResource } from '../../kube/graph.js';
import { CRASH_NEXT_STEP_WITH_LOGS, diagnose, mergeByOwner, refKey, replicaSetsOf } from '../../kube/health.js';
import { containerLanes, podLifecycle, rolloutOf } from '../../kube/insight.js';
import { requireKube } from '../../kube/permissions.js';
import type { KubeContext } from '../../kube/service.js';
import { withKubeClient } from '../../kube/service.js';
import { objectRef } from '../../kube/validation.js';
import { clusterParams, sendKubeError } from './kube.js';
import { namespaceScopes } from './kube-views.js';

/**
 * Understanding a cluster (spec §4.2, K2): the app topology graph, the events
 * timeline, the "needs attention" list, and an object's insight (diagnoses,
 * its events, the rollout timeline or the pod lifecycle). Everything is read
 * from the shared watch cache (kube/cache.ts) within the cluster's namespace
 * allowlist, so the views and their change feed (`…/stream?view=graph|
 * events|attention` in kube-views.ts) cost the cluster one watch per scope.
 *
 * Nothing here returns a raw object: graph nodes, diagnoses and events carry
 * names, plain fields and words. Secrets appear by name (the cache holds them
 * redacted); the crash-loop log tail is read only for members who may read
 * logs.
 */

const namespaceQuery = z.object({ namespace: z.string().max(63).optional() });

const eventsQuery = namespaceQuery.extend({
  /** `30m`, `6h`, `2d`, or an ISO time: events last seen before it are left out. */
  since: z.string().max(40).optional(),
});

const insightParams = clusterParams.extend({ resource: z.string(), ns: z.string(), name: z.string() });

/** Lines of the attention list. */
const MAX_ATTENTION = 200;
/** Object groups on the events timeline. */
const MAX_EVENT_GROUPS = 300;
/** Event lines on an object's panel. */
const MAX_OBJECT_EVENTS = 50;
/** Crash-looping pods whose log tail is read for one insight. */
const MAX_LOG_TAILS = 3;
const LOG_TAIL_LINES = 20;
const LOG_TAIL_BYTES = 32 * 1024;
const LOG_TAIL_TIMEOUT_MS = 5_000;

/** `30m` / `6h` / `2d` / an ISO time → epoch ms; null when absent. */
export function parseSince(since: string | undefined, now = Date.now()): number | null {
  if (!since) return null;
  const rel = /^(\d{1,5})([smhd])$/.exec(since);
  if (rel) return now - Number(rel[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 's' | 'm' | 'h' | 'd'];
  const at = Date.parse(since);
  if (Number.isNaN(at)) throw new KubeError('since must look like 30m, 6h, 2d or an ISO time', 400);
  return at;
}

/**
 * The objects of `resources` the caller may see — in `namespace`, or every
 * visible one — from the watch cache. A list the credential may not read is
 * null, with a plain-words warning; any other failure fails the view.
 */
export async function readObjects(
  ctx: KubeContext,
  resources: KubeResource[],
  namespace: string | null | undefined,
): Promise<{ objects: ObjectsByResource; warnings: string[] }> {
  const specs = resources.flatMap((resource) => namespaceScopes(ctx, resource, namespace).map((s) => ({ ...s, resource })));
  const snap = await snapshotKube(ctx.source, specs);
  const objects: ObjectsByResource = {};
  const warnings = new Set<string>();
  specs.forEach((spec, i) => {
    const items = snap.items[i];
    if (!items) {
      const err = snap.errors[i]!;
      if (!(err instanceof KubeError && err.statusCode === 403)) throw err;
      objects[spec.resource] = null;
      warnings.add(`The cluster credential may not list ${spec.resource}; they are left out.`);
      return;
    }
    if (objects[spec.resource] === null) return;
    const kind = KUBE_RESOURCES[spec.resource].kind;
    const visible = items
      .filter((o) => ctx.namespaceAllowed(o.metadata.namespace))
      .filter((o) => {
        // A volume belongs to the namespace of the claim bound to it
        if (spec.resource !== 'persistentvolumes') return true;
        const claimNs = (o.spec as { claimRef?: { namespace?: unknown } } | undefined)?.claimRef?.namespace;
        return typeof claimNs !== 'string' || ctx.namespaceAllowed(claimNs);
      })
      // Lists leave out each item's kind; the views read it
      .map((o) => (o.kind ? o : { ...o, kind }));
    objects[spec.resource] = [...(objects[spec.resource] ?? []), ...visible];
  });
  return { objects, warnings: [...warnings] };
}

/** The last lines of a container's previous run; null when they cannot be read (logs not available, timed out…). */
async function logTail(client: KubeClient, namespace: string, pod: string, container: string): Promise<string[] | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LOG_TAIL_TIMEOUT_MS);
  try {
    const res = await client.logs(namespace, pod, { container, previous: true, tailLines: LOG_TAIL_LINES, signal: abort.signal });
    let text = '';
    for await (const chunk of res) {
      text += (chunk as Buffer).toString('utf8');
      if (text.length > LOG_TAIL_BYTES) {
        res.destroy();
        break;
      }
    }
    const lines = text.slice(-LOG_TAIL_BYTES).split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-LOG_TAIL_LINES);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Attach the log tail to crash-loop diagnoses, for members who may read logs. */
async function withLogTails(ctx: KubeContext, diagnoses: KubeDiagnosis[], pods: KubeObject[]): Promise<KubeDiagnosis[]> {
  if (!ctx.permissions.logs) return diagnoses;
  const crashes = diagnoses.filter((d) => d.id === 'crash-loop' && d.subject.kind === 'Pod' && d.subject.namespace).slice(0, MAX_LOG_TAILS);
  await Promise.all(
    crashes.map(async (d) => {
      const pod = pods.find((p) => p.metadata.name === d.subject.name && p.metadata.namespace === d.subject.namespace);
      const statuses = ((pod?.status as { containerStatuses?: { name?: string; state?: { waiting?: { reason?: string } } }[] } | undefined)
        ?.containerStatuses ?? []);
      const container = statuses.find((c) => c.state?.waiting?.reason === 'CrashLoopBackOff')?.name;
      if (!container) return;
      const tail = await logTail(ctx.client, d.subject.namespace!, d.subject.name, container);
      if (tail?.length) {
        d.logTail = tail;
        d.nextStep = CRASH_NEXT_STEP_WITH_LOGS;
      }
    }),
  );
  return diagnoses;
}

export async function kubeGraphRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** GET /clusters/:id/graph?namespace= — the app topology: nodes coloured by health, edges from real relationships. */
  app.get('/clusters/:id/graph', { preHandler: requireKube('view') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const q = namespaceQuery.parse(req.query);
    try {
      return await withKubeClient(req, id, async (ctx): Promise<KubeGraph> => {
        const { objects, warnings } = await readObjects(ctx, GRAPH_RESOURCES, q.namespace);
        const diagnoses = diagnose(diagnosisInput(objects));
        return buildGraph({ namespace: q.namespace ?? null, objects, diagnoses, warnings });
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** GET /clusters/:id/events?namespace=&since= — the events timeline, grouped by object, repeats collapsed. */
  app.get('/clusters/:id/events', { preHandler: requireKube('view') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const q = eventsQuery.parse(req.query);
    try {
      const since = parseSince(q.since);
      return await withKubeClient(req, id, async (ctx): Promise<KubeEventList> => {
        const { objects, warnings } = await readObjects(ctx, ['events'], q.namespace);
        return {
          groups: groupEvents(objects.events ?? [], { since, maxGroups: MAX_EVENT_GROUPS }),
          warnings,
          generatedAt: new Date().toISOString(),
        };
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** GET /clusters/:id/attention?namespace= — problems ranked across namespaces, a workload's pods merged. */
  app.get('/clusters/:id/attention', { preHandler: requireKube('view') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const q = namespaceQuery.parse(req.query);
    try {
      return await withKubeClient(req, id, async (ctx): Promise<KubeAttentionList> => {
        const { objects, warnings } = await readObjects(ctx, DIAGNOSIS_RESOURCES, q.namespace);
        return {
          items: mergeByOwner(diagnose(diagnosisInput(objects))).slice(0, MAX_ATTENTION),
          warnings,
          generatedAt: new Date().toISOString(),
        };
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /**
   * GET /clusters/:id/objects/:resource/:ns/:name/insight — what is wrong
   * with one object (its diagnoses and its pods'), what happened to it (its
   * events, collapsed), and per kind the rollout timeline (Deployment) or the
   * lifecycle strip and container lanes (Pod).
   */
  app.get('/clusters/:id/objects/:resource/:ns/:name/insight', { preHandler: requireKube('view') }, async (req, reply) => {
    const params = insightParams.parse(req.params);
    try {
      const ref = objectRef(params.resource, params.ns, params.name);
      return await withKubeClient(req, params.id, async (ctx): Promise<KubeObjectInsight> => {
        if (!ctx.namespaceAllowed(ref.namespace)) throw new KubeError('Not found', 404);
        if (ref.resource === 'namespaces' && !ctx.namespaceAllowed(ref.name)) throw new KubeError('Not found', 404);
        const kind = KUBE_RESOURCES[ref.resource].kind;
        const resources = [...new Set<KubeResource>([...DIAGNOSIS_RESOURCES, ref.resource, ...(kind === 'Ingress' ? (['services'] as const) : [])])];
        const { objects } = await readObjects(ctx, resources, ref.namespace ?? (ref.resource === 'namespaces' ? ref.name : null));
        const object: KubeObject =
          (objects[ref.resource] ?? []).find((o) => o.metadata.name === ref.name && (o.metadata.namespace ?? null) === ref.namespace) ??
          // Just created, or a list this credential may not read: ask for the object itself (404s propagate)
          { ...(await ctx.client.get<KubeObject>(ref.resource, ref.namespace, ref.name)), kind };
        const claimNamespace = (object.spec as { claimRef?: { namespace?: unknown } } | undefined)?.claimRef?.namespace;
        if (ref.resource === 'persistentvolumes' && typeof claimNamespace === 'string' && !ctx.namespaceAllowed(claimNamespace)) {
          throw new KubeError('Not found', 404);
        }
        const pods = objects.pods ?? [];
        const key = refKey({ kind, namespace: ref.namespace, name: ref.name });

        // Its own problems, its pods' (through whatever controls them), and for an Ingress its Services'
        const direct = new Set(
          pods
            .filter((p) => (p.metadata.ownerReferences ?? []).some((o) => o.kind === kind && o.name === ref.name))
            .map((p) => p.metadata.name),
        );
        const backends = new Set<string>();
        if (kind === 'Ingress') {
          const spec = (object.spec ?? {}) as { defaultBackend?: { service?: { name?: string } }; rules?: { http?: { paths?: { backend?: { service?: { name?: string } } }[] } }[] };
          const names = [spec.defaultBackend?.service?.name, ...(spec.rules ?? []).flatMap((r) => (r.http?.paths ?? []).map((p) => p.backend?.service?.name))];
          for (const n of names) if (n) backends.add(refKey({ kind: 'Service', namespace: ref.namespace, name: n }));
        }
        const mine = diagnose(diagnosisInput(objects)).filter(
          (d) =>
            refKey(d.subject) === key ||
            (d.owner && refKey(d.owner) === key) ||
            (d.subject.kind === 'Pod' && direct.has(d.subject.name)) ||
            backends.has(refKey(d.subject)),
        );
        const diagnoses = await withLogTails(ctx, mine, pods);

        const index = new EventIndex(objects.events ?? []);
        const evs = index.for(kind, ref.namespace, ref.name);
        const replicaSets = objects.replicasets ?? [];
        if (kind === 'Deployment') {
          for (const rs of replicaSetsOf(object, replicaSets)) evs.push(...index.for('ReplicaSet', ref.namespace, rs.metadata.name));
        }
        const insight: KubeObjectInsight = { diagnoses, events: collapseEvents(evs).slice(0, MAX_OBJECT_EVENTS) };
        if (kind === 'Deployment') insight.rollout = rolloutOf(object, replicaSets);
        if (kind === 'Pod') {
          insight.lifecycle = podLifecycle(object, index);
          insight.containers = containerLanes(object);
        }
        return insight;
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });
}
