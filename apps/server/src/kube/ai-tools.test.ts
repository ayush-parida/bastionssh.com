import { describe, it, expect } from 'vitest';
import { aiEventLimit, aiObject, aiObjectRef, formatEvents, toEventLine } from './ai-tools.js';
import type { KubeObject } from './client.js';
import { summarizeCluster } from './fleet.js';
import { deployment, node, pod } from './fake-api.test-helper.js';
import { REDACTED } from './redact.js';

const asObj = (o: unknown) => o as KubeObject;

describe('kube AI context', () => {
  it('never carries a Secret value, nor the manifest copy of it', () => {
    const secret = asObj({
      kind: 'Secret',
      metadata: {
        name: 'db',
        namespace: 'shop',
        managedFields: [{ manager: 'kubectl' }],
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"aHVudGVyMg=="}}', team: 'pay' },
      },
      data: { password: 'aHVudGVyMg==' },
      stringData: { token: 'plain-token' },
    });
    const out = aiObject(secret, true);
    expect(out.data).toEqual({ password: REDACTED });
    expect(out.metadata.annotations).toEqual({ team: 'pay' });
    const text = JSON.stringify(out);
    for (const value of ['aHVudGVyMg==', 'plain-token', 'managedFields']) expect(text).not.toContain(value);
  });

  it('drops the manifest copy of other objects too, and hides ConfigMap values when the org does', () => {
    const cm = asObj({
      kind: 'ConfigMap',
      metadata: { name: 'cfg', namespace: 'shop', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"mode":"x"}}' } },
      data: { mode: 'fast' },
    });
    expect(aiObject(cm, true).data).toEqual({ mode: 'fast' });
    expect(aiObject(cm, true).metadata.annotations).toEqual({});
    expect(aiObject(cm, false).data).toEqual({ mode: REDACTED });
  });

  it('reads object references the way the detail URLs do', () => {
    expect(aiObjectRef('pods', 'shop', 'web-1')).toEqual({ resource: 'pods', namespace: 'shop', name: 'web-1' });
    // Cluster-scoped kinds ignore a namespace the model adds
    expect(aiObjectRef('nodes', 'shop', 'worker-1')).toEqual({ resource: 'nodes', namespace: null, name: 'worker-1' });
    expect(() => aiObjectRef('pods', undefined, 'web-1')).toThrow(/not namespaced|Invalid namespace/);
    expect(() => aiObjectRef('pods', 'shop', 'a/b')).toThrow('Invalid object name');
    expect(() => aiObjectRef('clusterroles', null, 'x')).toThrow(/Unknown/);
  });

  it('formats events newest-style with their repeat count', () => {
    const line = toEventLine(
      asObj({
        metadata: { name: 'e', namespace: 'shop' },
        involvedObject: { kind: 'Pod', name: 'web-2' },
        type: 'Warning',
        reason: 'BackOff',
        message: ' Back-off restarting failed container ',
        series: { count: 37, lastObservedTime: '2026-10-03T12:00:00Z' },
        lastTimestamp: '2026-10-03T11:00:00Z',
      }),
    );
    expect(line).toEqual({
      at: '2026-10-03T12:00:00Z',
      type: 'Warning',
      reason: 'BackOff',
      object: 'Pod/web-2',
      message: 'Back-off restarting failed container',
      count: 37,
    });
    expect(formatEvents([line])).toBe('[2026-10-03T12:00:00Z] Warning BackOff Pod/web-2: Back-off restarting failed container (×37)');
    expect(formatEvents([])).toBe('No events.');
    expect([aiEventLimit(undefined), aiEventLimit(5000), aiEventLimit('3'), aiEventLimit(0)]).toEqual([50, 200, 3, 1]);
  });
});

describe('kube fleet summary', () => {
  it('counts nodes, pods and workloads, and lists the worst problems first', () => {
    const summary = summarizeCluster({
      nodes: [asObj(node('cp-1')), asObj(node('worker-2', { ready: false }))],
      pods: [
        asObj(pod('shop', 'web-1')),
        asObj(pod('shop', 'web-2', { waiting: 'ImagePullBackOff' })),
        asObj(pod('shop', 'huge', { unschedulable: 'no room' })),
        asObj(pod('shop', 'starting', { ready: false })),
        asObj(pod('shop', 'done', { phase: 'Succeeded' })),
      ],
      workloads: [
        { kind: 'Deployment', object: asObj(deployment('shop', 'web')) },
        { kind: 'Deployment', object: asObj(deployment('shop', 'api', { replicas: 3, ready: 0 })) },
        { kind: 'Deployment', object: asObj(deployment('shop', 'half', { replicas: 2, ready: 1 })) },
      ],
    });
    expect(summary.nodes).toEqual({ total: 2, ready: 1, cordoned: 0 });
    expect(summary.pods).toEqual({ running: 1, pending: 2, failing: 1, completed: 1, terminating: 0 });
    expect(summary.workloads).toEqual({ healthy: 1, failed: 1, degraded: 1 });
    expect(summary.problems.map((p) => `${p.severity} ${p.ref.kind} ${p.ref.name} ${p.reason}`)).toEqual([
      'critical Node worker-2 NotReady',
      'critical Deployment api 0 of 3 ready',
      'critical Pod web-2 ImagePullBackOff',
      'warning Deployment half 1 of 2 ready',
      // A pod still starting on its node is not a problem yet; one no node will take is
      'warning Pod huge Unschedulable',
    ]);
  });

  it('copes with a credential that may not list nodes', () => {
    expect(summarizeCluster({ nodes: null, pods: [], workloads: [] }).nodes).toEqual({ total: 0, ready: 0, cordoned: 0 });
  });
});
