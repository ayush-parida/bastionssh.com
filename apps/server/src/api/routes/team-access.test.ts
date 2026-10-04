import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Custom roles, personal grants, scope, the access checker, who-has-access
 * and access requests for roles and resources (custom roles spec §6). The
 * live-access closers and the notifier are spied on; their own behaviour is
 * covered elsewhere (live-revocation.test.ts, notifications).
 */
const spies = vi.hoisted(() => ({
  terminals: vi.fn(() => 0),
  sftp: vi.fn(() => 0),
  agents: vi.fn(() => 0),
  notify: vi.fn(),
}));

vi.mock('../../ssh/broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ssh/broker.js')>();
  return { ...actual, SSHBroker: { ...actual.SSHBroker, closeForUser: spies.terminals } };
});
vi.mock('../../ssh/sftp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ssh/sftp.js')>();
  return { ...actual, evictUser: spies.sftp };
});
vi.mock('../../ai/streams.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/streams.js')>();
  return { ...actual, abortAgentStreams: spies.agents };
});
vi.mock('../../notifications/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../notifications/index.js')>();
  return { ...actual, notifyNotice: spies.notify };
});

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, kubeClusters, memberships, resourceGrants, roleMembers } from '../../db/schema.js';
import { canAccessServer } from '../../auth/server-access.js';
import { accessibleIds, levelFor } from '../../auth/access/index.js';
import { sweepExpiredAccess } from '../../auth/access-grants.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

describe('custom roles and resource access', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: Who;
  let admin: Who;
  let web1: string;
  let web2: string;
  let db1: string;
  let shop: string;

  let calls = 0;
  const remoteAddress = () => `10.78.${(++calls >> 8) & 255}.${calls & 255}`;
  const as = (who: Who) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: who.headers, remoteAddress: remoteAddress() }),
    post: (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, headers: who.headers, payload: payload ?? {}, remoteAddress: remoteAddress() }),
    put: (url: string, payload: object) =>
      app.inject({ method: 'PUT', url, headers: who.headers, payload, remoteAddress: remoteAddress() }),
    patch: (url: string, payload: object) =>
      app.inject({ method: 'PATCH', url, headers: who.headers, payload, remoteAddress: remoteAddress() }),
    delete: (url: string, payload?: object) =>
      app.inject({ method: 'DELETE', url, headers: who.headers, ...(payload && { payload }), remoteAddress: remoteAddress() }),
  });

  const audits = (action: string, resourceId: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)))
      .all()
      .map((row) => ({ ...row, meta: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {} }));

  /** A member limited to what roles and personal grants give them. */
  async function roleScoped(role: 'viewer' | 'operator' = 'viewer'): Promise<Who> {
    const member = seedUser(orgId, role);
    expect((await as(admin).patch(`/api/team/members/${member.userId}`, { scope: 'roles' })).statusCode).toBe(200);
    return member;
  }

  async function createRole(name: string, grants: object[] = []) {
    const res = await as(admin).post('/api/team/roles', { name, color: '#3b82f6', grants });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string };
  }

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-roles');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    web1 = seedServer(orgId, admin.userId, 'web-1', ['frontend']);
    web2 = seedServer(orgId, admin.userId, 'web-2', ['frontend']);
    db1 = seedServer(orgId, admin.userId, 'db-1', ['backend']);
    shop = nanoid();
    getDb()
      .insert(kubeClusters)
      .values({ id: shop, orgId, name: 'shop-prod', apiUrl: 'https://10.0.0.5:6443', authType: 'token', encryptedCredential: 'x', credentialHint: 'h', createdBy: admin.userId })
      .run();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('roles', () => {
    it('are created, read, renamed and deleted by admins only, audited with before and after', async () => {
      // Roles & access is off for a viewer: not there at all
      const viewer = seedUser(orgId, 'viewer');
      expect((await as(viewer).get('/api/team/roles')).statusCode).toBe(404);
      expect((await as(viewer).post('/api/team/roles', { name: 'Sneaky' })).statusCode).toBe(404);

      const role = await createRole('Ops', [{ resourceType: 'server', selector: 'id', resourceId: web1, level: 'operate' }]);
      expect((await as(admin).post('/api/team/roles', { name: 'Ops' })).statusCode).toBe(409);

      const list = (await as(admin).get('/api/team/roles')).json() as { id: string; memberCount: number; grants: unknown[] }[];
      expect(list.find((r) => r.id === role.id)).toMatchObject({ memberCount: 0, grants: [expect.objectContaining({ resourceId: web1, level: 'operate' })] });

      const renamed = await as(admin).patch(`/api/team/roles/${role.id}`, { name: 'Operations', description: 'On call' });
      expect(renamed.json()).toMatchObject({ name: 'Operations', description: 'On call' });
      expect(audits('role.update', role.id)[0]!.meta).toMatchObject({ before: { name: 'Ops' }, after: { name: 'Operations' } });
      expect(audits('role.create', role.id)).toHaveLength(1);

      expect((await as(admin).delete(`/api/team/roles/${role.id}`)).statusCode).toBe(204);
      expect((await as(admin).get(`/api/team/roles/${role.id}`)).statusCode).toBe(404);
      expect(getDb().select().from(resourceGrants).where(eq(resourceGrants.principalId, role.id)).all()).toHaveLength(0);
      expect(audits('role.delete', role.id)[0]!.meta).toMatchObject({ before: { name: 'Operations' } });
    });

    it('never hands out Owner below an owner, edits a locked role, deletes a built-in, or imitates one whatever the case of its name', async () => {
      const ownerRole = `builtin:${orgId}:owner`;
      expect((await as(admin).get(`/api/team/roles/${ownerRole}`)).json()).toMatchObject({ system: 'owner', editable: false, deletable: false });
      expect((await as(admin).post(`/api/team/roles/${ownerRole}/members`, { userId: admin.userId })).statusCode).toBe(400);
      const someone = seedUser(orgId, 'viewer');
      expect((await as(admin).post(`/api/team/roles/${ownerRole}/members`, { userId: someone.userId })).statusCode).toBe(403);
      expect((await as(admin).put(`/api/team/roles/${ownerRole}/grants`, { grants: [] })).statusCode).toBe(400);
      expect((await as(admin).patch(`/api/team/roles/${ownerRole}`, { color: '#ffffff' })).statusCode).toBe(400);
      expect((await as(admin).delete(`/api/team/roles/builtin:${orgId}:viewer`)).statusCode).toBe(400);
      for (const name of ['Owner', 'owner', ' ADMIN ', 'no access', 'Viewer (modules only)']) {
        expect((await as(admin).post('/api/team/roles', { name })).statusCode).toBe(409);
      }
      const role = await createRole('Lookalike', []);
      expect((await as(admin).patch(`/api/team/roles/${role.id}`, { name: 'operator' })).statusCode).toBe(409);
    });

    it('rejects grants on resources outside the org, tags on anything but servers, and namespaces on anything but clusters', async () => {
      const otherOrg = seedOrg('org-roles-other');
      const foreign = seedServer(otherOrg, admin.userId, 'elsewhere');
      const bad = [
        { resourceType: 'server', selector: 'id', resourceId: foreign, level: 'view' },
        { resourceType: 'cluster', selector: 'tag', tag: 'x', level: 'view' },
        { resourceType: 'server', selector: 'all', namespaces: ['shop'], level: 'view' },
        { resourceType: 'cluster', selector: 'id', resourceId: shop, namespaces: [], level: 'view' },
        { resourceType: 'cluster', selector: 'id', resourceId: shop, namespaces: ['Not_A_Namespace'], level: 'view' },
      ];
      const role = await createRole(`Checks ${nanoid(4)}`);
      for (const grant of bad) {
        expect((await as(admin).put(`/api/team/roles/${role.id}/grants`, { grants: [grant] })).statusCode).toBe(400);
      }
    });

    it('gives role-scoped members exactly what the role covers: a tag, live, and a cluster narrowed to a namespace', async () => {
      const role = await createRole(`Web team ${nanoid(4)}`, [
        { resourceType: 'server', selector: 'tag', tag: 'frontend', level: 'operate' },
        { resourceType: 'cluster', selector: 'id', resourceId: shop, namespaces: ['shop'], level: 'view' },
      ]);
      const alice = await roleScoped('viewer');
      const nobody = (await as(alice).get('/api/servers')).json() as { id: string }[];
      expect(nobody).toHaveLength(0);

      const added = await as(admin).post(`/api/team/roles/${role.id}/members`, { userId: alice.userId });
      expect(added.statusCode).toBe(201);
      const ids = ((await as(alice).get('/api/servers')).json() as { id: string }[]).map((s) => s.id).sort();
      expect(ids).toEqual([web1, web2].sort());
      expect((await as(alice).get(`/api/servers/${db1}`)).statusCode).toBe(404);

      // The role raises a viewer to operate on its servers, and only there
      const mine = (await as(alice).get('/api/team/access/mine?type=server')).json();
      expect(mine.levels).toEqual({ [web1]: 'operate', [web2]: 'operate' });
      const clusters = (await as(alice).get('/api/team/access/mine?type=cluster')).json();
      expect(clusters.levels).toEqual({ [shop]: 'view' });
      expect(clusters.namespaces).toEqual({ [shop]: ['shop'] });

      // Tagging another server brings it in at once
      const edge = seedServer(orgId, admin.userId, 'edge-1', ['frontend']);
      expect(canAccessServer({ orgId, userId: alice.userId }, edge)).toBe(true);

      // The checker says why
      const why = (await as(admin).get(`/api/team/access/explain?userId=${alice.userId}&type=server&id=${web1}`)).json();
      expect(why).toMatchObject({ level: 'operate', resource: { name: 'web-1' }, user: { scope: 'roles' } });
      expect(why.via).toEqual([expect.objectContaining({ kind: 'role', roleId: role.id, selector: 'tag', tag: 'frontend', level: 'operate' })]);
      const none = (await as(admin).get(`/api/team/access/explain?userId=${alice.userId}&type=server&id=${db1}`)).json();
      expect(none).toMatchObject({ level: null, via: [] });

      // Who has access to web-1: admins and owners at manage, alice through the role
      const holders = (await as(admin).get(`/api/team/access/resource?type=server&id=${web1}`)).json().holders as { userId: string; level: string; via: { kind: string }[] }[];
      expect(holders.find((h) => h.userId === alice.userId)).toMatchObject({ level: 'operate', via: [{ kind: 'role' }] });
      expect(holders.find((h) => h.userId === owner.userId)).toMatchObject({ level: 'manage' });
      expect(holders.some((h) => h.userId === seedUser(orgId, 'viewer').userId)).toBe(false);

      // The member detail shows the role and the effective access, with its reason
      const detail = (await as(admin).get(`/api/team/members/${alice.userId}/access`)).json();
      expect(detail).toMatchObject({ scope: 'roles', serverAccess: 'restricted' });
      expect(detail.roles).toEqual(expect.arrayContaining([expect.objectContaining({ roleId: role.id, system: null })]));
      expect(detail.effective.server.map((e: { resourceId: string }) => e.resourceId).sort()).toEqual([web1, web2, edge].sort());
      expect(detail.effective.cluster).toEqual([expect.objectContaining({ resourceId: shop, level: 'view', namespaces: ['shop'] })]);
    });

    it('closes what a member loses when they leave the role, and only that', async () => {
      const role = await createRole(`Edge ${nanoid(4)}`, [{ resourceType: 'server', selector: 'id', resourceId: web1, level: 'operate' }]);
      const bob = await roleScoped('operator');
      await as(admin).put(`/api/team/members/${bob.userId}/grants`, {
        grants: [{ resourceType: 'server', selector: 'id', resourceId: web2, level: 'operate' }],
      });
      await as(admin).post(`/api/team/roles/${role.id}/members`, { userId: bob.userId });
      vi.clearAllMocks();

      const removed = await as(admin).delete(`/api/team/roles/${role.id}/members/${bob.userId}`);
      expect(removed.statusCode).toBe(200);
      expect(spies.terminals).toHaveBeenCalledTimes(1);
      expect(spies.terminals).toHaveBeenCalledWith(bob.userId, expect.objectContaining({ orgId, keepServerIds: [web2] }));
      expect(audits('role.member_remove', role.id)[0]!.meta).toMatchObject({ userId: bob.userId, before: { expiresAt: null }, after: null });
    });

    it('closes what members lose when the role’s resources are narrowed, and nothing when they are widened', async () => {
      const role = await createRole(`Narrow ${nanoid(4)}`, [{ resourceType: 'server', selector: 'all', level: 'operate' }]);
      const carol = await roleScoped('viewer');
      await as(admin).post(`/api/team/roles/${role.id}/members`, { userId: carol.userId });

      vi.clearAllMocks();
      await as(admin).put(`/api/team/roles/${role.id}/grants`, {
        grants: [{ resourceType: 'server', selector: 'all', level: 'manage' }],
      });
      expect(spies.terminals).not.toHaveBeenCalled();

      const res = await as(admin).put(`/api/team/roles/${role.id}/grants`, {
        grants: [{ resourceType: 'server', selector: 'id', resourceId: db1, level: 'view' }],
      });
      expect(res.statusCode).toBe(200);
      // Still sees db-1, but at view: no shells there either
      expect(spies.terminals).toHaveBeenCalledWith(carol.userId, expect.objectContaining({ orgId, keepServerIds: [] }));
      const changed = audits('role.grants_change', role.id).at(-1)!.meta;
      expect(changed).toMatchObject({ before: [{ selector: 'all', level: 'manage' }], after: [{ selector: 'id', resourceId: db1, level: 'view' }] });
    });

    it('never lets an admin add themselves to a role, where it would outlive a demotion', async () => {
      const role = await createRole(`Self ${nanoid(4)}`, [{ resourceType: 'server', selector: 'all', level: 'manage' }]);
      const res = await as(admin).post(`/api/team/roles/${role.id}/members`, { userId: admin.userId });
      expect(res.statusCode).toBe(400);
      expect(getDb().select().from(roleMembers).where(eq(roleMembers.roleId, role.id)).all()).toHaveLength(0);
      // Demoted and narrowed by an owner, they keep nothing the role would have given
      const demoted = seedUser(orgId, 'admin');
      expect((await as(demoted).post(`/api/team/roles/${role.id}/members`, { userId: demoted.userId })).statusCode).toBe(400);
      expect((await as(owner).patch(`/api/team/members/${demoted.userId}`, { role: 'viewer', scope: 'roles' })).statusCode).toBe(200);
      expect(levelFor({ orgId, userId: demoted.userId }, 'server', web1)).toBeNull();
    });

    it('lets role memberships expire, closing what they gave', async () => {
      const role = await createRole(`Temp ${nanoid(4)}`, [{ resourceType: 'server', selector: 'id', resourceId: db1, level: 'operate' }]);
      const dave = await roleScoped('viewer');
      await as(admin).post(`/api/team/roles/${role.id}/members`, { userId: dave.userId, expiresInMinutes: 30 });
      expect(levelFor({ orgId, userId: dave.userId }, 'server', db1)?.level).toBe('operate');
      vi.clearAllMocks();
      sweepExpiredAccess(new Date(Date.now() + 31 * 60_000));
      expect(levelFor({ orgId, userId: dave.userId }, 'server', db1)).toBeNull();
      expect(getDb().select().from(roleMembers).where(and(eq(roleMembers.userId, dave.userId), eq(roleMembers.roleId, role.id))).all()).toHaveLength(0);
      expect(spies.terminals).toHaveBeenCalledWith(dave.userId, expect.objectContaining({ orgId }));
    });
  });

  describe('members', () => {
    it('switches scope, never for owners and admins, audited, closing what is lost', async () => {
      const erin = seedUser(orgId, 'operator');
      expect((await as(admin).patch(`/api/team/members/${owner.userId}`, { scope: 'roles' })).statusCode).toBe(403);
      const peer = seedUser(orgId, 'admin');
      expect((await as(owner).patch(`/api/team/members/${peer.userId}`, { scope: 'roles' })).statusCode).toBe(400);

      vi.clearAllMocks();
      expect((await as(admin).patch(`/api/team/members/${erin.userId}`, { scope: 'roles' })).statusCode).toBe(200);
      expect(spies.terminals).toHaveBeenCalledWith(erin.userId, expect.objectContaining({ orgId, keepServerIds: [] }));
      expect(getDb().select().from(memberships).where(eq(memberships.userId, erin.userId)).get()).toMatchObject({ scope: 'roles', serverAccess: 'restricted' });
      expect(audits('member.scope_change', erin.userId)[0]!.meta).toMatchObject({
        from: 'all',
        to: 'roles',
        before: { scope: 'all' },
        after: { scope: 'roles' },
      });
      expect((await as(erin).get('/api/servers')).json()).toHaveLength(0);
    });

    it('audits base-role and old-endpoint access changes with before and after', async () => {
      const gina = seedUser(orgId, 'operator');
      expect((await as(admin).patch(`/api/team/members/${gina.userId}`, { role: 'viewer' })).statusCode).toBe(200);
      expect(audits('member.role_change', gina.userId)[0]!.meta).toMatchObject({
        before: { role: 'operator' },
        after: { role: 'viewer' },
      });

      await as(admin).put(`/api/team/members/${gina.userId}/access`, { serverAccess: 'restricted', serverIds: [web1] });
      await as(admin).put(`/api/team/members/${gina.userId}/access`, { serverAccess: 'restricted', serverIds: [web2] });
      const rows = audits('member.access_change', gina.userId);
      expect(rows.map((r) => r.meta)).toContainEqual(
        expect.objectContaining({
          before: { serverAccess: 'restricted', servers: [{ serverId: web1, expiresAt: null }] },
          after: { serverAccess: 'restricted', servers: [{ serverId: web2, expiresAt: null }] },
        }),
      );
    });

    it('keeps what the old restriction never narrowed when the old endpoint restricts, as migration 0023 did', async () => {
      const LEGACY = ['cloud_account', 'cron_job', 'ftp_connection', 'saved_command', 'storage_connection'] as const;
      const legacyAll = (userId: string) =>
        getDb()
          .select({ id: resourceGrants.id, resourceType: resourceGrants.resourceType, selector: resourceGrants.selector, level: resourceGrants.level })
          .from(resourceGrants)
          .where(and(eq(resourceGrants.principalId, userId), eq(resourceGrants.selector, 'all')))
          .orderBy(resourceGrants.resourceType)
          .all();
      const reaches = (userId: string, level?: 'operate' | 'manage') =>
        LEGACY.filter((type) => accessibleIds({ orgId, userId }, type, level).all);

      const hana = seedUser(orgId, 'operator');
      const ivan = seedUser(orgId, 'viewer');
      for (const who of [hana, ivan]) {
        const res = await as(admin).put(`/api/team/members/${who.userId}/access`, { serverAccess: 'restricted', serverIds: [web1] });
        expect(res.statusCode, res.body).toBe(200);
      }
      // The same ids as the migration's, so they follow the member's base role
      expect(legacyAll(hana.userId)).toEqual(
        LEGACY.map((type) => ({ id: `legacy-all:${type}:${orgId}:${hana.userId}`, resourceType: type, selector: 'all', level: 'operate' })),
      );
      expect(legacyAll(ivan.userId).map((g) => g.level)).toEqual(LEGACY.map(() => 'view'));
      expect(reaches(hana.userId, 'operate')).toEqual([...LEGACY]);
      expect(reaches(hana.userId, 'manage')).toEqual([]);
      expect(reaches(ivan.userId)).toEqual([...LEGACY]);
      expect(reaches(ivan.userId, 'operate')).toEqual([]);
      // Servers stay narrowed
      expect(canAccessServer({ orgId, userId: hana.userId }, web1)).toBe(true);
      expect(canAccessServer({ orgId, userId: hana.userId }, web2)).toBe(false);
      expect(audits('member.access_change', hana.userId)[0]!.meta).toMatchObject({
        before: { serverAccess: 'all', legacyAll: [] },
        after: { serverAccess: 'restricted', legacyAll: LEGACY.map((resourceType) => ({ resourceType, level: 'operate' })) },
      });

      // Demoted: they follow the base role down
      expect((await as(admin).patch(`/api/team/members/${hana.userId}`, { role: 'viewer' })).statusCode).toBe(200);
      expect(reaches(hana.userId, 'operate')).toEqual([]);
      expect(reaches(hana.userId)).toEqual([...LEGACY]);

      // Saved again while still restricted: an admin's removal of one is not undone
      getDb().delete(resourceGrants).where(eq(resourceGrants.id, `legacy-all:cron_job:${orgId}:${ivan.userId}`)).run();
      await as(admin).put(`/api/team/members/${ivan.userId}/access`, { serverAccess: 'restricted', serverIds: [web2] });
      expect(reaches(ivan.userId)).toEqual(LEGACY.filter((type) => type !== 'cron_job'));

      // Lifted: they go, and the base role covers everything again
      expect((await as(admin).put(`/api/team/members/${ivan.userId}/access`, { serverAccess: 'all', serverIds: [] })).statusCode).toBe(200);
      expect(legacyAll(ivan.userId)).toEqual([]);
      expect(reaches(ivan.userId)).toEqual([...LEGACY]);
      expect(audits('member.access_change', ivan.userId).at(-1)!.meta).toMatchObject({
        before: { serverAccess: 'restricted', legacyAll: LEGACY.filter((t) => t !== 'cron_job').map((resourceType) => ({ resourceType, level: 'view' })) },
        after: { serverAccess: 'all', legacyAll: [] },
      });
      // …and restricted again later, they come back whole
      await as(admin).put(`/api/team/members/${ivan.userId}/access`, { serverAccess: 'restricted', serverIds: [] });
      expect(reaches(ivan.userId)).toEqual([...LEGACY]);

      // The newer scope switch is default-deny and leaves them to the admin
      const jo = await roleScoped('operator');
      expect(legacyAll(jo.userId)).toEqual([]);
      expect(reaches(jo.userId)).toEqual([]);

      // Lifted through the newer scope switch they go too (nothing changes while
      // the base role covers everything), so narrowing again there denies by default
      expect((await as(admin).patch(`/api/team/members/${ivan.userId}`, { scope: 'all' })).statusCode).toBe(200);
      expect(legacyAll(ivan.userId)).toEqual([]);
      expect(reaches(ivan.userId)).toEqual([...LEGACY]);
      expect(audits('member.scope_change', ivan.userId).at(-1)!.meta).toMatchObject({
        before: { scope: 'roles', legacyAll: LEGACY.map((resourceType) => ({ resourceType, level: 'view' })) },
        after: { scope: 'all', legacyAll: [] },
      });
      expect((await as(admin).patch(`/api/team/members/${ivan.userId}`, { scope: 'roles' })).statusCode).toBe(200);
      expect(reaches(ivan.userId)).toEqual([]);
    });

    it('replaces personal grants at any level, audited, and serves them through the old access endpoint too', async () => {
      const frank = await roleScoped('viewer');
      const res = await as(admin).put(`/api/team/members/${frank.userId}/grants`, {
        grants: [
          { resourceType: 'server', selector: 'id', resourceId: web1, level: 'manage', expiresInMinutes: 60 },
          { resourceType: 'cluster', selector: 'id', resourceId: shop, level: 'operate' },
        ],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(levelFor({ orgId, userId: frank.userId }, 'server', web1)?.level).toBe('manage');

      const legacy = (await as(admin).get(`/api/team/members/${frank.userId}/access`)).json();
      expect(legacy.serverIds).toEqual([web1]);
      expect(legacy.clusterIds).toEqual([shop]);
      expect(legacy.personalGrants).toHaveLength(2);

      // The old endpoint keeps the newer grant (and its level) for a server it still lists
      await as(admin).put(`/api/team/members/${frank.userId}/access`, { serverAccess: 'restricted', serverIds: [web1, web2] });
      expect(levelFor({ orgId, userId: frank.userId }, 'server', web1)?.level).toBe('manage');
      expect(levelFor({ orgId, userId: frank.userId }, 'server', web2)?.level).toBe('view');
      // …and drops it for one it leaves out
      await as(admin).put(`/api/team/members/${frank.userId}/access`, { serverAccess: 'restricted', serverIds: [web2] });
      expect(levelFor({ orgId, userId: frank.userId }, 'server', web1)).toBeNull();

      expect(audits('member.grants_change', frank.userId)[0]!.meta).toMatchObject({
        before: [],
        after: expect.arrayContaining([expect.objectContaining({ resourceId: web1, level: 'manage' })]),
      });
      expect((await as(admin).put(`/api/team/members/${owner.userId}/grants`, { grants: [] })).statusCode).toBe(403);
      expect((await as(owner).put(`/api/team/members/${admin.userId}/grants`, { grants: [] })).statusCode).toBe(400);
    });

    it('keeps the checker and who-has-access to Roles & access (admins by default)', async () => {
      const viewer = seedUser(orgId, 'viewer');
      expect((await as(viewer).get(`/api/team/access/explain?userId=${viewer.userId}&type=server&id=${web1}`)).statusCode).toBe(404);
      expect((await as(viewer).get(`/api/team/access/resource?type=server&id=${web1}`)).statusCode).toBe(404);
      expect((await as(viewer).get('/api/team/access/resources')).statusCode).toBe(404);
      // Anyone may read their own levels
      expect((await as(viewer).get('/api/team/access/mine?type=server')).json().levels[web1]).toBe('view');
      expect((await as(admin).get(`/api/team/access/resource?type=server&id=missing`)).statusCode).toBe(404);
    });

    it('tells a scope-all operator what their base role still allows on commands and cron jobs', async () => {
      const operator = seedUser(orgId, 'operator');
      expect((await as(operator).get('/api/team/access/mine?type=saved_command')).json().baseActions).toEqual(['edit']);
      expect((await as(operator).get('/api/team/access/mine?type=cron_job')).json().baseActions).toEqual(['edit', 'delete']);
      expect((await as(operator).get('/api/team/access/mine?type=server')).json().baseActions).toBeUndefined();
      // Neither a viewer nor a role-scoped operator keeps them
      const viewer = seedUser(orgId, 'viewer');
      expect((await as(viewer).get('/api/team/access/mine?type=cron_job')).json().baseActions).toBeUndefined();
      const scoped = await roleScoped('operator');
      expect((await as(scoped).get('/api/team/access/mine?type=cron_job')).json().baseActions).toBeUndefined();
    });
  });

  describe('access requests', () => {
    it('lets a member ask for a role; approval adds them until the time is up', async () => {
      const role = await createRole(`On call ${nanoid(4)}`, [{ resourceType: 'server', selector: 'id', resourceId: db1, level: 'operate' }]);
      const gina = await roleScoped('viewer');
      const requestable = (await as(gina).get('/api/access-requests/requestable')).json();
      expect(requestable.canRequest).toBe(true);
      expect(requestable.roles.map((r: { id: string }) => r.id)).toContain(role.id);

      const created = await as(gina).post('/api/access-requests', { roleId: role.id, reason: 'incident 42', durationMinutes: 60 });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json()).toMatchObject({ resourceType: 'role', role: { id: role.id }, servers: [] });

      const approved = await as(admin).post(`/api/access-requests/${created.json().id}/approve`, { durationMinutes: 30 });
      expect(approved.statusCode, approved.body).toBe(200);
      const membership = getDb().select().from(roleMembers).where(and(eq(roleMembers.roleId, role.id), eq(roleMembers.userId, gina.userId))).get()!;
      expect(new Date(membership.expiresAt!).getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);
      expect(levelFor({ orgId, userId: gina.userId }, 'server', db1)?.level).toBe('operate');
      expect(audits('role.member_add', role.id)[0]!.meta).toMatchObject({ userId: gina.userId, before: null });
    });

    it('lets a member ask for a higher level on a resource they see; approval adds a time-bound personal grant', async () => {
      const hal = seedUser(orgId, 'viewer');
      const created = await as(hal).post('/api/access-requests', {
        resourceType: 'server',
        resourceIds: [web2],
        level: 'operate',
        reason: 'restart nginx',
        durationMinutes: 60,
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json()).toMatchObject({ resourceType: 'server', level: 'operate', servers: [{ id: web2, name: 'web-2' }] });
      expect((await as(admin).post(`/api/access-requests/${created.json().id}/approve`)).statusCode).toBe(200);
      expect(levelFor({ orgId, userId: hal.userId }, 'server', web2)?.level).toBe('operate');
      expect(levelFor({ orgId, userId: hal.userId }, 'server', web1)?.level).toBe('view');

      // Already viewing it for good: asking for view changes nothing
      const again = await as(hal).post('/api/access-requests', {
        resourceType: 'server', resourceIds: [web1], level: 'view', reason: 'look', durationMinutes: 60,
      });
      expect(again.statusCode).toBe(400);
    });

    it('never offers or accepts what a role-scoped member cannot see, beyond server names the org lists', async () => {
      const ivy = await roleScoped('viewer');
      const requestable = (await as(ivy).get('/api/access-requests/requestable')).json();
      expect(requestable.resources.filter((r: { type: string }) => r.type === 'cluster')).toEqual([]);
      expect(requestable.resources.filter((r: { type: string }) => r.type === 'server').length).toBeGreaterThan(0);
      const res = await as(ivy).post('/api/access-requests', {
        resourceType: 'cluster', resourceIds: [shop], level: 'view', reason: 'peek', durationMinutes: 60,
      });
      expect(res.statusCode).toBe(400);
      expect((await as(admin).get('/api/access-requests/requestable')).json()).toMatchObject({ canRequest: false });
    });

    describe('cluster namespaces', () => {
      /** A role-scoped member who sees `shop` as a whole, at view. */
      async function shopViewer(base: 'viewer' | 'operator' = 'viewer'): Promise<Who> {
        const member = await roleScoped(base);
        getDb()
          .insert(resourceGrants)
          .values({
            id: nanoid(),
            orgId,
            principalType: 'user',
            principalId: member.userId,
            resourceType: 'cluster',
            selector: 'id',
            resourceId: shop,
            level: 'view',
            grantedBy: admin.userId,
            createdAt: new Date().toISOString(),
          })
          .run();
        return member;
      }
      const ask = (who: Who, body: object) =>
        as(who).post('/api/access-requests', { reason: 'incident 7', durationMinutes: 60, ...body });
      const operateIn = (who: Who, namespace?: string) =>
        levelFor({ orgId, userId: who.userId }, 'cluster', shop, namespace === undefined ? {} : { namespace })?.level ?? null;
      const personalClusterGrants = (who: Who) =>
        getDb()
          .select()
          .from(resourceGrants)
          .where(and(eq(resourceGrants.principalId, who.userId), eq(resourceGrants.resourceType, 'cluster'), eq(resourceGrants.level, 'operate')))
          .all();

      it('lets a member ask for some namespaces and the approver narrow them; approval grants only those', async () => {
        const jules = await shopViewer();
        const created = await ask(jules, { resourceType: 'cluster', resourceIds: [shop], level: 'operate', namespaces: ['web', 'shop'] });
        expect(created.statusCode, created.body).toBe(201);
        expect(created.json()).toMatchObject({ resourceType: 'cluster', level: 'operate', namespaces: ['shop', 'web'], approvedNamespaces: null });
        const id = created.json().id as string;

        // Never wider than asked
        const widened = await as(admin).post(`/api/access-requests/${id}/approve`, { namespaces: ['shop', 'ops'] });
        expect(widened.statusCode).toBe(400);
        expect(widened.json().error).toMatch(/narrow/);
        expect(personalClusterGrants(jules)).toEqual([]);

        const approved = await as(admin).post(`/api/access-requests/${id}/approve`, { namespaces: ['shop'] });
        expect(approved.statusCode, approved.body).toBe(200);
        expect(approved.json()).toMatchObject({ status: 'approved', namespaces: ['shop', 'web'], approvedNamespaces: ['shop'] });

        const [grant] = personalClusterGrants(jules);
        expect(grant).toMatchObject({ namespaces: '["shop"]', selector: 'id', resourceId: shop });
        expect(grant!.expiresAt).not.toBeNull();
        expect(operateIn(jules, 'shop')).toBe('operate');
        expect(operateIn(jules, 'web')).toBe('view');
        // The cluster as a whole stays at view
        expect(operateIn(jules)).toBe('view');
        expect(audits('access_request.approve', id)[0]!.meta).toMatchObject({
          namespaces: { before: ['shop', 'web'], after: ['shop'] },
          level: 'operate',
        });
      });

      it('narrows a whole-cluster request when the approver picks namespaces, and keeps a narrowed one narrowed', async () => {
        const kai = await shopViewer();
        const whole = await ask(kai, { resourceType: 'cluster', resourceIds: [shop], level: 'operate' });
        expect(whole.json()).toMatchObject({ namespaces: null });
        expect((await as(admin).post(`/api/access-requests/${whole.json().id}/approve`, { namespaces: ['shop'] })).statusCode).toBe(200);
        expect(operateIn(kai, 'shop')).toBe('operate');
        expect(operateIn(kai, 'ops')).toBe('view');
        expect(operateIn(kai)).toBe('view');

        const lea = await shopViewer();
        const narrowed = await ask(lea, { resourceType: 'cluster', resourceIds: [shop], level: 'operate', namespaces: ['web'] });
        expect((await as(admin).post(`/api/access-requests/${narrowed.json().id}/approve`)).statusCode).toBe(200);
        expect(operateIn(lea, 'web')).toBe('operate');
        expect(operateIn(lea, 'shop')).toBe('view');
        expect(operateIn(lea)).toBe('view');
      });

      it('grants a base-level cluster request narrowed to namespaces at the base role, in those namespaces only', async () => {
        const max = await roleScoped('operator');
        const created = await ask(max, { clusterIds: [shop], namespaces: ['shop'] });
        expect(created.statusCode, created.body).toBe(201);
        expect(created.json()).toMatchObject({ resourceType: 'cluster', level: null, namespaces: ['shop'], clusters: [{ id: shop }] });
        expect((await as(admin).post(`/api/access-requests/${created.json().id}/approve`)).statusCode).toBe(200);
        expect(operateIn(max, 'shop')).toBe('operate');
        expect(operateIn(max, 'ops')).toBeNull();
        expect(operateIn(max)).toBe('view');

        // It stands for the base role there, so it follows the role down (and back up) before it expires
        const demoted = await as(admin).patch(`/api/team/members/${max.userId}`, { role: 'viewer' });
        expect(demoted.statusCode, demoted.body).toBe(200);
        expect(operateIn(max, 'shop')).toBe('view');
        expect((await as(admin).patch(`/api/team/members/${max.userId}`, { role: 'operator' })).statusCode).toBe(200);
        expect(operateIn(max, 'shop')).toBe('operate');

        // The old per-member endpoint still removes it with the cluster
        const cleared = await as(admin).put(`/api/team/members/${max.userId}/access`, { serverAccess: 'restricted', serverIds: [], clusterIds: [] });
        expect(cleared.statusCode, cleared.body).toBe(200);
        expect(operateIn(max, 'shop')).toBeNull();
      });

      it('keeps the level of a narrowed request that named one when the requester’s base role changes', async () => {
        const ren = await shopViewer('operator');
        const created = await ask(ren, { resourceType: 'cluster', resourceIds: [shop], level: 'operate', namespaces: ['shop'] });
        expect((await as(admin).post(`/api/access-requests/${created.json().id}/approve`)).statusCode).toBe(200);
        expect((await as(admin).patch(`/api/team/members/${ren.userId}`, { role: 'viewer' })).statusCode).toBe(200);
        // Asked and approved at operate: an explicit level, not the base role's
        expect(operateIn(ren, 'shop')).toBe('operate');
        expect(personalClusterGrants(ren)[0]!.id.startsWith('legacy-')).toBe(false);
      });

      it('refuses namespaces anywhere but on cluster requests', async () => {
        const nia = seedUser(orgId, 'viewer');
        const server = await ask(nia, { resourceType: 'server', resourceIds: [web1], level: 'operate', namespaces: ['shop'] });
        expect(server.statusCode).toBe(400);
        const plain = await ask(nia, { resourceType: 'server', resourceIds: [web1], level: 'operate' });
        expect(plain.statusCode).toBe(201);
        const approve = await as(admin).post(`/api/access-requests/${plain.json().id}/approve`, { namespaces: ['shop'] });
        expect(approve.statusCode).toBe(400);
        expect(levelFor({ orgId, userId: nia.userId }, 'server', web1)?.level).toBe('view');
        // Not a namespace at all
        const bad = await ask(await shopViewer(), { resourceType: 'cluster', resourceIds: [shop], level: 'operate', namespaces: ['Not_A_Namespace'] });
        expect(bad.statusCode).toBe(400);
      });
    });
  });
});
