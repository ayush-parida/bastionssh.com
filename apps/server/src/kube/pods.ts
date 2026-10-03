import type {
  KubeContainerRole,
  KubeContainerState,
  KubeContainerView,
  KubePodDetail,
  KubePodLifecycleStep,
  KubeResourceAmounts,
  KubeResourceLimits,
} from '@smt/shared';
import type { KubeClient, KubeObject } from './client.js';
import { defaultContainer } from './logs.js';
import { metricsAvailable } from './metrics.js';
import { bytes, cpuMillis } from './quantity.js';

/**
 * The pod panel (K4, spec §5.3): containers as lanes (init → sidecars → app
 * → ephemeral) with their state, restarts and last termination, requests and
 * limits against live usage, and a lifecycle strip from the pod's conditions.
 * Built from the pod object as the API returns it; usage per container comes
 * from metrics.k8s.io when the cluster has it.
 */

const MESSAGE_MAX = 300;
const METRICS_TIMEOUT_MS = 8_000;

type Json = Record<string, unknown>;

interface ContainerSpec {
  name?: string;
  image?: string;
  restartPolicy?: string;
  resources?: { requests?: Json; limits?: Json };
  ports?: { name?: string; containerPort?: number; protocol?: string }[];
}

interface StateDetail {
  reason?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
}

interface ContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  state?: { running?: StateDetail; waiting?: StateDetail; terminated?: StateDetail };
  lastState?: { terminated?: StateDetail };
}

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

const short = (text: string | undefined): string | null => {
  if (!text) return null;
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text;
};

function limits(map: Json | undefined): KubeResourceLimits {
  return {
    cpuMillis: map?.cpu !== undefined ? cpuMillis(map.cpu) : null,
    memoryBytes: map?.memory !== undefined ? bytes(map.memory) : null,
  };
}

function stateOf(status: ContainerStatus | undefined): Pick<KubeContainerView, 'state' | 'reason' | 'message' | 'since' | 'exitCode'> {
  const state = status?.state;
  if (state?.running) return { state: 'running', reason: null, message: null, since: state.running.startedAt ?? null, exitCode: null };
  if (state?.waiting) {
    return { state: 'waiting', reason: state.waiting.reason ?? null, message: short(state.waiting.message), since: null, exitCode: null };
  }
  if (state?.terminated) {
    const t = state.terminated;
    return {
      state: 'terminated',
      reason: t.reason ?? null,
      message: short(t.message),
      since: t.finishedAt ?? null,
      exitCode: typeof t.exitCode === 'number' ? t.exitCode : null,
    };
  }
  return { state: 'unknown' as KubeContainerState, reason: null, message: null, since: null, exitCode: null };
}

function container(
  spec: ContainerSpec,
  role: KubeContainerRole,
  status: ContainerStatus | undefined,
  usage: Map<string, KubeResourceAmounts> | null,
): KubeContainerView {
  const name = spec.name ?? '';
  const last = status?.lastState?.terminated;
  const view: KubeContainerView = {
    name,
    role,
    image: spec.image ?? '',
    ...stateOf(status),
    ready: status?.ready === true,
    restarts: status?.restartCount ?? 0,
    lastTermination: last
      ? { reason: last.reason ?? null, exitCode: typeof last.exitCode === 'number' ? last.exitCode : null, finishedAt: last.finishedAt ?? null }
      : null,
    requests: limits(spec.resources?.requests),
    limits: limits(spec.resources?.limits),
    usage: null,
    ports: (spec.ports ?? [])
      .filter((p) => typeof p.containerPort === 'number')
      .map((p) => ({ name: p.name ?? null, port: p.containerPort!, protocol: p.protocol ?? 'TCP' })),
  };
  if (view.state === 'running') view.usage = usage?.get(name) ?? null;
  return view;
}

const CONDITION_STEPS: { id: KubePodLifecycleStep['id']; label: string; type: string }[] = [
  { id: 'scheduled', label: 'Scheduled', type: 'PodScheduled' },
  { id: 'initialized', label: 'Initialized', type: 'Initialized' },
  { id: 'started', label: 'Started', type: 'ContainersReady' },
  { id: 'ready', label: 'Ready', type: 'Ready' },
];

/** Scheduled → Initialized → Started → Ready, each done, pending or failed with the cluster's reason. */
export function podLifecycle(pod: KubeObject, containers: KubeContainerView[]): KubePodLifecycleStep[] {
  const conditions = (((pod.status ?? {}) as { conditions?: Condition[] }).conditions ?? []) as Condition[];
  const byType = new Map(conditions.map((c) => [c.type ?? '', c]));
  const app = containers.filter((c) => c.role === 'app' || c.role === 'sidecar');
  const failing = (c: KubeContainerView) => c.state === 'waiting' && c.reason !== null && c.reason !== 'ContainerCreating' && c.reason !== 'PodInitializing';
  let blocked = false;
  return CONDITION_STEPS.map(({ id, label, type }) => {
    const condition = byType.get(type);
    let status: KubePodLifecycleStep['status'] = condition?.status === 'True' ? 'done' : 'pending';
    let detail = condition?.status === 'True' ? null : short(condition?.message ?? condition?.reason);
    let at = condition?.lastTransitionTime ?? null;
    if (id === 'started') {
      // Started: every app container has run (the readiness of each is the next step)
      const running = app.length > 0 && app.every((c) => c.state === 'running' || (c.state === 'terminated' && c.exitCode === 0));
      const broken = app.find(failing) ?? app.find((c) => c.state === 'terminated' && c.exitCode !== 0);
      status = running ? 'done' : broken ? 'failed' : 'pending';
      detail = broken ? `${broken.name}: ${broken.reason ?? 'exited'}${broken.message ? ` — ${broken.message}` : ''}` : running ? null : detail;
      at = running ? (app.map((c) => c.since).filter(Boolean).sort().pop() ?? null) : null;
    } else if (id === 'scheduled' && condition?.status === 'False') {
      status = 'failed';
    } else if (id === 'initialized' && status !== 'done') {
      const broken = containers.find((c) => c.role === 'init' && (failing(c) || (c.state === 'terminated' && c.exitCode !== 0)));
      if (broken) {
        status = 'failed';
        detail = `${broken.name}: ${broken.reason ?? 'exited'}`;
      }
    }
    // A step after one that has not happened is waiting for it, whatever its own condition says
    if (blocked && status === 'done') status = 'pending';
    if (status !== 'done') blocked = true;
    return { id, label, status, at: status === 'done' ? at : null, detail };
  });
}

/** The pod panel's picture of a pod; `usage` maps container names to live usage. */
export function podDetail(pod: KubeObject, usage: Map<string, KubeResourceAmounts> | null, metrics: boolean): KubePodDetail {
  const spec = (pod.spec ?? {}) as {
    initContainers?: ContainerSpec[];
    containers?: ContainerSpec[];
    ephemeralContainers?: ContainerSpec[];
    nodeName?: string;
  };
  const status = (pod.status ?? {}) as {
    phase?: string;
    podIP?: string;
    startTime?: string;
    initContainerStatuses?: ContainerStatus[];
    containerStatuses?: ContainerStatus[];
    ephemeralContainerStatuses?: ContainerStatus[];
  };
  const find = (list: ContainerStatus[] | undefined, name: string | undefined) => list?.find((s) => s.name === name);
  const init: KubeContainerView[] = [];
  const sidecars: KubeContainerView[] = [];
  for (const c of spec.initContainers ?? []) {
    // A native sidecar: an init container that keeps running beside the app
    const view = container(c, c.restartPolicy === 'Always' ? 'sidecar' : 'init', find(status.initContainerStatuses, c.name), usage);
    (view.role === 'sidecar' ? sidecars : init).push(view);
  }
  const app = (spec.containers ?? []).map((c) => container(c, 'app', find(status.containerStatuses, c.name), usage));
  const ephemeral = (spec.ephemeralContainers ?? []).map((c) =>
    container(c, 'ephemeral', find(status.ephemeralContainerStatuses, c.name), usage),
  );
  const containers = [...init, ...sidecars, ...app, ...ephemeral];
  return {
    namespace: pod.metadata.namespace ?? '',
    name: pod.metadata.name,
    phase: status.phase ?? 'Unknown',
    nodeName: spec.nodeName ?? null,
    podIP: status.podIP ?? null,
    startedAt: status.startTime ?? null,
    containers,
    lifecycle: podLifecycle(pod, containers),
    defaultContainer: defaultContainer(pod),
    metricsAvailable: metrics,
  };
}

/** Live usage per container of one pod, or null when metrics are unavailable or not (yet) reported. */
export async function containerUsage(
  clusterKey: string,
  client: KubeClient,
  namespace: string,
  pod: string,
): Promise<{ available: boolean; usage: Map<string, KubeResourceAmounts> | null }> {
  if (!(await metricsAvailable(clusterKey, client))) return { available: false, usage: null };
  try {
    const item = await client.raw<{ containers?: { name?: string; usage?: { cpu?: string; memory?: string } }[] }>(
      `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}`,
      { timeoutMs: METRICS_TIMEOUT_MS },
    );
    const usage = new Map<string, KubeResourceAmounts>();
    for (const c of item.containers ?? []) {
      if (c.name) usage.set(c.name, { cpuMillis: cpuMillis(c.usage?.cpu), memoryBytes: bytes(c.usage?.memory) });
    }
    return { available: true, usage };
  } catch {
    // A pod just started has no reading yet (404)
    return { available: true, usage: null };
  }
}
