import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Route matrix for servers and clusters (custom roles spec §5, §10): every
 * server and cluster route, and their dependents (terminal, SFTP, Docker,
 * Kubernetes views/actions, diagnostics, host keys, key rotation,
 * monitoring), asked by members whose level on the resource comes from the
 * base role (scope `all`), a custom role (by id, "all" or a tag), or a
 * personal grant (scope `roles`) — at view, operate and manage. A resource a
 * member cannot reach is a 404; one they see below the action's level a 403.
 *
 * Connectivity is kept out of it: the server has no credentials and Docker
 * off, so a request past the gate fails fast with its own 400; the cluster
 * is the in-process fake API; diagnostics are stubbed.
 */
const spies = vi.hoisted(() => ({
  revoke: vi.fn((_userId: string, _scope?: unknown) => ({ terminals: 0, sftp: 0, docker: 0, kube: 0, agents: 0 })),
}));
vi.mock('../../auth/revoke.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/revoke.js')>()),
  revokeLiveAccess: spies.revoke,
}));
vi.mock('../../diagnostics/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../diagnostics/index.js')>()),
  diagnoseServer: async () => ({ ok: true, failedStep: null, steps: [] }),
}));
vi.mock('../../kube/diagnose.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../kube/diagnose.js')>()),
  diagnoseCluster: async () => ({ ok: true, failedStep: null, steps: [] }),
}));

import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import type { AccessLevel, KubeCluster } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, memberships, resourceGrants, roleMembers, roles, servers } from '../../db/schema.js';
import { resetKubeCache } from '../../kube/cache.js';
import { deployment, fakeKubeconfig, node, pod, startFakeApi, type FakeApi } from '../../kube/fake-api.test-helper.js';
import { seedOrg, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };
type Level = AccessLevel | 'none';

const RANK: Record<Level, number> = { none: 0, view: 1, operate: 2, manage: 3 };

describe('server and cluster access matrix', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let api: FakeApi;
  let orgId: string;
  let admin: Who;
  let serverId: string;
  let otherServerId: string;
  let clusterId: string;

  // Each request from its own address, so the matrix stays under the app's per-IP rate limit
  let requests = 0;
  const call = (who: Who, method: string, url: string, payload?: object) => {
    requests++;
    return app.inject({
      method: method as 'GET',
      url,
      headers: who.headers,
      remoteAddress: `10.${(requests >> 16) & 255}.${(requests >> 8) & 255}.${requests & 255}`,
      ...(payload && { payload }),
    });
  };

  /** A server with no credentials and Docker off, so nothing past the gate reaches the network. */
  function seedOfflineServer(name: string, tags: string[]) {
    const id = nanoid();
    getDb()
      .insert(servers)
      .values({ id, orgId, name, host: '127.0.0.1', port: 1, username: 'root', createdBy: admin.userId, tags: JSON.stringify(tags), dockerMode: 'off' })
      .run();
    return id;
  }

  function roleScoped(base: 'viewer' | 'operator'): Who {
    const who = seedUser(orgId, base);
    getDb().update(memberships).set({ scope: 'roles' }).where(and(eq(memberships.userId, who.userId), eq(memberships.orgId, orgId))).run();
    return who;
  }

  function role(name: string, members: Who[]): string {
    const id = nanoid();
    getDb().insert(roles).values({ id, orgId, name, createdBy: admin.userId }).run();
    for (const m of members) getDb().insert(roleMembers).values({ roleId: id, userId: m.userId, orgId }).run();
    return id;
  }

  function grant(
    principal: { role: string } | { user: string },
    g: { resourceType: 'server' | 'cluster'; level: AccessLevel; selector?: 'id' | 'all' | 'tag'; resourceId?: string; tag?: string; namespaces?: string[] },
  ) {
    getDb()
      .insert(resourceGrants)
      .values({
        id: nanoid(),
        orgId,
        principalType: 'role' in principal ? 'role' : 'user',
        principalId: 'role' in principal ? principal.role : principal.user,
        resourceType: g.resourceType,
        selector: g.selector ?? 'id',
        resourceId: (g.selector ?? 'id') === 'id' ? g.resourceId : null,
        tag: g.tag ?? null,
        namespaces: g.namespaces ? JSON.stringify(g.namespaces) : null,
        level: g.level,
        grantedBy: admin.userId,
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  /** Every member of the matrix, with their level on the server and on the cluster, and how they got it. */
  const members: { name: string; who: () => Who; server: Level; cluster: Level }[] = [];
  const cases: Record<string, { who: Who; server: Level; cluster: Level }> = {};

  beforeAll(async () => {
    await runMigrations();
    api = await startFakeApi();
    api.add('nodes', node('worker-1'));
    api.add('namespaces', { kind: 'Namespace', metadata: { name: 'shop' } });
    api.add('namespaces', { kind: 'Namespace', metadata: { name: 'ops' } });
    api.add('deployments', deployment('shop', 'web', { replicas: 2, ready: 2 }));
    api.add('deployments', deployment('ops', 'tool', { replicas: 1, ready: 1 }));
    api.add('pods', pod('shop', 'web-1', { node: 'worker-1' }));
    api.add('pods', pod('ops', 'tool-1', { node: 'worker-1' }));

    orgId = seedOrg('org-resource-matrix');
    admin = seedUser(orgId, 'admin');
    serverId = seedOfflineServer('web-1', ['web']);
    otherServerId = seedOfflineServer('db-1', ['db']);

    app = await buildApp();
    await app.ready();
    const created = await call(admin, 'POST', '/api/kube/clusters', { name: 'shop-prod', kubeconfig: fakeKubeconfig(api) });
    expect(created.statusCode).toBe(201);
    clusterId = (created.json() as KubeCluster).id;
    // Scaling and restarting are operator actions only with this toggle on
    expect((await call(admin, 'PATCH', '/api/kube/settings', { operatorsCanScale: true })).statusCode).toBe(200);

    // Scope `all`: the base role is the level everywhere
    cases.baseViewer = { who: seedUser(orgId, 'viewer'), server: 'view', cluster: 'view' };
    cases.baseOperator = { who: seedUser(orgId, 'operator'), server: 'operate', cluster: 'operate' };
    cases.admin = { who: admin, server: 'manage', cluster: 'manage' };

    // Scope `roles`: nothing by default
    cases.nothing = { who: roleScoped('operator'), server: 'none', cluster: 'none' };

    // Through custom roles: by id, by tag, all — raising a viewer above their base role
    const roleView = roleScoped('viewer');
    const viewRole = role('Watchers', [roleView]);
    grant({ role: viewRole }, { resourceType: 'server', level: 'view', resourceId: serverId });
    grant({ role: viewRole }, { resourceType: 'cluster', level: 'view', resourceId: clusterId });
    cases.roleView = { who: roleView, server: 'view', cluster: 'view' };

    const roleOperate = roleScoped('viewer');
    const operateRole = role('Web team', [roleOperate]);
    grant({ role: operateRole }, { resourceType: 'server', level: 'operate', resourceId: serverId });
    grant({ role: operateRole }, { resourceType: 'cluster', level: 'operate', selector: 'all' });
    cases.roleOperate = { who: roleOperate, server: 'operate', cluster: 'operate' };

    const roleManage = roleScoped('viewer');
    const manageRole = role('Web owners', [roleManage]);
    grant({ role: manageRole }, { resourceType: 'server', level: 'manage', selector: 'tag', tag: 'web' });
    grant({ role: manageRole }, { resourceType: 'cluster', level: 'manage', resourceId: clusterId });
    cases.roleManage = { who: roleManage, server: 'manage', cluster: 'manage' };

    // Through personal grants
    const personalOperate = roleScoped('operator');
    grant({ user: personalOperate.userId }, { resourceType: 'server', level: 'operate', resourceId: serverId });
    grant({ user: personalOperate.userId }, { resourceType: 'cluster', level: 'view', resourceId: clusterId });
    cases.personalOperate = { who: personalOperate, server: 'operate', cluster: 'view' };

    const personalManage = roleScoped('viewer');
    grant({ user: personalManage.userId }, { resourceType: 'server', level: 'manage', resourceId: serverId });
    grant({ user: personalManage.userId }, { resourceType: 'cluster', level: 'manage', resourceId: clusterId });
    cases.personalManage = { who: personalManage, server: 'manage', cluster: 'manage' };

    for (const [name, c] of Object.entries(cases)) members.push({ name, who: () => c.who, server: c.server, cluster: c.cluster });
  });

  afterAll(async () => {
    resetKubeCache();
    await app.close();
    await api.close();
  });

  /** What `level` should get from a route needing `required`: 404, 403, or past the gate. */
  function expectGate(status: number, level: Level, required: AccessLevel, label: string) {
    if (level === 'none') expect(status, label).toBe(404);
    else if (RANK[level] < RANK[required]) expect(status, label).toBe(403);
    else expect([403, 404], label).not.toContain(status);
  }

  const s = (rest = '') => `/api/servers/${serverId}${rest}`;
  const c = (rest = '') => `/api/kube/clusters/${clusterId}${rest}`;

  /** Server routes and their dependents: method, url, body, level needed. */
  const serverRoutes = (): [string, string, object | undefined, AccessLevel][] => [
    ['GET', s(), undefined, 'view'],
    ['GET', `/api/monitoring/servers/${serverId}`, undefined, 'view'],
    ['GET', `/api/monitoring/servers/${serverId}/metrics`, undefined, 'view'],
    ['GET', `/api/docker/servers/${serverId}`, undefined, 'view'],
    ['GET', `/api/docker/servers/${serverId}/containers`, undefined, 'view'],
    ['POST', '/api/ssh-sessions', { serverId }, 'operate'],
    ['GET', `/api/sftp/${serverId}/list?path=/`, undefined, 'operate'],
    ['POST', `/api/sftp/${serverId}/mkdir`, { path: '/tmp/x' }, 'operate'],
    ['POST', `/api/diagnostics/servers/${serverId}`, {}, 'operate'],
    ['POST', `/api/monitoring/servers/${serverId}/check`, undefined, 'operate'],
    ['GET', `/api/docker/servers/${serverId}/containers/abc123abc123`, undefined, 'operate'],
    ['GET', s('/host-key'), undefined, 'manage'],
    ['PATCH', s(), { notes: 'edited' }, 'manage'],
    ['PATCH', `/api/monitoring/servers/${serverId}`, { enabled: true }, 'manage'],
    ['POST', `/api/docker/servers/${serverId}/probe`, {}, 'manage'],
    ['POST', s('/rotate-key'), {}, 'manage'],
  ];

  /** Cluster routes: method, url, body, level needed. */
  const clusterRoutes = (): [string, string, object | undefined, AccessLevel][] => [
    ['GET', c(), undefined, 'view'],
    ['GET', c('/namespaces'), undefined, 'view'],
    ['GET', c('/workloads?namespace=shop'), undefined, 'view'],
    ['GET', c('/pods/shop/web-1'), undefined, 'view'],
    ['GET', c('/pods/shop/web-1/logs/download'), undefined, 'operate'],
    ['GET', c('/objects/deployments/shop/web/yaml'), undefined, 'operate'],
    ['POST', c('/actions/restart'), { kind: 'Deployment', namespace: 'shop', name: 'web' }, 'operate'],
    ['POST', `/api/diagnostics/clusters/${clusterId}`, {}, 'operate'],
    ['POST', c('/actions/cordon'), { name: 'worker-1' }, 'manage'],
    ['PATCH', c(), { name: 'shop-prod' }, 'manage'],
  ];

  it('lists only what each member reaches', async () => {
    for (const m of members) {
      const listed = (await call(m.who(), 'GET', '/api/servers')).json().map((x: { id: string }) => x.id);
      expect(listed.includes(serverId), `${m.name} server list`).toBe(m.server !== 'none');
      const clusters = (await call(m.who(), 'GET', '/api/kube/clusters')).json().map((x: { id: string }) => x.id);
      expect(clusters.includes(clusterId), `${m.name} cluster list`).toBe(m.cluster !== 'none');
    }
    // A server tagged otherwise is covered by nothing a role-scoped member holds
    for (const name of ['roleView', 'roleOperate', 'roleManage', 'personalOperate', 'personalManage', 'nothing']) {
      const listed = (await call(cases[name]!.who, 'GET', '/api/servers')).json().map((x: { id: string }) => x.id);
      expect(listed, name).not.toContain(otherServerId);
    }
  });

  it('gates every server route at its level: 404 out of reach, 403 below, through for the rest', async () => {
    for (const m of members) {
      for (const [method, url, body, required] of serverRoutes()) {
        const res = await call(m.who(), method, url, body);
        expectGate(res.statusCode, m.server, required, `${m.name} ${method} ${url} (${res.statusCode} ${res.body.slice(0, 120)})`);
      }
    }
  });

  it('gates every cluster route at its level', async () => {
    for (const m of members) {
      for (const [method, url, body, required] of clusterRoutes()) {
        const res = await call(m.who(), method, url, body);
        expectGate(res.statusCode, m.cluster, required, `${m.name} ${method} ${url} (${res.statusCode} ${res.body.slice(0, 120)})`);
      }
    }
  });

  it('answers 404, not 403, for a server or cluster out of reach on manage-only routes', async () => {
    const who = cases.nothing!.who;
    expect((await call(who, 'DELETE', `/api/servers/${otherServerId}`)).statusCode).toBe(404);
    expect((await call(who, 'GET', `/api/servers/${otherServerId}/host-key`)).statusCode).toBe(404);
    expect((await call(who, 'POST', '/api/keys/rotate', { serverIds: [otherServerId] })).statusCode).toBe(404);
    expect((await call(who, 'POST', c('/actions/cordon'), { name: 'worker-1' })).statusCode).toBe(404);
    expect((await call(who, 'DELETE', c())).statusCode).toBe(404);
  });

  describe('cluster namespaces', () => {
    let narrowed: Who;

    beforeAll(() => {
      narrowed = roleScoped('viewer');
      const shopRole = role('Shop operators', [narrowed]);
      grant({ role: shopRole }, { resourceType: 'cluster', level: 'manage', resourceId: clusterId, namespaces: ['shop'] });
    });

    it('operates inside the granted namespace only, and sees the cluster as a whole at view', async () => {
      // Inside `shop`: the role's level
      expect((await call(narrowed, 'GET', c('/pods/shop/web-1/logs/download'))).statusCode).toBe(200);
      expect((await call(narrowed, 'GET', c('/objects/deployments/shop/web/yaml'))).statusCode).toBe(200);
      expect((await call(narrowed, 'POST', c('/actions/restart'), { kind: 'Deployment', namespace: 'shop', name: 'web' })).statusCode).toBe(200);
      // `ops` is not theirs: not found, whatever the action
      expect((await call(narrowed, 'GET', c('/pods/ops/tool-1'))).statusCode).toBe(404);
      expect((await call(narrowed, 'GET', c('/pods/ops/tool-1/logs/download'))).statusCode).toBe(404);
      expect((await call(narrowed, 'POST', c('/actions/restart'), { kind: 'Deployment', namespace: 'ops', name: 'tool' })).statusCode).toBe(404);
      // The cluster as a whole: visible, never managed through a narrowed grant
      const view = (await call(narrowed, 'GET', c())).json();
      expect(view.permissions).toMatchObject({ view: true, logs: false, cordon: false, configure: false });
      expect(view.namespacePermissions).toEqual({ shop: expect.objectContaining({ logs: true, rollback: true, exec: true }) });
      expect((await call(narrowed, 'POST', c('/actions/cordon'), { name: 'worker-1' })).statusCode).toBe(403);
      expect((await call(narrowed, 'PATCH', c(), { name: 'mine now' })).statusCode).toBe(403);
    });

    it('needs the cluster as a whole to explain a cluster-scoped object, whatever namespace the body names', async () => {
      // A Node has no namespace: the narrowed grant gives `view` on it, not `operate`
      const node = await call(narrowed, 'POST', c('/explain'), { resource: 'nodes', namespace: 'shop', name: 'worker-1' });
      expect(node.statusCode).toBe(403);
      // Inside `shop` the gate lets it through (no AI provider here, so it stops at 400)
      const inShop = await call(narrowed, 'POST', c('/explain'), { resource: 'deployments', namespace: 'shop', name: 'web' });
      expect(inShop.statusCode).toBe(400);
    });

    it('lists only the granted namespaces and their workloads', async () => {
      const namespaces = (await call(narrowed, 'GET', c('/namespaces'))).json() as { name: string }[];
      expect(namespaces.map((n) => n.name)).toEqual(['shop']);
      const { workloads } = (await call(narrowed, 'GET', c('/workloads'))).json() as { workloads: { namespace: string; name: string }[] };
      expect(workloads.map((w) => `${w.namespace}/${w.name}`)).toEqual(['shop/web']);
      // Someone with the whole cluster sees both
      const all = (await call(admin, 'GET', c('/workloads'))).json() as { workloads: { namespace: string }[] };
      expect(new Set(all.workloads.map((w) => w.namespace))).toEqual(new Set(['ops', 'shop']));
    });
  });

  describe('server edits through a role', () => {
    it('lets a role manager edit the server, but not steer its credentials, route or key', async () => {
      const who = cases.roleManage!.who;
      expect((await call(who, 'PATCH', s(), { name: 'web-1' })).statusCode).toBe(200);
      expect((await call(who, 'PATCH', s(), { host: '10.9.9.9' })).statusCode).toBe(403);
      expect((await call(who, 'PATCH', s(), { username: 'admin' })).statusCode).toBe(403);
      expect((await call(who, 'PATCH', s(), { agentId: 'some-agent' })).statusCode).toBe(403);
      expect((await call(who, 'PATCH', s(), { authType: 'key', defaultKeyId: 'any-key' })).statusCode).toBe(403);
      // A jump host, reachable or not, answers alike: never "unknown", so ids are not probed
      expect((await call(who, 'PATCH', s(), { jumpServerId: otherServerId })).statusCode).toBe(403);
      // A new password for the same endpoint is theirs to set
      const rekeyed = await call(who, 'PATCH', s(), { authType: 'password', password: 'fresh' });
      expect(rekeyed.statusCode).toBe(200);
    });

    it('never lets a role manager move where the server connects, even with a fresh password', async () => {
      // Any org key a terminal names (keyId) would log in wherever the server now points
      const who = cases.roleManage!.who;
      const moved = await call(who, 'PATCH', s(), { host: '10.9.9.9', port: 22, authType: 'password', password: 'fresh' });
      expect(moved.statusCode).toBe(403);
      // A jump host they operate themselves: the same host, resolved from another network
      const hop = seedOfflineServer('hop-1', ['web']);
      expect((await call(who, 'PATCH', s(), { jumpServerId: hop, authType: 'password', password: 'fresh' })).statusCode).toBe(403);
      const row = getDb().select().from(servers).where(eq(servers.id, serverId)).get()!;
      expect(row).toMatchObject({ host: '127.0.0.1', port: 1, jumpServerId: null });
      // Admins still can
      expect((await call(admin, 'PATCH', `/api/servers/${hop}`, { jumpServerId: null, notes: 'x' })).statusCode).toBe(200);
    });

    it('keeps creating servers admin-only', async () => {
      const res = await call(cases.roleManage!.who, 'POST', '/api/servers', { name: 'new', host: '127.0.0.1', username: 'root' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('tag changes (spec §8.3)', () => {
    it('need manage on the server, and are audited with the roles whose coverage changed', async () => {
      const tagged = seedOfflineServer('edge-1', ['web']);
      expect((await call(cases.roleOperate!.who, 'PATCH', `/api/servers/${tagged}`, { tags: [] })).statusCode).toBe(404);
      expect((await call(cases.baseOperator!.who, 'PATCH', `/api/servers/${tagged}`, { tags: [] })).statusCode).toBe(403);

      const member = cases.roleManage!.who;
      const before = (await call(member, 'GET', '/api/servers')).json().map((x: { id: string }) => x.id);
      expect(before).toContain(tagged);
      spies.revoke.mockClear();

      const res = await call(admin, 'PATCH', `/api/servers/${tagged}`, { tags: ['edge'] });
      expect(res.statusCode).toBe(200);
      const row = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'server.tags_change'), eq(auditLog.resourceId, tagged)))
        .get();
      expect(row).toBeDefined();
      const meta = JSON.parse(row!.metadata!);
      expect(meta).toMatchObject({ before: ['web'], after: ['edge'], added: ['edge'], removed: ['web'] });
      expect(meta.affectedRoles).toEqual([{ id: expect.any(String), name: 'Web owners', tags: ['web'] }]);

      // The tag selector no longer reaches the server: the member loses it, and what they had open on it closes
      const after = (await call(member, 'GET', '/api/servers')).json().map((x: { id: string }) => x.id);
      expect(after).not.toContain(tagged);
      const closed = spies.revoke.mock.calls.find(([userId]) => userId === member.userId);
      expect(closed).toBeDefined();
      const keep = closed![1] as { keepServerIds: string[] };
      expect(keep.keepServerIds).toContain(serverId);
      expect(keep.keepServerIds).not.toContain(tagged);
    });

    it('a role manager may retag their own server, which is audited too', async () => {
      const tagged = seedOfflineServer('edge-2', ['web']);
      const res = await call(cases.roleManage!.who, 'PATCH', `/api/servers/${tagged}`, { tags: ['web', 'eu'] });
      expect(res.statusCode).toBe(200);
      const row = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'server.tags_change'), eq(auditLog.resourceId, tagged)))
        .get();
      expect(JSON.parse(row!.metadata!)).toMatchObject({ added: ['eu'], removed: [] });
    });

    it('leaves the audit log alone when the tags did not change', async () => {
      const tagged = seedOfflineServer('edge-3', ['web']);
      expect((await call(admin, 'PATCH', `/api/servers/${tagged}`, { tags: ['web'], notes: 'same tags' })).statusCode).toBe(200);
      const row = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'server.tags_change'), eq(auditLog.resourceId, tagged)))
        .get();
      expect(row).toBeUndefined();
    });
  });

  describe('AI', () => {
    it('limits the AI context to what the member reaches', async () => {
      const body = (await call(cases.roleOperate!.who, 'GET', '/api/ai/context')).json() as { servers: { id: string }[] };
      expect(body.servers.map((x) => x.id)).toEqual([serverId]);
      const none = (await call(cases.nothing!.who, 'GET', '/api/ai/context')).json() as { servers: { id: string }[] };
      expect(none.servers).toEqual([]);
    });
  });

  describe('access requests for clusters', () => {
    it('are resource-typed: a member asks for a cluster, an admin approves, and the member gets it', async () => {
      const member = roleScoped('operator');
      const requestable = (await call(member, 'GET', '/api/access-requests/clusters')).json();
      expect(requestable).toMatchObject({ restricted: true, clusters: [{ id: clusterId, name: 'shop-prod', granted: null }] });

      expect((await call(member, 'GET', c())).statusCode).toBe(404);
      const created = await call(member, 'POST', '/api/access-requests', {
        resourceType: 'cluster',
        clusterIds: [clusterId],
        reason: 'debug the shop',
        durationMinutes: 60,
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ resourceType: 'cluster', clusters: [{ id: clusterId, name: 'shop-prod' }], servers: [] });

      const approved = await call(admin, 'POST', `/api/access-requests/${created.json().id}/approve`, {});
      expect(approved.statusCode).toBe(200);
      // At their base level (operator): logs now open, cordon still not
      expect((await call(member, 'GET', c())).statusCode).toBe(200);
      expect((await call(member, 'GET', c('/pods/shop/web-1/logs/download'))).statusCode).toBe(200);
      expect((await call(member, 'POST', c('/actions/cordon'), { name: 'worker-1' })).statusCode).toBe(403);
    });

    it('keep server requests as they were', async () => {
      const member = roleScoped('operator');
      const created = await call(member, 'POST', '/api/access-requests', { serverIds: [otherServerId], reason: 'look at db', durationMinutes: 30 });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ resourceType: 'server', servers: [{ id: otherServerId, name: 'db-1' }], clusters: [] });
      const mixed = await call(member, 'POST', '/api/access-requests', {
        resourceType: 'cluster',
        serverIds: [otherServerId],
        reason: 'wrong list',
        durationMinutes: 30,
      });
      expect(mixed.statusCode).toBe(400);
    });

    it('refuse members who already see every cluster', async () => {
      const res = await call(cases.baseOperator!.who, 'POST', '/api/access-requests', {
        resourceType: 'cluster',
        clusterIds: [clusterId],
        reason: 'already have it',
        durationMinutes: 30,
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
