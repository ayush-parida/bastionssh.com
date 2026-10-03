import { describe, it, expect } from 'vitest';
import type { KubeGraph } from '@smt/shared';
import type { KubeObject } from './client.js';
import { buildGraph, diagnosisInput, podSpecRefs, type ObjectsByResource } from './graph.js';
import { diagnose } from './health.js';
import { collapseEvents, groupEvents, readEvent } from './events.js';
import { containerLanes, podLifecycle, rolloutOf } from './insight.js';
import { EventIndex } from './events.js';
import { deployment, pod } from './fake-api.test-helper.js';

/**
 * The topology graph from fixture objects (spec §9): edges from selectors,
 * ownerReferences, volume and env references and HPA targets; dangling
 * edges broken with their reason; replica rings; plus the events timeline,
 * rollout timeline and pod lifecycle built from the same cache.
 */

const o = (x: unknown) => x as KubeObject;
type Mut = Record<string, any>;

const rs = (name: string, deploymentName: string, revision: number, ready: number, image = `shop/${deploymentName}:1.${revision}`) =>
  o({
    kind: 'ReplicaSet',
    metadata: {
      name,
      namespace: 'shop',
      creationTimestamp: `2026-10-0${revision}T00:00:00Z`,
      annotations: { 'deployment.kubernetes.io/revision': String(revision), 'kubernetes.io/change-cause': `release ${revision}` },
      ownerReferences: [{ kind: 'Deployment', name: deploymentName, controller: true }],
    },
    spec: { replicas: ready, template: { spec: { containers: [{ name: 'app', image }] } } },
    status: { readyReplicas: ready },
  });

function readyPod(name: string, extra: Parameters<typeof pod>[2] = {}): Mut {
  const p: Mut = pod('shop', name, { node: 'worker-1', labels: { app: 'web' }, owner: { kind: 'ReplicaSet', name: 'web-7d4' }, ...extra });
  p.status.conditions = [{ type: 'Ready', status: extra.waiting || extra.ready === false ? 'False' : 'True' }];
  return p;
}

/** A small shop: ingress → web service → web deployment (3 pods, one crashing) with config, a db, and broken links. */
function shop(): ObjectsByResource {
  const web = deployment('shop', 'web', { replicas: 3, ready: 2 }) as Mut;
  web.spec.template.spec.volumes = [
    { name: 'config', configMap: { name: 'web-config' } },
    { name: 'kube-api-access-x', projected: { sources: [{ configMap: { name: 'kube-root-ca.crt' } }] } },
  ];
  web.spec.template.spec.containers[0].env = [{ name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'db-creds', key: 'password' } } }];
  web.spec.template.spec.containers[0].envFrom = [{ configMapRef: { name: 'feature-flags' } }];
  const db = o({
    kind: 'StatefulSet',
    metadata: { name: 'db', namespace: 'shop', generation: 1 },
    spec: { replicas: 1, selector: { matchLabels: { app: 'db' } }, template: { metadata: { labels: { app: 'db' } }, spec: { containers: [{ name: 'pg', image: 'postgres:16' }] } } },
    status: { observedGeneration: 1, readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 },
  });
  const dbPod = pod('shop', 'db-0', { node: 'worker-1', labels: { app: 'db' }, owner: { kind: 'StatefulSet', name: 'db' } }) as Mut;
  dbPod.spec.volumes = [{ name: 'data', persistentVolumeClaim: { claimName: 'data-db-0' } }];
  dbPod.status.conditions = [{ type: 'Ready', status: 'True' }];
  return {
    ingresses: [
      o({
        kind: 'Ingress',
        metadata: { name: 'shop', namespace: 'shop' },
        spec: {
          rules: [
            {
              host: 'shop.example.com',
              http: {
                paths: [
                  { path: '/', backend: { service: { name: 'web', port: { number: 80 } } } },
                  { path: '/admin', backend: { service: { name: 'admin', port: { number: 80 } } } },
                ],
              },
            },
          ],
        },
      }),
    ],
    services: [
      o({ kind: 'Service', metadata: { name: 'web', namespace: 'shop' }, spec: { type: 'ClusterIP', selector: { app: 'web' }, ports: [{ port: 80, targetPort: 8080 }] } }),
      o({ kind: 'Service', metadata: { name: 'db', namespace: 'shop' }, spec: { type: 'ClusterIP', selector: { app: 'db' }, ports: [{ port: 5432 }] } }),
      o({ kind: 'Service', metadata: { name: 'search', namespace: 'shop' }, spec: { selector: { app: 'serach' }, ports: [{ port: 9200 }] } }),
    ],
    deployments: [o(web)],
    statefulsets: [db],
    daemonsets: [],
    cronjobs: [],
    jobs: [],
    replicasets: [rs('web-7d4', 'web', 2, 2), rs('web-5c8', 'web', 1, 0)],
    pods: [o(readyPod('web-1')), o(readyPod('web-2')), o(readyPod('web-3', { waiting: 'CrashLoopBackOff', restarts: 9 })), o(dbPod)],
    configmaps: [o({ kind: 'ConfigMap', metadata: { name: 'web-config', namespace: 'shop' }, data: { a: '1', b: '2' } })],
    secrets: [o({ kind: 'Secret', type: 'Opaque', metadata: { name: 'db-creds', namespace: 'shop' }, data: { password: '••••' } })],
    persistentvolumeclaims: [
      o({ kind: 'PersistentVolumeClaim', metadata: { name: 'data-db-0', namespace: 'shop' }, spec: { volumeName: 'pv-1' }, status: { phase: 'Bound', capacity: { storage: '10Gi' } } }),
    ],
    persistentvolumes: [o({ kind: 'PersistentVolume', metadata: { name: 'pv-1' }, spec: { capacity: { storage: '10Gi' }, storageClassName: 'local-path' }, status: { phase: 'Bound' } })],
    horizontalpodautoscalers: [
      o({ kind: 'HorizontalPodAutoscaler', metadata: { name: 'web', namespace: 'shop' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'web' }, minReplicas: 2, maxReplicas: 10 }, status: { currentReplicas: 3 } }),
      o({ kind: 'HorizontalPodAutoscaler', metadata: { name: 'gone', namespace: 'shop' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'worker' }, maxReplicas: 4 }, status: {} }),
    ],
    events: [],
    nodes: null,
    storageclasses: null,
  };
}

const graphOf = (objects: ObjectsByResource): KubeGraph =>
  buildGraph({ namespace: 'shop', objects, diagnoses: diagnose({ ...diagnosisInput(objects), now: Date.parse('2026-10-03T12:00:00Z') }) });

const edge = (g: KubeGraph, source: string, target: string) => g.edges.find((e) => e.source === source && e.target === target);

describe('topology graph', () => {
  it('draws Ingress → Service → workload → pods from real relationships', () => {
    const g = graphOf(shop());
    expect(edge(g, 'Ingress/shop/shop', 'Service/shop/web')).toMatchObject({
      relation: 'routes',
      broken: false,
      explanation: 'Routes shop.example.com/ to Service `web` port 80',
    });
    // The selector reaches the pods; the edge goes to the workload that owns them
    expect(edge(g, 'Service/shop/web', 'Deployment/shop/web')).toMatchObject({ relation: 'selects', broken: false });
    expect(edge(g, 'Service/shop/db', 'StatefulSet/shop/db')).toMatchObject({ relation: 'selects', broken: false });
    // ReplicaSets fold into the Deployment; its pods are one ring
    expect(g.nodes.some((n) => n.kind === 'ReplicaSet')).toBe(false);
    expect(edge(g, 'Deployment/shop/web', 'pods:Deployment/shop/web')).toMatchObject({ relation: 'owns', explanation: 'Runs 3 pods' });
    const ring = g.nodes.find((n) => n.id === 'pods:Deployment/shop/web')!;
    expect(ring).toMatchObject({ kind: 'Pods', health: 'failing', summary: '2 of 3 ready' });
    expect(ring.pods).toMatchObject({ ready: 2, total: 3, desired: 3, counts: { running: 2, failing: 1, pending: 0, completed: 0, terminating: 0 } });
    // Problems first in the ring
    expect(ring.pods!.pods[0]!.name).toBe('web-3');
    // The crash-looping pod counts as a problem of its Deployment
    expect(g.nodes.find((n) => n.id === 'Deployment/shop/web')).toMatchObject({ problems: 1, health: 'warning' });
  });

  it('links config and storage: volumes, env and envFrom, claims to volumes, autoscalers', () => {
    const g = graphOf(shop());
    expect(edge(g, 'Deployment/shop/web', 'ConfigMap/shop/web-config')).toMatchObject({ relation: 'mounts', broken: false });
    expect(edge(g, 'Deployment/shop/web', 'Secret/shop/db-creds')).toMatchObject({ relation: 'env', broken: false });
    // Secrets by name only: no values, no keys
    const secret = g.nodes.find((n) => n.id === 'Secret/shop/db-creds')!;
    expect(secret.summary).toBe('Opaque · values never shown');
    expect(JSON.stringify(g)).not.toContain('••••');
    // The token volume every pod gets is noise
    expect(g.nodes.some((n) => n.name === 'kube-root-ca.crt')).toBe(false);
    // StatefulSet claims come from its pods; the claim is bound to its volume
    expect(edge(g, 'StatefulSet/shop/db', 'PersistentVolumeClaim/shop/data-db-0')).toMatchObject({ relation: 'mounts' });
    expect(edge(g, 'PersistentVolumeClaim/shop/data-db-0', 'PersistentVolume//pv-1')).toMatchObject({ relation: 'bound', broken: false });
    expect(g.nodes.find((n) => n.id === 'PersistentVolume//pv-1')!.summary).toBe('Bound · 10Gi · local-path');
    expect(edge(g, 'HorizontalPodAutoscaler/shop/web', 'Deployment/shop/web')).toMatchObject({ relation: 'scales', broken: false });
  });

  it('draws what leads nowhere as broken, and says why', () => {
    const g = graphOf(shop());
    expect(edge(g, 'Ingress/shop/shop', 'missing:Service/shop/admin')).toMatchObject({
      broken: true,
      explanation: 'This Ingress sends shop.example.com/admin to Service `admin`, which does not exist.',
    });
    expect(g.nodes.find((n) => n.id === 'missing:Service/shop/admin')).toMatchObject({ health: 'missing', ref: null });
    expect(g.nodes.find((n) => n.id === 'Ingress/shop/shop')!.health).toBe('failing');
    expect(edge(g, 'Service/shop/search', 'missing:Pods/shop/search-selector')).toMatchObject({
      relation: 'selects',
      broken: true,
      explanation: 'This Service selects `app=serach`, but no pod has these labels — traffic goes nowhere.',
    });
    expect(g.nodes.find((n) => n.id === 'Service/shop/search')).toMatchObject({ health: 'failing', problems: 1 });
    expect(edge(g, 'Deployment/shop/web', 'missing:ConfigMap/shop/feature-flags')).toMatchObject({
      relation: 'env',
      broken: true,
      explanation: 'Its pods read settings from ConfigMap `feature-flags`, which does not exist — they cannot start.',
    });
    expect(edge(g, 'HorizontalPodAutoscaler/shop/gone', 'missing:Deployment/shop/worker')).toMatchObject({
      broken: true,
      explanation: 'Scales Deployment `worker`, which does not exist.',
    });
    expect(g.edges.filter((e) => e.broken)).toHaveLength(4);
  });

  it('marks a Service whose pods are all unready, and a workload scaled to zero still connects', () => {
    const objects = shop();
    objects.pods = objects.pods!.filter((p) => !p.metadata.name.startsWith('web'));
    (objects.deployments![0]!.spec as Mut).replicas = 0;
    const g = graphOf(objects);
    expect(edge(g, 'Service/shop/web', 'Deployment/shop/web')).toMatchObject({
      broken: true,
      explanation: 'Selects `app=web`, but none of those pods is ready — traffic goes nowhere.',
    });
    expect(g.nodes.find((n) => n.id === 'Deployment/shop/web')!.summary).toBe('Scaled to zero');
    expect(g.nodes.find((n) => n.id === 'Ingress/shop/shop')!.health).toBe('failing');
  });

  it('does not call a reference missing when the credential could not list that kind', () => {
    const objects = shop();
    objects.configmaps = null;
    const g = graphOf(objects);
    expect(g.nodes.find((n) => n.id === 'ConfigMap/shop/feature-flags')).toMatchObject({ health: 'idle', summary: 'Not listable with this credential' });
    expect(edge(g, 'Deployment/shop/web', 'ConfigMap/shop/feature-flags')!.broken).toBe(false);
  });

  it('stays readable with hundreds of pods: one ring per workload, capped', () => {
    const objects = shop();
    const many = Array.from({ length: 450 }, (_, i) => o(readyPod(`web-${i}`)));
    objects.pods = [...many, ...objects.pods!.filter((p) => !p.metadata.name.startsWith('web'))];
    const g = graphOf(objects);
    const ring = g.nodes.find((n) => n.id === 'pods:Deployment/shop/web')!;
    expect(ring.pods!.total).toBe(450);
    expect(ring.pods!.pods).toHaveLength(300);
    expect(g.nodes.filter((n) => n.kind === 'Pod')).toHaveLength(0);
    expect(g.nodes.length).toBeLessThan(25);
  });

  it('hangs a CronJob’s Jobs and their pods under it; bare pods stand alone', () => {
    const objects = shop();
    objects.cronjobs = [o({ kind: 'CronJob', metadata: { name: 'nightly', namespace: 'shop' }, spec: { schedule: '0 3 * * *', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'j' }] } } } } }, status: {} })];
    objects.jobs = [
      o({ kind: 'Job', metadata: { name: 'nightly-1', namespace: 'shop', ownerReferences: [{ kind: 'CronJob', name: 'nightly', controller: true }] }, spec: { completions: 1 }, status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] } }),
    ];
    objects.pods = [...objects.pods!, o(pod('shop', 'nightly-1-x', { phase: 'Succeeded', owner: { kind: 'Job', name: 'nightly-1' } })), o(pod('shop', 'debug'))];
    const g = graphOf(objects);
    expect(edge(g, 'CronJob/shop/nightly', 'Job/shop/nightly-1')).toMatchObject({ relation: 'owns' });
    expect(edge(g, 'Job/shop/nightly-1', 'pods:Job/shop/nightly-1')).toBeDefined();
    expect(g.nodes.find((n) => n.id === 'Pod/shop/debug')).toMatchObject({ kind: 'Pod', ref: { resource: 'pods', name: 'debug' } });
  });

  it('reads every kind of pod spec reference, skipping optional ones', () => {
    const refs = podSpecRefs({
      volumes: [
        { name: 'a', secret: { secretName: 's1' } },
        { name: 'b', projected: { sources: [{ secret: { name: 's2' } }, { configMap: { name: 'c1', optional: true } }] } },
      ],
      initContainers: [{ env: [{ name: 'X', valueFrom: { configMapKeyRef: { name: 'c2', key: 'k' } } }] }],
      containers: [{ envFrom: [{ secretRef: { name: 's3' } }] }],
    });
    expect(refs.map((r) => `${r.relation}:${r.kind}/${r.name}${r.optional ? '?' : ''}`)).toEqual([
      'mounts:Secret/s1',
      'mounts:Secret/s2',
      'mounts:ConfigMap/c1?',
      'env:ConfigMap/c2',
      'env:Secret/s3',
    ]);
  });
});

const ev = (name: string, reason: string, message: string, count: number, last: string, type = 'Warning') =>
  o({
    kind: 'Event',
    metadata: { name: `${name}.${reason}.${last}`, namespace: 'shop' },
    involvedObject: { kind: 'Pod', namespace: 'shop', name },
    reason,
    message,
    type,
    count,
    firstTimestamp: '2026-10-03T11:40:00Z',
    lastTimestamp: last,
    source: { component: 'kubelet' },
  });

describe('events timeline', () => {
  it('groups by object, newest first, and collapses repeats with their count', () => {
    const groups = groupEvents([
      ev('web-3', 'BackOff', 'Back-off restarting failed container', 30, '2026-10-03T11:58:00Z'),
      ev('web-3', 'BackOff', 'Back-off restarting failed container', 7, '2026-10-03T12:00:00Z'),
      ev('web-3', 'Pulled', 'Container image already present', 1, '2026-10-03T11:41:00Z', 'Normal'),
      ev('web-1', 'Started', 'Started container app', 1, '2026-10-03T11:00:00Z', 'Normal'),
    ]);
    expect(groups.map((g) => g.object.name)).toEqual(['web-3', 'web-1']);
    expect(groups[0]).toMatchObject({ object: { resource: 'pods', kind: 'Pod', namespace: 'shop' }, warnings: 37, lastSeen: '2026-10-03T12:00:00Z' });
    expect(groups[0]!.events[0]).toEqual({
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      count: 37,
      firstSeen: '2026-10-03T11:40:00Z',
      lastSeen: '2026-10-03T12:00:00Z',
      source: 'kubelet',
    });
    expect(groups[0]!.events).toHaveLength(2);
    // since: only what happened after
    expect(groupEvents([ev('web-1', 'Started', 'x', 1, '2026-10-03T11:00:00Z')], { since: Date.parse('2026-10-03T11:30:00Z') })).toEqual([]);
  });

  it('reads series and event times, and node events link without a namespace', () => {
    const e = readEvent(
      o({
        kind: 'Event',
        metadata: { name: 'n', namespace: 'default', creationTimestamp: '2026-10-03T10:00:00Z' },
        involvedObject: { kind: 'Node', name: 'worker-2' },
        reason: 'NodeNotReady',
        message: 'Node worker-2 status is now: NodeNotReady',
        eventTime: '2026-10-03T10:00:00Z',
        series: { count: 4, lastObservedTime: '2026-10-03T10:05:00Z' },
      }),
    )!;
    expect(e).toMatchObject({ count: 4, lastSeen: '2026-10-03T10:05:00Z', firstSeen: '2026-10-03T10:00:00Z', type: 'Normal' });
    const [group] = groupEvents([o({ kind: 'Event', metadata: { name: 'n', namespace: 'default' }, involvedObject: { kind: 'Node', name: 'worker-2' }, reason: 'Rebooted', lastTimestamp: '2026-10-03T10:00:00Z' })]);
    expect(group!.object).toEqual({ resource: 'nodes', kind: 'Node', namespace: null, name: 'worker-2' });
    expect(collapseEvents([])).toEqual([]);
  });
});

describe('rollout timeline and pod lifecycle', () => {
  it('lists revisions newest first with images and change-cause, the current one marked', () => {
    const dep = deployment('shop', 'web', { replicas: 3, ready: 2 }) as Mut;
    dep.metadata.annotations = { 'deployment.kubernetes.io/revision': '2' };
    dep.status.updatedReplicas = 2;
    const rollout = rolloutOf(o(dep), [rs('web-5c8', 'web', 1, 1), rs('web-7d4', 'web', 2, 2), rs('other-1', 'other', 1, 1)]);
    expect(rollout.current).toBe(2);
    expect(rollout.replicas).toEqual({ desired: 3, updated: 2, ready: 2, available: 2 });
    expect(rollout.inProgress).toBe(true);
    expect(rollout.revisions.map((r) => [r.revision, r.replicaSet, r.images[0], r.changeCause, r.current])).toEqual([
      [2, 'web-7d4', 'shop/web:1.2', 'release 2', true],
      [1, 'web-5c8', 'shop/web:1.1', 'release 1', false],
    ]);
  });

  it('builds Scheduled → Pulled → Started → Ready from conditions and events', () => {
    const p = readyPod('web-1') as Mut;
    p.status.conditions = [
      { type: 'PodScheduled', status: 'True', lastTransitionTime: '2026-10-03T11:00:00Z' },
      { type: 'Ready', status: 'True', lastTransitionTime: '2026-10-03T11:00:20Z' },
    ];
    const events = new EventIndex([ev('web-1', 'Pulled', 'Successfully pulled image "shop/web:1.4.2" in 3s', 1, '2026-10-03T11:00:05Z', 'Normal')]);
    expect(podLifecycle(o(p), events).map((s) => [s.id, s.state])).toEqual([
      ['scheduled', 'done'],
      ['pulled', 'done'],
      ['started', 'done'],
      ['ready', 'done'],
    ]);

    const pulling = pod('shop', 'web-9', { node: 'worker-1', waiting: 'ImagePullBackOff', phase: 'Pending' }) as Mut;
    pulling.status.conditions = [{ type: 'PodScheduled', status: 'True' }];
    const steps = podLifecycle(o(pulling), new EventIndex([ev('web-9', 'Failed', 'Failed to pull image "shop/web:9": not found', 3, '2026-10-03T11:00:05Z')]));
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ['scheduled', 'done'],
      ['pulled', 'failed'],
      ['started', 'waiting'],
      ['ready', 'waiting'],
    ]);
    expect(steps[1]!.detail).toBe('Failed to pull image "shop/web:9": not found');

    const stuck = pod('shop', 'big', { unschedulable: '0/2 nodes are available: 2 Insufficient cpu.' });
    expect(podLifecycle(o(stuck), new EventIndex([]))[0]).toMatchObject({ state: 'failed', detail: '0/2 nodes are available: 2 Insufficient cpu.' });
  });

  it('lays containers out as lanes: init, app, then sidecars', () => {
    const p = pod('shop', 'web-1', { node: 'worker-1', waiting: 'CrashLoopBackOff', restarts: 4 }) as Mut;
    p.spec.initContainers = [{ name: 'migrate', image: 'shop/migrate' }, { name: 'proxy', image: 'envoy', restartPolicy: 'Always' }];
    p.spec.containers.push({ name: 'istio-proxy', image: 'istio/proxyv2' });
    p.status.initContainerStatuses = [{ name: 'migrate', state: { terminated: { reason: 'Completed', exitCode: 0 } } }];
    p.status.containerStatuses[0].lastState = { terminated: { reason: 'Error', exitCode: 1, finishedAt: '2026-10-03T11:00:00Z' } };
    const lanes = containerLanes(o(p));
    expect(lanes.map((l) => [l.name, l.role, l.state, l.reason])).toEqual([
      ['migrate', 'init', 'terminated', 'Completed'],
      ['app', 'app', 'waiting', 'CrashLoopBackOff'],
      ['proxy', 'sidecar', 'unknown', null],
      ['istio-proxy', 'sidecar', 'unknown', null],
    ]);
    expect(lanes[1]).toMatchObject({ restarts: 4, lastTermination: { reason: 'Error', exitCode: 1, finishedAt: '2026-10-03T11:00:00Z' } });
  });
});
