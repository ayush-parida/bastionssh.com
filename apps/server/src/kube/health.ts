import type {
  KubeDiagnosis,
  KubeDiagnosisId,
  KubeEvidence,
  KubeObjectRef,
  KubePodTileStatus,
  KubeSeverity,
  KubeWorkloadHealth,
  KubeWorkloadKind,
} from '@smt/shared';
import { KUBE_RESOURCES, kubeResourceOfKind } from '@smt/shared';
import type { KubeObject } from './client.js';
import { EventIndex, type KubeEventView } from './events.js';
import { bytes, cpuMillis } from './quantity.js';
import { mapSelectorString, podRequests } from './views.js';

/**
 * Health at a glance: the colour of a pod tile on the cluster map (spec
 * §5.1) and the dot next to a workload. Plain rules over the status the API
 * server reports; the plain-language diagnoses built on them (§5.4, K2) are
 * at the end of this file.
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

/**
 * `Progressing` reasons of a Deployment whose rollout has not finished yet;
 * once it has, the reason is `NewReplicaSetAvailable`.
 */
const ROLLOUT_IN_PROGRESS = new Set(['NewReplicaSetCreated', 'FoundNewReplicaSet', 'ReplicaSetUpdated']);

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
      // A rollout still within its deadline (a new Deployment pulling its image, too): starting, not failed
      const rollingOut =
        kind === 'Deployment' && progressing?.status === 'True' && ROLLOUT_IN_PROGRESS.has(str(progressing.reason) ?? '');
      const rolling =
        kind === 'StatefulSet' && str(status.updateRevision) !== null && str(status.currentRevision) !== str(status.updateRevision);
      const health = replicaHealth(desired, ready, updated, available, stale || rolling || rollingOut, deadline);
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

// ── Diagnoses (spec §5.4) ────────────────────────────────────

/**
 * A rule-based explainer, no AI: known states → a headline, the likely cause
 * and a next step, each resting on evidence the viewer can open (the object,
 * its events, the facts read from it). A pod is checked in this order and
 * the first rule that matches wins — one problem per pod:
 *
 * | rule                    | signal                                                     |
 * | ----------------------- | ---------------------------------------------------------- |
 * | image-pull              | ErrImagePull / ImagePullBackOff / InvalidImageName          |
 * | oom-killed              | last (or current) termination OOMKilled, recently           |
 * | crash-loop              | CrashLoopBackOff + last exit code (the route adds the log   |
 * |                         | tail for operators)                                         |
 * | unschedulable-resources | Pending + FailedScheduling "Insufficient cpu/memory"        |
 * | unschedulable-placement | … node selector, affinity or taints                         |
 * | unschedulable           | … anything else the scheduler says                          |
 * | readiness-failing       | running, not ready, readiness probe failing                 |
 *
 * and per object: service-no-endpoints (a Service no ready pod answers),
 * pvc-pending, node-not-ready / node-pressure, rollout-stuck
 * (ProgressDeadlineExceeded).
 *
 * Everything here reads cached, already-redacted objects; a diagnosis names
 * Secrets at most, never their values.
 */

export interface DiagnosisInput {
  pods: KubeObject[];
  /** Null when the credential may not list nodes (the scheduling rule then names no free capacity). */
  nodes: KubeObject[] | null;
  events: KubeObject[];
  services?: KubeObject[];
  claims?: KubeObject[];
  /** Null when not listable: a claim's class is then not checked for existence. */
  storageClasses?: KubeObject[] | null;
  deployments?: KubeObject[];
  replicaSets?: KubeObject[];
  jobs?: KubeObject[];
  /** For tests: what "now" is (readiness waits out the probe's grace first). */
  now?: number;
}

const SEVERITY_RANK: Record<KubeSeverity, number> = { critical: 0, warning: 1 };

const IMAGE_PULL_REASONS = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'ErrImageNeverPull']);

/** What a container's exit code usually means, in words. */
const EXIT_MEANING: Record<number, string> = {
  0: 'it finished without an error, but a long-running app is expected to keep running',
  1: 'the app reported an error and quit',
  2: 'it was started with wrong arguments',
  126: 'its command cannot be executed',
  127: 'its command was not found in the image',
  137: 'it was killed (SIGKILL), often by a failing liveness check or for using too much memory',
  139: 'it crashed (segmentation fault)',
  143: 'it was told to stop (SIGTERM) and did',
};

export const CRASH_NEXT_STEP = 'Check its logs from the last run for the error it printed before exiting.';
export const CRASH_NEXT_STEP_WITH_LOGS = 'Check its logs — last lines shown.';

/** A ref to an object of a kind the app reads; null for anything else. */
export function refOf(kind: string, namespace: string | null | undefined, name: string): KubeObjectRef | null {
  const resource = kubeResourceOfKind(kind);
  if (!resource) return null;
  return { resource, kind, namespace: KUBE_RESOURCES[resource].namespaced ? (namespace ?? null) : null, name };
}

export const refKey = (r: Pick<KubeObjectRef, 'kind' | 'namespace' | 'name'>) => `${r.kind}/${r.namespace ?? ''}/${r.name}`;

/** `2000` → `2 CPU`, `500` → `0.5 CPU`. */
export function formatCores(millis: number): string {
  return `${Number((millis / 1000).toFixed(2))} CPU`;
}

/** `4 GiB`, `1.5 GiB`, `512 MiB`. */
export function formatMemoryAmount(n: number): string {
  if (n >= 2 ** 30) return `${Number((n / 2 ** 30).toFixed(1))} GiB`;
  return `${Math.round(n / 2 ** 20)} MiB`;
}

function controller(o: KubeObject): { kind: string; name: string } | null {
  const refs = o.metadata.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  return ref ? { kind: ref.kind, name: ref.name } : null;
}

/**
 * The workload a pod belongs to, past the controllers in between: a
 * Deployment's pod (via its ReplicaSet), a CronJob's (via its Job), or the
 * direct controller (StatefulSet, DaemonSet, Job, a bare ReplicaSet, or a
 * kind the app does not read). Null for a pod nothing owns.
 */
export function ownerResolver(replicaSets: KubeObject[] = [], jobs: KubeObject[] = []) {
  const up = new Map<string, { kind: string; name: string } | null>();
  for (const rs of replicaSets) up.set(`ReplicaSet/${rs.metadata.namespace ?? ''}/${rs.metadata.name}`, controller(rs));
  for (const job of jobs) up.set(`Job/${job.metadata.namespace ?? ''}/${job.metadata.name}`, controller(job));
  return (o: KubeObject): { kind: string; name: string } | null => {
    const direct = controller(o);
    if (!direct) return null;
    if (direct.kind !== 'ReplicaSet' && direct.kind !== 'Job') return direct;
    const parent = up.get(`${direct.kind}/${o.metadata.namespace ?? ''}/${direct.name}`);
    if (parent && ((direct.kind === 'ReplicaSet' && parent.kind === 'Deployment') || (direct.kind === 'Job' && parent.kind === 'CronJob'))) {
      return parent;
    }
    return direct;
  };
}

/** The pod's `Ready` condition is true (it receives Service traffic). */
export function podReady(pod: KubeObject): boolean {
  if (pod.metadata.deletionTimestamp) return false;
  return condition(obj(pod.status), 'Ready')?.status === 'True';
}

/** Every key=value of a Service-style selector map is among `labels`. An empty selector matches nothing. */
export function selectorMatches(selector: unknown, labels: Record<string, string> | undefined): boolean {
  const entries = Object.entries(obj(selector)).filter(([, v]) => typeof v === 'string');
  if (!entries.length) return false;
  return entries.every(([k, v]) => labels?.[k] === v);
}

const evidenceOf = {
  object: (ref: KubeObjectRef | null, label: string, detail: string | null = null): KubeEvidence => ({ type: 'object', label, detail, ref }),
  event: (e: KubeEventView, ref: KubeObjectRef | null): KubeEvidence => ({
    type: 'event',
    label: e.count > 1 ? `${e.reason} ×${e.count}` : e.reason,
    detail: e.message || null,
    ref,
  }),
  fact: (label: string, detail: string | null): KubeEvidence => ({ type: 'fact', label, detail, ref: null }),
};

function diagnosis(
  id: KubeDiagnosisId,
  severity: KubeSeverity,
  subject: KubeObjectRef,
  owner: KubeObjectRef | null,
  text: { headline: string; cause: string; nextStep: string },
  evidence: (KubeEvidence | null)[],
  since: string | null,
): KubeDiagnosis {
  return { id, severity, subject, owner, ...text, evidence: evidence.filter((e): e is KubeEvidence => !!e), affected: 1, since };
}

const latest = (...times: (string | null | undefined)[]): string | null =>
  times.filter((t): t is string => !!t).sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0))[0] ?? null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface PodContext {
  events: EventIndex;
  ownerOf: (pod: KubeObject) => { kind: string; name: string } | null;
  /** Free CPU and memory of each node that takes new pods; null when nodes are not known. */
  free: { name: string; cpuMillis: number; memoryBytes: number }[] | null;
  now: number;
}

/** A readiness probe's target in words (`/healthz`, `tcp :5432`…), and its HTTP path and port when it has them. */
function probeTarget(probe: Json): { label: string; path: string | null; port: string | null } {
  const http = obj(probe.httpGet);
  if (Object.keys(http).length) {
    const path = str(http.path) ?? '/';
    return { label: `\`${path}\``, path, port: http.port !== undefined ? String(http.port) : null };
  }
  const tcp = obj(probe.tcpSocket);
  if (Object.keys(tcp).length) return { label: `\`tcp :${String(tcp.port)}\``, path: null, port: String(tcp.port) };
  const grpc = obj(probe.grpc);
  if (Object.keys(grpc).length) return { label: `\`grpc :${String(grpc.port)}\``, path: null, port: String(grpc.port) };
  const exec = obj(probe.exec);
  const command = Array.isArray(exec.command) ? (exec.command as unknown[]).map(String).join(' ') : '';
  return { label: command ? `\`${command.length > 60 ? `${command.slice(0, 60)}…` : command}\`` : 'check', path: null, port: null };
}

function podDiagnosis(pod: KubeObject, ctx: PodContext): KubeDiagnosis | null {
  if (pod.metadata.deletionTimestamp) return null;
  const ns = pod.metadata.namespace ?? null;
  const name = pod.metadata.name;
  const subject = refOf('Pod', ns, name)!;
  const owning = ctx.ownerOf(pod);
  const owner = owning ? refOf(owning.kind, ns, owning.name) : null;
  const ownerEvidence = owner ? evidenceOf.object(owner, `${owner.kind} ${owner.name}`, 'runs this pod') : null;
  const spec = obj(pod.spec);
  const status = obj(pod.status);
  const specContainers = new Map([...arr(spec.initContainers), ...arr(spec.containers)].map((c) => [str(c.name) ?? '', c]));
  const statuses = [...arr(status.initContainerStatuses), ...arr(status.containerStatuses)];
  const podEvent = (reason: string | RegExp, message?: RegExp) => ctx.events.latest('Pod', ns, name, reason, message);

  // 1. The image cannot be pulled
  for (const c of statuses) {
    const waiting = obj(obj(c.state).waiting);
    const reason = str(waiting.reason);
    if (!reason || !IMAGE_PULL_REASONS.has(reason)) continue;
    const cname = str(c.name) ?? '?';
    const image = str(specContainers.get(cname)?.image) ?? str(c.image) ?? '?';
    const failed = podEvent('Failed', /pull|image/i) ?? podEvent('Failed');
    return diagnosis(
      'image-pull',
      'critical',
      subject,
      owner,
      {
        headline: `The image \`${image}\` can't be downloaded — wrong tag, private registry without credentials, or registry unreachable.`,
        cause: failed?.message || str(waiting.message) || `The node could not pull the image (${reason}).`,
        nextStep:
          'Check the image name and tag, add an image pull secret if the registry is private, or check that the nodes can reach the registry.',
      },
      [evidenceOf.fact(`Container ${cname}`, `${reason} for ${image}`), failed && evidenceOf.event(failed, subject), ownerEvidence],
      latest(failed?.lastSeen, podEvent('BackOff', /pull/i)?.lastSeen),
    );
  }

  // 2. Out of memory, recently (an OOM long ago that the container recovered from is history, not a problem)
  for (const c of statuses) {
    const current = obj(obj(c.state).terminated);
    const last = obj(obj(c.lastState).terminated);
    const oom = str(current.reason) === 'OOMKilled' ? current : str(last.reason) === 'OOMKilled' ? last : null;
    if (!oom) continue;
    const finished = str(oom.finishedAt);
    const recent = !finished || ctx.now - (Date.parse(finished) || 0) < 60 * 60 * 1000;
    if (c.ready === true && !recent) continue;
    const cname = str(c.name) ?? '?';
    const limit = str(obj(obj(specContainers.get(cname)?.resources).limits).memory);
    const restarts = num(c.restartCount);
    const restarted = restarts ? `; it has restarted ${plural(restarts, 'time')}` : '';
    return diagnosis(
      'oom-killed',
      c.ready === true ? 'warning' : 'critical',
      subject,
      owner,
      limit
        ? {
            headline: `The container ran out of memory (limit ${limit}).`,
            cause: `Container \`${cname}\` used more than its ${limit} memory limit and was killed by the kernel${restarted}.`,
            nextStep: 'Raise the limit or reduce usage.',
          }
        : {
            headline: 'The container ran out of memory (no limit set — the node ran out).',
            cause: `Container \`${cname}\` was killed by the kernel because the node ran out of memory${restarted}.`,
            nextStep: 'Set a memory request and limit that fit what it uses, or reduce usage.',
          },
      [
        evidenceOf.fact(`Container ${cname}`, `OOMKilled${finished ? ` at ${finished}` : ''}, exit code ${num(oom.exitCode, 137)}`),
        evidenceOf.fact('Memory limit', limit ?? 'none'),
        ownerEvidence,
      ],
      finished,
    );
  }

  // 3. Starts and crashes, over and over
  for (const c of statuses) {
    if (str(obj(obj(c.state).waiting).reason) !== 'CrashLoopBackOff') continue;
    const cname = str(c.name) ?? '?';
    const last = obj(obj(c.lastState).terminated);
    const exit = typeof last.exitCode === 'number' ? last.exitCode : null;
    const lastReason = str(last.reason);
    const restarts = num(c.restartCount);
    const meaning = exit !== null ? EXIT_MEANING[exit] : undefined;
    const exited = exit !== null ? `exited with code ${exit}${lastReason && lastReason !== 'Error' ? ` (${lastReason})` : ''}` : 'keeps exiting';
    const backoff = podEvent('BackOff');
    return diagnosis(
      'crash-loop',
      'critical',
      subject,
      owner,
      {
        headline: exit !== null ? `The app starts and crashes repeatedly (exit code ${exit}).` : 'The app starts and crashes repeatedly.',
        cause: `Container \`${cname}\` ${exited}${meaning ? ` — ${meaning}` : ''}; it has restarted ${plural(restarts, 'time')} and Kubernetes now waits longer before each new start.`,
        nextStep: CRASH_NEXT_STEP,
      },
      [
        evidenceOf.fact(`Container ${cname}`, `CrashLoopBackOff, restarted ${plural(restarts, 'time')}`),
        exit !== null
          ? evidenceOf.fact('Last exit', `code ${exit}${lastReason ? ` (${lastReason})` : ''}${str(last.finishedAt) ? ` at ${str(last.finishedAt)}` : ''}`)
          : null,
        backoff && evidenceOf.event(backoff, subject),
        ownerEvidence,
      ],
      latest(backoff?.lastSeen, str(last.finishedAt)),
    );
  }

  // 4. No node will take it
  const scheduled = condition(status, 'PodScheduled');
  if (str(status.phase) === 'Pending' && scheduled?.status === 'False') {
    const event = podEvent('FailedScheduling');
    const message = str(scheduled.message) ?? event?.message ?? 'The scheduler has not placed this pod.';
    const evidence = [event ? evidenceOf.event(event, subject) : evidenceOf.fact('Scheduler', message), ownerEvidence];
    const since = latest(event?.lastSeen, str(scheduled.lastTransitionTime));
    const cpu = /Insufficient cpu/i.test(message);
    const memory = /Insufficient memory/i.test(message);
    if (cpu || memory) {
      const req = podRequests(pod);
      const largest = ctx.free?.length
        ? ctx.free.reduce((best, n) => ((cpu ? n.cpuMillis > best.cpuMillis : n.memoryBytes > best.memoryBytes) ? n : best))
        : null;
      const needs = cpu ? formatCores(req.cpuMillis) : `${formatMemoryAmount(req.memoryBytes)} memory`;
      const room = largest
        ? cpu
          ? formatCores(Math.max(0, largest.cpuMillis))
          : formatMemoryAmount(Math.max(0, largest.memoryBytes))
        : null;
      return diagnosis(
        'unschedulable-resources',
        'critical',
        subject,
        owner,
        {
          headline: room ? `No node has room: needs ${needs}, largest free is ${room}.` : `No node has room: needs ${needs}.`,
          cause: message,
          nextStep: `Lower the pod's ${cpu ? 'CPU' : 'memory'} request, make room by scaling other workloads down, or add a node.`,
        },
        [
          evidenceOf.fact('Requests', `${formatCores(req.cpuMillis)}, ${formatMemoryAmount(req.memoryBytes)} memory`),
          largest ? evidenceOf.object(refOf('Node', null, largest.name), `Node ${largest.name}`, `${room} free, the most of any node`) : null,
          ...evidence,
        ],
        since,
      );
    }
    if (/node selector|node affinity|didn't match|untolerated taint|had taint|didn't tolerate/i.test(message)) {
      const selector = Object.entries(obj(spec.nodeSelector)).map(([k, v]) => `${k}=${String(v)}`);
      return diagnosis(
        'unschedulable-placement',
        'critical',
        subject,
        owner,
        {
          headline: 'No node matches its node selector or tolerations.',
          cause: message,
          nextStep: "Check the pod's nodeSelector, affinity and tolerations against the nodes' labels and taints.",
        },
        [selector.length ? evidenceOf.fact('Node selector', selector.join(', ')) : null, ...evidence],
        since,
      );
    }
    return diagnosis(
      'unschedulable',
      'critical',
      subject,
      owner,
      {
        headline: 'No node can take this pod yet.',
        cause: message,
        nextStep: "The scheduler's message says what each node lacks; fix that, or add a node.",
      },
      evidence,
      since,
    );
  }

  // 5. Running, but the readiness check fails, so no traffic
  if (str(status.phase) === 'Running') {
    for (const c of arr(status.containerStatuses)) {
      if (c.ready === true) continue;
      const state = obj(c.state);
      if (!('running' in state)) continue;
      const cname = str(c.name) ?? '?';
      const probe = obj(specContainers.get(cname)?.readinessProbe);
      if (!Object.keys(probe).length) continue;
      const failing = podEvent('Unhealthy', /^Readiness probe/i);
      const startedAt = str(obj(state.running).startedAt);
      // Without a failure event, wait out the probe's own grace before calling it failing
      const grace = (num(probe.initialDelaySeconds) + num(probe.periodSeconds, 10) * num(probe.failureThreshold, 3)) * 1000;
      if (!failing && (!startedAt || ctx.now - (Date.parse(startedAt) || ctx.now) < grace)) continue;
      const target = probeTarget(probe);
      return diagnosis(
        'readiness-failing',
        'warning',
        subject,
        owner,
        {
          headline: `Running but not ready — the readiness check ${target.label} fails, so it receives no traffic.`,
          cause:
            failing?.message ||
            `Container \`${cname}\` has been running${startedAt ? ` since ${startedAt}` : ''}, but its readiness check has not passed.`,
          nextStep: target.path
            ? `Make sure the app answers \`${target.path}\`${target.port ? ` on port ${target.port}` : ''} with a success status once it has started, or fix the probe's path and port.`
            : 'Make sure the check passes once the app has started, or fix the probe.',
        },
        [
          evidenceOf.fact('Readiness check', `${target.label.replace(/`/g, '')} on container ${cname}`),
          failing && evidenceOf.event(failing, subject),
          ownerEvidence,
        ],
        latest(failing?.lastSeen, startedAt),
      );
    }
  }
  return null;
}

/** What each node that takes new pods has left after its pods' requests. */
function freeCapacity(nodes: KubeObject[], pods: KubeObject[]) {
  const requested = new Map<string, { cpuMillis: number; memoryBytes: number }>();
  for (const pod of pods) {
    const nodeName = str(obj(pod.spec).nodeName);
    const phase = str(obj(pod.status).phase);
    if (!nodeName || phase === 'Succeeded' || phase === 'Failed') continue;
    const r = podRequests(pod);
    const sum = requested.get(nodeName) ?? { cpuMillis: 0, memoryBytes: 0 };
    sum.cpuMillis += r.cpuMillis;
    sum.memoryBytes += r.memoryBytes;
    requested.set(nodeName, sum);
  }
  return nodes
    .filter((n) => obj(n.spec).unschedulable !== true && condition(obj(n.status), 'Ready')?.status === 'True')
    .map((n) => {
      const allocatable = obj(obj(n.status).allocatable);
      const used = requested.get(n.metadata.name) ?? { cpuMillis: 0, memoryBytes: 0 };
      return {
        name: n.metadata.name,
        cpuMillis: cpuMillis(allocatable.cpu) - used.cpuMillis,
        memoryBytes: bytes(allocatable.memory) - used.memoryBytes,
      };
    });
}

function serviceDiagnosis(svc: KubeObject, pods: KubeObject[]): KubeDiagnosis | null {
  const spec = obj(svc.spec);
  if (str(spec.type) === 'ExternalName') return null;
  const selector = mapSelectorString(spec.selector);
  if (!selector) return null;
  const ns = svc.metadata.namespace ?? null;
  const matching = pods.filter((p) => (p.metadata.namespace ?? null) === ns && selectorMatches(spec.selector, p.metadata.labels));
  if (matching.some(podReady)) return null;
  const subject = refOf('Service', ns, svc.metadata.name)!;
  return diagnosis(
    'service-no-endpoints',
    'critical',
    subject,
    null,
    {
      headline: `This Service selects \`${selector}\` but no ready pods match — traffic goes nowhere.`,
      cause: matching.length
        ? `${matching.length === 1 ? '1 pod matches' : `${matching.length} pods match`} the selector, but none is ready.`
        : `No pod in \`${ns ?? ''}\` has these labels — a typo in the selector or in the pods' labels, or nothing is running yet.`,
      nextStep: matching.length
        ? 'Fix the pods it selects (their problems are listed too); traffic flows again once one is ready.'
        : 'Compare the selector with the labels of the pods it should reach, or start the workload behind it.',
    },
    [
      evidenceOf.fact('Selector', selector),
      ...matching.slice(0, 5).map((p) => evidenceOf.object(refOf('Pod', ns, p.metadata.name), `Pod ${p.metadata.name}`, 'matches, not ready')),
    ],
    null,
  );
}

const DEFAULT_CLASS_ANNOTATIONS = ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class'];

function claimDiagnosis(claim: KubeObject, classes: KubeObject[] | null, events: EventIndex): KubeDiagnosis | null {
  if (str(obj(claim.status).phase) !== 'Pending') return null;
  const ns = claim.metadata.namespace ?? null;
  const subject = refOf('PersistentVolumeClaim', ns, claim.metadata.name)!;
  const spec = obj(claim.spec);
  const asked = typeof spec.storageClassName === 'string' ? spec.storageClassName : null;
  const fallback = classes?.find((c) => DEFAULT_CLASS_ANNOTATIONS.some((a) => c.metadata.annotations?.[a] === 'true')) ?? null;
  const className = asked === null ? (fallback?.metadata.name ?? null) : asked || null;
  const cls = className ? (classes?.find((c) => c.metadata.name === className) ?? null) : null;
  const failed = events.latest('PersistentVolumeClaim', ns, claim.metadata.name, 'ProvisioningFailed');
  // WaitForFirstConsumer: pending until a pod uses it — expected, unless provisioning already failed
  if (cls && str(cls.volumeBindingMode) === 'WaitForFirstConsumer' && !failed) return null;
  const missingClass = !!className && classes !== null && classes !== undefined && !cls;
  const requested = str(obj(obj(spec.resources).requests).storage);
  let cause: string;
  if (missingClass) cause = `There is no StorageClass \`${className}\` in this cluster.`;
  else if (failed?.message) cause = failed.message;
  else if (asked === '') cause = 'It asks for no StorageClass, so it waits for a matching PersistentVolume to be created by hand.';
  else if (className) cause = `The provisioner for \`${className}\` has not created a volume for it yet.`;
  else cause = 'It names no StorageClass and the cluster has no default one, so nothing provisions it.';
  return diagnosis(
    'pvc-pending',
    'critical',
    subject,
    null,
    {
      headline:
        asked === ''
          ? 'Storage was requested but not provisioned — no matching PersistentVolume exists.'
          : className
            ? `Storage was requested but not provisioned — no StorageClass \`${className}\` or no capacity.`
            : 'Storage was requested but not provisioned — no default StorageClass or no capacity.',
      cause,
      nextStep: missingClass
        ? `Use one of the cluster's StorageClasses (or create \`${className}\`), then recreate the claim.`
        : "Check the storage provisioner's capacity and logs, or pick another StorageClass.",
    },
    [
      evidenceOf.fact('Requested', `${requested ?? '?'}${className ? ` of class ${className}` : ''}`),
      cls ? evidenceOf.object(refOf('StorageClass', null, cls.metadata.name), `StorageClass ${cls.metadata.name}`, str(cls.provisioner)) : null,
      failed && evidenceOf.event(failed, subject),
    ],
    latest(failed?.lastSeen, claim.metadata.creationTimestamp),
  );
}

const PRESSURE_WORDS: Record<string, string> = {
  MemoryPressure: 'memory pressure',
  DiskPressure: 'disk pressure',
  PIDPressure: 'too many processes',
  NetworkUnavailable: 'an unconfigured network',
};

function nodeDiagnosis(node: KubeObject, events: EventIndex): KubeDiagnosis | null {
  const conditions = arr(obj(node.status).conditions);
  const ready = conditions.find((c) => c.type === 'Ready') ?? null;
  const pressures = conditions.filter((c) => (str(c.type) ?? '') in PRESSURE_WORDS && c.status === 'True');
  const notReady = !!ready && ready.status !== 'True';
  if (!notReady && !pressures.length) return null;
  const subject = refOf('Node', null, node.metadata.name)!;
  const pressureText = pressures.map((c) => PRESSURE_WORDS[str(c.type)!]).join(' and ');
  const event = events.latest('Node', null, node.metadata.name, /NotReady|Pressure|Rebooted/);
  const readyWhy = str(ready?.message);
  const firstPressureWhy = pressures[0] ? str(pressures[0].message) : null;
  return diagnosis(
    notReady ? 'node-not-ready' : 'node-pressure',
    notReady ? 'critical' : 'warning',
    subject,
    null,
    {
      headline: 'Node is unreachable or under memory/disk pressure; its pods may be evicted.',
      cause: notReady
        ? `${ready!.status === 'Unknown' ? 'The node has stopped reporting to the cluster' : 'The node reports it is not ready'}${readyWhy ? ` (${readyWhy})` : ''}${pressureText ? `, and it is under ${pressureText}` : ''}.`
        : `The node reports ${pressureText}${firstPressureWhy ? ` (${firstPressureWhy})` : ''}.`,
      nextStep: notReady
        ? 'Check that the machine is running and its kubelet is up; cordon it while you look so no new pods land there.'
        : 'Free memory or disk on the node, or move some of its pods elsewhere.',
    },
    [
      evidenceOf.fact('Ready', `${str(ready?.status) ?? 'Unknown'}${str(ready?.lastTransitionTime) ? ` since ${str(ready?.lastTransitionTime)}` : ''}`),
      ...pressures.map((c) => evidenceOf.fact(str(c.type)!, str(c.message))),
      event && evidenceOf.event(event, subject),
    ],
    latest(str(ready?.lastTransitionTime), ...pressures.map((c) => str(c.lastTransitionTime)), event?.lastSeen),
  );
}

export const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';

/** The ReplicaSets a Deployment owns. */
export function replicaSetsOf(dep: KubeObject, replicaSets: KubeObject[]): KubeObject[] {
  const ns = dep.metadata.namespace ?? null;
  return replicaSets.filter(
    (rs) =>
      (rs.metadata.namespace ?? null) === ns &&
      (rs.metadata.ownerReferences ?? []).some((o) => o.kind === 'Deployment' && o.name === dep.metadata.name),
  );
}

function rolloutDiagnosis(dep: KubeObject, replicaSets: KubeObject[], events: EventIndex): KubeDiagnosis | null {
  const progressing = condition(obj(dep.status), 'Progressing');
  if (!progressing || str(progressing.reason) !== 'ProgressDeadlineExceeded') return null;
  const ns = dep.metadata.namespace ?? null;
  const subject = refOf('Deployment', ns, dep.metadata.name)!;
  const owned = replicaSetsOf(dep, replicaSets);
  const current = dep.metadata.annotations?.[REVISION_ANNOTATION];
  const newest = owned.find((rs) => current && rs.metadata.annotations?.[REVISION_ANNOTATION] === current) ?? null;
  const serving = owned.filter((rs) => rs !== newest && num(obj(rs.status).readyReplicas) > 0);
  const event = events.for('Deployment', ns, dep.metadata.name)[0] ?? null;
  return diagnosis(
    'rollout-stuck',
    'critical',
    subject,
    null,
    {
      headline: serving.length
        ? 'The new version never became ready; the previous version is still serving.'
        : 'The new version never became ready, and no earlier version is serving.',
      cause:
        str(progressing.message) ??
        `The rollout passed its ${num(obj(dep.spec).progressDeadlineSeconds, 600)}s deadline without the new pods becoming ready.`,
      nextStep:
        'See why the new pods fail (their problems are listed too), then fix the image or configuration — or roll back to the previous revision.',
    },
    [
      newest
        ? evidenceOf.object(
            refOf('ReplicaSet', ns, newest.metadata.name),
            `ReplicaSet ${newest.metadata.name}`,
            `new version (revision ${current}), ${num(obj(newest.status).readyReplicas)} ready`,
          )
        : null,
      ...serving.map((rs) =>
        evidenceOf.object(
          refOf('ReplicaSet', ns, rs.metadata.name),
          `ReplicaSet ${rs.metadata.name}`,
          `previous version (revision ${rs.metadata.annotations?.[REVISION_ANNOTATION] ?? '?'}), ${num(obj(rs.status).readyReplicas)} ready`,
        ),
      ),
      event && evidenceOf.event(event, subject),
    ],
    latest(str(progressing.lastUpdateTime), str(progressing.lastTransitionTime)),
  );
}

/** Every problem in `input`, most severe and most recent first. */
export function diagnose(input: DiagnosisInput): KubeDiagnosis[] {
  const events = new EventIndex(input.events);
  const ctx: PodContext = {
    events,
    ownerOf: ownerResolver(input.replicaSets, input.jobs),
    free: input.nodes ? freeCapacity(input.nodes, input.pods) : null,
    now: input.now ?? Date.now(),
  };
  const out: KubeDiagnosis[] = [];
  const push = (d: KubeDiagnosis | null) => {
    if (d) out.push(d);
  };
  for (const node of input.nodes ?? []) push(nodeDiagnosis(node, events));
  for (const dep of input.deployments ?? []) push(rolloutDiagnosis(dep, input.replicaSets ?? [], events));
  for (const svc of input.services ?? []) push(serviceDiagnosis(svc, input.pods));
  for (const claim of input.claims ?? []) push(claimDiagnosis(claim, input.storageClasses ?? null, events));
  for (const pod of input.pods) push(podDiagnosis(pod, ctx));
  return rankDiagnoses(out);
}

/** Most severe first, then the ones affecting most objects, then the most recent. */
export function rankDiagnoses(list: KubeDiagnosis[]): KubeDiagnosis[] {
  return [...list].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.affected - a.affected ||
      (Date.parse(b.since ?? '') || 0) - (Date.parse(a.since ?? '') || 0) ||
      refKey(a.subject).localeCompare(refKey(b.subject)),
  );
}

/**
 * The "needs attention" list: one line per problem and workload — thirty
 * crash-looping replicas of one Deployment are one problem affecting thirty
 * pods, not thirty problems.
 */
export function mergeByOwner(list: KubeDiagnosis[]): KubeDiagnosis[] {
  const merged = new Map<string, KubeDiagnosis>();
  const out: KubeDiagnosis[] = [];
  for (const d of list) {
    if (!d.owner || d.subject.kind !== 'Pod') {
      out.push(d);
      continue;
    }
    const key = `${d.id}|${refKey(d.owner)}`;
    const first = merged.get(key);
    if (!first) {
      const copy = { ...d, evidence: [...d.evidence] };
      merged.set(key, copy);
      out.push(copy);
      continue;
    }
    first.affected += 1;
    first.since = latest(first.since, d.since);
  }
  for (const d of merged.values()) {
    if (d.affected > 1) d.evidence.push(evidenceOf.fact('Pods affected', `${d.affected} pods of ${d.owner!.kind} ${d.owner!.name}`));
  }
  return rankDiagnoses(out);
}
