import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { KubeAttentionList, KubeCluster, KubeEventList, KubeGraph, KubeObjectInsight } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import { resetKubeCache } from '../../kube/cache.js';
import { KubeClient } from '../../kube/client.js';
import { activeKubeStreamCount } from '../../kube/sse.js';
import { deployment, fakeKubeconfig, node, pod, startFakeApi, type FakeApi } from '../../kube/fake-api.test-helper.js';
import { seedOrg, seedUser } from './test-utils.js';
import { parseSince } from './kube-graph.js';

/**
 * K2 routes against the in-process fake API: the topology graph (edges,
 * broken links, rings), the events timeline, the attention list and an
 * object's insight — all from the watch cache, inside the namespace
 * allowlist, 404 for members without the cluster, Secret values nowhere, the
 * crash log tail for operators only — and the graph's change feed.
 */

type Who = { userId: string; headers: Record<string, string> };

const until = async (check: () => boolean, ms = 4000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function kevent(name: string, reason: string, message: string, count: number, last: string, type = 'Warning') {
  return {
    kind: 'Event',
    metadata: { name: `${name}.${reason}`, namespace: 'shop' },
    involvedObject: { kind: 'Pod', namespace: 'shop', name },
    reason,
    message,
    type,
    count,
    firstTimestamp: '2026-10-03T11:00:00Z',
    lastTimestamp: last,
    source: { component: 'kubelet' },
  };
}

describe('kube graph routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let api: FakeApi;
  let base: string;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let clusterId: string;

  const get = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: who.headers });
  const c = (rest = '') => `/api/kube/clusters/${clusterId}${rest}`;

  beforeAll(async () => {
    await runMigrations();
    api = await startFakeApi();
    api.add('nodes', node('worker-1'));
    api.add('namespaces', { kind: 'Namespace', metadata: { name: 'shop' } });
    api.add('namespaces', { kind: 'Namespace', metadata: { name: 'ops' } });
    const web = deployment('shop', 'web', { replicas: 2, ready: 1 });
    web.metadata.annotations = { 'deployment.kubernetes.io/revision': '2' };
    (web.spec as any).template.spec.containers[0].envFrom = [{ secretRef: { name: 'db' } }, { configMapRef: { name: 'missing-flags' } }];
    api.add('deployments', web);
    for (const [name, rev, ready] of [['web-7d4', 2, 1], ['web-5c8', 1, 0]] as const) {
      api.add('replicasets', {
        kind: 'ReplicaSet',
        metadata: {
          name,
          namespace: 'shop',
          annotations: { 'deployment.kubernetes.io/revision': String(rev), 'kubernetes.io/change-cause': `deploy ${rev}` },
          ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }],
        },
        spec: { replicas: ready, template: { spec: { containers: [{ name: 'app', image: `shop/web:1.${rev}` }] } } },
        status: { readyReplicas: ready },
      });
    }
    const ok = pod('shop', 'web-1', { node: 'worker-1', labels: { app: 'web' }, owner: { kind: 'ReplicaSet', name: 'web-7d4' } });
    (ok.status as any).conditions = [
      { type: 'PodScheduled', status: 'True' },
      { type: 'Ready', status: 'True' },
    ];
    api.add('pods', ok);
    const crash = pod('shop', 'web-2', { node: 'worker-1', labels: { app: 'web' }, owner: { kind: 'ReplicaSet', name: 'web-7d4' }, waiting: 'CrashLoopBackOff', restarts: 12 });
    (crash.status as any).containerStatuses[0].lastState = { terminated: { reason: 'Error', exitCode: 1 } };
    api.add('pods', crash);
    api.add('pods', pod('ops', 'tool', { node: 'worker-1', waiting: 'ImagePullBackOff' }));
    api.add('services', { kind: 'Service', metadata: { name: 'web', namespace: 'shop' }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } });
    api.add('services', { kind: 'Service', metadata: { name: 'api', namespace: 'shop' }, spec: { selector: { app: 'api' }, ports: [{ port: 80 }] } });
    api.add('ingresses', {
      kind: 'Ingress',
      metadata: { name: 'shop', namespace: 'shop' },
      spec: { rules: [{ host: 'shop.test', http: { paths: [{ path: '/', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] },
    });
    api.add('secrets', { kind: 'Secret', type: 'Opaque', metadata: { name: 'db', namespace: 'shop' }, data: { password: 'aHVudGVyMg==' } });
    api.add('events', kevent('web-2', 'BackOff', 'Back-off restarting failed container app', 30, '2026-10-03T11:50:00Z'));
    api.add('events', { ...kevent('web-2', 'BackOff', 'Back-off restarting failed container app', 7, '2026-10-03T11:59:00Z'), metadata: { name: 'web-2.BackOff.2', namespace: 'shop' } });
    api.add('events', kevent('web-1', 'Started', 'Started container app', 1, '2026-10-03T10:00:00Z', 'Normal'));

    const orgId = seedOrg('org-kube-graph');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const res = await app.inject({ method: 'POST', url: '/api/kube/clusters', headers: admin.headers, payload: { name: 'g', kubeconfig: fakeKubeconfig(api) } });
    expect(res.statusCode).toBe(201);
    clusterId = (res.json() as KubeCluster).id;
    await app.inject({
      method: 'PUT',
      url: `/api/team/members/${restricted.userId}/access`,
      headers: admin.headers,
      payload: { serverAccess: 'restricted', serverIds: [] },
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    resetKubeCache();
    await app.close();
    await api.close();
  });

  it('draws the topology: real edges, broken ones with their reason, problems counted', async () => {
    const res = await get(viewer, c('/graph?namespace=shop'));
    expect(res.statusCode).toBe(200);
    const g = res.json() as KubeGraph;
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(
      expect.arrayContaining(['Ingress/shop/shop', 'Service/shop/web', 'Deployment/shop/web', 'pods:Deployment/shop/web', 'Secret/shop/db']),
    );
    expect(g.edges.find((e) => e.source === 'Ingress/shop/shop' && e.target === 'Service/shop/web')).toMatchObject({ broken: false });
    expect(g.edges.find((e) => e.source === 'Service/shop/web' && e.target === 'Deployment/shop/web')).toMatchObject({ broken: false });
    expect(g.edges.filter((e) => e.broken).map((e) => e.target).sort()).toEqual(['missing:ConfigMap/shop/missing-flags', 'missing:Pods/shop/api-selector']);
    expect(g.nodes.find((n) => n.id === 'Deployment/shop/web')!.problems).toBe(1);
    expect(g.nodes.find((n) => n.id === 'pods:Deployment/shop/web')!.pods).toMatchObject({ ready: 1, total: 2 });
    // Other namespaces stay out; Secret values never leave
    expect(ids.some((id) => id.includes('/ops/'))).toBe(false);
    expect(res.body).not.toContain('aHVudGVyMg==');
  });

  it('collapses events by object and filters by time', async () => {
    const list = (await get(viewer, c('/events?namespace=shop'))).json() as KubeEventList;
    expect(list.groups.map((g) => g.object.name)).toEqual(['web-2', 'web-1']);
    expect(list.groups[0]!.events).toEqual([expect.objectContaining({ reason: 'BackOff', count: 37, lastSeen: '2026-10-03T11:59:00Z' })]);
    expect((await get(viewer, c('/events?namespace=shop&since=2026-10-03T11:00:00Z'))).json().groups).toHaveLength(1);
    expect((await get(viewer, c('/events?since=yesterday'))).statusCode).toBe(400);
    expect(parseSince('30m', 1_000_000_000)).toBe(1_000_000_000 - 30 * 60_000);
  });

  it('ranks problems across namespaces', async () => {
    const list = (await get(viewer, c('/attention'))).json() as KubeAttentionList;
    expect(list.items.map((d) => `${d.id} ${d.subject.namespace}/${d.subject.name}`).sort()).toEqual([
      'crash-loop shop/web-2',
      'image-pull ops/tool',
      'service-no-endpoints shop/api',
    ]);
    expect((await get(viewer, c('/attention?namespace=shop'))).json().items).toHaveLength(2);
  });

  it('explains one object: diagnoses, events, rollout, lifecycle', async () => {
    const dep = (await get(viewer, c('/objects/deployments/shop/web/insight'))).json() as KubeObjectInsight;
    expect(dep.diagnoses.map((d) => d.id)).toEqual(['crash-loop']);
    expect(dep.diagnoses[0]!.logTail).toBeUndefined();
    expect(dep.rollout).toMatchObject({ current: 2, revisions: [expect.objectContaining({ revision: 2, current: true, changeCause: 'deploy 2' }), expect.objectContaining({ revision: 1 })] });

    const p = (await get(viewer, c('/objects/pods/shop/web-1/insight'))).json() as KubeObjectInsight;
    expect(p.diagnoses).toEqual([]);
    expect(p.events).toEqual([expect.objectContaining({ reason: 'Started', type: 'Normal' })]);
    expect(p.lifecycle!.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(p.containers).toEqual([expect.objectContaining({ name: 'app', role: 'app', state: 'running' })]);

    const svc = (await get(viewer, c('/objects/services/shop/api/insight'))).json() as KubeObjectInsight;
    expect(svc.diagnoses[0]!.headline).toBe('This Service selects `app=api` but no ready pods match — traffic goes nowhere.');
    const ing = (await get(viewer, c('/objects/ingresses/shop/shop/insight'))).json() as KubeObjectInsight;
    expect(ing.diagnoses).toEqual([]);

    const secret = await get(operator, c('/objects/secrets/shop/db/insight'));
    expect(secret.statusCode).toBe(200);
    expect(secret.body).not.toContain('aHVudGVyMg==');
    expect((await get(viewer, c('/objects/pods/shop/nope/insight'))).statusCode).toBe(404);
    expect((await get(viewer, c('/objects/clusterroles/_/x/insight'))).statusCode).toBe(400);
  });

  it('adds the crash log tail for members who may read logs, never for viewers', async () => {
    const logs = vi.spyOn(KubeClient.prototype, 'logs').mockImplementation(async () => {
      return Readable.from([Buffer.from('starting\npanic: DATABASE_URL is not set\n')]) as unknown as IncomingMessage;
    });
    try {
      const asOperator = (await get(operator, c('/objects/pods/shop/web-2/insight'))).json() as KubeObjectInsight;
      expect(asOperator.diagnoses[0]).toMatchObject({
        id: 'crash-loop',
        logTail: ['starting', 'panic: DATABASE_URL is not set'],
        nextStep: 'Check its logs — last lines shown.',
      });
      expect(logs).toHaveBeenCalledWith('shop', 'web-2', expect.objectContaining({ container: 'app', previous: true, tailLines: 20 }));
      const calls = logs.mock.calls.length;
      const asViewer = (await get(viewer, c('/objects/pods/shop/web-2/insight'))).json() as KubeObjectInsight;
      expect(asViewer.diagnoses[0]!.logTail).toBeUndefined();
      expect(logs.mock.calls.length).toBe(calls);
    } finally {
      logs.mockRestore();
    }
  });

  it('keeps everyone inside the allowlist, and members without the cluster out', async () => {
    for (const path of ['/graph', '/events', '/attention', '/objects/pods/shop/web-1/insight']) {
      expect((await get(restricted, c(path))).statusCode).toBe(404);
    }
    await app.inject({ method: 'PATCH', url: c(), headers: admin.headers, payload: { namespacesAllowlist: ['shop'], defaultNamespace: 'shop' } });
    try {
      const all = (await get(viewer, c('/attention'))).json() as KubeAttentionList;
      expect(all.items.some((d) => d.subject.namespace === 'ops')).toBe(false);
      expect((await get(viewer, c('/graph?namespace=ops'))).statusCode).toBe(404);
      expect((await get(viewer, c('/objects/pods/ops/tool/insight'))).statusCode).toBe(404);
    } finally {
      await app.inject({ method: 'PATCH', url: c(), headers: admin.headers, payload: { namespacesAllowlist: null } });
    }
  });

  it('follows the graph live, and revocation ends the feed', async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}${c('/stream?view=graph&namespace=shop')}`, { headers: viewer.headers, signal: abort.signal });
    expect(res.status).toBe(200);
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
    expect(await next()).toEqual({ type: 'ready' });
    api.add('services', { kind: 'Service', metadata: { name: 'new', namespace: 'shop' }, spec: { selector: { app: 'web' } } });
    expect(await next()).toEqual({ type: 'changed', resources: ['services'] });
    expect(revokeLiveAccess(viewer.userId).kube).toBe(1);
    expect(await next()).toMatchObject({ type: 'error', status: 403 });
    await until(() => activeKubeStreamCount(viewer.userId) === 0);
    abort.abort();
  });
});
