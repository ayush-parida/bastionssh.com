import { describe, it, expect } from 'vitest';
import type { KubeDiagnosis } from '@smt/shared';
import type { KubeObject } from './client.js';
import { CRASH_NEXT_STEP, diagnose, mergeByOwner, ownerResolver } from './health.js';
import { deployment, node, pod } from './fake-api.test-helper.js';

/**
 * Every plain-language diagnosis of spec §5.4, one fixture each: the exact
 * headline, cause and next step, and the evidence it links to.
 */

const o = (x: unknown) => x as KubeObject;
const NOW = Date.parse('2026-10-03T12:00:00Z');

type Mut = Record<string, any>;

function event(
  kind: string,
  namespace: string | null,
  name: string,
  reason: string,
  message: string,
  opts: { type?: 'Normal' | 'Warning'; count?: number; last?: string; first?: string } = {},
): KubeObject {
  return o({
    kind: 'Event',
    metadata: { name: `${name}.${reason}.${Math.random().toString(36).slice(2, 8)}`, namespace: namespace ?? 'default' },
    involvedObject: { kind, namespace: namespace ?? undefined, name },
    reason,
    message,
    type: opts.type ?? 'Warning',
    count: opts.count ?? 1,
    firstTimestamp: opts.first ?? opts.last ?? '2026-10-03T11:50:00Z',
    lastTimestamp: opts.last ?? '2026-10-03T11:59:00Z',
    source: { component: 'kubelet' },
  });
}

/** A Deployment's pod: owned by ReplicaSet web-7d4. */
function webPod(name: string, opts: Parameters<typeof pod>[2] = {}): Mut {
  return pod('shop', name, { node: 'worker-1', labels: { app: 'web' }, owner: { kind: 'ReplicaSet', name: 'web-7d4' }, ...opts });
}

const replicaSet = o({
  kind: 'ReplicaSet',
  metadata: {
    name: 'web-7d4',
    namespace: 'shop',
    annotations: { 'deployment.kubernetes.io/revision': '2' },
    ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }],
  },
  spec: { replicas: 2 },
  status: { readyReplicas: 0 },
});

const run = (input: Partial<Parameters<typeof diagnose>[0]>) =>
  diagnose({ pods: [], nodes: null, events: [], replicaSets: [replicaSet], now: NOW, ...input });

const only = (list: KubeDiagnosis[]) => {
  expect(list).toHaveLength(1);
  return list[0]!;
};

describe('diagnoses (spec §5.4)', () => {
  it('crash loop: the exit code, what it means, and the logs as next step', () => {
    const p = webPod('web-1', { waiting: 'CrashLoopBackOff', restarts: 37 });
    p.status.containerStatuses[0].lastState = { terminated: { reason: 'Error', exitCode: 1, finishedAt: '2026-10-03T11:58:00Z' } };
    const d = only(run({ pods: [o(p)], events: [event('Pod', 'shop', 'web-1', 'BackOff', 'Back-off restarting failed container app in pod web-1', { count: 37 })] }));
    expect(d).toMatchObject({
      id: 'crash-loop',
      severity: 'critical',
      subject: { resource: 'pods', kind: 'Pod', namespace: 'shop', name: 'web-1' },
      owner: { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: 'web' },
      headline: 'The app starts and crashes repeatedly (exit code 1).',
      cause:
        'Container `app` exited with code 1 — the app reported an error and quit; it has restarted 37 times and Kubernetes now waits longer before each new start.',
      nextStep: CRASH_NEXT_STEP,
      since: '2026-10-03T11:59:00Z',
    });
    expect(d.evidence).toEqual([
      { type: 'fact', label: 'Container app', detail: 'CrashLoopBackOff, restarted 37 times', ref: null },
      { type: 'fact', label: 'Last exit', detail: 'code 1 (Error) at 2026-10-03T11:58:00Z', ref: null },
      { type: 'event', label: 'BackOff ×37', detail: 'Back-off restarting failed container app in pod web-1', ref: d.subject },
      { type: 'object', label: 'Deployment web', detail: 'runs this pod', ref: d.owner },
    ]);
  });

  it('image pull: names the image and the three usual causes', () => {
    const p = webPod('web-1', { waiting: 'ImagePullBackOff' });
    const d = only(
      run({
        pods: [o(p)],
        events: [event('Pod', 'shop', 'web-1', 'Failed', 'Failed to pull image "shop/web:1.4.2": not found', { count: 4 })],
      }),
    );
    expect(d).toMatchObject({
      id: 'image-pull',
      severity: 'critical',
      headline: "The image `shop/web:1.4.2` can't be downloaded — wrong tag, private registry without credentials, or registry unreachable.",
      cause: 'Failed to pull image "shop/web:1.4.2": not found',
      nextStep: 'Check the image name and tag, add an image pull secret if the registry is private, or check that the nodes can reach the registry.',
    });
    expect(d.evidence[0]).toEqual({ type: 'fact', label: 'Container app', detail: 'ImagePullBackOff for shop/web:1.4.2', ref: null });
    expect(d.evidence[1]).toMatchObject({ type: 'event', label: 'Failed ×4' });
  });

  it('OOMKilled: the limit, and raise it or use less', () => {
    const p = webPod('web-1', { waiting: 'CrashLoopBackOff', restarts: 3 });
    p.spec.containers[0].resources.limits = { memory: '256Mi' };
    p.status.containerStatuses[0].lastState = { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-10-03T11:55:00Z' } };
    const d = only(run({ pods: [o(p)] }));
    expect(d).toMatchObject({
      id: 'oom-killed',
      severity: 'critical',
      headline: 'The container ran out of memory (limit 256Mi).',
      cause: 'Container `app` used more than its 256Mi memory limit and was killed by the kernel; it has restarted 3 times.',
      nextStep: 'Raise the limit or reduce usage.',
      since: '2026-10-03T11:55:00Z',
    });
    expect(d.evidence.slice(0, 2)).toEqual([
      { type: 'fact', label: 'Container app', detail: 'OOMKilled at 2026-10-03T11:55:00Z, exit code 137', ref: null },
      { type: 'fact', label: 'Memory limit', detail: '256Mi', ref: null },
    ]);

    // Recovered long ago: history, not a problem
    const old = webPod('web-2');
    old.status.containerStatuses[0].lastState = { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-10-01T00:00:00Z' } };
    expect(run({ pods: [o(old)] })).toEqual([]);
  });

  it('pending, no room: what it needs against the largest free node', () => {
    const p = webPod('big', { unschedulable: '0/2 nodes are available: 2 Insufficient cpu.', cpu: '2' });
    const busy = webPod('busy', { node: 'worker-1', cpu: '3500m' });
    const d = only(
      run({
        pods: [o(p), o(busy)],
        nodes: [o(node('worker-1', { cpu: '4' })), o(node('worker-2', { cpu: '1', ready: true }))],
        events: [event('Pod', 'shop', 'big', 'FailedScheduling', '0/2 nodes are available: 2 Insufficient cpu.')],
      }),
    );
    expect(d).toMatchObject({
      id: 'unschedulable-resources',
      headline: 'No node has room: needs 2 CPU, largest free is 1 CPU.',
      cause: '0/2 nodes are available: 2 Insufficient cpu.',
      nextStep: "Lower the pod's CPU request, make room by scaling other workloads down, or add a node.",
    });
    expect(d.evidence[0]).toEqual({ type: 'fact', label: 'Requests', detail: '2 CPU, 128 MiB memory', ref: null });
    expect(d.evidence[1]).toMatchObject({ type: 'object', label: 'Node worker-2', detail: '1 CPU free, the most of any node', ref: { kind: 'Node', name: 'worker-2' } });

    // Memory, half a CPU free on the busy node
    const mem = webPod('mem', { unschedulable: '0/1 nodes are available: 1 Insufficient memory.', memory: '4Gi' });
    const dm = only(run({ pods: [o(mem)], nodes: [o(node('worker-1', { memory: '1536Mi' }))] }));
    expect(dm.headline).toBe('No node has room: needs 4 GiB memory, largest free is 1.5 GiB.');
  });

  it('pending, nowhere it may go: selector or tolerations', () => {
    const p = webPod('picky', { unschedulable: "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector." });
    p.spec.nodeSelector = { disk: 'ssd' };
    const d = only(run({ pods: [o(p)], nodes: [o(node('worker-1'))] }));
    expect(d).toMatchObject({
      id: 'unschedulable-placement',
      headline: 'No node matches its node selector or tolerations.',
      cause: "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector.",
      nextStep: "Check the pod's nodeSelector, affinity and tolerations against the nodes' labels and taints.",
    });
    expect(d.evidence[0]).toEqual({ type: 'fact', label: 'Node selector', detail: 'disk=ssd', ref: null });
  });

  it('readiness failing: running, no traffic, and the probe path', () => {
    const p = webPod('web-1', { ready: false });
    p.spec.containers[0].readinessProbe = { httpGet: { path: '/healthz', port: 8080 } };
    p.status.containerStatuses[0].state = { running: { startedAt: '2026-10-03T11:00:00Z' } };
    const d = only(
      run({
        pods: [o(p)],
        events: [event('Pod', 'shop', 'web-1', 'Unhealthy', 'Readiness probe failed: HTTP probe failed with statuscode: 503', { count: 120 })],
      }),
    );
    expect(d).toMatchObject({
      id: 'readiness-failing',
      severity: 'warning',
      headline: 'Running but not ready — the readiness check `/healthz` fails, so it receives no traffic.',
      cause: 'Readiness probe failed: HTTP probe failed with statuscode: 503',
      nextStep:
        "Make sure the app answers `/healthz` on port 8080 with a success status once it has started, or fix the probe's path and port.",
    });
    expect(d.evidence[0]).toEqual({ type: 'fact', label: 'Readiness check', detail: '/healthz on container app', ref: null });

    // Just started, no failure reported yet: give the probe its grace
    const fresh = webPod('web-2', { ready: false });
    fresh.spec.containers[0].readinessProbe = { httpGet: { path: '/healthz', port: 8080 } };
    fresh.status.containerStatuses[0].state = { running: { startedAt: '2026-10-03T11:59:50Z' } };
    expect(run({ pods: [o(fresh)] })).toEqual([]);
  });

  it('service without endpoints: the selector, and why nothing answers', () => {
    const svc = o({ kind: 'Service', metadata: { name: 'web', namespace: 'shop' }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } });
    const d = only(run({ services: [svc] }));
    expect(d).toMatchObject({
      id: 'service-no-endpoints',
      severity: 'critical',
      subject: { kind: 'Service', name: 'web' },
      headline: 'This Service selects `app=web` but no ready pods match — traffic goes nowhere.',
      cause: "No pod in `shop` has these labels — a typo in the selector or in the pods' labels, or nothing is running yet.",
      nextStep: 'Compare the selector with the labels of the pods it should reach, or start the workload behind it.',
      evidence: [{ type: 'fact', label: 'Selector', detail: 'app=web', ref: null }],
    });

    // Pods match but none is ready: they are listed as evidence
    const notReady = webPod('web-1', { ready: false });
    notReady.status.conditions = [{ type: 'Ready', status: 'False' }];
    const withPods = run({ services: [svc], pods: [o(notReady)] }).find((x) => x.id === 'service-no-endpoints')!;
    expect(withPods.cause).toBe('1 pod matches the selector, but none is ready.');
    expect(withPods.evidence[1]).toMatchObject({ type: 'object', label: 'Pod web-1', ref: { kind: 'Pod', name: 'web-1' } });

    // A ready pod: fine
    const ready = webPod('web-2');
    ready.status.conditions = [{ type: 'Ready', status: 'True' }];
    expect(run({ services: [svc], pods: [o(ready)] })).toEqual([]);
  });

  it('PVC pending: a StorageClass that does not exist, or one that cannot provision', () => {
    const claim = (cls: string | null) =>
      o({
        kind: 'PersistentVolumeClaim',
        metadata: { name: 'data', namespace: 'shop', creationTimestamp: '2026-10-03T11:00:00Z' },
        spec: { ...(cls !== null && { storageClassName: cls }), resources: { requests: { storage: '10Gi' } } },
        status: { phase: 'Pending' },
      });
    const local = o({ kind: 'StorageClass', metadata: { name: 'local-path' }, provisioner: 'rancher.io/local-path', volumeBindingMode: 'Immediate' });
    const missing = only(run({ claims: [claim('fast')], storageClasses: [local] }));
    expect(missing).toMatchObject({
      id: 'pvc-pending',
      headline: 'Storage was requested but not provisioned — no StorageClass `fast` or no capacity.',
      cause: 'There is no StorageClass `fast` in this cluster.',
      nextStep: "Use one of the cluster's StorageClasses (or create `fast`), then recreate the claim.",
      evidence: [{ type: 'fact', label: 'Requested', detail: '10Gi of class fast', ref: null }],
    });

    const failing = only(
      run({
        claims: [claim('local-path')],
        storageClasses: [local],
        events: [event('PersistentVolumeClaim', 'shop', 'data', 'ProvisioningFailed', 'no space left on device')],
      }),
    );
    expect(failing).toMatchObject({
      headline: 'Storage was requested but not provisioned — no StorageClass `local-path` or no capacity.',
      cause: 'no space left on device',
      nextStep: "Check the storage provisioner's capacity and logs, or pick another StorageClass.",
    });
    expect(failing.evidence[1]).toMatchObject({ type: 'object', label: 'StorageClass local-path', detail: 'rancher.io/local-path' });

    expect(only(run({ claims: [claim(null)], storageClasses: [] })).headline).toBe(
      'Storage was requested but not provisioned — no default StorageClass or no capacity.',
    );
    // Waiting for its first pod is how WaitForFirstConsumer works
    const lazy = o({ kind: 'StorageClass', metadata: { name: 'lazy' }, volumeBindingMode: 'WaitForFirstConsumer' });
    expect(run({ claims: [claim('lazy')], storageClasses: [lazy] })).toEqual([]);
  });

  it('node not ready or under pressure: its pods may be evicted', () => {
    const down = node('worker-2', { ready: false }) as Mut;
    down.status.conditions[0] = { type: 'Ready', status: 'Unknown', message: 'Kubelet stopped posting node status.', lastTransitionTime: '2026-10-03T11:40:00Z' };
    const d = only(run({ nodes: [o(down)] }));
    expect(d).toMatchObject({
      id: 'node-not-ready',
      severity: 'critical',
      subject: { resource: 'nodes', kind: 'Node', namespace: null, name: 'worker-2' },
      headline: 'Node is unreachable or under memory/disk pressure; its pods may be evicted.',
      cause: 'The node has stopped reporting to the cluster (Kubelet stopped posting node status.).',
      nextStep: 'Check that the machine is running and its kubelet is up; cordon it while you look so no new pods land there.',
      since: '2026-10-03T11:40:00Z',
    });
    expect(d.evidence[0]).toEqual({ type: 'fact', label: 'Ready', detail: 'Unknown since 2026-10-03T11:40:00Z', ref: null });

    const pressed = node('worker-3') as Mut;
    pressed.status.conditions.push({ type: 'MemoryPressure', status: 'True', message: 'kubelet has insufficient memory available' });
    expect(only(run({ nodes: [o(pressed)] }))).toMatchObject({
      id: 'node-pressure',
      severity: 'warning',
      cause: 'The node reports memory pressure (kubelet has insufficient memory available).',
      nextStep: 'Free memory or disk on the node, or move some of its pods elsewhere.',
    });
  });

  it('rollout stuck: the new version never became ready, the old one still serves', () => {
    const dep = deployment('shop', 'web', { replicas: 2, ready: 2 }) as Mut;
    dep.metadata.annotations = { 'deployment.kubernetes.io/revision': '2' };
    dep.status.conditions = [
      { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "web-7d4" has timed out progressing.' },
    ];
    const previous = o({
      kind: 'ReplicaSet',
      metadata: {
        name: 'web-5c8',
        namespace: 'shop',
        annotations: { 'deployment.kubernetes.io/revision': '1' },
        ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }],
      },
      spec: { replicas: 2 },
      status: { readyReplicas: 2 },
    });
    const d = only(run({ deployments: [o(dep)], replicaSets: [replicaSet, previous] }));
    expect(d).toMatchObject({
      id: 'rollout-stuck',
      headline: 'The new version never became ready; the previous version is still serving.',
      cause: 'ReplicaSet "web-7d4" has timed out progressing.',
      nextStep:
        'See why the new pods fail (their problems are listed too), then fix the image or configuration — or roll back to the previous revision.',
    });
    expect(d.evidence).toEqual([
      expect.objectContaining({ type: 'object', label: 'ReplicaSet web-7d4', detail: 'new version (revision 2), 0 ready', ref: expect.objectContaining({ kind: 'ReplicaSet', name: 'web-7d4' }) }),
      expect.objectContaining({ type: 'object', label: 'ReplicaSet web-5c8', detail: 'previous version (revision 1), 2 ready' }),
    ]);
  });

  it('a healthy namespace has nothing to say', () => {
    const ok = webPod('web-1');
    ok.status.conditions = [{ type: 'Ready', status: 'True' }];
    expect(run({ pods: [o(ok)], nodes: [o(node('worker-1'))], deployments: [o(deployment('shop', 'web'))] })).toEqual([]);
  });
});

describe('the attention list', () => {
  it('merges a workload’s pods into one line and ranks critical first', () => {
    const crash = (name: string) => {
      const p = webPod(name, { waiting: 'CrashLoopBackOff', restarts: 5 });
      p.status.containerStatuses[0].lastState = { terminated: { reason: 'Error', exitCode: 1 } };
      return o(p);
    };
    const slow = webPod('other', { ready: false, owner: { kind: 'StatefulSet', name: 'db' } });
    slow.spec.containers[0].readinessProbe = { tcpSocket: { port: 5432 } };
    slow.status.containerStatuses[0].state = { running: { startedAt: '2026-10-03T10:00:00Z' } };
    const all = run({ pods: [o(slow), crash('web-1'), crash('web-2'), crash('web-3')] });
    expect(all).toHaveLength(4);
    const merged = mergeByOwner(all);
    expect(merged.map((d) => [d.id, d.affected])).toEqual([
      ['crash-loop', 3],
      ['readiness-failing', 1],
    ]);
    expect(merged[0]!.evidence.at(-1)).toEqual({ type: 'fact', label: 'Pods affected', detail: '3 pods of Deployment web', ref: null });
    expect(merged[1]!.headline).toBe('Running but not ready — the readiness check `tcp :5432` fails, so it receives no traffic.');
  });

  it('follows pods to their workload through ReplicaSets and Jobs', () => {
    const job = o({ kind: 'Job', metadata: { name: 'nightly-1', namespace: 'ops', ownerReferences: [{ kind: 'CronJob', name: 'nightly', controller: true }] } });
    const resolve = ownerResolver([replicaSet], [job]);
    expect(resolve(o(webPod('web-1')))).toEqual({ kind: 'Deployment', name: 'web' });
    expect(resolve(o(pod('ops', 'n-1', { owner: { kind: 'Job', name: 'nightly-1' } })))).toEqual({ kind: 'CronJob', name: 'nightly' });
    expect(resolve(o(pod('ops', 'db-0', { owner: { kind: 'StatefulSet', name: 'db' } })))).toEqual({ kind: 'StatefulSet', name: 'db' });
    expect(resolve(o(pod('ops', 'bare')))).toBeNull();
  });
});
