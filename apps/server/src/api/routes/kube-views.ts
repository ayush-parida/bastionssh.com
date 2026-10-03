import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  KUBE_RESOURCES,
  KUBE_WORKLOAD_KINDS,
  kubeResourceOfKind,
  type KubeLogEvent,
  type KubeNamespace,
  type KubeObjectDetail,
  type KubeObjectRef,
  type KubeOverview,
  type KubeResource,
  type KubeStreamEvent,
  type KubeStreamView,
  type KubeWorkload,
  type KubeWorkloadKind,
  type KubeWorkloadList,
} from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { canAccessCluster } from '../../auth/cluster-access.js';
import { snapshotKube, subscribeKube, type CacheSubscription, type ScopeSpec } from '../../kube/cache.js';
import type { KubeObject } from '../../kube/client.js';
import { KubeError } from '../../kube/errors.js';
import { DIAGNOSIS_RESOURCES, GRAPH_RESOURCES } from '../../kube/graph.js';
import { CONFIG_RESOURCES, STORAGE_RESOURCES } from '../../kube/inventory.js';
import { podHealth, workloadHealth } from '../../kube/health.js';
import { nodeUsage } from '../../kube/metrics.js';
import { requireKube } from '../../kube/permissions.js';
import { redactObject } from '../../kube/redact.js';
import { withKubeClient, type KubeContext } from '../../kube/service.js';
import { MAX_STREAMS_PER_USER, activeStreamCount } from '../sse.js';
import { openKubeSse, TOO_MANY_KUBE_STREAMS, type KubeSse } from '../../kube/sse.js';
import { namespaceName, objectRef, objectName, resourceName } from '../../kube/validation.js';
import { OWNED_KINDS, buildOverview, directRelations, objectFacts, podQueryFor, toNamespace, toWorkload } from '../../kube/views.js';
import { clusterParams, recordClusterStatus, sendKubeError } from './kube.js';

/**
 * The views over one cluster (spec §4.2, K1): the cluster map, namespaces,
 * workloads, an object's redacted detail, and the change feed that keeps
 * them live. Lists come from the shared watch cache (kube/cache.ts), so a
 * page of viewers costs the cluster one watch per scope; details are read
 * fresh. Everything passes the cluster's namespace allowlist, and objects
 * leave through redact.ts.
 *
 * Later phases reuse {@link kubeSseRoute} for their own streams and
 * {@link namespaceScopes} to respect the allowlist.
 */

const WORKLOAD_RESOURCE: Record<KubeWorkloadKind, KubeResource> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
  Job: 'jobs',
  CronJob: 'cronjobs',
};

const workloadsQuery = z.object({
  namespace: z.string().max(63).optional(),
  kind: z.enum(KUBE_WORKLOAD_KINDS as [KubeWorkloadKind, ...KubeWorkloadKind[]]).optional(),
});

const objectParams = clusterParams.extend({ resource: z.string(), ns: z.string(), name: z.string() });

const streamQuery = z.object({
  view: z.enum(['overview', 'workloads', 'namespaces', 'object', 'graph', 'events', 'attention', 'storage', 'config']),
  namespace: z.string().max(63).optional(),
  resource: z.string().max(64).optional(),
  name: z.string().max(253).optional(),
});

/** Coalesce change notifications: at most one `changed` per this long. */
const CHANGE_DEBOUNCE_MS = 400;
/** Related pods shown on a detail panel. */
const MAX_RELATED_PODS = 50;

/**
 * The scopes to read `resource` from for the caller: one namespace (checked
 * against the allowlist — anything else is a 404), each allowlisted
 * namespace, or the whole cluster.
 */
export function namespaceScopes(ctx: KubeContext, resource: KubeResource, namespace?: string | null): ScopeSpec[] {
  if (!KUBE_RESOURCES[resource].namespaced) return [{ resource, namespace: null }];
  if (namespace) {
    namespaceName(namespace);
    if (!ctx.namespaceAllowed(namespace)) throw new KubeError('Namespace not found', 404);
    return [{ resource, namespace }];
  }
  return ctx.allowlist ? ctx.allowlist.map((ns) => ({ resource, namespace: ns })) : [{ resource, namespace: null }];
}

const isForbidden = (err: Error | null) => err instanceof KubeError && err.statusCode === 403;

/** A plain-words line for something the credential may not read. */
function forbiddenWarning(resource: KubeResource): string {
  return `The cluster credential may not list ${resource}; they are left out. Grant it read access to show them.`;
}

/** Namespaces the caller may pick: the allowlist, or what the cluster lists (the default one when it may not). */
async function visibleNamespaces(ctx: KubeContext): Promise<{ namespaces: KubeNamespace[]; warning: string | null }> {
  if (ctx.allowlist) {
    return { namespaces: ctx.allowlist.map((name) => ({ name, phase: 'Active', createdAt: null, labels: {} })), warning: null };
  }
  const snap = await snapshotKube(ctx.source, [{ resource: 'namespaces', namespace: null }]);
  const [items] = snap.items;
  if (!items) {
    if (isForbidden(snap.errors[0]!)) {
      return {
        namespaces: [{ name: ctx.cluster.defaultNamespace, phase: 'Active', createdAt: null, labels: {} }],
        warning: 'The cluster credential may not list namespaces; only the default namespace is offered.',
      };
    }
    throw snap.errors[0]!;
  }
  return { namespaces: items.map(toNamespace).sort((a, b) => a.name.localeCompare(b.name)), warning: null };
}

/**
 * A server-sent event route on a cluster. `run` does whatever may still fail
 * with a proper HTTP status, then calls `open()` to start the stream and
 * feeds it until the browser leaves. Errors before `open()` are answered as
 * JSON, after it as an `error` event; the stream is always ended.
 */
export async function kubeSseRoute<E extends KubeLogEvent | KubeStreamEvent = KubeStreamEvent>(
  req: FastifyRequest,
  reply: FastifyReply,
  clusterId: string,
  run: (ctx: KubeContext, open: () => KubeSse<E> | null, signal: AbortSignal) => Promise<void>,
) {
  // The cap counts every feature's streams (api/sse.ts)
  if (activeStreamCount(req.user.id) >= MAX_STREAMS_PER_USER) {
    return reply.status(429).send({ error: TOO_MANY_KUBE_STREAMS });
  }
  const gone = new AbortController();
  reply.raw.on('close', () => gone.abort());

  let sse: KubeSse<E> | null = null;
  const open = () => {
    // Access may have been revoked while the view was being read; a stream registered after that would outlive it
    if (!canAccessCluster(req, clusterId)) throw new KubeError('Cluster not found', 404);
    sse = openKubeSse<E>(req, reply, clusterId);
    sse?.signal.addEventListener('abort', () => gone.abort(), { once: true });
    return sse;
  };
  try {
    await withKubeClient(req, clusterId, (ctx) => run(ctx, open, gone.signal));
  } catch (err) {
    const stream = sse as KubeSse<E> | null;
    if (stream) stream.fail(err);
    else if (!reply.sent && !gone.signal.aborted) return sendKubeError(reply, err);
  } finally {
    (sse as KubeSse<E> | null)?.end();
  }
}

/** The scopes a stream view follows. */
function streamScopes(ctx: KubeContext, q: z.infer<typeof streamQuery>): ScopeSpec[] {
  switch (q.view as KubeStreamView) {
    case 'overview':
      return [{ resource: 'nodes', namespace: null }, ...namespaceScopes(ctx, 'pods')];
    case 'namespaces':
      return ctx.allowlist ? [] : [{ resource: 'namespaces', namespace: null }];
    case 'workloads':
      return Object.values(WORKLOAD_RESOURCE).flatMap((r) => namespaceScopes(ctx, r, q.namespace));
    case 'object': {
      const resource = resourceName(q.resource);
      const info = KUBE_RESOURCES[resource];
      if (info.namespaced && !q.namespace) throw new KubeError('namespace is required', 400);
      // The object's own collection, and the pods around it (owned, selected, or on the node)
      return [
        ...namespaceScopes(ctx, resource, info.namespaced ? q.namespace : null),
        ...namespaceScopes(ctx, 'pods', info.namespaced ? q.namespace : null),
      ];
    }
    // K2 (routes/kube-graph.ts)
    case 'graph':
      return GRAPH_RESOURCES.flatMap((r) => namespaceScopes(ctx, r, q.namespace));
    case 'events':
      return namespaceScopes(ctx, 'events', q.namespace);
    case 'attention':
      return DIAGNOSIS_RESOURCES.flatMap((r) => namespaceScopes(ctx, r, q.namespace));
    case 'storage':
      return STORAGE_RESOURCES.flatMap((r) => namespaceScopes(ctx, r, q.namespace));
    case 'config':
      return CONFIG_RESOURCES.flatMap((r) => namespaceScopes(ctx, r, q.namespace));
  }
}

function related(ref: Omit<KubeObjectRef, 'kind'> & { kind?: string }, relation: string): (KubeObjectRef & { relation: string }) | null {
  const kind = ref.kind ?? KUBE_RESOURCES[ref.resource].kind;
  return { resource: ref.resource, kind, namespace: ref.namespace, name: ref.name, relation };
}

export async function kubeViewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** GET /clusters/:id/overview — the cluster map: nodes with their pods, and pods waiting for a node. */
  app.get('/clusters/:id/overview', { preHandler: requireKube('view') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    try {
      return await withKubeClient(req, id, async (ctx): Promise<KubeOverview> => {
        const podScopes = namespaceScopes(ctx, 'pods');
        const [snap, usage, ns] = await Promise.all([
          snapshotKube(ctx.source, [{ resource: 'nodes', namespace: null }, ...podScopes]),
          nodeUsage(ctx.source.key, ctx.client),
          visibleNamespaces(ctx).catch(() => ({ namespaces: [], warning: null })),
        ]);
        const warnings: string[] = [];
        const nodes = snap.items[0] ?? null;
        const [nodeError, ...podErrors] = snap.errors;
        const podLists = snap.items.slice(1);
        if (!nodes) {
          if (!isForbidden(nodeError!)) throw nodeError!;
          warnings.push('The cluster credential may not list nodes; node capacity is unknown and nodes only appear where pods run.');
        }
        const pods: KubeObject[] = [];
        podLists.forEach((list, i) => {
          if (list) pods.push(...list);
          else if (isForbidden(podErrors[i]!)) {
            const where = podScopes[i]!.namespace;
            warnings.push(`The cluster credential may not list pods${where ? ` in ${where}` : ''}.`);
          } else throw podErrors[i]!;
        });
        if (ns.warning) warnings.push(ns.warning);
        if (ctx.cluster.lastStatus !== 'ok') recordClusterStatus(ctx.cluster.id, true, null);
        return buildOverview({
          clusterId: ctx.cluster.id,
          serverVersion: ctx.cluster.serverVersion,
          nodes,
          pods: pods.filter((p) => ctx.namespaceAllowed(p.metadata.namespace)),
          namespaces: ns.namespaces.map((n) => n.name),
          nodeUsage: usage,
          warnings,
        });
      });
    } catch (err) {
      // Unreachable or refused: the cluster list's health dot says so too
      if (err instanceof KubeError && err.statusCode >= 500) recordClusterStatus(id, false, err.message);
      return sendKubeError(reply, err);
    }
  });

  /** GET /clusters/:id/namespaces */
  app.get('/clusters/:id/namespaces', { preHandler: requireKube('view') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    try {
      return await withKubeClient(req, id, async (ctx) => (await visibleNamespaces(ctx)).namespaces);
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** GET /clusters/:id/workloads?namespace=&kind= — workloads with their health. */
  app.get('/clusters/:id/workloads', { preHandler: requireKube('view') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const q = workloadsQuery.parse(req.query);
    try {
      return await withKubeClient(req, id, async (ctx): Promise<KubeWorkloadList> => {
        const kinds = q.kind ? [q.kind] : [...KUBE_WORKLOAD_KINDS];
        const specs = kinds.flatMap((kind) => namespaceScopes(ctx, WORKLOAD_RESOURCE[kind], q.namespace).map((s) => ({ ...s, kind })));
        const snap = await snapshotKube(ctx.source, specs);
        const workloads: KubeWorkload[] = [];
        const warnings = new Set<string>();
        specs.forEach((spec, i) => {
          const items = snap.items[i];
          if (!items) {
            if (isForbidden(snap.errors[i]!)) warnings.add(forbiddenWarning(spec.resource));
            else throw snap.errors[i]!;
            return;
          }
          for (const item of items) {
            if (!ctx.namespaceAllowed(item.metadata.namespace)) continue;
            workloads.push(toWorkload(spec.kind, item));
          }
        });
        workloads.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
        return { workloads, warnings: [...warnings] };
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /**
   * GET /clusters/:id/objects/:resource/:ns/:name — one object, redacted:
   * facts, labels, health and what it is related to. The read-only YAML is
   * its own endpoint (kube-pods.ts), fetched — and for a Secret audited —
   * only when the YAML tab is opened. `_` stands for "no namespace" on
   * cluster-scoped objects.
   */
  app.get('/clusters/:id/objects/:resource/:ns/:name', { preHandler: requireKube('view') }, async (req, reply) => {
    const params = objectParams.parse(req.params);
    try {
      const ref = objectRef(params.resource, params.ns, params.name);
      return await withKubeClient(req, params.id, async (ctx): Promise<KubeObjectDetail> => {
        if (!ctx.namespaceAllowed(ref.namespace)) throw new KubeError('Not found', 404);
        if (ref.resource === 'namespaces' && !ctx.namespaceAllowed(ref.name)) throw new KubeError('Not found', 404);
        const raw = await ctx.client.get(ref.resource, ref.namespace, ref.name);
        // A volume belongs to the namespace of the claim bound to it
        const claimNamespace = (raw.spec as { claimRef?: { namespace?: unknown } } | undefined)?.claimRef?.namespace;
        if (ref.resource === 'persistentvolumes' && typeof claimNamespace === 'string' && !ctx.namespaceAllowed(claimNamespace)) {
          throw new KubeError('Not found', 404);
        }
        const object = redactObject(
          { ...raw, kind: raw.kind ?? KUBE_RESOURCES[ref.resource].kind },
          { showConfigMapValues: ctx.settings.showConfigMapValues },
        );
        const kind = object.kind!;

        // What it points at, then what points at it (pods it owns or selects, objects it owns)
        const rel = directRelations(object).filter((r) => ctx.namespaceAllowed(r.namespace));
        // A pod's ReplicaSet is a detail: show the Deployment behind it too
        const replicaSet = rel.find((r) => r.relation === 'owned by' && r.kind === 'ReplicaSet');
        if (replicaSet) {
          const rs = await ctx.client.get('replicasets', replicaSet.namespace, replicaSet.name).catch(() => null);
          for (const owner of rs?.metadata.ownerReferences ?? []) {
            const resource = kubeResourceOfKind(owner.kind);
            if (resource) rel.push({ resource, kind: owner.kind, namespace: replicaSet.namespace, name: owner.name, relation: 'owned by' });
          }
        }
        const podQuery = podQueryFor(object);
        if (podQuery) {
          const scopes = namespaceScopes(ctx, 'pods', ref.namespace);
          const lists = await Promise.all(
            scopes.map((s) => ctx.client.list('pods', { namespace: s.namespace, ...podQuery }).catch(() => ({ items: [] as KubeObject[] }))),
          );
          const pods = lists.flatMap((l) => l.items).filter((p) => ctx.namespaceAllowed(p.metadata.namespace));
          for (const pod of pods.slice(0, MAX_RELATED_PODS)) {
            const r = related({ resource: 'pods', namespace: pod.metadata.namespace ?? null, name: pod.metadata.name }, ref.resource === 'nodes' ? 'runs' : ref.resource === 'services' ? 'sends traffic to' : 'owns');
            if (r) rel.push(r);
          }
        }
        const owned = OWNED_KINDS[kind];
        if (owned && ref.namespace) {
          const list = await ctx.client.list(owned, { namespace: ref.namespace }).catch(() => ({ items: [] as KubeObject[] }));
          for (const item of list.items) {
            if ((item.metadata.ownerReferences ?? []).some((o) => o.kind === kind && o.name === ref.name)) {
              const r = related({ resource: owned, namespace: ref.namespace, name: item.metadata.name }, 'owns');
              if (r) rel.push(r);
            }
          }
        }

        const health =
          kind === 'Pod'
            ? podHealth(object).status
            : (KUBE_WORKLOAD_KINDS as readonly string[]).includes(kind)
              ? workloadHealth(kind as KubeWorkloadKind, object).health
              : null;

        return {
          ref: { ...ref, kind },
          health,
          facts: objectFacts(object),
          labels: object.metadata.labels ?? {},
          related: rel,
        };
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /**
   * GET /clusters/:id/stream?view=overview|workloads|namespaces|object — the
   * change feed: `ready` once the view's scopes are listed, then `changed`
   * (coalesced) whenever any of them changes; the browser refetches the
   * view's JSON. Nothing large is pushed.
   */
  app.get('/clusters/:id/stream', { preHandler: requireKube('view') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const q = streamQuery.parse(req.query);
    if (q.view === 'object' && q.name) {
      try {
        objectName(q.name, q.resource as KubeResource);
      } catch (err) {
        return sendKubeError(reply, err);
      }
    }
    return kubeSseRoute(req, reply, id, async (ctx, open, signal) => {
      const specs = streamScopes(ctx, q);
      let sse: KubeSse | null = null;
      const pending = new Set<KubeResource>();
      let timer: NodeJS.Timeout | undefined;
      let fatal: Error | null = null;
      const flush = () => {
        timer = undefined;
        if (!sse || sse.closed || !pending.size) return;
        sse.send({ type: 'changed', resources: [...pending] });
        pending.clear();
      };
      const subs: CacheSubscription[] = [];
      const done = new Promise<void>((resolve) => {
        const finish = () => resolve();
        signal.addEventListener('abort', finish, { once: true });
        for (const spec of specs) {
          const sub = subscribeKube(ctx.source, spec.resource, spec.namespace, (event) => {
            if (event.type === 'error') {
              // Stopped for good (evicted, cluster changed, access changed): end the stream; transient errors are retried
              if (sub.status === 'stopped') {
                fatal = event.error;
                finish();
              }
              return;
            }
            pending.add(event.resource);
            timer ??= setTimeout(flush, CHANGE_DEBOUNCE_MS);
          });
          subs.push(sub);
        }
      });
      try {
        // The first list decides whether the view can be followed at all (JSON errors before the stream starts)
        const ready = await Promise.allSettled(subs.map((s) => s.ready));
        const failed = ready.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed && !isForbidden(failed.reason as Error)) throw failed.reason;
        pending.clear();
        sse = open();
        if (!sse) return;
        sse.send({ type: 'ready' });
        await done;
        if (fatal) throw fatal;
      } finally {
        clearTimeout(timer);
        for (const sub of subs) sub.unsubscribe();
      }
    });
  });
}
