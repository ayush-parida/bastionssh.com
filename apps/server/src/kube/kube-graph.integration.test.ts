import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { KubeAttentionList, KubeCluster, KubeConfigView, KubeDiagnosisId, KubeEventList, KubeGraph, KubeObjectInsight, KubeStorageView } from '@smt/shared';
import type { KubeClient, KubeObject } from './client.js';

/**
 * Understanding a cluster (K2) against a real, throwaway k3s cluster — never
 * a cluster from ~/.kube. Uses the environment of kube.integration.test.ts
 * (scripts/kube-it.sh):
 *
 *   eval "$(apps/server/scripts/kube-it.sh up | sed 's/^/export /')"
 *   pnpm vitest run src/kube/kube-graph.integration.test.ts
 *
 * It builds an app with every problem a single-node cluster can show in its
 * own namespace (created and deleted here): an Ingress → Service → Deployment
 * that works, an Ingress to a Service that does not exist, a Service no pod
 * answers, an image that cannot be pulled, a container killed for memory, a
 * crash loop, a readiness check that fails, pods no node can take (too big;
 * a node selector nothing matches), a claim for a StorageClass that does not
 * exist, and a rollout that never finishes. Then it reads the graph, the
 * diagnoses, the attention list and the events through the real routes —
 * directly with the kubeconfig's client certificate, and through the SSH
 * container with the read-only service account token.
 */

const kubeconfigPath = process.env.SMT_TEST_KUBE_KUBECONFIG;
const tokenFile = process.env.SMT_TEST_KUBE_TOKEN_FILE;
const caFile = process.env.SMT_TEST_KUBE_CA_FILE;
const innerUrl = process.env.SMT_TEST_KUBE_INNER_URL;
const sshHost = process.env.SMT_TEST_KUBE_SSH_HOST;
const sshPort = Number(process.env.SMT_TEST_KUBE_SSH_PORT ?? 22);
const NS = 'smt-it-graph';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { clientFor } = await import('./service.js');
const { connectionFromKubeconfig } = await import('./kubeconfig.js');

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 180_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - started > ms) return value;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

const small = { requests: { cpu: '5m', memory: '8Mi' } };
const sleeper = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  image: 'busybox:1.36',
  command: ['sleep', '3600'],
  resources: small,
  ...extra,
});
const pod = (name: string, spec: Record<string, unknown>, labels: Record<string, string> = {}): KubeObject =>
  ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: NS, labels }, spec }) as unknown as KubeObject;
const deployment = (name: string, container: Record<string, unknown>, extra: Record<string, unknown> = {}): KubeObject =>
  ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: NS },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { containers: [container] } },
      ...extra,
    },
  }) as unknown as KubeObject;
const service = (name: string, selector: Record<string, string>): KubeObject =>
  ({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: NS }, spec: { selector, ports: [{ port: 80, targetPort: 8080 }] } }) as unknown as KubeObject;
const ingress = (name: string, backend: string): KubeObject =>
  ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name, namespace: NS },
    spec: {
      rules: [
        {
          host: `${name}.smt-it.local`,
          http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: backend, port: { number: 80 } } } }] },
        },
      ],
    },
  }) as unknown as KubeObject;

/** Every rule the sample app sets off (node-not-ready / node-pressure need a broken node: unit-tested only). */
const EXPECTED: KubeDiagnosisId[] = [
  'crash-loop',
  'image-pull',
  'oom-killed',
  'unschedulable-resources',
  'unschedulable-placement',
  'readiness-failing',
  'service-no-endpoints',
  'pvc-pending',
  'rollout-stuck',
];

describe.skipIf(!kubeconfigPath)('understanding a live k3s cluster', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let cluster: KubeCluster;
  let client: KubeClient;

  const get = <T>(who: { headers: Record<string, string> }, id: string, rest: string) =>
    app.inject({ method: 'GET', url: `/api/kube/clusters/${id}${rest}`, headers: who.headers }).then((r) => {
      expect(r.statusCode, `${rest}: ${r.body}`).toBe(200);
      return r.json() as T;
    });

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('kube-it-graph');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    app = await buildApp();

    const kubeconfig = readFileSync(kubeconfigPath!, 'utf8');
    const res = await app.inject({ method: 'POST', url: '/api/kube/clusters', headers: admin.headers, payload: { kubeconfig, name: 'k3s-graph' } });
    expect(res.statusCode).toBe(201);
    cluster = res.json();

    const conn = connectionFromKubeconfig(kubeconfig);
    client = clientFor({ orgId, ...conn, connectVia: 'direct', viaServerId: null, viaAgentId: null });
    await client.delete('namespaces', null, NS).catch(() => undefined);
    await eventually(
      () => client.get('namespaces', null, NS).then(() => true, () => false),
      (exists) => !exists,
    );
    await client.create('namespaces', null, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } } as unknown as KubeObject);

    // Works: Ingress → Service → Deployment, with a ConfigMap it mounts
    await client.create('configmaps', NS, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'shop-config', namespace: NS }, data: { MODE: 'demo' } } as unknown as KubeObject);
    await client.create(
      'deployments',
      NS,
      deployment('shop', sleeper('shop', { envFrom: [{ configMapRef: { name: 'shop-config' } }] }), { replicas: 2 }),
    );
    await client.create('services', NS, service('shop', { app: 'shop' }));
    await client.create('ingresses', NS, ingress('shop', 'shop'));
    // Leads nowhere: an Ingress to a Service that does not exist, a Service no pod answers
    await client.create('ingresses', NS, ingress('ghost', 'nowhere'));
    await client.create('services', NS, service('orphan', { app: 'nobody' }));
    // Problems, one per rule
    await client.create('pods', NS, pod('bad-image', { containers: [sleeper('app', { image: 'busybox:smt-it-no-such-tag' })] }));
    await client.create(
      'pods',
      NS,
      pod('memory-hog', {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'hog',
            image: 'busybox:1.36',
            command: ['sh', '-c', 'a=$(head -c 104857600 /dev/zero | tr "\\0" x); sleep 3600'],
            resources: { requests: { cpu: '5m', memory: '16Mi' }, limits: { memory: '16Mi' } },
          },
        ],
      }),
    );
    await client.create(
      'pods',
      NS,
      pod('crashy', { containers: [{ name: 'app', image: 'busybox:1.36', command: ['sh', '-c', 'echo boom; exit 1'], resources: small }] }),
    );
    await client.create(
      'pods',
      NS,
      pod('not-ready', {
        containers: [sleeper('app', { readinessProbe: { exec: { command: ['false'] }, periodSeconds: 2, failureThreshold: 1 } })],
      }),
    );
    await client.create('pods', NS, pod('huge', { containers: [sleeper('app', { resources: { requests: { cpu: '400' } } })] }));
    await client.create('pods', NS, pod('picky', { nodeSelector: { 'smt-it/pool': 'nowhere' }, containers: [sleeper('app')] }));
    await client.create(
      'persistentvolumeclaims',
      NS,
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: 'data', namespace: NS },
        spec: { storageClassName: 'smt-it-missing', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } },
      } as unknown as KubeObject,
    );
    // A rollout that never finishes: a working version, then one whose image does not exist
    await client.create('deployments', NS, deployment('stuck', sleeper('app'), { progressDeadlineSeconds: 10 }));
    await eventually(
      () => client.get('deployments', NS, 'stuck'),
      (d) => (d.status as { availableReplicas?: number } | undefined)?.availableReplicas === 1,
    );
    await client.patch('deployments', NS, 'stuck', {
      spec: { template: { spec: { containers: [sleeper('app', { image: 'busybox:smt-it-also-missing' })] } } },
    });
  }, 300_000);

  afterAll(async () => {
    await client?.delete('namespaces', null, NS).catch(() => undefined);
    client?.close();
    await app?.close();
  });

  it('diagnoses every problem of the sample app in plain words, ranked on the attention list', async () => {
    const attention = await eventually(
      () => get<KubeAttentionList>(viewer, cluster.id, `/attention`),
      (a) => EXPECTED.every((id) => a.items.some((d) => d.id === id && d.subject.namespace === NS)),
    );
    const mine = attention.items.filter((d) => d.subject.namespace === NS);
    expect([...new Set(mine.map((d) => d.id))].sort()).toEqual([...EXPECTED].sort());
    const by = (id: KubeDiagnosisId) => mine.find((d) => d.id === id)!;
    // Both the bare pod and the stuck rollout's new pod cannot pull their image
    expect(mine.find((d) => d.id === 'image-pull' && d.subject.name === 'bad-image')!.headline).toContain('busybox:smt-it-no-such-tag');
    expect(mine.find((d) => d.id === 'image-pull' && d.owner?.name === 'stuck')!.headline).toContain('busybox:smt-it-also-missing');
    expect(by('oom-killed').headline).toMatch(/ran out of memory \(limit 16Mi\)/);
    expect(by('crash-loop').subject.name).toBe('crashy');
    expect(by('unschedulable-resources')).toMatchObject({ subject: expect.objectContaining({ name: 'huge' }) });
    expect(by('unschedulable-resources').headline).toMatch(/No node has room: needs 400 CPU/);
    expect(by('unschedulable-placement').subject.name).toBe('picky');
    expect(by('readiness-failing').subject.name).toBe('not-ready');
    expect(by('service-no-endpoints').headline).toContain('app=nobody');
    expect(by('pvc-pending').cause).toContain('smt-it-missing');
    expect(by('rollout-stuck').subject).toMatchObject({ kind: 'Deployment', name: 'stuck' });
    // Critical before warning
    const severities = attention.items.map((d) => d.severity);
    expect(severities.indexOf('warning') === -1 || severities.lastIndexOf('critical') < severities.indexOf('warning')).toBe(true);
    // The healthy app has no problem
    expect(mine.some((d) => d.subject.name.startsWith('shop') || d.owner?.name === 'shop')).toBe(false);
  }, 240_000);

  it('draws the topology: real links, a replica ring, and the links that lead nowhere dashed', async () => {
    const graph = await eventually(
      () => get<KubeGraph>(viewer, cluster.id, `/graph?namespace=${NS}`),
      (g) => g.nodes.some((n) => n.kind === 'Pods' && n.pods?.ready === 2 && n.id.includes('shop')),
    );
    const node = (kind: string, name: string) => graph.nodes.find((n) => n.kind === kind && n.name === name);
    const edge = (from: string, to: string) => graph.edges.find((e) => e.source === from && e.target === to);

    const shopIngress = node('Ingress', 'shop')!;
    const shopService = node('Service', 'shop')!;
    const shopDeployment = node('Deployment', 'shop')!;
    expect(edge(shopIngress.id, shopService.id)).toMatchObject({ relation: 'routes', broken: false });
    expect(edge(shopService.id, shopDeployment.id)).toMatchObject({ relation: 'selects', broken: false });
    expect(graph.edges.some((e) => e.source === shopDeployment.id && e.target === node('ConfigMap', 'shop-config')!.id && !e.broken)).toBe(true);
    const ring = graph.nodes.find((n) => n.kind === 'Pods' && graph.edges.some((e) => e.source === shopDeployment.id && e.target === n.id))!;
    expect(ring.pods).toMatchObject({ ready: 2, total: 2, desired: 2 });
    expect(shopDeployment.health).toBe('healthy');

    // Dangling: the Ingress to a Service that does not exist …
    const ghost = node('Ingress', 'ghost')!;
    const nowhere = node('Service', 'nowhere')!;
    expect(nowhere.health).toBe('missing');
    expect(nowhere.ref).toBeNull();
    expect(edge(ghost.id, nowhere.id)).toMatchObject({ broken: true, explanation: expect.stringMatching(/nowhere/) });
    // … and the Service no pod answers
    const orphan = node('Service', 'orphan')!;
    expect(orphan.problems).toBeGreaterThan(0);
    expect(graph.edges.some((e) => e.source === orphan.id && e.broken)).toBe(true);
    // The claim for a StorageClass that does not exist: pending, amber, its problem counted
    expect(node('PersistentVolumeClaim', 'data')).toMatchObject({ health: 'failing', summary: expect.stringMatching(/^Pending/), problems: 1 });
    // The stuck rollout counts its problem
    expect(node('Deployment', 'stuck')!.problems).toBeGreaterThan(0);
    expect(graph.warnings).toEqual([]);
  }, 240_000);

  it('opens an object with its diagnosis, its events and its rollout timeline', async () => {
    const pod = await eventually(
      () => get<KubeObjectInsight>(operator, cluster.id, `/objects/pods/${NS}/crashy/insight`),
      (i) => i.diagnoses.some((d) => d.id === 'crash-loop' && (d.logTail?.length ?? 0) > 0),
    );
    const crash = pod.diagnoses.find((d) => d.id === 'crash-loop')!;
    expect(crash.headline).toMatch(/exit code 1/);
    expect(crash.logTail).toContain('boom');
    expect(pod.events.some((e) => e.type === 'Warning' && e.reason === 'BackOff')).toBe(true);

    // A viewer gets the same diagnosis, without log lines
    const forViewer = await get<KubeObjectInsight>(viewer, cluster.id, `/objects/pods/${NS}/crashy/insight`);
    expect(forViewer.diagnoses.find((d) => d.id === 'crash-loop')?.logTail).toBeUndefined();

    const stuck = await get<KubeObjectInsight>(viewer, cluster.id, `/objects/deployments/${NS}/stuck/insight`);
    expect(stuck.diagnoses.map((d) => d.id)).toContain('rollout-stuck');
    expect(stuck.rollout!.revisions.map((r) => [r.revision, r.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(stuck.rollout!.revisions[0]!.images).toEqual(['busybox:smt-it-also-missing']);
    expect(stuck.rollout!.revisions[1]!.containers[0]).toMatchObject({ name: 'app', image: 'busybox:1.36' });
  }, 240_000);

  it('lists the claim without storage and the config by key only — never a Secret value', async () => {
    await client.create('secrets', NS, {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'shop-db', namespace: NS },
      stringData: { password: 'smt-it-live-secret' },
    } as unknown as KubeObject);
    const storage = await eventually(
      () => get<KubeStorageView>(viewer, cluster.id, `/storage?namespace=${NS}`),
      (v) => !!v.claims.find((c) => c.ref.name === 'data')?.problem,
      60_000,
    );
    expect(storage.claims.find((c) => c.ref.name === 'data')).toMatchObject({
      phase: 'Pending',
      storageClass: 'smt-it-missing',
      volume: null,
      problem: expect.objectContaining({ id: 'pvc-pending' }),
    });
    expect(storage.classes?.some((c) => c.isDefault)).toBe(true);

    const res = await app.inject({ method: 'GET', url: `/api/kube/clusters/${cluster.id}/config?namespace=${NS}`, headers: viewer.headers });
    expect(res.statusCode).toBe(200);
    const config = await eventually(
      async () => (await app.inject({ method: 'GET', url: `/api/kube/clusters/${cluster.id}/config?namespace=${NS}`, headers: viewer.headers })).json() as KubeConfigView,
      (v) => v.secrets.some((x) => x.ref.name === 'shop-db'),
      30_000,
    );
    expect(config.secrets.find((x) => x.ref.name === 'shop-db')).toMatchObject({ type: 'Opaque', keys: ['password'], usedBy: [] });
    expect(config.configMaps.find((x) => x.ref.name === 'shop-config')).toMatchObject({
      keys: ['MODE'],
      usedBy: [{ ref: expect.objectContaining({ kind: 'Deployment', name: 'shop' }), how: ['env'] }],
    });
    expect(JSON.stringify(config)).not.toContain('smt-it-live-secret');
    expect(JSON.stringify(config)).not.toContain(Buffer.from('smt-it-live-secret').toString('base64'));
  }, 120_000);

  it('groups the events by object, warnings highlighted and repeats collapsed', async () => {
    const events = await eventually(
      () => get<KubeEventList>(viewer, cluster.id, `/events?namespace=${NS}`),
      (l) => l.groups.some((g) => g.object.name === 'crashy' && g.events.some((e) => e.reason === 'BackOff' && e.count > 1)),
    );
    const crashy = events.groups.find((g) => g.object.name === 'crashy')!;
    expect(crashy.warnings).toBeGreaterThan(0);
    const backOff = crashy.events.filter((e) => e.reason === 'BackOff');
    expect(backOff).toHaveLength(1);
    expect(backOff[0]!.count).toBeGreaterThan(1);
    expect(events.groups.some((g) => g.object.kind === 'PersistentVolumeClaim' && g.object.name === 'data')).toBe(true);
  }, 240_000);

  it.skipIf(!sshHost || !innerUrl || !tokenFile || !caFile)(
    'draws the same graph and diagnoses through a managed server’s SSH tunnel with a read-only token',
    async () => {
      const server = await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: admin.headers,
        payload: {
          name: 'kube-graph-bastion',
          host: sshHost,
          port: sshPort,
          username: process.env.SMT_TEST_KUBE_SSH_USER ?? 'smt',
          authType: 'password',
          password: process.env.SMT_TEST_KUBE_SSH_PASSWORD ?? 'smt-it-pass',
        },
      });
      expect(server.statusCode).toBe(201);
      const res = await app.inject({
        method: 'POST',
        url: '/api/kube/clusters',
        headers: admin.headers,
        payload: {
          name: 'k3s-graph-via-ssh',
          apiUrl: innerUrl,
          caData: readFileSync(caFile!, 'utf8'),
          token: readFileSync(tokenFile!, 'utf8').trim(),
          connectVia: 'server',
          viaServerId: server.json().id,
        },
      });
      expect(res.statusCode).toBe(201);
      const viaSsh = res.json() as KubeCluster;

      const graph = await get<KubeGraph>(viewer, viaSsh.id, `/graph?namespace=${NS}`);
      const ghost = graph.nodes.find((n) => n.kind === 'Ingress' && n.name === 'ghost')!;
      expect(graph.edges.find((e) => e.source === ghost.id)).toMatchObject({ broken: true });
      expect(graph.nodes.find((n) => n.kind === 'Service' && n.name === 'nowhere')?.health).toBe('missing');

      // A crash-looping container is briefly running or just exited between back-offs
      const attention = await eventually(
        () => get<KubeAttentionList>(viewer, viaSsh.id, `/attention`),
        (a) => EXPECTED.every((id) => a.items.some((d) => d.id === id && d.subject.namespace === NS)),
        60_000,
      );
      const ids = new Set(attention.items.filter((d) => d.subject.namespace === NS).map((d) => d.id));
      expect(EXPECTED.filter((id) => !ids.has(id))).toEqual([]);
    },
    120_000,
  );
});
