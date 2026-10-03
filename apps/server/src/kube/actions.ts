import { randomBytes } from 'node:crypto';
import {
  KUBE_ACTION_CAPABILITY,
  KUBE_RESOURCES,
  type KubeActionId,
  type KubeActionPreview,
  type KubeActionResult,
  type KubeObjectRef,
  type KubePermissions,
  type KubeResource,
  type KubeRestartableKind,
  type KubeRevision,
  type KubeScalableKind,
  type KubeTemplateContainer,
  type KubeUpdateStrategy,
} from '@smt/shared';
import type { KubeClient, KubeObject } from './client.js';
import { KubeError } from './errors.js';
import { resourcePath } from './validation.js';
import { selectorString } from './views.js';

/**
 * Guided actions (spec §6, K3): each one a minimal, well-defined change —
 * exactly what the equivalent kubectl command sends, nothing more:
 *
 * | Action | Request |
 * | --- | --- |
 * | scale | merge patch `{spec:{replicas}}` on the `scale` subresource |
 * | restart | strategic merge patch of `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` |
 * | rollback | JSON patch: the Deployment's template ← the revision's ReplicaSet template minus `pod-template-hash`, its annotations as `kubectl rollout undo` sets them, guarded by a `test` of the resourceVersion read |
 * | delete pod | `DELETE` the pod |
 * | cordon / uncordon | merge patch `{spec:{unschedulable}}` |
 * | suspend / resume a CronJob | merge patch `{spec:{suspend}}` |
 * | trigger a CronJob | create a Job from its `jobTemplate`, owned by the CronJob, under a generated name |
 *
 * The patch bodies are pure functions (tested on their own); the `*`
 * functions below read the object first — a missing one is a 404, and an
 * object already in the asked state is answered `changed: false` without a
 * write — then send the change and describe it as a {@link KubeActionResult}
 * whose before/after the route audits. Callers check the role, the cluster
 * access and the namespace allowlist first (api/routes/kube-actions.ts).
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v) as Json[]) : []);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export const RESTARTED_AT_ANNOTATION = 'kubectl.kubernetes.io/restartedAt';
export const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';
export const CHANGE_CAUSE_ANNOTATION = 'kubernetes.io/change-cause';
/** The label a Deployment adds to each ReplicaSet's template; never copied back. */
export const POD_TEMPLATE_HASH_LABEL = 'pod-template-hash';
/** Marks a Job started by hand from a CronJob, as kubectl does. */
export const INSTANTIATE_ANNOTATION = 'cronjob.kubernetes.io/instantiate';

/**
 * Deployment annotations a rollback keeps from the Deployment rather than
 * copying from the ReplicaSet (kubectl's `annotationsToSkip`).
 */
const ROLLBACK_SKIP_ANNOTATIONS = new Set([
  'kubectl.kubernetes.io/last-applied-configuration',
  REVISION_ANNOTATION,
  'deployment.kubernetes.io/revision-history',
  'deployment.kubernetes.io/desired-replicas',
  'deployment.kubernetes.io/max-replicas',
  'deprecated.deployment.rollback.to',
]);

export const SCALABLE_RESOURCE: Record<KubeScalableKind, KubeResource> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
};

export const RESTARTABLE_RESOURCE: Record<KubeRestartableKind, KubeResource> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
};

export interface JsonPatchOp {
  op: 'add' | 'replace' | 'remove' | 'test';
  path: string;
  value?: unknown;
}

// ── Patch bodies ─────────────────────────────────────────────

/** Merge patch for the `scale` subresource. */
export function scalePatch(replicas: number) {
  return { spec: { replicas } };
}

/** What `kubectl rollout restart` sends: a new pod-template annotation, so every pod is replaced. */
export function restartPatch(at: Date) {
  return { spec: { template: { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: at.toISOString() } } } } };
}

/** Cordon (`true`) or uncordon (`false`) a node. */
export function cordonPatch(unschedulable: boolean) {
  return { spec: { unschedulable } };
}

/** Suspend (`true`) or resume (`false`) a CronJob. */
export function suspendPatch(suspend: boolean) {
  return { spec: { suspend } };
}

/** A pod template as a ReplicaSet holds it, without the label its Deployment added. */
export function templateWithoutHash(template: unknown): Json {
  const copy = structuredClone(obj(template));
  const metadata = obj(copy.metadata);
  if (metadata.labels && typeof metadata.labels === 'object') {
    const labels = { ...(metadata.labels as Record<string, unknown>) };
    delete labels[POD_TEMPLATE_HASH_LABEL];
    copy.metadata = { ...metadata, labels };
  }
  return copy;
}

/** The Deployment's annotations after rolling back to `replicaSet` (as `kubectl rollout undo` sets them). */
export function rollbackAnnotations(deployment: KubeObject, replicaSet: KubeObject): Record<string, string> {
  const annotations: Record<string, string> = {};
  const current = deployment.metadata.annotations ?? {};
  for (const key of ROLLBACK_SKIP_ANNOTATIONS) if (current[key] !== undefined) annotations[key] = current[key];
  for (const [key, value] of Object.entries(replicaSet.metadata.annotations ?? {})) {
    if (!ROLLBACK_SKIP_ANNOTATIONS.has(key)) annotations[key] = value;
  }
  return annotations;
}

/**
 * The JSON patch that rolls `deployment` back to `replicaSet`'s template.
 * The `test` makes the API server refuse it when the Deployment changed
 * since it was read, instead of overwriting someone else's change.
 */
export function rollbackPatch(deployment: KubeObject, replicaSet: KubeObject): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  if (deployment.metadata.resourceVersion) {
    ops.push({ op: 'test', path: '/metadata/resourceVersion', value: deployment.metadata.resourceVersion });
  }
  ops.push(
    { op: 'replace', path: '/spec/template', value: templateWithoutHash(obj(replicaSet.spec).template) },
    // `add` sets the member whether or not the Deployment had annotations
    { op: 'add', path: '/metadata/annotations', value: rollbackAnnotations(deployment, replicaSet) },
  );
  return ops;
}

/**
 * A name for a Job started by hand: `<cronjob>-manual-<5 random>`, kept to
 * 63 characters (Job names end up in a label value) and a valid DNS name.
 */
export function manualJobName(cronJobName: string, suffix = randomBytes(3).toString('hex').slice(0, 5)): string {
  const tail = `-manual-${suffix}`;
  const base = cronJobName.slice(0, 63 - tail.length).replace(/[-.]+$/, '');
  return `${base}${tail}`;
}

/**
 * The Job `kubectl create job --from=cronjob/<name>` makes: the CronJob's
 * job template, its labels and annotations, marked as started by hand and
 * owned by the CronJob (so it shows up under it and is cleaned up with it).
 */
export function jobFromCronJob(cronJob: KubeObject, name: string): KubeObject {
  const jobTemplate = obj(obj(cronJob.spec).jobTemplate);
  const templateMeta = obj(jobTemplate.metadata);
  const labels = obj(templateMeta.labels) as Record<string, string>;
  const annotations = obj(templateMeta.annotations) as Record<string, string>;
  const owner = {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    name: cronJob.metadata.name,
    ...(cronJob.metadata.uid && { uid: cronJob.metadata.uid }),
    controller: true,
    blockOwnerDeletion: true,
  };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: cronJob.metadata.namespace,
      labels: { ...labels },
      annotations: { ...annotations, [INSTANTIATE_ANNOTATION]: 'manual' },
      ownerReferences: [owner],
    },
    spec: structuredClone(obj(jobTemplate.spec)),
  };
}

// ── Reading what an action needs ─────────────────────────────

/** The containers of a pod template: name, image and env var names — never a value. */
export function templateContainers(template: unknown): KubeTemplateContainer[] {
  const spec = obj(obj(template).spec);
  return [...arr(spec.initContainers), ...arr(spec.containers)].map((c) => ({
    name: str(c.name) ?? '',
    image: str(c.image) ?? '',
    envNames: arr(c.env)
      .map((e) => str(e.name))
      .filter((n): n is string => !!n),
  }));
}

/** JSON with object keys sorted, for comparing templates. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Json)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Whether two pod templates are the same, the ReplicaSet's hash label aside. */
export function sameTemplate(a: unknown, b: unknown): boolean {
  return stable(templateWithoutHash(a)) === stable(templateWithoutHash(b));
}

function revisionOf(o: KubeObject): number {
  const value = Number(o.metadata.annotations?.[REVISION_ANNOTATION]);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** The ReplicaSets `deployment` controls, with their revision numbers, newest first. */
export async function deploymentReplicaSets(client: KubeClient, deployment: KubeObject): Promise<KubeObject[]> {
  const labelSelector = selectorString(obj(deployment.spec).selector);
  if (!labelSelector) return [];
  const list = await client.list('replicasets', { namespace: deployment.metadata.namespace, labelSelector });
  return list.items
    .filter((rs) =>
      (rs.metadata.ownerReferences ?? []).some(
        (o) =>
          o.controller &&
          o.kind === 'Deployment' &&
          (deployment.metadata.uid && o.uid ? o.uid === deployment.metadata.uid : o.name === deployment.metadata.name),
      ),
    )
    .filter((rs) => revisionOf(rs) > 0)
    .sort((a, b) => revisionOf(b) - revisionOf(a));
}

/**
 * A Deployment's revisions for the timeline, newest first. `current` is the
 * one its template matches — right after a change the controller has not yet
 * renumbered anything — or else the one its revision annotation names.
 */
export function toRevisions(deployment: KubeObject, replicaSets: KubeObject[]): KubeRevision[] {
  const template = obj(deployment.spec).template;
  const matching = replicaSets.find((rs) => sameTemplate(obj(rs.spec).template, template));
  const currentRevision = matching ? revisionOf(matching) : revisionOf(deployment);
  return replicaSets.map((rs) => {
    const revision = revisionOf(rs);
    return {
      revision,
      replicaSet: rs.metadata.name,
      createdAt: rs.metadata.creationTimestamp ?? null,
      changeCause: rs.metadata.annotations?.[CHANGE_CAUSE_ANNOTATION] ?? null,
      images: [...new Set(templateContainers(obj(rs.spec).template).map((c) => c.image).filter(Boolean))],
      containers: templateContainers(obj(rs.spec).template),
      replicas: num(obj(rs.status).replicas),
      readyReplicas: num(obj(rs.status).readyReplicas),
      current: revision === currentRevision,
    };
  });
}

/** The autoscaler that controls a workload's replicas, if any (null too when the credential may not read autoscalers). */
export async function controllingHpa(
  client: KubeClient,
  kind: string,
  namespace: string,
  name: string,
): Promise<{ name: string; minReplicas: number; maxReplicas: number } | null> {
  try {
    const list = await client.list('horizontalpodautoscalers', { namespace });
    const hpa = list.items.find((h) => {
      const target = obj(obj(h.spec).scaleTargetRef);
      return target.kind === kind && target.name === name;
    });
    if (!hpa) return null;
    const spec = obj(hpa.spec);
    return { name: hpa.metadata.name, minReplicas: num(spec.minReplicas, 1), maxReplicas: num(spec.maxReplicas) };
  } catch (err) {
    if (err instanceof KubeError && (err.statusCode === 403 || err.statusCode === 404)) return null;
    throw err;
  }
}

function controllerOf(o: KubeObject): { kind: string; name: string } | null {
  const refs = o.metadata.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  return ref ? { kind: ref.kind, name: ref.name } : null;
}

/**
 * Whether deleting `pod` brings a fresh one: its owner must exist, and a
 * Job's pod that already finished is not run again.
 */
export function podIsRecreated(pod: KubeObject): boolean {
  const owner = controllerOf(pod);
  if (!owner) return false;
  const phase = str(obj(pod.status).phase);
  return !(owner.kind === 'Job' && (phase === 'Succeeded' || phase === 'Failed'));
}

/** How a workload replaces its pods when its template changes (the API's default when unset). */
export function updateStrategy(kind: KubeRestartableKind, workload: KubeObject): KubeUpdateStrategy {
  const spec = obj(workload.spec);
  const type = str(obj(kind === 'Deployment' ? spec.strategy : spec.updateStrategy).type);
  if (kind === 'Deployment') return type === 'Recreate' ? 'Recreate' : 'RollingUpdate';
  return type === 'OnDelete' ? 'OnDelete' : 'RollingUpdate';
}

/** What a template change does to the pods, for a result's message. */
function replacementNote(strategy: KubeUpdateStrategy): string {
  switch (strategy) {
    case 'Recreate':
      return 'all its pods stop, then new ones start';
    case 'OnDelete':
      return 'each pod picks up the change only when it is deleted (OnDelete strategy)';
    default:
      return 'its pods are replaced one by one';
  }
}

function refOf(resource: KubeResource, namespace: string | null, name: string): KubeObjectRef {
  return { resource, kind: KUBE_RESOURCES[resource].kind, namespace, name };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── Actions ──────────────────────────────────────────────────

/** Scale a Deployment or StatefulSet through its `scale` subresource. */
export async function scaleWorkload(
  client: KubeClient,
  target: { kind: KubeScalableKind; namespace: string; name: string; replicas: number },
): Promise<KubeActionResult & { hpa: string | null }> {
  const resource = SCALABLE_RESOURCE[target.kind];
  const path = resourcePath(resource, { namespace: target.namespace, name: target.name, subresource: 'scale' });
  const scale = await client.json<KubeObject>({ path });
  const before = num(obj(scale.spec).replicas);
  const hpa = await controllingHpa(client, target.kind, target.namespace, target.name);
  const base = {
    action: 'scale' as const,
    ref: refOf(resource, target.namespace, target.name),
    before: { replicas: before },
    after: { replicas: target.replicas },
    hpa: hpa?.name ?? null,
  };
  const note = hpa ? ` — the autoscaler ${hpa.name} may change it again` : '';
  if (before === target.replicas) {
    return { ...base, changed: false, message: `${target.name} already runs ${plural(before, 'replica')}` };
  }
  await client.patch(resource, target.namespace, target.name, scalePatch(target.replicas), { subresource: 'scale' });
  return { ...base, changed: true, message: `Scaled ${target.name} from ${before} to ${plural(target.replicas, 'replica')}${note}` };
}

/** Restart a rollout: every pod is replaced, following the workload's update strategy. */
export async function restartRollout(
  client: KubeClient,
  target: { kind: KubeRestartableKind; namespace: string; name: string },
  now = new Date(),
): Promise<KubeActionResult> {
  const resource = RESTARTABLE_RESOURCE[target.kind];
  const workload = await client.get(resource, target.namespace, target.name);
  if (target.kind === 'Deployment' && obj(workload.spec).paused === true) {
    throw new KubeError(`${target.name} is paused; resume its rollout before restarting it`, 409);
  }
  const previous = obj(obj(obj(obj(workload.spec).template).metadata).annotations)[RESTARTED_AT_ANNOTATION];
  await client.patch(resource, target.namespace, target.name, restartPatch(now), { type: 'strategic' });
  const strategy = updateStrategy(target.kind, workload);
  return {
    action: 'restart',
    ref: refOf(resource, target.namespace, target.name),
    changed: true,
    before: { restartedAt: str(previous) },
    after: { restartedAt: now.toISOString() },
    message: strategy === 'OnDelete' ? `Restart requested for ${target.name}: ${replacementNote(strategy)}` : `Restarting ${target.name}: ${replacementNote(strategy)}`,
  };
}

/** Roll a Deployment back to an earlier revision (what `kubectl rollout undo --to-revision` does). */
export async function rollbackDeployment(
  client: KubeClient,
  target: { namespace: string; name: string; revision: number },
): Promise<KubeActionResult> {
  const deployment = await client.get('deployments', target.namespace, target.name);
  if (obj(deployment.spec).paused === true) {
    throw new KubeError(`${target.name} is paused; resume its rollout before rolling it back`, 409);
  }
  const replicaSets = await deploymentReplicaSets(client, deployment);
  const replicaSet = replicaSets.find((rs) => revisionOf(rs) === target.revision);
  if (!replicaSet) throw new KubeError(`Revision ${target.revision} of ${target.name} not found`, 404);
  const currentTemplate = obj(deployment.spec).template;
  const images = (template: unknown) => templateContainers(template).map((c) => `${c.name}=${c.image}`);
  const base = {
    action: 'rollback' as const,
    ref: refOf('deployments', target.namespace, target.name),
    before: { revision: revisionOf(deployment) || null, images: images(currentTemplate) },
    after: { revision: target.revision, images: images(obj(replicaSet.spec).template) },
  };
  if (sameTemplate(obj(replicaSet.spec).template, currentTemplate)) {
    return { ...base, changed: false, message: `${target.name} already runs revision ${target.revision}'s template` };
  }
  try {
    await client.patch('deployments', target.namespace, target.name, rollbackPatch(deployment, replicaSet), { type: 'json' });
  } catch (err) {
    // A failed `test` comes back as a bare 422 ("the server rejected our request…"): say what happened
    if (err instanceof KubeError && err.statusCode === 422) {
      const now = await client.get('deployments', target.namespace, target.name).catch(() => null);
      if (now && now.metadata.resourceVersion !== deployment.metadata.resourceVersion) {
        throw new KubeError(`${target.name} changed while it was being rolled back; nothing was changed — look again and retry`, 409, 'Conflict');
      }
    }
    throw err;
  }
  const how = updateStrategy('Deployment', deployment) === 'Recreate' ? ': all its pods stop, then new ones start' : '';
  return { ...base, changed: true, message: `Rolling ${target.name} back to revision ${target.revision}${how}` };
}

/** Delete a pod; its controller (if any) starts a replacement. */
export async function deletePod(client: KubeClient, target: { namespace: string; name: string }): Promise<KubeActionResult> {
  const pod = await client.get('pods', target.namespace, target.name);
  const owner = controllerOf(pod);
  const recreated = podIsRecreated(pod);
  await client.delete('pods', target.namespace, target.name);
  return {
    action: 'delete-pod',
    ref: refOf('pods', target.namespace, target.name),
    changed: true,
    before: { phase: str(obj(pod.status).phase), node: str(obj(pod.spec).nodeName), owner },
    after: { deleted: true },
    message: recreated
      ? `Deleted ${target.name}; its ${owner!.kind} starts a new pod in its place`
      : owner
        ? `Deleted ${target.name}; its ${owner.kind} had finished, so nothing recreates it`
        : `Deleted ${target.name}; it had no owner, so nothing recreates it`,
  };
}

/** Cordon (`unschedulable: true`) or uncordon a node. */
export async function setNodeSchedulable(client: KubeClient, name: string, unschedulable: boolean): Promise<KubeActionResult> {
  const node = await client.get('nodes', null, name);
  const before = obj(node.spec).unschedulable === true;
  const base = {
    action: (unschedulable ? 'cordon' : 'uncordon') as KubeActionId,
    ref: refOf('nodes', null, name),
    before: { unschedulable: before },
    after: { unschedulable },
  };
  if (before === unschedulable) {
    return { ...base, changed: false, message: `${name} is already ${unschedulable ? 'cordoned' : 'schedulable'}` };
  }
  await client.patch('nodes', null, name, cordonPatch(unschedulable));
  return {
    ...base,
    changed: true,
    message: unschedulable ? `Cordoned ${name}: no new pods are scheduled there` : `Uncordoned ${name}: new pods may be scheduled there again`,
  };
}

/** Suspend or resume a CronJob. */
export async function setCronJobSuspended(
  client: KubeClient,
  target: { namespace: string; name: string; suspend: boolean },
): Promise<KubeActionResult> {
  const cronJob = await client.get('cronjobs', target.namespace, target.name);
  const before = obj(cronJob.spec).suspend === true;
  const base = {
    action: 'suspend-cronjob' as const,
    ref: refOf('cronjobs', target.namespace, target.name),
    before: { suspend: before },
    after: { suspend: target.suspend },
  };
  if (before === target.suspend) {
    return { ...base, changed: false, message: `${target.name} is already ${before ? 'suspended' : 'running on schedule'}` };
  }
  await client.patch('cronjobs', target.namespace, target.name, suspendPatch(target.suspend));
  return {
    ...base,
    changed: true,
    message: target.suspend ? `Suspended ${target.name}: no new runs start until it is resumed` : `Resumed ${target.name}: it runs on schedule again`,
  };
}

/** Start a CronJob's job now. */
export async function triggerCronJob(
  client: KubeClient,
  target: { namespace: string; name: string },
  jobName = manualJobName(target.name),
): Promise<KubeActionResult> {
  const cronJob = await client.get('cronjobs', target.namespace, target.name);
  const created = await client.create('jobs', target.namespace, jobFromCronJob(cronJob, jobName));
  const name = (created as Partial<KubeObject>).metadata?.name ?? jobName;
  return {
    action: 'trigger-cronjob',
    ref: refOf('cronjobs', target.namespace, target.name),
    changed: true,
    before: { active: arr(obj(cronJob.status).active).length },
    after: { job: name },
    message: `Started job ${name} from ${target.name}`,
    created: refOf('jobs', target.namespace, name),
  };
}

// ── Preview ──────────────────────────────────────────────────

/** Resources with guided actions; the preview of anything else is refused before it is read. */
const ACTIONABLE_RESOURCES: ReadonlySet<KubeResource> = new Set(['deployments', 'statefulsets', 'daemonsets', 'pods', 'nodes', 'cronjobs']);

/** Which actions apply to an object of `resource` in its current state, before permissions. */
function applicableActions(resource: KubeResource, preview: KubeActionPreview): KubeActionId[] {
  switch (resource) {
    case 'deployments':
      return ['scale', 'restart', ...((preview.revisions?.length ?? 0) > 1 ? (['rollback'] as const) : [])];
    case 'statefulsets':
      return ['scale', 'restart'];
    case 'daemonsets':
      return ['restart'];
    case 'pods':
      return ['delete-pod'];
    case 'nodes':
      return [preview.node?.unschedulable ? 'uncordon' : 'cordon'];
    case 'cronjobs':
      return ['suspend-cronjob', 'trigger-cronjob'];
    default:
      return [];
  }
}

/**
 * What the action panels show for an object (see {@link KubeActionPreview}).
 * `namespaceAllowed` keeps a node's pod counts to the namespaces the caller
 * may see.
 */
export async function actionPreview(
  client: KubeClient,
  ref: { resource: KubeResource; namespace: string | null; name: string },
  permissions: KubePermissions,
  namespaceAllowed: (namespace: string | null | undefined) => boolean,
): Promise<KubeActionPreview> {
  if (!ACTIONABLE_RESOURCES.has(ref.resource)) throw new KubeError(`${KUBE_RESOURCES[ref.resource].kind} objects have no guided actions`, 400);
  const o = await client.get(ref.resource, ref.namespace, ref.name);
  const spec = obj(o.spec);
  const status = obj(o.status);
  const preview: KubeActionPreview = { ref: { ...refOf(ref.resource, ref.namespace, ref.name) }, actions: [] };
  const ns = ref.namespace ?? '';

  switch (ref.resource) {
    case 'deployments':
    case 'statefulsets': {
      const kind = KUBE_RESOURCES[ref.resource].kind;
      preview.replicas = {
        desired: num(spec.replicas, 1),
        ready: num(status.readyReplicas),
        updated: num(status.updatedReplicas),
        available: num(status.availableReplicas),
      };
      preview.hpa = await controllingHpa(client, kind, ns, ref.name);
      preview.strategy = updateStrategy(kind as KubeRestartableKind, o);
      if (ref.resource === 'deployments') {
        preview.paused = spec.paused === true;
        preview.revisions = toRevisions(o, await deploymentReplicaSets(client, o).catch(() => []));
      }
      break;
    }
    case 'daemonsets':
      preview.replicas = {
        desired: num(status.desiredNumberScheduled),
        ready: num(status.numberReady),
        updated: num(status.updatedNumberScheduled),
        available: num(status.numberAvailable),
      };
      preview.strategy = updateStrategy('DaemonSet', o);
      break;
    case 'pods':
      preview.pod = { owner: controllerOf(o), recreated: podIsRecreated(o), nodeName: str(spec.nodeName), phase: str(status.phase) ?? 'Unknown' };
      break;
    case 'nodes': {
      const pods = await client
        .list('pods', { fieldSelector: `spec.nodeName=${ref.name}` })
        .then((l) => l.items.filter((p) => namespaceAllowed(p.metadata.namespace)))
        .catch(() => [] as KubeObject[]);
      const running = pods.filter((p) => !['Succeeded', 'Failed'].includes(String(obj(p.status).phase)));
      preview.node = {
        unschedulable: spec.unschedulable === true,
        pods: running.length,
        daemonSetPods: running.filter((p) => controllerOf(p)?.kind === 'DaemonSet').length,
      };
      break;
    }
    case 'cronjobs':
      preview.cronJob = {
        suspended: spec.suspend === true,
        schedule: str(spec.schedule) ?? '',
        lastScheduleTime: str(status.lastScheduleTime),
        active: arr(status.active).length,
      };
      break;
    default:
      break;
  }
  preview.actions = applicableActions(ref.resource, preview).filter((a) => permissions[KUBE_ACTION_CAPABILITY[a]]);
  return preview;
}
