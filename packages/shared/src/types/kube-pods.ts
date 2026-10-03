import type { KubeResourceAmounts } from './kube.js';

/**
 * Inside a pod (Kubernetes K4, spec §5.3): its containers as lanes with
 * requests, limits and live usage, its logs, a shell in a container, and the
 * read-only YAML. See docs/superpowers/specs/2026-10-03-kubernetes-visual-design.md.
 */

// ── Pod panel ────────────────────────────────────────────────────────────────

/**
 * Where a container sits in the pod's life, in lane order: `init` runs to
 * completion before the app starts, `app` are the pod's containers,
 * `sidecar` native sidecars (init containers with `restartPolicy: Always`),
 * `ephemeral` debug containers added later.
 */
export type KubeContainerRole = 'init' | 'sidecar' | 'app' | 'ephemeral';

/** A container's state in a word; `unknown` before the kubelet reported it. */
export type KubeContainerState = 'running' | 'waiting' | 'terminated' | 'unknown';

/** CPU and memory, each absent when not set. */
export interface KubeResourceLimits {
  cpuMillis: number | null;
  memoryBytes: number | null;
}

export interface KubeContainerView {
  name: string;
  role: KubeContainerRole;
  image: string;
  state: KubeContainerState;
  /** CrashLoopBackOff, ImagePullBackOff, Completed, OOMKilled…; null while simply running. */
  reason: string | null;
  /** The kubelet's message for that reason, shortened. */
  message: string | null;
  /** Running since / finished at. */
  since: string | null;
  exitCode: number | null;
  ready: boolean;
  restarts: number;
  /** The previous run, when it ended (what "previous logs" show). */
  lastTermination: { reason: string | null; exitCode: number | null; finishedAt: string | null } | null;
  requests: KubeResourceLimits;
  limits: KubeResourceLimits;
  /** From metrics.k8s.io; null when metrics are unavailable or the container is not running. */
  usage: KubeResourceAmounts | null;
  ports: { name: string | null; port: number; protocol: string }[];
}

/** One step of the pod's lifecycle strip (Scheduled → Initialized → Started → Ready). */
export interface KubePodLifecycleStep {
  id: 'scheduled' | 'initialized' | 'started' | 'ready';
  label: string;
  status: 'done' | 'pending' | 'failed';
  at: string | null;
  /** Why it is not done yet, in the cluster's words. */
  detail: string | null;
}

/** GET /api/kube/clusters/:id/pods/:namespace/:name — the pod panel's picture. */
export interface KubePodDetail {
  namespace: string;
  name: string;
  phase: string;
  nodeName: string | null;
  podIP: string | null;
  startedAt: string | null;
  /** Init, then sidecars, then app containers, then ephemeral ones. */
  containers: KubeContainerView[];
  lifecycle: KubePodLifecycleStep[];
  /** The container logs and the shell open on when none is picked. */
  defaultContainer: string | null;
  metricsAvailable: boolean;
}

// ── Logs ─────────────────────────────────────────────────────────────────────

export interface KubeLogLine {
  /** RFC 3339 time the kubelet stamped, when timestamps were asked for. */
  time?: string;
  text: string;
}

/**
 * `GET …/pods/:ns/:name/logs?container=&previous=&follow=&tail=&timestamps=`
 * (server-sent events): `ready` names the container being read, then `logs`
 * batches; `end` when the log ends (the container stopped, or not following).
 */
export type KubeLogEvent =
  | { type: 'ready'; container: string; previous: boolean }
  | { type: 'logs'; lines: KubeLogLine[] }
  | { type: 'error'; error: string; status?: number }
  | { type: 'end'; truncated?: boolean };

// ── Shell ────────────────────────────────────────────────────────────────────

/** Body of `POST /api/kube/clusters/:id/pods/:namespace/:name/exec`. */
export interface KubeExecRequest {
  /** Default: the pod's default container. */
  container?: string;
  /** argv, no shell parsing. Default: bash if the container has it, else sh. */
  cmd?: string[];
  cols?: number;
  rows?: number;
}

/**
 * A shell in a pod's container, as a terminal session: attach to `wsUrl`,
 * the same WebSocket path as SSH terminals (`/api/ssh-sessions/:id/ws`), and
 * close it with `DELETE /api/ssh-sessions/:id`.
 */
export interface KubeExecSession {
  sessionId: string;
  wsUrl: string;
  pod: KubePodShellTarget;
  cmd: string[];
  recording: { id: string; inputRecorded: boolean } | null;
}

/** What a pod shell runs in. */
export interface KubePodShellTarget {
  clusterId: string;
  clusterName: string;
  namespace: string;
  name: string;
  container: string;
}

// ── YAML ─────────────────────────────────────────────────────────────────────

/** GET /api/kube/clusters/:id/objects/:resource/:namespace/:name/yaml (operators and up). */
export interface KubeObjectYaml {
  yaml: string;
  /** Values were removed (a Secret's data); env values from Secrets are only ever references. */
  redacted: boolean;
}
