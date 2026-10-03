import { describe, it, expect } from 'vitest';
import type { KubeObject } from './client.js';
import { podHealth, workloadHealth } from './health.js';
import { bytes, cpuMillis } from './quantity.js';
import { buildOverview, directRelations, objectFacts, selectorString, toWorkload } from './views.js';
import { deployment, node, pod } from './fake-api.test-helper.js';

const o = (x: unknown) => x as KubeObject;

describe('kube quantities', () => {
  it('reads CPU and memory the way Kubernetes writes them', () => {
    expect(cpuMillis('250m')).toBe(250);
    expect(cpuMillis('2')).toBe(2000);
    expect(cpuMillis('0.5')).toBe(500);
    expect(cpuMillis('1500000n')).toBe(2);
    expect(bytes('128Mi')).toBe(128 * 2 ** 20);
    expect(bytes('1G')).toBe(1e9);
    expect(bytes('1e3')).toBe(1000);
    expect(bytes('garbage')).toBe(0);
  });
});

describe('pod health', () => {
  it('colours tiles by what the pod is doing', () => {
    expect(podHealth(o(pod('a', 'ok'))).status).toBe('running');
    expect(podHealth(o(pod('a', 'crash', { waiting: 'CrashLoopBackOff', restarts: 37 })))).toMatchObject({
      status: 'failing',
      reason: 'CrashLoopBackOff',
      restarts: 37,
    });
    expect(podHealth(o(pod('a', 'pull', { waiting: 'ImagePullBackOff' }))).status).toBe('failing');
    expect(podHealth(o(pod('a', 'start', { waiting: 'ContainerCreating', phase: 'Pending' })))).toMatchObject({
      status: 'pending',
      reason: 'ContainerCreating',
    });
    expect(podHealth(o(pod('a', 'stuck', { unschedulable: '0/3 nodes are available: 3 Insufficient cpu.' })))).toMatchObject({
      status: 'pending',
      reason: 'Unschedulable',
      message: '0/3 nodes are available: 3 Insufficient cpu.',
    });
    expect(podHealth(o(pod('a', 'done', { phase: 'Succeeded', ready: false }))).status).toBe('completed');
    expect(podHealth(o(pod('a', 'notready', { ready: false }))).status).toBe('pending');
    const terminating = pod('a', 'bye');
    terminating.metadata.deletionTimestamp = '2026-10-03T00:00:00Z';
    expect(podHealth(o(terminating)).status).toBe('terminating');
    const oom = pod('a', 'oom', { ready: false });
    (oom.status as { containerStatuses: Record<string, unknown>[] }).containerStatuses[0]!.lastState = {
      terminated: { reason: 'OOMKilled', exitCode: 137 },
    };
    expect(podHealth(o(oom))).toMatchObject({ status: 'failing', reason: 'OOMKilled' });
  });
});

describe('workload health', () => {
  it('reads replicas, rollouts and jobs', () => {
    expect(workloadHealth('Deployment', o(deployment('a', 'web', { replicas: 3, ready: 3 })))).toMatchObject({
      health: 'healthy',
      summary: '3 of 3 ready',
    });
    expect(workloadHealth('Deployment', o(deployment('a', 'web', { replicas: 3, ready: 1 }))).health).toBe('degraded');
    expect(workloadHealth('Deployment', o(deployment('a', 'web', { replicas: 2, ready: 0 }))).health).toBe('failed');
    expect(workloadHealth('Deployment', o(deployment('a', 'web', { replicas: 0, ready: 0 }))).health).toBe('idle');
    const stuck = deployment('a', 'web', { replicas: 2, ready: 1 });
    (stuck.status as Record<string, unknown>).conditions = [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }];
    expect(workloadHealth('Deployment', o(stuck))).toMatchObject({ health: 'failed', summary: expect.stringContaining('stuck') });
    // A new Deployment still pulling its image is starting, not failing; after its deadline it is failing
    const starting = deployment('a', 'web', { replicas: 2, ready: 0 });
    (starting.status as Record<string, unknown>).conditions = [{ type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated' }];
    expect(workloadHealth('Deployment', o(starting)).health).toBe('progressing');
    const crashedLater = deployment('a', 'web', { replicas: 2, ready: 0 });
    (crashedLater.status as Record<string, unknown>).conditions = [{ type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }];
    expect(workloadHealth('Deployment', o(crashedLater)).health).toBe('failed');
    const rolling = deployment('a', 'web');
    rolling.metadata.generation = 2;
    expect(workloadHealth('Deployment', o(rolling)).health).toBe('progressing');

    const job = { kind: 'Job', metadata: { name: 'j' }, spec: { completions: 1 }, status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] } };
    expect(workloadHealth('Job', o(job)).health).toBe('completed');
    const cron = { kind: 'CronJob', metadata: { name: 'c' }, spec: { schedule: '*/5 * * * *', suspend: true }, status: {} };
    expect(toWorkload('CronJob', o(cron))).toMatchObject({ health: 'suspended', summary: 'Suspended (*/5 * * * *)' });
  });
});

describe('cluster map', () => {
  it('puts pods on their nodes, sums requests, and keeps a lane for pods waiting for a node', () => {
    const overview = buildOverview({
      clusterId: 'c1',
      serverVersion: 'v1.31.2',
      nodes: [o(node('worker-1')), o(node('cp-1', { roles: ['control-plane', 'master'] })), o(node('worker-2', { ready: false }))],
      pods: [
        o(pod('shop', 'web-1', { node: 'worker-1', cpu: '250m', memory: '256Mi' })),
        o(pod('shop', 'web-2', { node: 'worker-1', waiting: 'CrashLoopBackOff' })),
        o(pod('shop', 'big', { unschedulable: '0/3 nodes are available: 3 Insufficient cpu.' })),
        o(pod('kube-system', 'gone', { node: 'old-node' })),
      ],
      namespaces: ['kube-system', 'shop'],
      nodeUsage: new Map([['worker-1', { cpuMillis: 120, memoryBytes: 300 * 2 ** 20 }]]),
      warnings: [],
    });
    expect(overview.nodes.map((n) => [n.name, n.roles, n.ready])).toEqual([
      ['cp-1', ['control-plane'], true],
      ['old-node', [], true],
      ['worker-1', ['worker'], true],
      ['worker-2', ['worker'], false],
    ]);
    const w1 = overview.nodes.find((n) => n.name === 'worker-1')!;
    // Failing first
    expect(w1.pods.map((p) => [p.name, p.status])).toEqual([
      ['web-2', 'failing'],
      ['web-1', 'running'],
    ]);
    expect(w1.requested).toEqual({ cpuMillis: 350, memoryBytes: 384 * 2 ** 20 });
    expect(w1.allocatable).toEqual({ cpuMillis: 4000, memoryBytes: 8 * 2 ** 30, pods: 110 });
    expect(w1.usage).toEqual({ cpuMillis: 120, memoryBytes: 300 * 2 ** 20 });
    expect(overview.unscheduled.map((p) => [p.name, p.reason, p.message])).toEqual([
      ['big', 'Unschedulable', '0/3 nodes are available: 3 Insufficient cpu.'],
    ]);
    expect(overview.metricsAvailable).toBe(true);
  });
});

describe('object detail', () => {
  it('lists what a pod points at, Secrets by name only', () => {
    const p = pod('shop', 'web-1', { owner: { kind: 'ReplicaSet', name: 'web-7d4' }, secretEnv: { secret: 'db', key: 'password' } });
    expect(directRelations(o(p)).map((r) => [r.relation, r.kind, r.name])).toEqual([
      ['owned by', 'ReplicaSet', 'web-7d4'],
      ['runs on', 'Node', 'node-1'],
      ['reads env from', 'Secret', 'db'],
    ]);
  });

  it('links a static pod to its Node without a namespace (nodes are cluster-scoped)', () => {
    const p = pod('kube-system', 'kube-apiserver-cp-1', { node: 'cp-1' }) as Record<string, unknown> & { metadata: Record<string, unknown> };
    p.metadata.ownerReferences = [{ kind: 'Node', name: 'cp-1', controller: true }];
    const owner = directRelations(o(p)).find((r) => r.relation === 'owned by');
    expect(owner).toMatchObject({ resource: 'nodes', namespace: null, name: 'cp-1' });
  });

  it('describes a Secret without its values', () => {
    const facts = objectFacts(o({ kind: 'Secret', type: 'Opaque', metadata: { name: 's' }, data: { password: '••••' } }));
    expect(facts).toContainEqual({ label: 'Keys', value: 'password' });
    expect(JSON.stringify(facts)).not.toMatch(/••••/);
  });

  it('turns selectors into label selector strings', () => {
    expect(selectorString({ matchLabels: { app: 'web', tier: 'fe' } })).toBe('app=web,tier=fe');
    expect(selectorString({ matchExpressions: [{ key: 'env', operator: 'In', values: ['a', 'b'] }] })).toBe('env in (a,b)');
    expect(selectorString({})).toBeNull();
  });
});
