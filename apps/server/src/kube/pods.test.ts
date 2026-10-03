import { describe, it, expect } from 'vitest';
import type { KubeObject } from './client.js';
import { podDetail } from './pods.js';

/** The pod panel (pods.ts): lanes in order, state, last termination, resources, usage, lifecycle. */

const base = (spec: Record<string, unknown>, status: Record<string, unknown>): KubeObject => ({
  kind: 'Pod',
  metadata: { name: 'web-1', namespace: 'shop' },
  spec: { nodeName: 'worker-1', ...spec },
  status,
});

describe('podDetail', () => {
  const healthy = base(
    {
      initContainers: [
        { name: 'migrate', image: 'shop/migrate:1' },
        { name: 'mesh', image: 'mesh/proxy:2', restartPolicy: 'Always', resources: { requests: { cpu: '50m' } } },
      ],
      containers: [
        {
          name: 'app',
          image: 'shop/web:1.4.2',
          resources: { requests: { cpu: '250m', memory: '128Mi' }, limits: { memory: '256Mi' } },
          ports: [{ name: 'http', containerPort: 8080 }],
        },
      ],
    },
    {
      phase: 'Running',
      podIP: '10.42.0.7',
      startTime: '2026-10-03T09:00:00Z',
      conditions: [
        { type: 'PodScheduled', status: 'True', lastTransitionTime: '2026-10-03T09:00:00Z' },
        { type: 'Initialized', status: 'True', lastTransitionTime: '2026-10-03T09:00:05Z' },
        { type: 'ContainersReady', status: 'True', lastTransitionTime: '2026-10-03T09:00:09Z' },
        { type: 'Ready', status: 'True', lastTransitionTime: '2026-10-03T09:00:09Z' },
      ],
      initContainerStatuses: [
        { name: 'migrate', state: { terminated: { reason: 'Completed', exitCode: 0, finishedAt: '2026-10-03T09:00:04Z' } } },
        { name: 'mesh', ready: true, state: { running: { startedAt: '2026-10-03T09:00:04Z' } } },
      ],
      containerStatuses: [
        {
          name: 'app',
          ready: true,
          restartCount: 2,
          state: { running: { startedAt: '2026-10-03T09:00:08Z' } },
          lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-10-03T08:59:00Z' } },
        },
      ],
    },
  );

  it('orders lanes init → sidecar → app, with state, resources and last termination', () => {
    const usage = new Map([['app', { cpuMillis: 120, memoryBytes: 200 * 2 ** 20 }]]);
    const d = podDetail(healthy, usage, true);
    expect(d.containers.map((c) => [c.name, c.role, c.state])).toEqual([
      ['migrate', 'init', 'terminated'],
      ['mesh', 'sidecar', 'running'],
      ['app', 'app', 'running'],
    ]);
    const app = d.containers[2]!;
    expect(app).toMatchObject({
      restarts: 2,
      ready: true,
      requests: { cpuMillis: 250, memoryBytes: 128 * 2 ** 20 },
      limits: { cpuMillis: null, memoryBytes: 256 * 2 ** 20 },
      usage: { cpuMillis: 120 },
      lastTermination: { reason: 'OOMKilled', exitCode: 137 },
      ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
    });
    expect(d.containers[0]!.usage).toBeNull();
    expect(d).toMatchObject({ phase: 'Running', podIP: '10.42.0.7', defaultContainer: 'app', metricsAvailable: true });
    expect(d.lifecycle.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('shows where a crash-looping pod is stuck', () => {
    const crashing = base(
      { containers: [{ name: 'app', image: 'shop/web:1' }] },
      {
        phase: 'Running',
        conditions: [
          { type: 'PodScheduled', status: 'True' },
          { type: 'Initialized', status: 'True' },
          { type: 'ContainersReady', status: 'False', reason: 'ContainersNotReady' },
          { type: 'Ready', status: 'False' },
        ],
        containerStatuses: [
          { name: 'app', restartCount: 9, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container' } } },
        ],
      },
    );
    const d = podDetail(crashing, null, false);
    expect(d.containers[0]).toMatchObject({ state: 'waiting', reason: 'CrashLoopBackOff', restarts: 9, usage: null });
    expect(d.lifecycle.map((s) => s.status)).toEqual(['done', 'done', 'failed', 'pending']);
    expect(d.lifecycle[2]!.detail).toMatch(/app: CrashLoopBackOff/);
  });

  it('shows a pod no node can take as failing at Scheduled, everything after it waiting', () => {
    const pending = base(
      { nodeName: undefined, containers: [{ name: 'app' }] },
      { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/2 nodes are available' }] },
    );
    const d = podDetail(pending, null, false);
    expect(d.lifecycle.map((s) => s.status)).toEqual(['failed', 'pending', 'pending', 'pending']);
    expect(d.lifecycle[0]!.detail).toBe('0/2 nodes are available');
    expect(d.containers[0]!.state).toBe('unknown');
  });
});
