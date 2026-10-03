import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { KubeActionPreview, KubeActionResult, KubeCluster } from '@smt/shared';
import type { KubeClient, KubeObject } from './client.js';

/**
 * The guided actions (K3) against a real, throwaway k3s cluster — never a
 * cluster from ~/.kube. Uses the same environment as kube.integration.test.ts
 * (scripts/kube-it.sh, or any throwaway k3s/kind whose admin kubeconfig sits
 * in a temp file):
 *
 *   SMT_TEST_KUBE_KUBECONFIG=/tmp/…/kubeconfig pnpm vitest run src/kube/actions.integration.test.ts
 *
 * It works in its own namespace (created and deleted here) with a Deployment
 * and a CronJob, and runs every action through the real routes: scale,
 * restart, rollback, delete pod, cordon / uncordon, CronJob suspend / resume
 * and run now — then checks what the cluster made of each.
 */

const kubeconfigPath = process.env.SMT_TEST_KUBE_KUBECONFIG;
const NS = 'smt-it-actions';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { clientFor } = await import('./service.js');
const { connectionFromKubeconfig } = await import('./kubeconfig.js');

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 120_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - started > ms) return value;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

const container = (env: Record<string, string>) => ({
  name: 'app',
  image: 'busybox:1.36',
  command: ['sleep', '3600'],
  resources: { requests: { cpu: '5m', memory: '8Mi' } },
  env: Object.entries(env).map(([name, value]) => ({ name, value })),
});

describe.skipIf(!kubeconfigPath)('guided actions against a live k3s cluster', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let cluster: KubeCluster;
  let client: KubeClient;
  let nodeName: string;

  const api = (who: { headers: Record<string, string> }, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, ...(payload && { payload }) });
  const act = async (who: { headers: Record<string, string> }, action: string, body: object) => {
    const res = await api(who, 'POST', `/api/kube/clusters/${cluster.id}/actions/${action}`, body);
    expect(res.statusCode, `${action}: ${res.body}`).toBeLessThan(300);
    return res.json() as KubeActionResult;
  };
  const deployment = () => client.get('deployments', NS, 'api');
  const env = (d: KubeObject) =>
    ((d.spec as { template: { spec: { containers: { env?: { name: string }[] }[] } } }).template.spec.containers[0]!.env ?? []).map((e) => e.name);

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('kube-it-actions');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    app = await buildApp();

    const kubeconfig = readFileSync(kubeconfigPath!, 'utf8');
    const res = await api(admin, 'POST', '/api/kube/clusters', { kubeconfig, name: 'k3s-actions' });
    expect(res.statusCode).toBe(201);
    cluster = res.json();

    const conn = connectionFromKubeconfig(kubeconfig);
    client = clientFor({ orgId, ...conn, connectVia: 'direct', viaServerId: null, viaAgentId: null });
    nodeName = (await client.list('nodes')).items[0]!.metadata.name;

    await client.delete('namespaces', null, NS).catch(() => undefined);
    await eventually(
      () => client.get('namespaces', null, NS).then(() => true, () => false),
      (exists) => !exists,
    );
    await client.create('namespaces', null, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } });
    await client.create('deployments', NS, {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'api', namespace: NS },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'api' } },
        template: { metadata: { labels: { app: 'api' } }, spec: { containers: [container({ MODE: 'one' })] } },
      },
    });
    await client.create('cronjobs', NS, {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'tick', namespace: NS },
      spec: {
        schedule: '0 0 1 1 *',
        jobTemplate: {
          metadata: { labels: { job: 'tick' } },
          spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'tick', image: 'busybox:1.36', command: ['true'] }] } } },
        },
      },
    });
  }, 180_000);

  afterAll(async () => {
    await client?.patch('nodes', null, nodeName, { spec: { unschedulable: null } }).catch(() => undefined);
    await client?.delete('namespaces', null, NS).catch(() => undefined);
    client?.close();
    await app?.close();
  });

  it('scales through the scale subresource', async () => {
    const result = await act(operator, 'scale', { kind: 'Deployment', namespace: NS, name: 'api', replicas: 2 });
    expect(result).toMatchObject({ changed: true, before: { replicas: 1 }, after: { replicas: 2 } });
    const d = await eventually(deployment, (o) => (o.status as { readyReplicas?: number }).readyReplicas === 2);
    expect((d.status as { readyReplicas?: number }).readyReplicas).toBe(2);
  }, 150_000);

  it('restarts the rollout with the restartedAt annotation', async () => {
    await act(operator, 'restart', { kind: 'Deployment', namespace: NS, name: 'api' });
    const d = await deployment();
    const annotations = (d.spec as { template: { metadata: { annotations?: Record<string, string> } } }).template.metadata.annotations;
    expect(annotations?.['kubectl.kubernetes.io/restartedAt']).toMatch(/^\d{4}-/);
  });

  it('rolls back to an earlier revision, shown with env names only', async () => {
    await client.patch('deployments', NS, 'api', { spec: { template: { spec: { containers: [container({ MODE: 'two', NEW: 'x' })] } } } });
    const preview = await eventually(
      async () => (await api(admin, 'GET', `/api/kube/clusters/${cluster.id}/actions/preview/deployments/${NS}/api`)).json() as KubeActionPreview,
      (p) => (p.revisions?.length ?? 0) >= 3 && !!p.revisions?.[0]?.current,
    );
    expect(preview.actions).toContain('rollback');
    expect(preview.revisions!.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(preview.revisions![0]!.containers[0]!.envNames).toEqual(['MODE', 'NEW']);
    expect(JSON.stringify(preview)).not.toContain('"two"');

    const result = await act(admin, 'rollback', { namespace: NS, name: 'api', revision: 1 });
    expect(result).toMatchObject({ changed: true, after: { revision: 1 } });
    const d = await deployment();
    expect(env(d)).toEqual(['MODE']);
    const template = (d.spec as { template: { metadata: { labels: Record<string, string>; annotations?: Record<string, string> } } }).template;
    expect(template.metadata.labels['pod-template-hash']).toBeUndefined();
    expect(template.metadata.annotations?.['kubectl.kubernetes.io/restartedAt']).toBeUndefined();
    // The controller takes revision 1's ReplicaSet back as the newest revision
    const after = await eventually(
      async () => (await api(admin, 'GET', `/api/kube/clusters/${cluster.id}/actions/preview/deployments/${NS}/api`)).json() as KubeActionPreview,
      (p) => p.revisions?.[0]?.current === true && p.revisions[0].containers[0]!.envNames.length === 1,
    );
    expect(after.revisions![0]).toMatchObject({ revision: 4, current: true });
  }, 150_000);

  it('deletes a pod, and its ReplicaSet starts another', async () => {
    const pods = await eventually(
      () => client.list('pods', { namespace: NS, labelSelector: 'app=api' }),
      (l) => l.items.filter((p) => !p.metadata.deletionTimestamp).length === 2,
    );
    const victim = pods.items.find((p) => !p.metadata.deletionTimestamp)!.metadata.name;
    const result = await act(operator, 'delete-pod', { namespace: NS, name: victim });
    expect(result.message).toMatch(/ReplicaSet starts a new pod/);
    const later = await eventually(
      () => client.list('pods', { namespace: NS, labelSelector: 'app=api' }),
      (l) => l.items.filter((p) => !p.metadata.deletionTimestamp && p.metadata.name !== victim).length >= 2,
    );
    expect(later.items.filter((p) => !p.metadata.deletionTimestamp && p.metadata.name !== victim).length).toBeGreaterThanOrEqual(2);
  }, 150_000);

  it('cordons and uncordons the node', async () => {
    expect((await api(operator, 'POST', `/api/kube/clusters/${cluster.id}/actions/cordon`, { name: nodeName })).statusCode).toBe(403);
    await act(admin, 'cordon', { name: nodeName });
    expect((await client.get('nodes', null, nodeName)).spec).toMatchObject({ unschedulable: true });
    await act(admin, 'uncordon', { name: nodeName });
    expect(((await client.get('nodes', null, nodeName)).spec as { unschedulable?: boolean }).unschedulable ?? false).toBe(false);
  });

  it('suspends, resumes and runs a CronJob now', async () => {
    await act(operator, 'suspend-cronjob', { namespace: NS, name: 'tick', suspend: true });
    expect((await client.get('cronjobs', NS, 'tick')).spec).toMatchObject({ suspend: true });
    await act(operator, 'suspend-cronjob', { namespace: NS, name: 'tick', suspend: false });
    expect((await client.get('cronjobs', NS, 'tick')).spec).toMatchObject({ suspend: false });

    const result = await act(operator, 'trigger-cronjob', { namespace: NS, name: 'tick' });
    expect(result.created!.name).toMatch(/^tick-manual-[0-9a-f]{5}$/);
    const job = await client.get('jobs', NS, result.created!.name);
    expect(job.metadata.ownerReferences).toEqual([expect.objectContaining({ kind: 'CronJob', name: 'tick', controller: true })]);
    expect(job.metadata.annotations?.['cronjob.kubernetes.io/instantiate']).toBe('manual');
  });
});
