import { describe, it, expect, beforeEach, vi } from 'vitest';

const notify = vi.hoisted(() => ({ events: [] as import('../notifications/index.js').AlertEvent[] }));
vi.mock('../notifications/index.js', () => ({
  notifyAlertsChanged: (events: import('../notifications/index.js').AlertEvent[]) => notify.events.push(...events),
}));

import { dedupKey } from '../notifications/channels/types.js';
import type { KubeObject } from './client.js';
import {
  MAX_ALERTS_PER_CLUSTER,
  PENDING_THRESHOLD_MS,
  REOPEN_COOLDOWN_MS,
  UNREACHABLE_SWEEPS,
  evaluateCluster,
  forgetClusterAlerts,
  openClusterAlerts,
  podOwner,
  reconcileClusterAlerts,
  sweepCluster,
  type ClusterRef,
} from './alerts.js';
import type { ClusterObjects } from './fleet.js';
import { deployment, node, pod } from './fake-api.test-helper.js';
import type { ClusterRow } from './service.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const cluster: ClusterRef = { id: 'c1', orgId: 'o1', name: 'prod', apiUrl: 'https://10.0.0.5:6443' };
const row = { id: 'c1', orgId: 'o1', name: 'prod', apiUrl: 'https://10.0.0.5:6443' } as ClusterRow;

const asObj = (o: unknown) => o as KubeObject;
const empty = (): ClusterObjects => ({ nodes: [], pods: [], workloads: [] });

/** A pod owned by a Deployment's ReplicaSet, the way the API server labels it. */
function replica(name: string, opts: Parameters<typeof pod>[2] = {}, uid = name): KubeObject {
  const p = asObj(pod('shop', name, { ...opts, owner: { kind: 'ReplicaSet', name: 'web-7d4f9c' } }));
  p.metadata.labels = { ...p.metadata.labels, 'pod-template-hash': '7d4f9c' };
  p.metadata.uid = uid;
  p.metadata.creationTimestamp = new Date(NOW - 60 * 60 * 1000).toISOString();
  return p;
}

beforeEach(() => {
  forgetClusterAlerts();
  notify.events.length = 0;
});

describe('cluster alert rules', () => {
  it('raises a not-ready node, an unavailable workload, and nothing for a healthy cluster', () => {
    expect(
      evaluateCluster('c1', 'o1', { nodes: [asObj(node('cp-1'))], pods: [replica('web-a')], workloads: [{ kind: 'Deployment', object: asObj(deployment('shop', 'web')) }] }, NOW),
    ).toEqual([]);

    const sick = asObj(node('worker-2', { ready: false }));
    const down = asObj(deployment('shop', 'api', { replicas: 3, ready: 0 }));
    const conditions = evaluateCluster('c1', 'o1', { nodes: [sick], pods: [], workloads: [{ kind: 'Deployment', object: down }] }, NOW);
    expect(conditions).toEqual([
      expect.objectContaining({ type: 'kube_node_not_ready', severity: 'critical', object: 'Node worker-2' }),
      expect.objectContaining({ type: 'kube_workload_unavailable', severity: 'critical', object: 'shop/Deployment api', value: 0, threshold: 3 }),
    ]);
    expect(conditions[1]!.message).toMatch(/0 of 3 ready/);
  });

  it('groups crash-looping pods under the Deployment that owns them', () => {
    expect(podOwner(replica('web-a'))).toBe('shop/Deployment web');
    expect(podOwner(asObj(pod('shop', 'lonely')))).toBe('shop/Pod lonely');
    const conditions = evaluateCluster(
      'c1',
      'o1',
      { ...empty(), pods: [replica('web-a', { waiting: 'CrashLoopBackOff', restarts: 12 }), replica('web-b', { waiting: 'CrashLoopBackOff', restarts: 9 })] },
      NOW,
    );
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ type: 'kube_pod_crashloop', object: 'shop/Deployment web', value: 2 });
    expect(conditions[0]!.message).toMatch(/2 pods crash-looping — web-a: CrashLoopBackOff, restarted 12 times \(and 1 more\)/);
  });

  it('counts restarts within the window even between back-offs', () => {
    const at = (restarts: number) => ({ ...empty(), pods: [replica('web-a', { restarts })] });
    expect(evaluateCluster('c1', 'o1', at(4), NOW)).toEqual([]);
    expect(evaluateCluster('c1', 'o1', at(5), NOW + 60_000)).toEqual([]);
    expect(evaluateCluster('c1', 'o1', at(7), NOW + 120_000)).toEqual([expect.objectContaining({ type: 'kube_pod_crashloop' })]);
    // Quiet for longer than the window: no longer a crash loop
    expect(evaluateCluster('c1', 'o1', at(7), NOW + 20 * 60_000)).toEqual([]);
  });

  it('raises pods pending past the threshold, not ones just starting', () => {
    const fresh = replica('web-new', { unschedulable: '0/2 nodes are available: 2 Insufficient cpu.' });
    fresh.metadata.creationTimestamp = new Date(NOW - 60_000).toISOString();
    const stuck = replica('web-old', { unschedulable: '0/2 nodes are available: 2 Insufficient cpu.' });
    stuck.metadata.creationTimestamp = new Date(NOW - PENDING_THRESHOLD_MS - 5 * 60_000).toISOString();
    const conditions = evaluateCluster('c1', 'o1', { ...empty(), pods: [fresh, stuck] }, NOW);
    expect(conditions).toEqual([expect.objectContaining({ type: 'kube_pod_pending', severity: 'warning', object: 'shop/Deployment web', value: 1 })]);
    expect(conditions[0]!.message).toMatch(/web-old: Unschedulable for 15 min — 0\/2 nodes are available/);
  });

  it('caps the alerts of one cluster, critical first', () => {
    const nodes = Array.from({ length: MAX_ALERTS_PER_CLUSTER + 10 }, (_, i) => asObj(node(`n-${String(i).padStart(2, '0')}`, { ready: false })));
    const conditions = evaluateCluster('c1', 'o1', { nodes, pods: [], workloads: [] }, NOW);
    expect(conditions).toHaveLength(MAX_ALERTS_PER_CLUSTER);
  });
});

describe('cluster alert dedupe', () => {
  const crash = { type: 'kube_pod_crashloop' as const, severity: 'critical' as const, object: 'shop/Deployment web', message: 'shop/Deployment web: crashing' };

  it('notifies on open and on resolve only, under a stable per-object key', () => {
    reconcileClusterAlerts(cluster, [crash], { now: NOW });
    reconcileClusterAlerts(cluster, [{ ...crash, message: 'still crashing' }], { now: NOW + 60_000 });
    expect(notify.events).toHaveLength(1);
    expect(notify.events[0]).toMatchObject({
      kind: 'opened',
      orgId: 'o1',
      serverId: 'c1',
      type: 'kube_pod_crashloop',
      container: 'shop/Deployment web',
      subject: { id: 'c1', name: 'prod', host: '10.0.0.5' },
    });
    expect(dedupKey(notify.events[0]!, 'now')).toBe('smt:c1:kube_pod_crashloop:shop/Deployment web');
    expect(openClusterAlerts('c1')).toEqual([expect.objectContaining({ message: 'still crashing', object: 'shop/Deployment web' })]);

    reconcileClusterAlerts(cluster, [], { now: NOW + 120_000 });
    expect(notify.events.map((e) => e.kind)).toEqual(['opened', 'resolved']);
    expect(notify.events[1]!.openedAt).toBe(new Date(NOW).toISOString());
    expect(openClusterAlerts('c1')).toEqual([]);
  });

  it('reopens a flapping alert quietly within the cooldown, and resolves it quietly too', () => {
    reconcileClusterAlerts(cluster, [crash], { now: NOW });
    reconcileClusterAlerts(cluster, [], { now: NOW + 60_000 });
    reconcileClusterAlerts(cluster, [crash], { now: NOW + 120_000 });
    reconcileClusterAlerts(cluster, [], { now: NOW + 180_000 });
    expect(notify.events.map((e) => e.kind)).toEqual(['opened', 'resolved']);
    // Past the cooldown it is a new incident again
    reconcileClusterAlerts(cluster, [crash], { now: NOW + 180_000 + REOPEN_COOLDOWN_MS });
    expect(notify.events.map((e) => e.kind)).toEqual(['opened', 'resolved', 'opened']);
  });

  it('keeps a critical alert critical while it fires', () => {
    reconcileClusterAlerts(cluster, [crash], { now: NOW });
    reconcileClusterAlerts(cluster, [{ ...crash, severity: 'warning' }], { now: NOW + 60_000 });
    expect(openClusterAlerts('c1')[0]!.severity).toBe('critical');
  });

  it('raises the cluster as unreachable after a few failed reads, keeping what was open', async () => {
    const sick = { ...empty(), nodes: [asObj(node('worker-2', { ready: false }))] };
    await sweepCluster(row, async () => sick);
    expect(openClusterAlerts('c1').map((a) => a.type)).toEqual(['kube_node_not_ready']);
    for (let i = 1; i < UNREACHABLE_SWEEPS; i++) {
      await sweepCluster(row, async () => null);
      expect(openClusterAlerts('c1').map((a) => a.type)).toEqual(['kube_node_not_ready']);
    }
    await sweepCluster(row, async () => null);
    expect(openClusterAlerts('c1').map((a) => a.type).sort()).toEqual(['kube_cluster_unreachable', 'kube_node_not_ready']);
    const unreachable = notify.events.find((e) => e.type === 'kube_cluster_unreachable')!;
    expect(unreachable).toMatchObject({ kind: 'opened', severity: 'critical' });
    expect(unreachable.container).toBeUndefined();
    // Back, and healthy: both resolve
    await sweepCluster(row, async () => ({ ...empty(), nodes: [asObj(node('worker-2'))] }));
    expect(openClusterAlerts('c1')).toEqual([]);
    expect(notify.events.filter((e) => e.kind === 'resolved').map((e) => e.type).sort()).toEqual([
      'kube_cluster_unreachable',
      'kube_node_not_ready',
    ]);
  });
});
