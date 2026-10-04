import type { FastifyRequest } from 'fastify';
import { stringify as toYaml } from 'yaml';
import {
  KUBE_CLUSTER_SCOPE,
  KUBE_RESOURCES,
  KUBE_WORKLOAD_KINDS,
  type KubeExplainContext,
  type KubeObjectRef,
  type KubeResource,
  type KubeWorkloadKind,
} from '@smt/shared';
import { aiTail, keepHead, keepTail, TRUNCATED_MARKER } from '../docker/ai-tools.js';
import { snapshotKube, type ScopeSpec } from './cache.js';
import type { KubeObject } from './client.js';
import { KubeError } from './errors.js';
import { podHealth, workloadHealth } from './health.js';
import { redactObject } from './redact.js';
import { withKubeClient, type KubeContext } from './service.js';
import { isDns1123Label, namespaceName, objectRef, resourcePath } from './validation.js';
import { podQueryFor, toPodTile, toWorkload } from './views.js';

/**
 * What the AI sees of a cluster (spec §5.4 "Explain", K5 read-only tools):
 * plain text built through `withKubeClient` like every Kubernetes route, so
 * cluster access (404 for clusters a restricted member was not granted),
 * the namespace allowlist and the §7 matrix apply exactly as in the UI.
 *
 * - Objects always pass redact.ts first: Secret values never reach the
 *   model, and the last-applied annotation (a second copy of the manifest)
 *   is dropped for size.
 * - Logs need the `logs` capability (operators and up) and are capped like
 *   the Docker tools: a bounded tail, a byte limit asked of the API server,
 *   and the newest lines kept when over the shared output cap.
 * - Nothing here changes the cluster. The assistant never performs
 *   Kubernetes actions; the guided buttons do (K3).
 */

type Caller = Pick<FastifyRequest, 'orgId' | 'user'> & Partial<Pick<FastifyRequest, 'apiTokenReadOnly'>>;
type Json = Record<string, unknown>;

/** Events returned by `kube_events` by default, and at most. */
export const AI_DEFAULT_EVENTS = 50;
export const AI_MAX_EVENTS = 200;
/** Bytes asked of the API server for one log read (`limitBytes`); the tail is cut from these. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOGS_TIMEOUT_MS = 20_000;

/** For an explanation: how much of each part goes to the provider. */
export const explainLimits = {
  objectChars: 24_000,
  events: 30,
  logLines: 60,
  logChars: 8_000,
  pods: 5,
};

const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v) as Json[]) : []);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const WORKLOAD_RESOURCE: Record<KubeWorkloadKind, KubeResource> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
  Job: 'jobs',
  CronJob: 'cronjobs',
};

const isWorkloadKind = (kind: string | undefined): kind is KubeWorkloadKind =>
  !!kind && (KUBE_WORKLOAD_KINDS as readonly string[]).includes(kind);

/** The scopes to read a namespaced resource from: one namespace (allowlist-checked), each allowlisted one, or all. */
function scopesFor(ctx: KubeContext, resource: KubeResource, namespace?: string | null): ScopeSpec[] {
  if (!KUBE_RESOURCES[resource].namespaced) return [{ resource, namespace: null }];
  if (namespace) {
    namespaceName(namespace);
    if (!ctx.namespaceAllowed(namespace)) throw new KubeError('Namespace not found', 404);
    return [{ resource, namespace }];
  }
  return ctx.allowlist ? ctx.allowlist.map((ns) => ({ resource, namespace: ns })) : [{ resource, namespace: null }];
}

/** A namespace argument from the model: '' and absent mean "all". */
function optionalNamespace(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return namespaceName(value);
}

/** An object for the model: redacted like the YAML view, without the manifest copy. */
export function aiObject(object: KubeObject, showConfigMapValues: boolean): KubeObject {
  const redacted = redactObject(object, { showConfigMapValues });
  const annotations = redacted.metadata.annotations;
  if (!annotations?.['kubectl.kubernetes.io/last-applied-configuration']) return redacted;
  const { 'kubectl.kubernetes.io/last-applied-configuration': _manifest, ...rest } = annotations;
  return { ...redacted, metadata: { ...redacted.metadata, annotations: rest } };
}

/** Health in a line, for the kinds that have one. */
function healthLine(o: KubeObject): string | null {
  if (o.kind === 'Pod') {
    const h = podHealth(o);
    return `${h.status}${h.reason ? ` (${h.reason})` : ''} — ${h.readyContainers}/${h.totalContainers} containers ready, ${h.restarts} restarts${h.message ? ` — ${h.message}` : ''}`;
  }
  if (isWorkloadKind(o.kind)) {
    const h = workloadHealth(o.kind, o);
    return `${h.health} — ${h.summary}`;
  }
  return null;
}

// ── kube_list_workloads ──────────────────────────────────────

/** Workloads with their health, and the pods that are not running cleanly. */
export async function aiListWorkloads(caller: Caller, clusterId: string, namespaceArg?: unknown): Promise<string> {
  const namespace = optionalNamespace(namespaceArg);
  return withKubeClient(caller, clusterId, async (ctx) => {
    const kinds = [...KUBE_WORKLOAD_KINDS];
    const specs = [
      ...kinds.flatMap((kind) => scopesFor(ctx, WORKLOAD_RESOURCE[kind], namespace).map((s) => ({ ...s, kind }))),
      ...scopesFor(ctx, 'pods', namespace).map((s) => ({ ...s, kind: null })),
    ];
    const snap = await snapshotKube(ctx.source, specs);
    const workloads: string[] = [];
    const pods: KubeObject[] = [];
    const unreadable = new Set<string>();
    specs.forEach((spec, i) => {
      const items = snap.items[i];
      if (!items) {
        const err = snap.errors[i];
        if (err instanceof KubeError && err.statusCode === 403) unreadable.add(spec.resource);
        else throw err!;
        return;
      }
      for (const item of items) {
        if (!ctx.namespaceAllowed(item.metadata.namespace)) continue;
        if (spec.kind) {
          const w = toWorkload(spec.kind, item);
          workloads.push(
            `- ${w.namespace}/${w.kind} ${w.name}: ${w.health} — ${w.summary}${w.images.length ? ` · images ${w.images.join(', ')}` : ''}`,
          );
        } else pods.push(item);
      }
    });
    workloads.sort();
    const tiles = pods.map(toPodTile);
    const counts = new Map<string, number>();
    for (const t of tiles) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    const troubled = tiles
      .filter((t) => t.status === 'failing' || t.status === 'pending')
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
      .map(
        (t) =>
          `- ${t.namespace}/${t.name}: ${t.status}${t.reason ? ` (${t.reason})` : ''}, ${t.restarts} restarts${t.nodeName ? `, node ${t.nodeName}` : ', not scheduled'}${t.message ? ` — ${t.message}` : ''}`,
      );
    const lines = [
      `Cluster ${ctx.cluster.name} (id ${ctx.cluster.id}), ${namespace ? `namespace ${namespace}` : ctx.allowlist ? `namespaces ${ctx.allowlist.join(', ')}` : 'all namespaces'}.`,
      '',
      'Workloads:',
      ...(workloads.length ? workloads : ['(none)']),
      '',
      `Pods: ${[...counts.entries()].map(([s, n]) => `${n} ${s}`).join(', ') || 'none'}.`,
      ...(troubled.length ? ['Pods not running cleanly:', ...troubled] : []),
      ...(unreadable.size ? ['', `The cluster credential may not list: ${[...unreadable].join(', ')}.`] : []),
    ];
    return keepHead(lines.join('\n'));
  });
}

// ── kube_describe ────────────────────────────────────────────

/** A validated object reference from the model's arguments (cluster-scoped kinds take no namespace). */
export function aiObjectRef(resource: unknown, namespace: unknown, name: unknown) {
  const isClusterScoped = typeof resource === 'string' && resource in KUBE_RESOURCES && !KUBE_RESOURCES[resource as KubeResource].namespaced;
  return objectRef(resource, isClusterScoped || namespace === undefined || namespace === null || namespace === '' ? KUBE_CLUSTER_SCOPE : namespace, name);
}

/** Read one object the caller may see, or 404 — the same rules as the detail panel. */
async function readObject(ctx: KubeContext, ref: { resource: KubeResource; namespace: string | null; name: string }): Promise<KubeObject> {
  if (!ctx.namespaceAllowed(ref.namespace)) throw new KubeError('Not found', 404);
  if (ref.resource === 'namespaces' && !ctx.namespaceAllowed(ref.name)) throw new KubeError('Not found', 404);
  const raw = await ctx.client.get(ref.resource, ref.namespace, ref.name);
  const claimNamespace = str(obj(obj(raw.spec).claimRef).namespace);
  if (ref.resource === 'persistentvolumes' && claimNamespace && !ctx.namespaceAllowed(claimNamespace)) throw new KubeError('Not found', 404);
  return { ...raw, kind: raw.kind ?? KUBE_RESOURCES[ref.resource].kind };
}

/** One object, redacted, as YAML with its health on top. Needs the `yaml` capability, like the YAML view. */
export async function aiDescribe(caller: Caller, clusterId: string, resource: unknown, namespace: unknown, name: unknown): Promise<string> {
  const ref = aiObjectRef(resource, namespace, name);
  return withKubeClient(caller, clusterId, async (ctx) => {
    if (!ctx.permissionsIn(ref.namespace).yaml) throw new KubeError('Describing objects needs operate access here', 403);
    const object = aiObject(await readObject(ctx, ref), ctx.settings.showConfigMapValues);
    const health = healthLine(object);
    const head = `${object.kind} ${ref.namespace ? `${ref.namespace}/` : ''}${ref.name}${health ? `\nHealth: ${health}` : ''}`;
    const note = object.kind === 'Secret' ? '\nSecret values are never shown; only the keys are listed.' : '';
    return keepHead(`${head}${note}\n\n${toYaml(object, { lineWidth: 0 })}`);
  });
}

// ── kube_events ──────────────────────────────────────────────

export interface EventLine {
  at: string;
  type: string;
  reason: string;
  object: string;
  message: string;
  count: number;
}

/** An Event as one line's worth of facts. */
export function toEventLine(e: KubeObject): EventLine {
  const involved = obj(e.involvedObject);
  const series = obj(e.series);
  return {
    at:
      str(series.lastObservedTime) ??
      str(e.lastTimestamp) ??
      str(e.eventTime) ??
      str(e.firstTimestamp) ??
      e.metadata.creationTimestamp ??
      '',
    type: str(e.type) ?? 'Normal',
    reason: str(e.reason) ?? '',
    object: `${str(involved.kind) ?? '?'}/${str(involved.name) ?? '?'}`,
    message: (str(e.message) ?? '').trim(),
    count: Math.max(1, num(series.count) || num(e.count)),
  };
}

export function formatEvents(events: EventLine[]): string {
  if (!events.length) return 'No events.';
  return events
    .map((e) => `[${e.at || '?'}] ${e.type} ${e.reason} ${e.object}: ${e.message}${e.count > 1 ? ` (×${e.count})` : ''}`)
    .join('\n');
}

/** Events (newest first) in the caller's namespaces, optionally about one object. */
async function readEvents(
  ctx: KubeContext,
  opts: { namespace: string | null; kind?: string; name?: string; limit: number },
): Promise<EventLine[]> {
  const fieldSelector = [opts.name && `involvedObject.name=${opts.name}`, opts.kind && `involvedObject.kind=${opts.kind}`]
    .filter(Boolean)
    .join(',');
  const scopes = scopesFor(ctx, 'events', opts.namespace);
  const lists = await Promise.all(
    scopes.map((s) => ctx.client.list('events', { namespace: s.namespace, ...(fieldSelector && { fieldSelector }) })),
  );
  return lists
    .flatMap((l) => l.items)
    .filter((e) => ctx.namespaceAllowed(e.metadata.namespace))
    // The field selector already did this; proxies and old servers that ignore it do not get to widen the answer
    .filter((e) => {
      const involved = obj(e.involvedObject);
      return (!opts.name || involved.name === opts.name) && (!opts.kind || involved.kind === opts.kind);
    })
    .map(toEventLine)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, opts.limit);
}

export function aiEventLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return AI_DEFAULT_EVENTS;
  return Math.min(AI_MAX_EVENTS, Math.max(1, Math.floor(n)));
}

/** Recent events, newest first: a namespace's, or one object's. */
export async function aiEvents(
  caller: Caller,
  clusterId: string,
  opts: { namespace?: unknown; resource?: unknown; name?: unknown; limit?: unknown } = {},
): Promise<string> {
  const limit = aiEventLimit(opts.limit);
  const ref = opts.name !== undefined && opts.name !== '' ? aiObjectRef(opts.resource, opts.namespace, opts.name) : null;
  const namespace = ref ? ref.namespace : optionalNamespace(opts.namespace);
  return withKubeClient(caller, clusterId, async (ctx) => {
    const events = await readEvents(ctx, {
      namespace,
      ...(ref && { kind: KUBE_RESOURCES[ref.resource].kind, name: ref.name }),
      limit,
    });
    return keepHead(formatEvents(events));
  });
}

// ── kube_pod_logs ────────────────────────────────────────────

/** The last `tail` lines of a container's log, through the API server's own limits. */
async function readLogTail(
  ctx: KubeContext,
  namespace: string,
  pod: string,
  opts: { container?: string; previous?: boolean; tail: number },
): Promise<string> {
  const text = await ctx.client.text({
    path: resourcePath('pods', { namespace, name: pod, subresource: 'log' }),
    query: {
      container: opts.container,
      previous: opts.previous || undefined,
      tailLines: opts.tail,
      limitBytes: MAX_LOG_BYTES,
    },
    timeoutMs: LOGS_TIMEOUT_MS,
  });
  // A partial last line (limitBytes cut it) is dropped with the oldest ones
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-opts.tail).join('\n');
}

/** A pod's recent log lines. Needs the `logs` capability (operators and up), like the logs tab. */
export async function aiPodLogs(
  caller: Caller,
  clusterId: string,
  namespaceArg: unknown,
  podArg: unknown,
  opts: { container?: unknown; previous?: unknown; tail?: unknown } = {},
): Promise<string> {
  const ref = aiObjectRef('pods', namespaceArg, podArg);
  if (!ref.namespace) throw new KubeError('namespace is required', 400);
  const container = opts.container === undefined || opts.container === '' ? undefined : opts.container;
  if (container !== undefined && (typeof container !== 'string' || !isDns1123Label(container))) {
    throw new KubeError('Invalid container name', 400);
  }
  const tail = aiTail(opts.tail);
  return withKubeClient(caller, clusterId, async (ctx) => {
    if (!ctx.permissionsIn(ref.namespace).logs) throw new KubeError('Pod logs need operate access here', 403);
    if (!ctx.namespaceAllowed(ref.namespace)) throw new KubeError('Not found', 404);
    const text = await readLogTail(ctx, ref.namespace!, ref.name, { container, previous: opts.previous === true, tail });
    if (!text.trim()) return opts.previous === true ? 'No log output from the previous run.' : 'No log output.';
    return keepTail(text);
  });
}

// ── Explain ──────────────────────────────────────────────────

/** Instructions for the explanation. The model never acts; it explains and suggests. */
export const EXPLAIN_SYSTEM_PROMPT = [
  'You are BastionSSH’s Kubernetes explainer. The reader may not know kubectl or Kubernetes internals.',
  'From the object, its health, related events, pod states and log lines given to you, explain in plain language:',
  '1. a one-line headline of what is going on (or that it looks healthy);',
  '2. the most likely cause, pointing at the evidence (an event, an exit code, a log line);',
  '3. what to do next, as short steps. Prefer BastionSSH’s guided buttons (scale, restart rollout, roll back, delete pod, cordon) and its logs view over commands; when a command helps, show it as an example only.',
  'You cannot perform actions. Secret values have been removed on purpose (shown as ••••); never ask for them.',
  'Be concise: at most about 250 words, Markdown, no preamble.',
].join('\n');

export interface ExplainMaterial {
  /** The user message for the provider. */
  prompt: string;
  /** What it holds, for the person and the audit log. */
  context: Omit<KubeExplainContext, 'provider'>;
}

/** The container worth reading logs of: not ready or restarting, else the first one. */
function logTarget(pod: KubeObject): { container: string; previous: boolean } | null {
  const statuses = arr(obj(pod.status).containerStatuses);
  const troubled = statuses.find((c) => c.ready !== true || num(c.restartCount) > 0) ?? statuses[0];
  const name = str(troubled?.name) ?? str(arr(obj(pod.spec).containers)[0]?.name);
  if (!name || !isDns1123Label(name)) return null;
  // Crash-looping: the current run is barely started, the previous one says why it died
  const waiting = str(obj(obj(troubled?.state).waiting).reason);
  const previous = !!troubled && num(troubled.restartCount) > 0 && (waiting === 'CrashLoopBackOff' || !!obj(obj(troubled.lastState).terminated).reason);
  return { container: name, previous };
}

/**
 * Everything an explanation of `ref` sends to the AI provider: the redacted
 * object, its health, events about it (and its troubled pods), the status
 * of a workload's troubled pods, and — when the caller may read logs — a
 * short log tail of the first troubled pod. Built from the same reads as
 * the detail panel, so the allowlist and redaction apply.
 */
export async function explainMaterial(
  ctx: KubeContext,
  ref: { resource: KubeResource; namespace: string | null; name: string },
): Promise<ExplainMaterial> {
  const object = aiObject(await readObject(ctx, ref), ctx.settings.showConfigMapValues);
  const kind = object.kind!;
  const fullRef: KubeObjectRef = { ...ref, kind };
  const sections: string[] = [];
  const objectText = toYaml(object, { lineWidth: 0 });
  sections.push(
    `## ${kind} ${ref.namespace ? `${ref.namespace}/` : ''}${ref.name} (cluster ${ctx.cluster.name})`,
    ...(healthLine(object) ? [`Health: ${healthLine(object)}`] : []),
    '',
    '### Object (redacted YAML)',
    '```yaml',
    objectText.length > explainLimits.objectChars ? `${objectText.slice(0, explainLimits.objectChars)}\n# ${TRUNCATED_MARKER}` : objectText,
    '```',
  );

  // The pods behind a workload or service (a pod is its own)
  let pods: KubeObject[] = kind === 'Pod' ? [object] : [];
  const podQuery = kind === 'Pod' ? null : podQueryFor(object);
  if (podQuery && ref.namespace) {
    const list = await ctx.client.list('pods', { namespace: ref.namespace, ...podQuery }).catch(() => ({ items: [] as KubeObject[] }));
    pods = list.items;
  }
  const troubled = pods
    .map((p) => ({ pod: p, h: podHealth(p) }))
    .filter(({ h }) => h.status === 'failing' || h.status === 'pending' || h.restarts > 0)
    .sort((a, b) => Number(b.h.status === 'failing') - Number(a.h.status === 'failing') || b.h.restarts - a.h.restarts)
    .slice(0, explainLimits.pods);
  if (kind !== 'Pod' && pods.length) {
    sections.push(
      '',
      `### Pods (${pods.length} in total${troubled.length ? `, ${troubled.length} with problems shown` : ', all running cleanly'})`,
      ...troubled.map(({ pod, h }) => `- ${pod.metadata.name}: ${h.status}${h.reason ? ` (${h.reason})` : ''}, ${h.restarts} restarts${h.message ? ` — ${h.message}` : ''}`),
    );
  }

  // Events: the object's own, then its troubled pods'
  const events: EventLine[] = [];
  if (ref.namespace || kind === 'Node') {
    const targets = [{ kind, name: ref.name }, ...(kind === 'Pod' ? [] : troubled.map(({ pod }) => ({ kind: 'Pod', name: pod.metadata.name })))];
    for (const t of targets.slice(0, 1 + explainLimits.pods)) {
      const found = await readEvents(ctx, { namespace: ref.namespace, kind: t.kind, name: t.name, limit: explainLimits.events }).catch(
        () => [] as EventLine[],
      );
      events.push(...found);
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  const shownEvents = events.slice(0, explainLimits.events);
  sections.push('', '### Recent events (newest first)', formatEvents(shownEvents));

  // A short log tail of the first troubled pod (operators and up)
  let logLines = 0;
  const logPod = kind === 'Pod' ? object : troubled[0]?.pod;
  if (logPod && kind !== 'Secret' && logPod.metadata.namespace && ctx.permissionsIn(logPod.metadata.namespace).logs) {
    const target = logTarget(logPod);
    if (target) {
      const text = await readLogTail(ctx, logPod.metadata.namespace, logPod.metadata.name, { ...target, tail: explainLimits.logLines }).catch(
        () => '',
      );
      if (text.trim()) {
        const kept = keepTail(text, explainLimits.logChars);
        logLines = kept.split('\n').filter((l) => l !== TRUNCATED_MARKER).length;
        sections.push(
          '',
          `### Last log lines of ${logPod.metadata.name}/${target.container}${target.previous ? ' (previous run, before it restarted)' : ''}`,
          '```',
          kept,
          '```',
        );
      }
    }
  }

  return {
    prompt: sections.join('\n'),
    context: { ref: fullRef, events: shownEvents.length, logLines, pods: kind === 'Pod' ? 0 : troubled.length },
  };
}
