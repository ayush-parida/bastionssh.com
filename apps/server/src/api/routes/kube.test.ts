import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type {
  KubeCluster,
  KubeClusterStatusView,
  KubeObjectDetail,
  KubeOverview,
  KubeTestResult,
  KubeWorkloadList,
  KubeconfigSummary,
  DiagnosticsResult,
} from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, kubeClusters, memberClusterAccess, memberships, resourceGrants } from '../../db/schema.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import { sweepExpiredAccess } from '../../auth/access-grants.js';
import { resetKubeCache } from '../../kube/cache.js';
import { activeKubeStreamCount } from '../../kube/sse.js';
import { deployment, fakeKubeconfig, node, pod, startFakeApi, type FakeApi } from '../../kube/fake-api.test-helper.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

/**
 * Kubernetes routes end to end against the in-process fake API server: the
 * role matrix and org settings, per-cluster access (404s, time-limited
 * grants, the expiry sweep), cluster CRUD from a kubeconfig, the connection
 * test, the map / workloads / detail views with redaction and the namespace
 * allowlist, the change feed, and revocation closing it.
 */

type Who = { userId: string; headers: Record<string, string> };

const until = async (check: () => boolean, ms = 4000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('kube routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let api: FakeApi;
  let base: string;
  let orgId: string;
  let owner: Who;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let outsider: Who;
  let clusterId: string;

  const get = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: who.headers });
  const send = (who: Who, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, ...(payload && { payload }) });
  const c = (rest = '') => `/api/kube/clusters/${clusterId}${rest}`;

  async function openStream(who: Who, path: string) {
    const abort = new AbortController();
    const res = await fetch(`${base}${path}`, { headers: who.headers, signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async (): Promise<Record<string, unknown> | null> => {
      for (;;) {
        const at = buffer.indexOf('\n\n');
        if (at !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith('data: ')) return JSON.parse(block.slice(6)) as Record<string, unknown>;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    return { res, next, close: () => abort.abort() };
  }

  const audited = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .all();

  beforeAll(async () => {
    await runMigrations();
    api = await startFakeApi();
    api.add('nodes', node('cp-1', { roles: ['control-plane'] }));
    api.add('nodes', node('worker-1'));
    api.add('namespaces', { kind: 'Namespace', metadata: { name: 'shop' }, status: { phase: 'Active' } });
    api.add('namespaces', { kind: 'Namespace', metadata: { name: 'kube-system' }, status: { phase: 'Active' } });
    api.add('deployments', deployment('shop', 'web', { replicas: 2, ready: 1 }));
    api.add('replicasets', {
      kind: 'ReplicaSet',
      metadata: { name: 'web-7d4', namespace: 'shop', ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }] },
      spec: { replicas: 2, selector: { matchLabels: { app: 'web' } } },
      status: { readyReplicas: 1 },
    });
    api.add(
      'pods',
      pod('shop', 'web-1', {
        node: 'worker-1',
        labels: { app: 'web' },
        owner: { kind: 'ReplicaSet', name: 'web-7d4' },
        secretEnv: { secret: 'db', key: 'password' },
      }),
    );
    api.add('pods', pod('shop', 'web-2', { node: 'worker-1', labels: { app: 'web' }, waiting: 'CrashLoopBackOff', restarts: 12 }));
    api.add('pods', pod('shop', 'huge', { unschedulable: '0/2 nodes are available: 2 Insufficient memory.' }));
    api.add('pods', pod('kube-system', 'coredns-1', { node: 'cp-1' }));
    api.add('services', { kind: 'Service', metadata: { name: 'web', namespace: 'shop' }, spec: { type: 'ClusterIP', selector: { app: 'web' }, ports: [{ port: 80, targetPort: 8080 }] } });
    api.add('secrets', { kind: 'Secret', type: 'Opaque', metadata: { name: 'db', namespace: 'shop' }, data: { password: 'aHVudGVyMg==' } });

    orgId = seedOrg('org-kube');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');
    const otherOrg = seedOrg('org-kube-other');
    outsider = seedUser(otherOrg, 'admin');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const res = await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [] });
    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => {
    resetKubeCache();
    await app.close();
    await api.close();
  });

  describe('settings', () => {
    it('lets everyone read them and owners and admins change them, audited', async () => {
      expect((await get(viewer, '/api/kube/settings')).json()).toEqual({
        operatorsCanExec: true,
        operatorsCanDeletePods: true,
        operatorsCanScale: true,
        showConfigMapValues: true,
        clusterAlerts: false,
      });
      expect((await send(operator, 'PATCH', '/api/kube/settings', { operatorsCanExec: false })).statusCode).toBe(403);
      const res = await send(owner, 'PATCH', '/api/kube/settings', { operatorsCanExec: false });
      expect(res.json()).toMatchObject({ operatorsCanExec: false });
      expect(audited('org.kube_settings')).toHaveLength(1);
      expect((await send(owner, 'PATCH', '/api/kube/settings', { bogus: true })).statusCode).toBe(400);
      await send(owner, 'PATCH', '/api/kube/settings', { operatorsCanExec: true });
    });
  });

  describe('clusters', () => {
    it('reads a kubeconfig’s contexts without keeping anything', async () => {
      const res = await send(admin, 'POST', '/api/kube/kubeconfig/contexts', { kubeconfig: fakeKubeconfig(api) });
      expect(res.statusCode).toBe(200);
      expect((res.json() as KubeconfigSummary).contexts).toEqual([
        expect.objectContaining({ name: 'fake', authType: 'token', hasCa: true, problem: null }),
      ]);
      expect((await send(operator, 'POST', '/api/kube/kubeconfig/contexts', { kubeconfig: fakeKubeconfig(api) })).statusCode).toBe(403);
    });

    it('lets only admins add a cluster, and never returns the credential', async () => {
      for (const who of [viewer, operator]) {
        expect((await send(who, 'POST', '/api/kube/clusters', { kubeconfig: fakeKubeconfig(api) })).statusCode).toBe(403);
      }
      const res = await send(admin, 'POST', '/api/kube/clusters', { name: 'prod', kubeconfig: fakeKubeconfig(api, { namespace: 'shop' }) });
      expect(res.statusCode).toBe(201);
      const cluster = res.json() as KubeCluster;
      clusterId = cluster.id;
      expect(cluster).toMatchObject({
        name: 'prod',
        apiUrl: api.url,
        connectVia: 'direct',
        authType: 'token',
        credentialHint: 'token ending …cdef',
        hasCa: true,
        defaultNamespace: 'shop',
        impersonate: false,
        lastStatus: 'unknown',
      });
      expect(res.body).not.toContain('fake-token');
      expect(getDb().select().from(kubeClusters).where(eq(kubeClusters.id, clusterId)).get()!.encryptedCredential).not.toContain('fake-token');
      expect(audited('kube_cluster.create')).toHaveLength(1);
    });

    it('refuses exec kubeconfigs, plain http and metadata addresses', async () => {
      const exec = fakeKubeconfig(api).replace(/ {4}token: .*/, '    exec:\n      command: aws');
      const refused = await send(admin, 'POST', '/api/kube/clusters', { kubeconfig: exec });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toMatch(/exec/);
      const http = await send(admin, 'POST', '/api/kube/clusters', { name: 'x', apiUrl: 'http://10.0.0.1:6443', token: 'abc' });
      expect(http.json().error).toMatch(/https/);
      const metadata = await send(admin, 'POST', '/api/kube/clusters', { name: 'x', apiUrl: 'https://169.254.169.254', token: 'abc' });
      expect(metadata.statusCode).toBe(400);
      const unknownServer = await send(admin, 'POST', '/api/kube/clusters', {
        name: 'x',
        apiUrl: 'https://10.0.0.5:6443',
        token: 'abc',
        connectVia: 'server',
        viaServerId: 'nope',
      });
      expect(unknownServer.json().error).toBe('Unknown server');
    });

    it('tests the connection step by step and records the cluster’s health', async () => {
      expect((await send(operator, 'POST', c('/test'))).statusCode).toBe(403);
      const res = await send(admin, 'POST', c('/test'));
      const result = res.json() as KubeTestResult;
      expect(result.steps.map((s) => [s.id, s.status])).toEqual([
        ['reach', 'ok'],
        ['tls', 'ok'],
        ['auth', 'ok'],
        ['version', 'ok'],
        ['rules', 'ok'],
      ]);
      expect(result.steps[1]!.detail).toMatch(/Verified against the cluster CA/);
      expect(result.serverVersion).toBe('v1.31.2+fake');
      expect(result.capabilities!.checks.find((x) => x.id === 'list-pods')!.allowed).toBe(true);
      expect(result.capabilities!.checks.find((x) => x.id === 'delete-pods')!.allowed).toBe(false);
      const status = (await get(viewer, c())).json() as KubeClusterStatusView;
      expect(status.cluster).toMatchObject({ lastStatus: 'ok', serverVersion: 'v1.31.2+fake' });
      expect(status.permissions).toMatchObject({ view: true, logs: false, yaml: false, configure: false });

      // An unsaved connection: nothing recorded
      const unsaved = await send(admin, 'POST', '/api/kube/clusters/test', { apiUrl: api.url, token: 'wrong-token' });
      const failed = unsaved.json() as KubeTestResult;
      expect(failed.ok).toBe(false);
      expect(failed.steps.find((s) => s.id === 'tls')!.status).toBe('fail');
    });
  });

  describe('views', () => {
    it('draws the cluster map: nodes with their pods, and pods waiting for a node', async () => {
      const res = await get(viewer, c('/overview'));
      expect(res.statusCode).toBe(200);
      const overview = res.json() as KubeOverview;
      expect(overview.nodes.map((n) => n.name)).toEqual(['cp-1', 'worker-1']);
      const worker = overview.nodes[1]!;
      expect(worker.pods.map((p) => [p.name, p.status, p.reason])).toEqual([
        ['web-2', 'failing', 'CrashLoopBackOff'],
        ['web-1', 'running', null],
      ]);
      expect(worker.requested.cpuMillis).toBe(200);
      expect(overview.unscheduled).toEqual([expect.objectContaining({ name: 'huge', reason: 'Unschedulable' })]);
      expect(overview.namespaces).toEqual(['kube-system', 'shop']);
      expect(overview.metricsAvailable).toBe(false);
    });

    it('lists workloads with their health', async () => {
      const res = await get(viewer, c('/workloads?namespace=shop'));
      const list = res.json() as KubeWorkloadList;
      expect(list.workloads).toEqual([
        expect.objectContaining({ kind: 'Deployment', name: 'web', health: 'degraded', summary: '1 of 2 ready', images: ['shop/web:1.0'] }),
      ]);
      expect((await get(viewer, c('/workloads?kind=Bogus'))).statusCode).toBe(400);
    });

    it('shows details redacted; the YAML (and its Secret audit) is its own endpoint', async () => {
      const asViewer = (await get(viewer, c('/objects/secrets/shop/db'))).json() as KubeObjectDetail;
      expect(asViewer.facts).toContainEqual({ label: 'Keys', value: 'password' });
      const res = await get(operator, c('/objects/secrets/shop/db'));
      expect(res.body).not.toContain('aHVudGVyMg==');
      // Opening a Secret's panel is not a YAML view: no YAML sent, nothing audited (kube-pods.ts has the YAML)
      expect(res.json()).not.toHaveProperty('yaml');
      expect(audited('kube.secret_view')).toHaveLength(0);

      const podDetail = (await get(viewer, c('/objects/pods/shop/web-1'))).json() as KubeObjectDetail;
      expect(podDetail.health).toBe('running');
      expect(podDetail.related.map((r) => `${r.relation} ${r.kind}/${r.name}`)).toEqual(
        expect.arrayContaining(['owned by ReplicaSet/web-7d4', 'owned by Deployment/web', 'runs on Node/worker-1', 'reads env from Secret/db']),
      );
      const svc = (await get(viewer, c('/objects/services/shop/web'))).json() as KubeObjectDetail;
      expect(svc.related.filter((r) => r.kind === 'Pod').map((r) => r.name).sort()).toEqual(['web-1', 'web-2']);
      const nodeDetail = (await get(viewer, c('/objects/nodes/_/worker-1'))).json() as KubeObjectDetail;
      expect(nodeDetail.related.filter((r) => r.kind === 'Pod')).toHaveLength(2);

      expect((await get(viewer, c('/objects/pods/shop/..%2Fsecrets'))).statusCode).toBe(400);
      expect((await get(viewer, c('/objects/clusterroles/_/admin'))).statusCode).toBe(400);
      expect((await get(viewer, c('/objects/pods/shop/missing'))).statusCode).toBe(404);
    });

    it('never sends the saved credential to a new address or CA', async () => {
      const moved = await send(admin, 'PATCH', c(), { apiUrl: 'https://10.0.0.99:6443' });
      expect(moved.statusCode).toBe(400);
      expect(moved.json().error).toMatch(/token or client certificate again/);
      const tested = await send(admin, 'POST', c('/test'), { apiUrl: 'https://10.0.0.99:6443' });
      expect(tested.statusCode).toBe(400);
      expect((await send(admin, 'PATCH', c(), { caData: '' })).statusCode).toBe(400);
      // Unchanged address: the saved credential is used as before
      expect((await send(admin, 'PATCH', c(), { apiUrl: api.url })).statusCode).toBe(200);
    });

    it('keeps everyone inside the namespace allowlist', async () => {
      const patched = await send(admin, 'PATCH', c(), { namespacesAllowlist: ['shop'], defaultNamespace: 'shop' });
      expect(patched.statusCode).toBe(200);
      try {
        const overview = (await get(viewer, c('/overview'))).json() as KubeOverview;
        expect(overview.namespaces).toEqual(['shop']);
        expect(overview.nodes.flatMap((n) => n.pods.map((p) => p.namespace))).not.toContain('kube-system');
        expect((await get(viewer, c('/objects/pods/kube-system/coredns-1'))).statusCode).toBe(404);
        // A volume bound to a claim outside the allowlist is outside it too
        api.add('persistentvolumes', { kind: 'PersistentVolume', metadata: { name: 'pv-sys' }, spec: { claimRef: { namespace: 'kube-system', name: 'etcd' } } });
        api.add('persistentvolumes', { kind: 'PersistentVolume', metadata: { name: 'pv-shop' }, spec: { claimRef: { namespace: 'shop', name: 'data' } } });
        expect((await get(viewer, c('/objects/persistentvolumes/_/pv-sys'))).statusCode).toBe(404);
        expect((await get(viewer, c('/objects/persistentvolumes/_/pv-shop'))).statusCode).toBe(200);
        expect((await get(viewer, c('/workloads?namespace=kube-system'))).statusCode).toBe(404);
        expect((await send(admin, 'PATCH', c(), { namespacesAllowlist: ['shop'], defaultNamespace: 'default' })).statusCode).toBe(400);
      } finally {
        await send(admin, 'PATCH', c(), { namespacesAllowlist: null });
      }
    });
  });

  describe('access', () => {
    it('lets a cluster manager below admin route the cluster only through servers they operate', async () => {
      // manage on a cluster through a grant (custom roles), restricted to what is granted
      const manager = seedUser(orgId, 'viewer');
      getDb().update(memberships).set({ serverAccess: 'restricted' }).where(eq(memberships.userId, manager.userId)).run();
      const hop = seedServer(orgId, admin.userId, 'hop-managed');
      const viaId = 'via-managed';
      getDb()
        .insert(kubeClusters)
        .values({
          id: viaId,
          orgId,
          name: 'managed',
          apiUrl: 'https://kube.internal:6443',
          connectVia: 'server',
          viaServerId: hop,
          authType: 'token',
          encryptedCredential: 'unused',
          credentialHint: 'token ending …abcd',
          createdBy: admin.userId,
        })
        .run();
      const grantTo = (resourceType: string, resourceId: string, level: string) =>
        getDb()
          .insert(resourceGrants)
          .values({
            id: `t-${resourceType}-${resourceId}-${level}`,
            orgId,
            principalType: 'user',
            principalId: manager.userId,
            resourceType,
            selector: 'id',
            resourceId,
            level,
            createdAt: new Date().toISOString(),
          })
          .run();
      const moveTo = { apiUrl: 'https://10.9.9.9:6443', token: 'new-token' };
      try {
        grantTo('cluster', viaId, 'manage');
        expect((await send(manager, 'PATCH', `/api/kube/clusters/${viaId}`, { name: 'managed-2', token: 't' })).statusCode).toBe(200);
        // A new address behind a server they cannot see, or only see
        expect((await send(manager, 'PATCH', `/api/kube/clusters/${viaId}`, moveTo)).statusCode).toBe(404);
        grantTo('server', hop, 'view');
        const viewOnly = await send(manager, 'PATCH', `/api/kube/clusters/${viaId}`, moveTo);
        expect(viewOnly.statusCode).toBe(403);
        expect(viewOnly.json().error).toMatch(/operate access to that server/);
        // …or a server they cannot see, from a direct cluster
        grantTo('cluster', clusterId, 'manage');
        const other = seedServer(orgId, admin.userId, 'hop-hidden');
        expect((await send(manager, 'PATCH', c(), { connectVia: 'server', viaServerId: other, token: 't' })).statusCode).toBe(404);
        expect(getDb().select().from(kubeClusters).where(eq(kubeClusters.id, clusterId)).get()!.connectVia).toBe('direct');
        // With operate on the server the route is theirs to change
        grantTo('server', hop, 'operate');
        expect((await send(manager, 'PATCH', `/api/kube/clusters/${viaId}`, moveTo)).statusCode).toBe(200);
      } finally {
        getDb().delete(resourceGrants).where(eq(resourceGrants.principalId, manager.userId)).run();
        getDb().delete(kubeClusters).where(eq(kubeClusters.id, viaId)).run();
      }
    });

    it('hides clusters from restricted members and other orgs as not found', async () => {
      expect((await get(restricted, '/api/kube/clusters')).json()).toEqual([]);
      expect((await get(restricted, c())).statusCode).toBe(404);
      expect((await get(restricted, c('/overview'))).statusCode).toBe(404);
      expect((await get(restricted, c('/stream?view=overview'))).statusCode).toBe(404);
      expect((await get(outsider, c())).statusCode).toBe(404);
      expect((await send(outsider, 'PATCH', c(), { name: 'mine' })).statusCode).toBe(404);
      const diag = await send(restricted, 'POST', `/api/diagnostics/clusters/${clusterId}`, { auth: true });
      expect(diag.statusCode).toBe(404);
    });

    it('grants clusters for a while, and the grant stops counting when it expires', async () => {
      const res = await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, {
        serverAccess: 'restricted',
        serverIds: [],
        clusterIds: [clusterId],
        clusterExpiresInMinutes: { [clusterId]: 60 },
      });
      expect(res.json()).toMatchObject({ clusterIds: [clusterId], clusterGrants: [expect.objectContaining({ clusterId })] });
      expect((await get(restricted, '/api/kube/clusters')).json()).toHaveLength(1);
      expect((await get(restricted, c('/overview'))).statusCode).toBe(200);
      // Server-only changes leave cluster grants alone
      await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [] });
      // Roles & access is off for them: not there at all
      expect((await get(restricted, `/api/team/members/${restricted.userId}/access`)).statusCode).toBe(404);
      expect((await get(admin, `/api/team/members/${restricted.userId}/access`)).json().clusterIds).toEqual([clusterId]);

      // Time is up: not found at once, and the sweep removes the row
      getDb()
        .update(memberClusterAccess)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(memberClusterAccess.userId, restricted.userId))
        .run();
      expect((await get(restricted, c('/overview'))).statusCode).toBe(404);
      expect(sweepExpiredAccess().grants).toBeGreaterThanOrEqual(1);
      expect(getDb().select().from(memberClusterAccess).where(eq(memberClusterAccess.userId, restricted.userId)).all()).toEqual([]);
      expect(audited('member.access_expired').some((row) => JSON.parse(row.metadata!).clusters?.includes(clusterId))).toBe(true);
    });

    it('rejects unknown clusters in a grant', async () => {
      const res = await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, {
        serverAccess: 'restricted',
        serverIds: [],
        clusterIds: ['nope'],
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('change feed', () => {
    it('says when the map changes, coalesced', async () => {
      const stream = await openStream(viewer, c('/stream?view=overview'));
      expect(stream.res.status).toBe(200);
      expect(await stream.next()).toEqual({ type: 'ready' });
      api.add('pods', pod('shop', 'web-3', { node: 'worker-1', labels: { app: 'web' } }));
      api.add('pods', pod('shop', 'web-4', { node: 'worker-1', labels: { app: 'web' } }));
      expect(await stream.next()).toEqual({ type: 'changed', resources: ['pods'] });
      stream.close();
      await until(() => activeKubeStreamCount(viewer.userId) === 0);
    });

    it('ends a member’s streams when their access is revoked', async () => {
      const stream = await openStream(viewer, c('/stream?view=workloads&namespace=shop'));
      expect(await stream.next()).toEqual({ type: 'ready' });
      expect(revokeLiveAccess(viewer.userId, { orgId }).kube).toBe(1);
      expect(await stream.next()).toMatchObject({ type: 'error', status: 403 });
      expect(await stream.next()).toBeNull();
    });

    it('ends a restricted member’s stream when their cluster grant is taken away, not on server changes', async () => {
      await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, {
        serverAccess: 'restricted',
        serverIds: [],
        clusterIds: [clusterId],
      });
      const stream = await openStream(restricted, c('/stream?view=namespaces'));
      expect(await stream.next()).toEqual({ type: 'ready' });
      await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, { serverAccess: 'restricted', serverIds: [] });
      expect(activeKubeStreamCount(restricted.userId)).toBe(1);
      await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, {
        serverAccess: 'restricted',
        serverIds: [],
        clusterIds: [],
      });
      expect(await stream.next()).toMatchObject({ type: 'error', status: 403 });
      await until(() => activeKubeStreamCount(restricted.userId) === 0);
    });

    it('ends streams on a cluster that was edited, so viewers reconnect to the new settings', async () => {
      const stream = await openStream(operator, c('/stream?view=object&resource=deployments&namespace=shop&name=web'));
      expect(await stream.next()).toEqual({ type: 'ready' });
      await send(admin, 'PATCH', c(), { name: 'prod-eu' });
      await until(() => activeKubeStreamCount(operator.userId) === 0);
      stream.close();
    });
  });

  describe('diagnose', () => {
    it('runs the network steps and the Kubernetes API step, audited', async () => {
      const res = await send(operator, 'POST', `/api/diagnostics/clusters/${clusterId}`, { auth: true });
      const result = res.json() as DiagnosticsResult;
      expect(result.target).toMatchObject({ kind: 'kube_cluster', id: clusterId });
      expect(result.steps.map((s) => [s.id, s.status])).toEqual([
        ['dns', 'ok'],
        ['tcp', 'ok'],
        ['tls', 'ok'],
        ['banner', 'ok'],
        ['auth', 'skipped'],
        ['kube_api', 'ok'],
      ]);
      expect(result.steps.at(-1)!.detail).toMatch(/v1\.31\.2\+fake accepted the stored credential/);
      expect(audited('kube_cluster.diagnose')).toHaveLength(1);
    });

    it('does not show a member the steps of a server they cannot access', async () => {
      const serverId = seedServer(orgId, admin.userId, 'bastion-hop');
      const viaId = 'via-hidden-server';
      getDb()
        .insert(kubeClusters)
        .values({
          id: viaId,
          orgId,
          name: 'private',
          apiUrl: 'https://kube.internal:6443',
          connectVia: 'server',
          viaServerId: serverId,
          authType: 'token',
          encryptedCredential: 'unused',
          credentialHint: 'token ending …abcd',
          createdBy: admin.userId,
        })
        .run();
      try {
        await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, {
          serverAccess: 'restricted',
          serverIds: [],
          clusterIds: [viaId],
        });
        const res = await send(restricted, 'POST', `/api/diagnostics/clusters/${viaId}`, { auth: false });
        const result = res.json() as DiagnosticsResult;
        expect(result.steps.map((s) => [s.id, s.status])).toEqual([['kube_api', 'skipped']]);
        expect(JSON.stringify(result)).not.toContain('10.0.0.1');
      } finally {
        getDb().delete(kubeClusters).where(eq(kubeClusters.id, viaId)).run();
      }
    });
  });

  it('removes a cluster with its grants', async () => {
    await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, {
      serverAccess: 'restricted',
      serverIds: [],
      clusterIds: [clusterId],
    });
    expect((await send(operator, 'DELETE', c())).statusCode).toBe(403);
    expect((await send(admin, 'DELETE', c())).statusCode).toBe(204);
    expect((await get(admin, c())).statusCode).toBe(404);
    expect(getDb().select().from(memberClusterAccess).all()).toEqual([]);
    expect(audited('kube_cluster.delete')).toHaveLength(1);
  });
});
