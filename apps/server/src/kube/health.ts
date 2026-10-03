import type { KubePodTileStatus, KubeWorkloadHealth, KubeWorkloadKind } from '@smt/shared';
import type { KubeObject } from './client.js';

/**
 * Health at a glance: the colour of a pod tile on the cluster map (spec
 * §5.1) and the dot next to a workload. Plain rules over the status the API
 * server reports; the plain-language diagnoses built on them (§5.4) come in
 * K2 and live here too.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v) as Json[]) : []);
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** Waiting reasons that mean the container cannot start as things stand. */
export const FAILING_WAITING_REASONS = new Set([
  'CrashLoopBackOff',
  'ErrImagePull',
  'ImagePullBackOff',
  'ErrImageNeverPull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
  'PreCreateHookError',
  'PostStartHookError',
]);

export interface PodHealth {
  status: KubePodTileStatus;
  /** The most telling reason; null when all is well. */
  reason: string | null;
  /** The scheduler's (or kubelet's) message for the reason, when there is one. */
  message: string | null;
  restarts: number;
  readyContainers: number;
  totalContainers: number;
}

function condition(status: Json, type: string): Json | null {
  return arr(status.conditions).find((c) => c.type === type) ?? null;
}

/** A pod's tile colour and the reason behind it. */
export function podHealth(pod: KubeObject): PodHealth {
  const status = obj(pod.status);
  const containers = arr(status.containerStatuses);
  const inits = arr(status.initContainerStatuses);
  const specContainers = arr(obj(pod.spec).containers);
  const restarts = containers.reduce((n, c) => n + num(c.restartCount), 0);
  const readyContainers = containers.filter((c) => c.ready === true).length;
  const totalContainers = Math.max(containers.length, specContainers.length);
  const base = { restarts, readyContainers, totalContainers };
  const phase = str(status.phase) ?? 'Unknown';

  if (pod.metadata.deletionTimestamp) return { ...base, status: 'terminating', reason: 'Terminating', message: null };

  // A container that cannot start, init containers first (they block the rest)
  for (const c of [...inits, ...containers]) {
    const waiting = obj(obj(c.state).waiting);
    const reason = str(waiting.reason);
    if (reason && FAILING_WAITING_REASONS.has(reason)) {
      return { ...base, status: 'failing', reason, message: str(waiting.message) };
    }
  }
  for (const c of inits) {
    const terminated = obj(obj(c.state).terminated);
    if (num(terminated.exitCode) !== 0) {
      return { ...base, status: 'failing', reason: `Init:${str(terminated.reason) ?? 'Error'}`, message: str(terminated.message) };
    }
  }

  if (phase === 'Succeeded') return { ...base, status: 'completed', reason: null, message: null };
  if (phase === 'Failed') {
    const terminated = containers.map((c) => obj(obj(c.state).terminated)).find((t) => str(t.reason));
    return {
      ...base,
      status: 'failing',
      reason: str(status.reason) ?? str(terminated?.reason) ?? 'Failed',
      message: str(status.message) ?? str(terminated?.message),
    };
  }
  if (phase === 'Unknown') return { ...base, status: 'failing', reason: 'Unknown', message: 'The node stopped reporting this pod.' };

  if (phase === 'Pending') {
    const scheduled = condition(status, 'PodScheduled');
    if (scheduled && scheduled.status === 'False') {
      return { ...base, status: 'pending', reason: str(scheduled.reason) ?? 'Unschedulable', message: str(scheduled.message) };
    }
    const waiting = [...inits, ...containers].map((c) => obj(obj(c.state).waiting)).find((w) => str(w.reason));
    return { ...base, status: 'pending', reason: str(waiting?.reason) ?? 'Pending', message: str(waiting?.message) };
  }

  // Running
  for (const c of containers) {
    const terminated = obj(obj(c.state).terminated);
    if (Object.keys(terminated).length && num(terminated.exitCode) !== 0) {
      return { ...base, status: 'failing', reason: str(terminated.reason) ?? 'Error', message: str(terminated.message) };
    }
    const last = obj(obj(c.lastState).terminated);
    if (c.ready !== true && str(last.reason) === 'OOMKilled') {
      return { ...base, status: 'failing', reason: 'OOMKilled', message: null };
    }
  }
  if (totalContainers > 0 && readyContainers < totalContainers) {
    return { ...base, status: 'pending', reason: 'NotReady', message: str(condition(status, 'Ready')?.message) };
  }
  return { ...base, status: 'running', reason: null, message: null };
}

/** Is the pod waiting for a node (the map's "Waiting for a node" lane)? */
export function isUnscheduled(pod: KubeObject): boolean {
  return !str(obj(pod.spec).nodeName) && str(obj(pod.status).phase) === 'Pending' && !pod.metadata.deletionTimestamp;
}

export interface WorkloadHealth {
  health: KubeWorkloadHealth;
  summary: string;
  desired: number | null;
  ready: number | null;
  lastRunAt?: string | null;
}

function replicaHealth(desired: number, ready: number, updated: number, available: number, stale: boolean, deadline: boolean): KubeWorkloadHealth {
  if (desired === 0) return 'idle';
  if (deadline) return 'failed';
  if (ready === 0) return stale || updated < desired ? 'progressing' : 'failed';
  if (stale || updated < desired) return 'progressing';
  if (ready < desired || available < desired) return 'degraded';
  return 'healthy';
}

/** A workload's health in a word, and a one-line summary. */
export function workloadHealth(kind: KubeWorkloadKind, w: KubeObject): WorkloadHealth {
  const spec = obj(w.spec);
  const status = obj(w.status);
  const generation = num(w.metadata.generation, 0);
  const stale = generation > 0 && num(status.observedGeneration, generation) < generation;

  switch (kind) {
    case 'Deployment':
    case 'StatefulSet': {
      const desired = num(spec.replicas, 1);
      const ready = num(status.readyReplicas);
      const updated = kind === 'Deployment' ? num(status.updatedReplicas) : num(status.updatedReplicas, desired);
      const available = kind === 'Deployment' ? num(status.availableReplicas) : num(status.availableReplicas, ready);
      const progressing = condition(status, 'Progressing');
      const deadline = str(progressing?.reason) === 'ProgressDeadlineExceeded';
      const rolling =
        kind === 'StatefulSet' && str(status.updateRevision) !== null && str(status.currentRevision) !== str(status.updateRevision);
      const health = replicaHealth(desired, ready, updated, available, stale || rolling, deadline);
      const summary =
        desired === 0
          ? 'Scaled to zero'
          : deadline
            ? `${ready} of ${desired} ready — the rollout is stuck`
            : `${ready} of ${desired} ready`;
      return { health, summary, desired, ready };
    }
    case 'DaemonSet': {
      const desired = num(status.desiredNumberScheduled);
      const ready = num(status.numberReady);
      const updated = num(status.updatedNumberScheduled, desired);
      const available = num(status.numberAvailable, ready);
      const health = replicaHealth(desired, ready, updated, available, stale, false);
      return { health, summary: desired === 0 ? 'No matching nodes' : `${ready} of ${desired} nodes ready`, desired, ready };
    }
    case 'Job': {
      const completions = num(spec.completions, 1);
      const succeeded = num(status.succeeded);
      const failed = num(status.failed);
      const active = num(status.active);
      const complete = condition(status, 'Complete')?.status === 'True';
      const failedCond = condition(status, 'Failed');
      if (complete) return { health: 'completed', summary: `Completed ${succeeded}/${completions}`, desired: completions, ready: succeeded };
      if (failedCond?.status === 'True') {
        return {
          health: 'failed',
          summary: `Failed: ${str(failedCond.reason) ?? 'BackoffLimitExceeded'} (${failed} failed)`,
          desired: completions,
          ready: succeeded,
        };
      }
      if (spec.suspend === true) return { health: 'suspended', summary: 'Suspended', desired: completions, ready: succeeded };
      return {
        health: failed > 0 ? 'degraded' : 'progressing',
        summary: `Running: ${active} active, ${succeeded}/${completions} done${failed ? `, ${failed} failed` : ''}`,
        desired: completions,
        ready: succeeded,
      };
    }
    case 'CronJob': {
      const active = arr(status.active).length;
      const lastRunAt = str(status.lastScheduleTime);
      const schedule = str(spec.schedule) ?? '?';
      if (spec.suspend === true) return { health: 'suspended', summary: `Suspended (${schedule})`, desired: null, ready: null, lastRunAt };
      return {
        health: active > 0 ? 'progressing' : 'idle',
        summary: active > 0 ? `${active} running now (${schedule})` : `Runs ${schedule}`,
        desired: null,
        ready: null,
        lastRunAt,
      };
    }
  }
}
