import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { KubeActionPreview, KubeActionResult, KubeCluster } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, memberClusterAccess } from '../../db/schema.js';
import { resetKubeCache } from '../../kube/cache.js';
import { RESTARTED_AT_ANNOTATION } from '../../kube/actions.js';
import { deployment, fakeKubeconfig, node, pod, startFakeApi, type FakeApi } from '../../kube/fake-api.test-helper.js';
import { seedOrg, seedUser } from './test-utils.js';

/**
 * The guided actions (K3) end to end against the in-process fake API
 * server: the exact patch each one sends (spec §6), the role and org-toggle
 * matrix (§7), per-cluster access (404 for restricted members), the
 * namespace allowlist, the preview the panels open with, and the audit
 * entries with before/after (§8.7).
 */

type Who = { userId: string; headers: Record<string, string> };

describe('kube action routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let api: FakeApi;
  let orgId: string;
  let owner: Who;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let outsider: Who;
  let clusterId: string;

  // Many requests: each from its own address, so the global rate limit (per IP) stays out of the way
  let requestNo = 0;
  const remoteAddress = () => `10.77.${Math.floor(++requestNo / 250) % 250}.${(requestNo % 250) + 1}`;
  const get = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: who.headers, remoteAddress: remoteAddress() });
  const send = (who: Who, method: 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, remoteAddress: remoteAddress(), ...(payload && { payload }) });
  const act = (who: Who, action: string, payload: object) => send(who, 'POST', `/api/kube/clusters/${clusterId}/actions/${action}`, payload);
  const lastWrite = () => api.writes[api.writes.length - 1]!;
  const audited = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .all()
      .map((row) => ({ ...row, metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null }));
  const setSettings = (patch: Record<string, boolean>) => send(owner, 'PATCH', '/api/kube/settings', patch);

  const replicaSet = (revision: number, image: string, env: string[]) => ({
    kind: 'ReplicaSet',
    metadata: {
      name: `web-rs${revision}`,
      namespace: 'shop',
      annotations: { 'deployment.kubernetes.io/revision': String(revision), 'kubernetes.io/change-cause': `release ${revision}` },
      ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }],
      labels: { app: 'web', 'pod-template-hash': `h${revision}` },
    },
    spec: {
      replicas: revision === 2 ? 2 : 0,
      selector: { matchLabels: { app: 'web', 'pod-template-hash': `h${revision}` } },
      template: {
        metadata: { labels: { app: 'web', 'pod-template-hash': `h${revision}` } },
        spec: { containers: [{ name: 'app', image, env: env.map((name) => ({ name, value: `${name}-secret-ish-value` })) }] },
      },
    },
    status: { replicas: revision === 2 ? 2 : 0 },
  });

  function seedObjects() {
    const web = deployment('shop', 'web', { replicas: 2 });
    (web.metadata as Record<string, unknown>).annotations = { 'deployment.kubernetes.io/revision': '2' };
    (web.spec as Record<string, unknown>).template = {
      metadata: { labels: { app: 'web' } },
      spec: { containers: [{ name: 'app', image: 'shop/web:2.0', env: [{ name: 'MODE', value: 'MODE-secret-ish-value' }, { name: 'NEW', value: 'NEW-secret-ish-value' }] }] },
    };
    api.add('deployments', web);
    api.add('replicasets', replicaSet(1, 'shop/web:1.0', ['MODE']));
    api.add('replicasets', replicaSet(2, 'shop/web:2.0', ['MODE', 'NEW']));
    api.add('deployments', deployment('shop', 'api', { replicas: 3 }));
    api.add('horizontalpodautoscalers', {
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: 'api', namespace: 'shop' },
      spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api' }, minReplicas: 2, maxReplicas: 10 },
    });
    api.add('deployments', deployment('kube-system', 'coredns', { replicas: 2 }));
    api.add('statefulsets', { kind: 'StatefulSet', metadata: { name: 'db', namespace: 'shop' }, spec: { replicas: 1, template: {} }, status: {} });
    api.add('daemonsets', {
      kind: 'DaemonSet',
      metadata: { name: 'agent', namespace: 'shop' },
      spec: { template: { metadata: {}, spec: { containers: [{ name: 'a', image: 'agent:1' }] } } },
      status: { desiredNumberScheduled: 2, numberReady: 2, updatedNumberScheduled: 2, numberAvailable: 2 },
    });
    api.add('pods', pod('shop', 'web-1', { node: 'worker-1', labels: { app: 'web' }, owner: { kind: 'ReplicaSet', name: 'web-rs2' } }));
    api.add('pods', pod('shop', 'debug', { node: 'worker-1' }));
    api.add('pods', pod('shop', 'agent-x', { node: 'worker-1', owner: { kind: 'DaemonSet', name: 'agent' } }));
    api.add('pods', pod('kube-system', 'coredns-1', { node: 'worker-1' }));
    api.add('nodes', node('worker-1'));
    api.add('cronjobs', {
      kind: 'CronJob',
      metadata: { name: 'nightly', namespace: 'shop' },
      spec: {
        schedule: '0 3 * * *',
        suspend: false,
        jobTemplate: {
          metadata: { labels: { job: 'nightly' } },
          spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'r', image: 'report:1' }] } } },
        },
      },
      status: { lastScheduleTime: '2026-10-02T03:00:00Z' },
    });
  }

  beforeAll(async () => {
    await runMigrations();
    api = await startFakeApi();
    seedObjects();

    orgId = seedOrg('org-kube-actions');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');
    outsider = seedUser(seedOrg('org-kube-actions-other'), 'admin');

    app = await buildApp();
    const res = await send(admin, 'POST', '/api/kube/clusters', { name: 'prod', kubeconfig: fakeKubeconfig(api) });
    expect(res.statusCode).toBe(201);
    clusterId = (res.json() as KubeCluster).id;
    expect((await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [] })).statusCode).toBe(200);
  });

  afterAll(async () => {
    resetKubeCache();
    await app.close();
    await api.close();
  });

  beforeEach(async () => {
    await setSettings({ operatorsCanScale: true, operatorsCanDeletePods: true });
  });

  describe('scale', () => {
    it('patches the scale subresource with the new replica count and audits before/after', async () => {
      const res = await act(operator, 'scale', { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 4 });
      expect(res.statusCode).toBe(200);
      const result = res.json() as KubeActionResult;
      expect(result).toMatchObject({ action: 'scale', changed: true, before: { replicas: 2 }, after: { replicas: 4 } });
      expect(result.message).toBe('Scaled web from 2 to 4 replicas');
      expect(lastWrite()).toEqual({
        method: 'PATCH',
        path: '/apis/apps/v1/namespaces/shop/deployments/web/scale',
        contentType: 'application/merge-patch+json',
        body: { spec: { replicas: 4 } },
      });
      const [entry] = audited('kube.scale');
      expect(entry).toMatchObject({ resourceType: 'kube_cluster', resourceId: clusterId, resourceName: 'prod', actorId: operator.userId });
      expect(entry!.metadata).toEqual({ namespace: 'shop', kind: 'Deployment', name: 'web', before: { replicas: 2 }, after: { replicas: 4 } });
    });

    it('scales StatefulSets too, and sends nothing when the count is unchanged (still audited)', async () => {
      const writes = api.writes.length;
      const same = (await act(operator, 'scale', { kind: 'StatefulSet', namespace: 'shop', name: 'db', replicas: 1 })).json() as KubeActionResult;
      expect(same.changed).toBe(false);
      expect(api.writes.length).toBe(writes);
      expect(audited('kube.scale').at(-1)!.metadata).toEqual({
        namespace: 'shop',
        kind: 'StatefulSet',
        name: 'db',
        before: { replicas: 1 },
        after: { replicas: 1 },
        changed: false,
      });
      const res = await act(operator, 'scale', { kind: 'StatefulSet', namespace: 'shop', name: 'db', replicas: 0 });
      expect(res.json()).toMatchObject({ changed: true, before: { replicas: 1 }, after: { replicas: 0 } });
      expect(lastWrite().path).toBe('/apis/apps/v1/namespaces/shop/statefulsets/db/scale');
    });

    it('names the autoscaler that controls the workload', async () => {
      const res = await act(admin, 'scale', { kind: 'Deployment', namespace: 'shop', name: 'api', replicas: 5 });
      expect((res.json() as KubeActionResult).message).toContain('the autoscaler api may change it again');
      expect(audited('kube.scale').at(-1)!.metadata).toMatchObject({ after: { replicas: 5, autoscaler: 'api' } });
    });

    it('rejects bad input before reaching the cluster', async () => {
      const writes = api.writes.length;
      for (const body of [
        { kind: 'DaemonSet', namespace: 'shop', name: 'agent', replicas: 2 },
        { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: -1 },
        { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 1.5 },
        { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 100_000 },
        { kind: 'Deployment', namespace: 'Shop', name: 'web', replicas: 1 },
        { kind: 'Deployment', namespace: 'shop', name: '../secrets', replicas: 1 },
        { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 1, extra: true },
      ]) {
        expect((await act(admin, 'scale', body)).statusCode).toBe(400);
      }
      expect(api.writes.length).toBe(writes);
    });

    it('is a 404 for an object that does not exist', async () => {
      expect((await act(admin, 'scale', { kind: 'Deployment', namespace: 'shop', name: 'ghost', replicas: 1 })).statusCode).toBe(404);
    });
  });

  describe('restart', () => {
    it('sets the restartedAt annotation with a strategic merge patch, for Deployments, StatefulSets and DaemonSets', async () => {
      for (const [kind, resource, name] of [
        ['Deployment', 'deployments', 'web'],
        ['StatefulSet', 'statefulsets', 'db'],
        ['DaemonSet', 'daemonsets', 'agent'],
      ] as const) {
        const res = await act(operator, 'restart', { kind, namespace: 'shop', name });
        expect(res.statusCode).toBe(200);
        const write = lastWrite();
        expect(write).toMatchObject({ method: 'PATCH', path: `/apis/apps/v1/namespaces/shop/${resource}/${name}`, contentType: 'application/strategic-merge-patch+json' });
        const at = (write.body as { spec: { template: { metadata: { annotations: Record<string, string> } } } }).spec.template.metadata.annotations[RESTARTED_AT_ANNOTATION];
        expect(Object.keys(write.body as object)).toEqual(['spec']);
        expect(new Date(at!).toISOString()).toBe(at);
        expect((res.json() as KubeActionResult).after).toEqual({ restartedAt: at });
      }
      expect(audited('kube.restart').map((e) => e.metadata!.kind)).toEqual(['Deployment', 'StatefulSet', 'DaemonSet']);
    });

    it('tells Recreate and OnDelete workloads apart from one-by-one rollouts', async () => {
      const recreate = deployment('shop', 'batch', { replicas: 2 });
      (recreate.spec as Record<string, unknown>).strategy = { type: 'Recreate' };
      api.add('deployments', recreate);
      api.add('statefulsets', {
        kind: 'StatefulSet',
        metadata: { name: 'legacy', namespace: 'shop' },
        spec: { replicas: 2, updateStrategy: { type: 'OnDelete' }, template: {} },
        status: {},
      });
      const preview = (path: string) => get(admin, `/api/kube/clusters/${clusterId}/actions/preview/${path}`).then((r) => r.json() as KubeActionPreview);
      expect((await preview('deployments/shop/batch')).strategy).toBe('Recreate');
      expect((await preview('statefulsets/shop/legacy')).strategy).toBe('OnDelete');
      expect((await preview('deployments/shop/api')).strategy).toBe('RollingUpdate');
      expect((await preview('daemonsets/shop/agent')).strategy).toBe('RollingUpdate');

      const recreated = (await act(admin, 'restart', { kind: 'Deployment', namespace: 'shop', name: 'batch' })).json() as KubeActionResult;
      expect(recreated.message).toBe('Restarting batch: all its pods stop, then new ones start');
      const onDelete = (await act(admin, 'restart', { kind: 'StatefulSet', namespace: 'shop', name: 'legacy' })).json() as KubeActionResult;
      expect(onDelete.message).toContain('only when it is deleted');
      expect(onDelete.message).not.toContain('one by one');
    });

    it('refuses a paused Deployment', async () => {
      const paused = deployment('shop', 'paused', { replicas: 1 });
      (paused.spec as Record<string, unknown>).paused = true;
      api.add('deployments', paused);
      expect((await act(admin, 'restart', { kind: 'Deployment', namespace: 'shop', name: 'paused' })).statusCode).toBe(409);
    });
  });

  describe('rollback', () => {
    it('shows the revisions with images and env names only', async () => {
      const res = await get(admin, `/api/kube/clusters/${clusterId}/actions/preview/deployments/shop/web`);
      expect(res.statusCode).toBe(200);
      const preview = res.json() as KubeActionPreview;
      expect(preview.revisions!.map((r) => [r.revision, r.current, r.containers[0]!.image, r.containers[0]!.envNames])).toEqual([
        [2, true, 'shop/web:2.0', ['MODE', 'NEW']],
        [1, false, 'shop/web:1.0', ['MODE']],
      ]);
      expect(preview.revisions![1]!.changeCause).toBe('release 1');
      expect(res.body).not.toContain('secret-ish-value');
      expect(preview.actions).toEqual(['scale', 'restart', 'rollback']);
    });

    it('copies the revision’s ReplicaSet template minus pod-template-hash into the Deployment (JSON patch)', async () => {
      const res = await act(admin, 'rollback', { namespace: 'shop', name: 'web', revision: 1 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        changed: true,
        before: { revision: 2, images: ['app=shop/web:2.0'] },
        after: { revision: 1, images: ['app=shop/web:1.0'] },
      });
      const write = lastWrite();
      expect(write).toMatchObject({ method: 'PATCH', path: '/apis/apps/v1/namespaces/shop/deployments/web', contentType: 'application/json-patch+json' });
      const ops = write.body as { op: string; path: string; value: unknown }[];
      expect(ops.map((o) => [o.op, o.path])).toEqual([
        ['test', '/metadata/resourceVersion'],
        ['replace', '/spec/template'],
        ['add', '/metadata/annotations'],
      ]);
      expect(ops[1]!.value).toEqual({
        metadata: { labels: { app: 'web' } },
        spec: { containers: [{ name: 'app', image: 'shop/web:1.0', env: [{ name: 'MODE', value: 'MODE-secret-ish-value' }] }] },
      });
      expect(ops[2]!.value).toEqual({ 'deployment.kubernetes.io/revision': '2', 'kubernetes.io/change-cause': 'release 1' });
      // The fake applied it: the Deployment now runs the old image
      const detail = await get(admin, `/api/kube/clusters/${clusterId}/actions/preview/deployments/shop/web`);
      expect((detail.json() as KubeActionPreview).revisions!.find((r) => r.current)?.revision).toBe(1);
      // Env values never reach the audit log
      const [entry] = audited('kube.rollback');
      expect(entry!.metadata).toMatchObject({ kind: 'Deployment', name: 'web', before: { revision: 2 }, after: { revision: 1 } });
      expect(JSON.stringify(entry)).not.toContain('secret-ish-value');
    });

    it('does nothing for the revision already running, and 404s for one that does not exist', async () => {
      const writes = api.writes.length;
      expect((await act(admin, 'rollback', { namespace: 'shop', name: 'web', revision: 1 })).json()).toMatchObject({ changed: false });
      expect(api.writes.length).toBe(writes);
      expect((await act(admin, 'rollback', { namespace: 'shop', name: 'web', revision: 9 })).statusCode).toBe(404);
    });
  });

  describe('delete pod', () => {
    it('deletes the pod and records who owned it', async () => {
      const res = await act(operator, 'delete-pod', { namespace: 'shop', name: 'web-1' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as KubeActionResult).message).toContain('its ReplicaSet starts a new pod');
      expect(lastWrite()).toMatchObject({ method: 'DELETE', path: '/api/v1/namespaces/shop/pods/web-1' });
      expect(audited('kube.delete_pod')[0]!.metadata).toMatchObject({
        kind: 'Pod',
        name: 'web-1',
        before: { phase: 'Running', node: 'worker-1', owner: { kind: 'ReplicaSet', name: 'web-rs2' } },
        after: { deleted: true },
      });
    });

    it('warns that a bare pod is not recreated', async () => {
      const preview = (await get(operator, `/api/kube/clusters/${clusterId}/actions/preview/pods/shop/debug`)).json() as KubeActionPreview;
      expect(preview.pod).toEqual({ owner: null, recreated: false, nodeName: 'worker-1', phase: 'Running' });
      expect(preview.actions).toEqual(['delete-pod']);
      const res = await act(operator, 'delete-pod', { namespace: 'shop', name: 'debug' });
      expect((res.json() as KubeActionResult).message).toContain('nothing recreates it');
    });

    it('does not promise a replacement for the pod of a Job that already finished', async () => {
      api.add('pods', pod('shop', 'report-done', { node: 'worker-2', phase: 'Succeeded', owner: { kind: 'Job', name: 'report' } }));
      api.add('pods', pod('shop', 'report-running', { node: 'worker-2', owner: { kind: 'Job', name: 'report2' } }));
      const done = (await get(operator, `/api/kube/clusters/${clusterId}/actions/preview/pods/shop/report-done`)).json() as KubeActionPreview;
      expect(done.pod).toMatchObject({ owner: { kind: 'Job', name: 'report' }, recreated: false });
      const running = (await get(operator, `/api/kube/clusters/${clusterId}/actions/preview/pods/shop/report-running`)).json() as KubeActionPreview;
      expect(running.pod).toMatchObject({ recreated: true });
      const res = await act(operator, 'delete-pod', { namespace: 'shop', name: 'report-done' });
      expect((res.json() as KubeActionResult).message).toBe('Deleted report-done; its Job had finished, so nothing recreates it');
    });
  });

  describe('cordon / uncordon', () => {
    it('sets spec.unschedulable and flips the offered action', async () => {
      const before = (await get(admin, `/api/kube/clusters/${clusterId}/actions/preview/nodes/_/worker-1`)).json() as KubeActionPreview;
      expect(before.actions).toEqual(['cordon']);
      expect(before.node).toMatchObject({ unschedulable: false, daemonSetPods: 1 });

      const res = await act(admin, 'cordon', { name: 'worker-1' });
      expect(res.json()).toMatchObject({ changed: true, before: { unschedulable: false }, after: { unschedulable: true } });
      expect(lastWrite()).toEqual({
        method: 'PATCH',
        path: '/api/v1/nodes/worker-1',
        contentType: 'application/merge-patch+json',
        body: { spec: { unschedulable: true } },
      });
      const after = (await get(admin, `/api/kube/clusters/${clusterId}/actions/preview/nodes/_/worker-1`)).json() as KubeActionPreview;
      expect(after.actions).toEqual(['uncordon']);

      // Already cordoned: nothing sent, but the attempt is still audited (spec §6: every action)
      const writes = api.writes.length;
      expect((await act(admin, 'cordon', { name: 'worker-1' })).json()).toMatchObject({ changed: false });
      expect(api.writes.length).toBe(writes);

      expect((await act(admin, 'uncordon', { name: 'worker-1' })).json()).toMatchObject({ changed: true, after: { unschedulable: false } });
      expect(lastWrite().body).toEqual({ spec: { unschedulable: false } });
      expect(audited('kube.cordon').map((e) => e.metadata!.changed)).toEqual([undefined, false]);
      expect(audited('kube.uncordon')).toHaveLength(1);
    });
  });

  describe('CronJobs', () => {
    it('suspends and resumes with spec.suspend', async () => {
      const res = await act(operator, 'suspend-cronjob', { namespace: 'shop', name: 'nightly', suspend: true });
      expect(res.json()).toMatchObject({ changed: true, before: { suspend: false }, after: { suspend: true } });
      expect(lastWrite()).toMatchObject({ path: '/apis/batch/v1/namespaces/shop/cronjobs/nightly', body: { spec: { suspend: true } } });
      await act(operator, 'suspend-cronjob', { namespace: 'shop', name: 'nightly', suspend: false });
      expect(lastWrite().body).toEqual({ spec: { suspend: false } });
      expect(audited('kube.cronjob_suspend')).toHaveLength(1);
      expect(audited('kube.cronjob_resume')).toHaveLength(1);
    });

    it('triggers a run: a Job from the template, owned by the CronJob, under a generated name', async () => {
      const res = await act(operator, 'trigger-cronjob', { namespace: 'shop', name: 'nightly' });
      expect(res.statusCode).toBe(201);
      const result = res.json() as KubeActionResult;
      expect(result.created).toMatchObject({ resource: 'jobs', kind: 'Job', namespace: 'shop' });
      expect(result.created!.name).toMatch(/^nightly-manual-[a-z0-9]{5}$/);
      const write = lastWrite();
      expect(write).toMatchObject({ method: 'POST', path: '/apis/batch/v1/namespaces/shop/jobs' });
      const job = write.body as { metadata: Record<string, unknown>; spec: unknown };
      expect(job.metadata).toMatchObject({
        name: result.created!.name,
        namespace: 'shop',
        labels: { job: 'nightly' },
        annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' },
        ownerReferences: [expect.objectContaining({ apiVersion: 'batch/v1', kind: 'CronJob', name: 'nightly', controller: true, uid: expect.any(String) })],
      });
      expect(job.spec).toEqual({ template: { spec: { restartPolicy: 'Never', containers: [{ name: 'r', image: 'report:1' }] } } });
      expect(audited('kube.cronjob_trigger')[0]!.metadata).toMatchObject({ kind: 'CronJob', name: 'nightly', created: { kind: 'Job', name: result.created!.name } });
    });
  });

  describe('preview', () => {
    it('refuses resources without guided actions before reading them (no Secret is fetched)', async () => {
      const before = api.requests.length;
      const res = await get(admin, `/api/kube/clusters/${clusterId}/actions/preview/secrets/shop/web-secret`);
      expect(res.statusCode).toBe(400);
      expect(api.requests.slice(before).some((r) => r.includes('/secrets'))).toBe(false);
    });
  });

  describe('who may do what', () => {
    const ACTIONS: [string, object][] = [
      ['scale', { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 2 }],
      ['restart', { kind: 'Deployment', namespace: 'shop', name: 'web' }],
      ['suspend-cronjob', { namespace: 'shop', name: 'nightly', suspend: false }],
      ['trigger-cronjob', { namespace: 'shop', name: 'nightly' }],
      ['delete-pod', { namespace: 'shop', name: 'gone' }],
      ['rollback', { namespace: 'shop', name: 'web', revision: 2 }],
      ['cordon', { name: 'worker-1' }],
      ['uncordon', { name: 'worker-1' }],
    ];
    const allowed = (status: number) => status !== 403;

    it('viewers may do none of it', async () => {
      for (const [action, body] of ACTIONS) expect((await act(viewer, action, body)).statusCode, action).toBe(403);
    });

    it('operators scale, restart, run CronJobs and delete pods; rollback and cordon are admin-only', async () => {
      const result = Object.fromEntries(await Promise.all(ACTIONS.map(async ([a, b]) => [a, allowed((await act(operator, a, b)).statusCode)])));
      expect(result).toEqual({
        scale: true,
        restart: true,
        'suspend-cronjob': true,
        'trigger-cronjob': true,
        'delete-pod': true,
        rollback: false,
        cordon: false,
        uncordon: false,
      });
      for (const who of [admin, owner]) {
        for (const [action, body] of ACTIONS) expect(allowed((await act(who, action, body)).statusCode), action).toBe(true);
      }
    });

    it('follows the org toggles: operatorsCanScale and operatorsCanDeletePods (admins unaffected)', async () => {
      await setSettings({ operatorsCanScale: false });
      for (const action of ['scale', 'restart', 'suspend-cronjob', 'trigger-cronjob']) {
        const body = ACTIONS.find(([a]) => a === action)![1];
        expect((await act(operator, action, body)).statusCode, action).toBe(403);
        expect(allowed((await act(admin, action, body)).statusCode), action).toBe(true);
      }
      expect(allowed((await act(operator, 'delete-pod', { namespace: 'shop', name: 'gone' })).statusCode)).toBe(true);
      const preview = (await get(operator, `/api/kube/clusters/${clusterId}/actions/preview/cronjobs/shop/nightly`)).json() as KubeActionPreview;
      expect(preview.actions).toEqual([]);

      await setSettings({ operatorsCanScale: true, operatorsCanDeletePods: false });
      const denied = await act(operator, 'delete-pod', { namespace: 'shop', name: 'gone' });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toMatch(/Deleting pods/);
      expect(allowed((await act(admin, 'delete-pod', { namespace: 'shop', name: 'gone' })).statusCode)).toBe(true);
      expect(allowed((await act(operator, 'scale', ACTIONS[0]![1])).statusCode)).toBe(true);
    });

    it('previews list only the actions the caller may take', async () => {
      const path = `/api/kube/clusters/${clusterId}/actions/preview/deployments/shop/web`;
      expect(((await get(viewer, path)).json() as KubeActionPreview).actions).toEqual([]);
      expect(((await get(operator, path)).json() as KubeActionPreview).actions).toEqual(['scale', 'restart']);
      expect(((await get(admin, path)).json() as KubeActionPreview).actions).toEqual(['scale', 'restart', 'rollback']);
      expect(((await get(operator, `/api/kube/clusters/${clusterId}/actions/preview/nodes/_/worker-1`)).json() as KubeActionPreview).actions).toEqual([]);
      expect((await get(viewer, `/api/kube/clusters/${clusterId}/actions/preview/deployments/shop/web`)).statusCode).toBe(200);
    });
  });

  describe('cluster access and namespaces', () => {
    it('is a 404 for a restricted member without a grant and for another org, before anything is sent', async () => {
      const writes = api.writes.length;
      expect((await act(restricted, 'scale', { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 3 })).statusCode).toBe(404);
      expect((await get(restricted, `/api/kube/clusters/${clusterId}/actions/preview/deployments/shop/web`)).statusCode).toBe(404);
      expect((await act(outsider, 'cordon', { name: 'worker-1' })).statusCode).toBe(404);
      expect(api.writes.length).toBe(writes);

      await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [], clusterIds: [clusterId] });
      expect((await act(restricted, 'scale', { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 3 })).statusCode).toBe(200);
      await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [], clusterIds: [] });
      expect((await act(restricted, 'scale', { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 2 })).statusCode).toBe(404);
    });

    it('honours a time-limited grant until it expires', async () => {
      await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, {
        serverAccess: 'restricted',
        serverIds: [],
        clusterIds: [clusterId],
        clusterExpiresInMinutes: { [clusterId]: 60 },
      });
      try {
        expect((await act(restricted, 'scale', { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 2 })).statusCode).toBe(200);
        getDb()
          .update(memberClusterAccess)
          .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
          .where(eq(memberClusterAccess.userId, restricted.userId))
          .run();
        const writes = api.writes.length;
        expect((await act(restricted, 'scale', { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 3 })).statusCode).toBe(404);
        expect(api.writes.length).toBe(writes);
      } finally {
        await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [], clusterIds: [] });
      }
    });

    it('keeps to the cluster’s namespace allowlist', async () => {
      expect((await send(admin, 'PATCH', `/api/kube/clusters/${clusterId}`, { namespacesAllowlist: ['shop'], defaultNamespace: 'shop' })).statusCode).toBe(200);
      try {
        const writes = api.writes.length;
        expect((await act(admin, 'scale', { kind: 'Deployment', namespace: 'kube-system', name: 'coredns', replicas: 0 })).statusCode).toBe(404);
        expect((await act(admin, 'restart', { kind: 'Deployment', namespace: 'kube-system', name: 'coredns' })).statusCode).toBe(404);
        expect((await act(admin, 'delete-pod', { namespace: 'kube-system', name: 'coredns-1' })).statusCode).toBe(404);
        expect((await get(admin, `/api/kube/clusters/${clusterId}/actions/preview/deployments/kube-system/coredns`)).statusCode).toBe(404);
        expect(api.writes.length).toBe(writes);
        expect((await act(admin, 'scale', { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 2 })).statusCode).toBe(200);
        // A node's pod count leaves out namespaces outside the allowlist
        const node = (await get(admin, `/api/kube/clusters/${clusterId}/actions/preview/nodes/_/worker-1`)).json() as KubeActionPreview;
        expect(node.node!.pods).toBe(1);
      } finally {
        await send(admin, 'PATCH', `/api/kube/clusters/${clusterId}`, { namespacesAllowlist: null, defaultNamespace: 'default' });
      }
    });

    it('passes the cluster’s own refusal through as a 403 with its reason', async () => {
      api.forbid('deployments');
      try {
        const res = await act(admin, 'restart', { kind: 'Deployment', namespace: 'shop', name: 'web' });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toMatch(/not allowed/);
      } finally {
        api.forbid('deployments', false);
      }
    });
  });
});
