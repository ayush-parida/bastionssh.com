import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type {
  DiagnosticsResult,
  KubeCluster,
  KubeObjectDetail,
  KubeOverview,
  KubeTestResult,
  KubeWorkloadList,
  KubeconfigSummary,
} from '@smt/shared';

/**
 * Runs only against a real, throwaway k3s cluster in Docker — never a
 * cluster from ~/.kube. scripts/kube-it.sh starts one on an unusual port with
 * a sample app (a Deployment behind a Service and an Ingress, a crash-looping
 * pod, a pod no node can take, a Secret) and a read-only service account,
 * plus an openssh-server container on the same Docker network:
 *
 *   eval "$(apps/server/scripts/kube-it.sh up | sed 's/^/export /')"
 *   pnpm vitest run src/kube/kube.integration.test.ts
 *   apps/server/scripts/kube-it.sh down
 *
 * Everything goes through the real routes, kubeconfig parsing, vault,
 * transport (verified TLS with SNI), watch cache and views: once directly
 * with the kubeconfig's client certificate, once through the SSH container
 * (forwardOut to the cluster's in-network name) with the service account
 * token.
 */

const kubeconfigPath = process.env.SMT_TEST_KUBE_KUBECONFIG;
const tokenFile = process.env.SMT_TEST_KUBE_TOKEN_FILE;
const caFile = process.env.SMT_TEST_KUBE_CA_FILE;
const innerUrl = process.env.SMT_TEST_KUBE_INNER_URL;
const sshHost = process.env.SMT_TEST_KUBE_SSH_HOST;
const sshPort = Number(process.env.SMT_TEST_KUBE_SSH_PORT ?? 22);
const sshUser = process.env.SMT_TEST_KUBE_SSH_USER ?? 'smt';
const sshPassword = process.env.SMT_TEST_KUBE_SSH_PASSWORD ?? 'smt-it-pass';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 120_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - started > ms) return value;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

describe.skipIf(!kubeconfigPath)('kubernetes against a live k3s cluster', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let admin: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let direct: KubeCluster;

  const api = (who: { headers: Record<string, string> }, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, ...(payload && { payload }) });

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('kube-it');
    admin = seedUser(orgId, 'admin');
    viewer = seedUser(orgId, 'viewer');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('reads the kubeconfig and adds the cluster from its context (client certificate, direct)', async () => {
    const kubeconfig = readFileSync(kubeconfigPath!, 'utf8');
    const summary = (await api(admin, 'POST', '/api/kube/kubeconfig/contexts', { kubeconfig })).json() as KubeconfigSummary;
    expect(summary.contexts).toEqual([expect.objectContaining({ name: 'default', authType: 'cert', hasCa: true, problem: null })]);

    const res = await api(admin, 'POST', '/api/kube/clusters', { kubeconfig, context: 'default', name: 'k3s-direct' });
    expect(res.statusCode).toBe(201);
    direct = res.json();
    expect(direct).toMatchObject({ connectVia: 'direct', authType: 'cert', hasCa: true });
    expect(JSON.stringify(direct)).not.toContain('PRIVATE KEY');
  });

  it('tests the connection step by step and lists what the credential can do', async () => {
    const result = (await api(admin, 'POST', `/api/kube/clusters/${direct.id}/test`, {})).json() as KubeTestResult;
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ['reach', 'ok'],
      ['tls', 'ok'],
      ['auth', 'ok'],
      ['version', 'ok'],
      ['rules', 'ok'],
    ]);
    expect(result.serverVersion).toMatch(/^v1\.\d+/);
    expect(result.capabilities?.checks.some((c) => c.allowed)).toBe(true);
  }, 30_000);

  it('draws the cluster map: the node, a crash-looping pod in red, a pod waiting for a node', async () => {
    const overview = await eventually(
      async () => (await api(viewer, 'GET', `/api/kube/clusters/${direct.id}/overview`)).json() as KubeOverview,
      (o) => o.nodes?.some((n) => n.pods.some((p) => p.name === 'crasher' && p.status === 'failing')) ?? false,
    );
    expect(overview.nodes).toHaveLength(1);
    const [node] = overview.nodes;
    expect(node).toMatchObject({ ready: true, roles: expect.arrayContaining(['control-plane']) });
    expect(node!.allocatable.cpuMillis).toBeGreaterThan(0);
    expect(node!.pods.filter((p) => p.namespace === 'smt-it' && p.owner?.kind === 'ReplicaSet')).toHaveLength(2);
    expect(node!.pods.find((p) => p.name === 'crasher')).toMatchObject({ status: 'failing', restarts: expect.any(Number) });
    expect(overview.unscheduled).toEqual([
      expect.objectContaining({ name: 'too-big', namespace: 'smt-it', status: 'pending', message: expect.stringMatching(/cpu/i) }),
    ]);
    expect(overview.namespaces).toEqual(expect.arrayContaining(['default', 'kube-system', 'smt-it']));
  }, 150_000);

  it('lists workloads with their health, and the Deployment’s details', async () => {
    const list = (await api(viewer, 'GET', `/api/kube/clusters/${direct.id}/workloads?namespace=smt-it`)).json() as KubeWorkloadList;
    expect(list.workloads).toEqual([expect.objectContaining({ kind: 'Deployment', name: 'web', health: 'healthy', desired: 2, ready: 2 })]);

    const detail = (await api(viewer, 'GET', `/api/kube/clusters/${direct.id}/objects/deployments/smt-it/web`)).json() as KubeObjectDetail;
    expect(detail.health).toBe('healthy');
    expect(detail.related.filter((r) => r.kind === 'Pod')).toHaveLength(2);
    expect(detail.yaml).toBeUndefined(); // viewers get no YAML
  });

  it('never sends a Secret’s values, nor a value an env var takes from it', async () => {
    const secret = await api(admin, 'GET', `/api/kube/clusters/${direct.id}/objects/secrets/smt-it/web-secret`);
    expect(secret.statusCode).toBe(200);
    expect(secret.body).not.toContain('hunter2');
    expect(secret.body).not.toContain(Buffer.from('hunter2-smt-it').toString('base64'));
    expect((secret.json() as KubeObjectDetail).facts).toEqual(expect.arrayContaining([{ label: 'Keys', value: 'password' }]));

    const overview = (await api(admin, 'GET', `/api/kube/clusters/${direct.id}/overview`)).json() as KubeOverview;
    const webPod = overview.nodes[0]!.pods.find((p) => p.owner?.kind === 'ReplicaSet' && p.namespace === 'smt-it')!;
    const pod = await api(admin, 'GET', `/api/kube/clusters/${direct.id}/objects/pods/smt-it/${webPod.name}`);
    expect(pod.body).not.toContain('hunter2');
    expect((pod.json() as KubeObjectDetail).yaml).toContain('secretKeyRef');
  });

  it('follows the map’s change feed', async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/api/kube/clusters/${direct.id}/stream?view=overview`, { headers: viewer.headers, signal: abort.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"type":"ready"');
    abort.abort();
  });

  it('diagnoses the route: DNS, TCP, TLS, then the Kubernetes API', async () => {
    const result = (await api(admin, 'POST', `/api/diagnostics/clusters/${direct.id}`, { auth: true })).json() as DiagnosticsResult;
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.id)).toEqual(expect.arrayContaining(['tcp', 'tls', 'kube_api']));
  }, 30_000);

  it.skipIf(!sshHost || !innerUrl || !tokenFile || !caFile)(
    'reaches the cluster through a managed server with a read-only service account token',
    async () => {
      const server = await api(admin, 'POST', '/api/servers', {
        name: 'kube-bastion',
        host: sshHost,
        port: sshPort,
        username: sshUser,
        authType: 'password',
        password: sshPassword,
      });
      expect(server.statusCode).toBe(201);

      const res = await api(admin, 'POST', '/api/kube/clusters', {
        name: 'k3s-via-ssh',
        apiUrl: innerUrl,
        caData: readFileSync(caFile!, 'utf8'),
        token: readFileSync(tokenFile!, 'utf8').trim(),
        connectVia: 'server',
        viaServerId: server.json().id,
        defaultNamespace: 'smt-it',
      });
      expect(res.statusCode).toBe(201);
      const viaSsh = res.json() as KubeCluster;
      expect(viaSsh.credentialHint).toMatch(/^token ending …/);

      const result = (await api(admin, 'POST', `/api/kube/clusters/${viaSsh.id}/test`, {})).json() as KubeTestResult;
      expect(result.ok).toBe(true);
      // Read-only: it may list pods but not delete them
      const checks = Object.fromEntries(result.capabilities!.checks.map((c) => [c.id, c.allowed]));
      expect(Object.values(checks)).toContain(true);
      expect(Object.values(checks)).toContain(false);

      const overview = (await api(viewer, 'GET', `/api/kube/clusters/${viaSsh.id}/overview`)).json() as KubeOverview;
      expect(overview.nodes).toHaveLength(1);
      expect(overview.unscheduled.map((p) => p.name)).toEqual(['too-big']);
    },
    60_000,
  );
});
