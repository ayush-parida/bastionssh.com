import type { KubeContainerLane, KubeLifecycleStep, KubeRevision, KubeRollout } from '@smt/shared';
import type { KubeObject } from './client.js';
import type { EventIndex } from './events.js';
import { FAILING_WAITING_REASONS, REVISION_ANNOTATION, replicaSetsOf, workloadHealth } from './health.js';

/**
 * The workload and pod views of spec §5.3, from cached objects and events:
 *
 * - the rollout timeline: a Deployment's ReplicaSets as revisions (images,
 *   when, the change-cause annotation), the current one marked, and the
 *   desired / updated / ready / available counts for the stacked bar;
 * - a pod's lifecycle strip, Scheduled → Pulled → Started → Ready, from its
 *   conditions and events;
 * - its containers as lanes: init containers, then the app, then sidecars.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v) as Json[]) : []);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

const CHANGE_CAUSE = 'kubernetes.io/change-cause';

/** Revisions shown on the timeline (Kubernetes keeps 10 by default). */
const MAX_REVISIONS = 15;

export function rolloutOf(dep: KubeObject, replicaSets: KubeObject[]): KubeRollout {
  const spec = obj(dep.spec);
  const status = obj(dep.status);
  const current = Number(dep.metadata.annotations?.[REVISION_ANNOTATION]) || null;
  const revisions: KubeRevision[] = replicaSetsOf(dep, replicaSets)
    .map((rs) => {
      const revision = Number(rs.metadata.annotations?.[REVISION_ANNOTATION]) || 0;
      const containers = arr(obj(obj(obj(rs.spec).template).spec).containers);
      return {
        revision,
        replicaSet: rs.metadata.name,
        images: [...new Set(containers.map((c) => str(c.image)).filter((i): i is string => !!i))],
        changeCause: rs.metadata.annotations?.[CHANGE_CAUSE] ?? null,
        createdAt: rs.metadata.creationTimestamp ?? null,
        replicas: num(obj(rs.spec).replicas),
        readyReplicas: num(obj(rs.status).readyReplicas),
        current: current !== null && revision === current,
      };
    })
    .sort((a, b) => b.revision - a.revision)
    .slice(0, MAX_REVISIONS);
  return {
    current,
    inProgress: workloadHealth('Deployment', dep).health === 'progressing',
    replicas: {
      desired: num(spec.replicas, 1),
      updated: num(status.updatedReplicas),
      ready: num(status.readyReplicas),
      available: num(status.availableReplicas),
    },
    revisions,
  };
}

const IMAGE_PULL = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'ErrImageNeverPull']);

function condition(pod: KubeObject, type: string): Json | null {
  return arr(obj(pod.status).conditions).find((c) => c.type === type) ?? null;
}

/**
 * Scheduled → Pulled → Started → Ready. A step is `done`, `failed` (with
 * why), `current` (under way) or `waiting` (an earlier step has not finished).
 */
export function podLifecycle(pod: KubeObject, events: EventIndex): KubeLifecycleStep[] {
  const ns = pod.metadata.namespace ?? null;
  const name = pod.metadata.name;
  const ev = (reason: string, message?: RegExp) => events.latest('Pod', ns, name, reason, message);
  const status = obj(pod.status);
  const containers = arr(status.containerStatuses);
  const all = [...arr(status.initContainerStatuses), ...containers];
  const waitingReasons = all.map((c) => str(obj(obj(c.state).waiting).reason)).filter((r): r is string => !!r);
  const succeeded = str(status.phase) === 'Succeeded';

  const steps: KubeLifecycleStep[] = [];
  const blocked = () => steps.some((s) => s.state !== 'done');
  const add = (step: KubeLifecycleStep) => steps.push(blocked() ? { ...step, state: 'waiting', detail: null, at: null } : step);

  const scheduled = condition(pod, 'PodScheduled');
  const scheduledEvent = ev('Scheduled');
  add({
    id: 'scheduled',
    label: 'Scheduled',
    state: scheduled?.status === 'True' ? 'done' : scheduled?.status === 'False' ? 'failed' : 'current',
    at: str(scheduled?.lastTransitionTime) ?? scheduledEvent?.lastSeen ?? null,
    detail:
      scheduled?.status === 'False'
        ? (str(scheduled.message) ?? ev('FailedScheduling')?.message ?? 'No node will take it yet')
        : str(obj(pod.spec).nodeName)
          ? `on ${str(obj(pod.spec).nodeName)}`
          : null,
  });

  const pullFailure = waitingReasons.find((r) => IMAGE_PULL.has(r));
  const started = all.some((c) => 'running' in obj(c.state) || 'terminated' in obj(c.state) || num(c.restartCount) > 0);
  const pulled = ev('Pulled');
  add({
    id: 'pulled',
    label: 'Pulled',
    state: pullFailure ? 'failed' : started || pulled || succeeded ? 'done' : 'current',
    at: pulled?.lastSeen ?? null,
    detail: pullFailure
      ? (ev('Failed', /pull|image/i)?.message ?? pullFailure)
      : (pulled?.message ?? (ev('Pulling') ? 'Pulling the image…' : null)),
  });

  const crash = waitingReasons.find((r) => FAILING_WAITING_REASONS.has(r) && !IMAGE_PULL.has(r));
  const startedEvent = ev('Started');
  const startedAt = containers.map((c) => str(obj(obj(c.state).running).startedAt)).find(Boolean) ?? null;
  add({
    id: 'started',
    label: 'Started',
    state: crash ? 'failed' : started || succeeded ? 'done' : 'current',
    at: startedEvent?.lastSeen ?? startedAt,
    detail: crash
      ? crash === 'CrashLoopBackOff'
        ? 'Starts, then crashes (CrashLoopBackOff)'
        : crash
      : waitingReasons[0] && !started
        ? waitingReasons[0]
        : null,
  });

  const ready = condition(pod, 'Ready');
  const unhealthy = ev('Unhealthy', /^Readiness probe/i);
  add({
    id: 'ready',
    label: succeeded ? 'Completed' : 'Ready',
    state: succeeded || ready?.status === 'True' ? 'done' : unhealthy ? 'failed' : 'current',
    at: str(ready?.lastTransitionTime),
    detail: succeeded ? 'Finished successfully' : ready?.status === 'True' ? 'Receives traffic' : (unhealthy?.message ?? str(ready?.message)),
  });
  return steps;
}

/** Proxy containers injected by a service mesh: sidecars by name. */
const SIDECAR_NAMES = /^(istio-proxy|linkerd-proxy|envoy|envoy-sidecar|cloud-sql-proxy|vault-agent|datadog-agent|fluent-bit|oauth2-proxy)$/;

function lane(spec: Json, status: Json | undefined, role: KubeContainerLane['role']): KubeContainerLane {
  const state = obj(status?.state);
  const kind = 'running' in state ? 'running' : 'waiting' in state ? 'waiting' : 'terminated' in state ? 'terminated' : 'unknown';
  const detail = obj(state[kind]);
  const last = obj(obj(status?.lastState).terminated);
  return {
    name: str(spec.name) ?? '?',
    role,
    image: str(spec.image),
    state: kind,
    reason: str(detail.reason),
    ready: status?.ready === true,
    restarts: num(status?.restartCount),
    lastTermination: Object.keys(last).length
      ? { reason: str(last.reason), exitCode: typeof last.exitCode === 'number' ? last.exitCode : null, finishedAt: str(last.finishedAt) }
      : null,
  };
}

/** A pod's containers as lanes: init containers, then the app, then sidecars (native ones, and mesh proxies). */
export function containerLanes(pod: KubeObject): KubeContainerLane[] {
  const spec = obj(pod.spec);
  const status = obj(pod.status);
  const byName = (list: Json[]) => new Map(list.map((c) => [str(c.name) ?? '', c]));
  const initStatus = byName(arr(status.initContainerStatuses));
  const mainStatus = byName(arr(status.containerStatuses));
  const lanes: KubeContainerLane[] = [];
  const sidecars: KubeContainerLane[] = [];
  for (const c of arr(spec.initContainers)) {
    const l = lane(c, initStatus.get(str(c.name) ?? ''), str(c.restartPolicy) === 'Always' ? 'sidecar' : 'init');
    (l.role === 'sidecar' ? sidecars : lanes).push(l);
  }
  const main = arr(spec.containers);
  for (const c of main) {
    const sidecar = main.length > 1 && SIDECAR_NAMES.test(str(c.name) ?? '');
    const l = lane(c, mainStatus.get(str(c.name) ?? ''), sidecar ? 'sidecar' : 'app');
    (sidecar ? sidecars : lanes).push(l);
  }
  return [...lanes, ...sidecars];
}
