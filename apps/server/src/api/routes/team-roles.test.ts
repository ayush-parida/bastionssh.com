import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Unified roles in Team & Access (unified roles spec §2–§5, §7): built-ins
 * listed first and editable but for Owner and No access, "Reset to default",
 * clone, module levels with the delegation guard, roles given by invites and
 * the org's default role, the No access member, the last owner, and the
 * member detail's modules section. The live-access closers are spied on.
 */
const spies = vi.hoisted(() => ({ terminals: vi.fn(() => 0), sftp: vi.fn(() => 0), agents: vi.fn(() => 0) }));

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

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, kubeClusters, roleMembers } from '../../db/schema.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

describe('unified roles in Team & Access', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: Who;
  let admin: Who;
  let web1: string;
  let shop: string;

  let calls = 0;
  const remoteAddress = () => `10.79.${(++calls >> 8) & 255}.${calls & 255}`;
  const as = (who: Who) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: who.headers, remoteAddress: remoteAddress() }),
    post: (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, headers: who.headers, payload: payload ?? {}, remoteAddress: remoteAddress() }),
    put: (url: string, payload: object) =>
      app.inject({ method: 'PUT', url, headers: who.headers, payload, remoteAddress: remoteAddress() }),
    patch: (url: string, payload: object) =>
      app.inject({ method: 'PATCH', url, headers: who.headers, payload, remoteAddress: remoteAddress() }),
    delete: (url: string) => app.inject({ method: 'DELETE', url, headers: who.headers, remoteAddress: remoteAddress() }),
  });
  const builtIn = (system: string) => `builtin:${orgId}:${system}`;

  const audits = (action: string, resourceId: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)))
      .all()
      .map((row) => (row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {}));

  const visible = async (who: Who) =>
    ((await as(who).get('/api/me/modules')).json() as { modules: { module: string }[] }).modules.map((m) => m.module);

  /** Join through an invite as a brand-new account; returns the new member. */
  async function join(invite: { link: string }, email: string): Promise<Who> {
    const token = invite.link.split('/').pop()!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      payload: { email, displayName: 'Invitee', password: 'invitee-password-1' },
      remoteAddress: remoteAddress(),
    });
    expect(res.statusCode, res.body).toBe(201);
    const cookie = res.cookies.find((c) => c.name === 'smt_session')!;
    return { userId: (res.json() as { user: { id: string } }).user.id, headers: { cookie: `smt_session=${cookie.value}` } };
  }

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-unified-roles');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    web1 = seedServer(orgId, admin.userId, 'web-1', ['frontend']);
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

  it('lists the built-ins first, locked where they must be, then the other roles', async () => {
    await as(admin).post('/api/team/roles', { name: 'Aardvarks', modulePermissions: { servers: 'view' } });
    const list = (await as(admin).get('/api/team/roles')).json() as { name: string; system: string | null; editable: boolean; customized: boolean; assignable: boolean }[];
    expect(list.slice(0, 5).map((r) => r.system)).toEqual(['owner', 'admin', 'operator', 'viewer', 'none']);
    expect(list.slice(0, 5).map((r) => r.editable)).toEqual([false, true, true, true, false]);
    expect(list.slice(0, 5).every((r) => !r.customized)).toBe(true);
    // An admin may give every role but Owner
    expect(list.slice(0, 5).map((r) => r.assignable)).toEqual([false, true, true, true, true]);
    expect(list[5]).toMatchObject({ name: 'Aardvarks', system: null });
  });

  it('edits built-in Viewer: dropping Kubernetes hides it for every viewer, parks the grant, and Reset to default brings it back', async () => {
    const viewer = seedUser(orgId, 'viewer');
    expect(await visible(viewer)).toContain('kubernetes');
    expect((await as(viewer).get('/api/kube/clusters')).json()).toHaveLength(1);

    const role = (await as(admin).get(`/api/team/roles/${builtIn('viewer')}`)).json() as { modulePermissions: Record<string, string> };
    const { kubernetes: _dropped, ...rest } = role.modulePermissions;
    const res = await as(admin).patch(`/api/team/roles/${builtIn('viewer')}`, { modulePermissions: rest });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ customized: true });
    expect(await visible(viewer)).not.toContain('kubernetes');
    expect(audits('role.modules_change', builtIn('viewer'))[0]).toMatchObject({
      before: expect.objectContaining({ kubernetes: 'view' }),
      after: expect.not.objectContaining({ kubernetes: expect.anything() }),
    });

    const reset = await as(admin).post(`/api/team/roles/${builtIn('viewer')}/reset`);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({ customized: false });
    expect(await visible(viewer)).toContain('kubernetes');
    expect(audits('role.reset', builtIn('viewer'))).toHaveLength(1);
    // Owner and No access have no defaults to go back to
    expect((await as(owner).post(`/api/team/roles/${builtIn('owner')}/reset`)).statusCode).toBe(400);
  });

  it('clones a role with its modules and resources, under a free name', async () => {
    const source = (await as(admin).post('/api/team/roles', {
      name: `Web ${nanoid(4)}`,
      modulePermissions: { servers: 'operate' },
      grants: [{ resourceType: 'server', selector: 'tag', tag: 'frontend', level: 'operate' }],
    })).json() as { id: string; name: string };
    const copy = await as(admin).post(`/api/team/roles/${source.id}/clone`);
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json()).toMatchObject({
      name: `${source.name} copy`,
      system: null,
      modulePermissions: { servers: 'operate' },
      grants: [expect.objectContaining({ selector: 'tag', tag: 'frontend', level: 'operate' })],
    });
    expect((await as(admin).post(`/api/team/roles/${source.id}/clone`)).json()).toMatchObject({ name: `${source.name} copy 2` });
    // A clone of Viewer is an ordinary role, its own name
    expect((await as(admin).post(`/api/team/roles/${builtIn('viewer')}/clone`)).json()).toMatchObject({ name: 'Viewer copy', system: null });
    expect((await as(admin).post(`/api/team/roles/${builtIn('owner')}/clone`)).statusCode).toBe(400);
  });

  it('lets a Team leads role invite and assign only roles within its own permissions', async () => {
    const leads = (await as(admin).post('/api/team/roles', {
      name: `Team leads ${nanoid(4)}`,
      modulePermissions: { team_members: 'operate', team_roles: 'manage' },
    })).json() as { id: string; name: string };
    const lead = seedUser(orgId, 'viewer');
    expect((await as(admin).post(`/api/team/roles/${leads.id}/members`, { userId: lead.userId })).statusCode).toBe(201);

    // Viewer and Team leads they hold; Operator and Admin they do not
    const roles = (await as(lead).get('/api/team/roles')).json() as { id: string; assignable: boolean }[];
    const assignable = new Set(roles.filter((r) => r.assignable).map((r) => r.id));
    expect(assignable.has(builtIn('viewer'))).toBe(true);
    expect(assignable.has(leads.id)).toBe(true);
    expect(assignable.has(builtIn('none'))).toBe(true);
    expect(assignable.has(builtIn('operator'))).toBe(false);
    expect(assignable.has(builtIn('admin'))).toBe(false);

    const ok = await as(lead).post('/api/team/invites', { email: `led-${nanoid(4)}@example.com`, roleIds: [builtIn('viewer')] });
    expect(ok.statusCode, ok.body).toBe(201);
    const refused = await as(lead).post('/api/team/invites', { email: `op-${nanoid(4)}@example.com`, roleIds: [builtIn('operator')] });
    expect(refused.statusCode).toBe(403);
    expect((await as(lead).post('/api/team/invites', { email: `ad-${nanoid(4)}@example.com`, role: 'admin' })).statusCode).toBe(403);

    // Assigning: Viewer to someone yes, Operator no, and Admin not taken away from an admin
    const someone = seedUser(orgId, 'viewer');
    expect((await as(lead).post(`/api/team/roles/${leads.id}/members`, { userId: someone.userId })).statusCode).toBe(201);
    const op = await as(lead).post(`/api/team/roles/${builtIn('operator')}/members`, { userId: someone.userId });
    expect(op.statusCode).toBe(403);
    expect(op.json().error).toMatch(/Servers: operate/);
    expect((await as(lead).delete(`/api/team/roles/${builtIn('admin')}/members/${admin.userId}`)).statusCode).toBe(403);
    // Nor edit a role to give more than they hold — their own included
    expect((await as(lead).patch(`/api/team/roles/${leads.id}`, { modulePermissions: { team_members: 'operate', team_roles: 'manage', servers: 'manage' } })).statusCode).toBe(403);
    expect(audits('role.member_add', leads.id).at(-1)).toMatchObject({ userId: someone.userId, delegation: { ok: true, missing: [] } });
  });

  it('weighs the grants a module change un-parks: turning a module on gives them, so the actor must hold them', async () => {
    // Owner parks "All servers: manage" in a role (Servers off) and gives it to a team lead
    const parked = (await as(owner).post('/api/team/roles', {
      name: `Parked ops ${nanoid(4)}`,
      modulePermissions: { dashboard: 'view' },
      grants: [{ resourceType: 'server', selector: 'all', level: 'manage' }],
    })).json() as { id: string };
    const leads = (await as(owner).post('/api/team/roles', {
      name: `Role editors ${nanoid(4)}`,
      modulePermissions: { team_roles: 'manage' },
    })).json() as { id: string };
    const lead = seedUser(orgId, 'viewer');
    for (const id of [parked.id, leads.id]) {
      expect((await as(owner).post(`/api/team/roles/${id}/members`, { userId: lead.userId })).statusCode).toBe(201);
    }
    const level = async () =>
      ((await as(lead).get('/api/team/access/mine?type=server')).json() as { levels: Record<string, string> }).levels[web1];
    expect(await level()).toBe('view');

    // They hold Servers: view (Viewer), but not the manage the grant would give them
    const res = await as(lead).patch(`/api/team/roles/${parked.id}`, { modulePermissions: { dashboard: 'view', servers: 'view' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toMatch(/all servers: manage/);
    expect(await level()).toBe('view');

    // An admin, who holds it, may
    expect((await as(admin).patch(`/api/team/roles/${parked.id}`, { modulePermissions: { dashboard: 'view', servers: 'view' } })).statusCode).toBe(200);
    expect(await level()).toBe('manage');
  });

  it('lists members only to those Team & Access shows them to, and keeps a default role from being deleted', async () => {
    const nobody = seedUser(orgId, 'viewer');
    getDb().delete(roleMembers).where(and(eq(roleMembers.orgId, orgId), eq(roleMembers.userId, nobody.userId))).run();
    expect((await as(nobody).get('/api/team/members')).statusCode).toBe(404);
    expect((await as(seedUser(orgId, 'viewer')).get('/api/team/members')).statusCode).toBe(200);

    const guests = (await as(admin).post('/api/team/roles', { name: `Guests ${nanoid(4)}`, modulePermissions: { dashboard: 'view' } })).json() as { id: string };
    expect((await as(admin).put('/api/team/default-role', { roleId: guests.id })).statusCode).toBe(200);
    // Deleting it would send new members back to Viewer
    expect((await as(admin).delete(`/api/team/roles/${guests.id}`)).statusCode).toBe(409);
    await as(admin).put('/api/team/default-role', { roleId: builtIn('viewer') });
    expect((await as(admin).delete(`/api/team/roles/${guests.id}`)).statusCode).toBe(204);
  });

  it('gives an invitee exactly the picked roles, or the default role; No access sees nothing', async () => {
    const custom = (await as(admin).post('/api/team/roles', { name: `Lookers ${nanoid(4)}`, modulePermissions: { dashboard: 'view' } })).json() as { id: string };
    const email = `picked-${nanoid(4)}@example.com`;
    const invite = await as(admin).post('/api/team/invites', { email, roleIds: [custom.id] });
    expect(invite.json()).toMatchObject({ role: 'viewer', roles: [{ id: custom.id }] });
    const member = await join(invite.json(), email);
    const held = getDb().select({ roleId: roleMembers.roleId }).from(roleMembers).where(eq(roleMembers.userId, member.userId)).all();
    expect(held.map((r) => r.roleId)).toEqual([custom.id]);
    expect(await visible(member)).toEqual(['dashboard']);

    // The default role, set in organization settings
    const set = await as(admin).put('/api/team/default-role', { roleId: builtIn('none') });
    expect(set.statusCode, set.body).toBe(200);
    expect((await as(admin).get('/api/team/default-role')).json()).toMatchObject({ roleId: builtIn('none'), name: 'No access' });
    expect(audits('org.default_role_change', orgId).at(-1)).toMatchObject({ after: { roleId: builtIn('none') } });
    const plainEmail = `plain-${nanoid(4)}@example.com`;
    const plain = await join((await as(admin).post('/api/team/invites', { email: plainEmail })).json(), plainEmail);
    expect(await visible(plain)).toEqual([]);
    const me = (await as(plain).get('/api/me/access')).json();
    expect(me).toMatchObject({ noAccess: true, roles: [{ system: 'none' }] });
    // Every module route is gone for them, but their own account is not
    expect((await as(plain).get('/api/team/roles')).statusCode).toBe(404);
    expect((await as(plain).get('/api/servers')).json()).toEqual([]);
    expect((await as(plain).get('/api/auth/me')).statusCode).toBe(200);
    expect((await as(admin).put('/api/team/default-role', { roleId: builtIn('owner') })).statusCode).toBe(400);
    await as(admin).put('/api/team/default-role', { roleId: builtIn('viewer') });
  });

  it('keeps the last owner, and weighs a member given Owner through a role as an owner', async () => {
    const solo = seedOrg(`org-solo-${nanoid(4)}`);
    const only = seedUser(solo, 'owner');
    const other = seedUser(solo, 'admin');
    const ownerRole = `builtin:${solo}:owner`;
    expect((await as(only).delete(`/api/team/roles/${ownerRole}/members/${other.userId}`)).statusCode).toBe(404);
    // Only owners give or take Owner; once given, an admin can no longer suspend them
    expect((await as(other).post(`/api/team/roles/${ownerRole}/members`, { userId: other.userId })).statusCode).toBe(400);
    const promoted = seedUser(solo, 'viewer');
    expect((await as(other).post(`/api/team/roles/${ownerRole}/members`, { userId: promoted.userId })).statusCode).toBe(403);
    expect((await as(only).post(`/api/team/roles/${ownerRole}/members`, { userId: promoted.userId })).statusCode).toBe(201);
    expect((await as(other).post(`/api/team/members/${promoted.userId}/suspend`)).statusCode).toBe(403);
    expect((await as(other).delete(`/api/team/roles/${ownerRole}/members/${promoted.userId}`)).statusCode).toBe(403);
    // Two owners: one may take it from the other, leaving one; nobody takes their own
    expect((await as(promoted).delete(`/api/team/roles/${ownerRole}/members/${promoted.userId}`)).statusCode).toBe(400);
    expect((await as(promoted).delete(`/api/team/roles/${ownerRole}/members/${only.userId}`)).statusCode).toBe(200);
    // Holding no role now: No access, and Team & Access is gone for them
    expect((await as(only).get('/api/team/roles')).statusCode).toBe(404);
    // Suspending the last owner is refused as before
    expect((await as(promoted).post(`/api/team/members/${promoted.userId}/suspend`)).statusCode).toBe(400);
  });

  it('shows in the member detail every module with its level and the roles giving it', async () => {
    const leads = (await as(admin).post('/api/team/roles', { name: `Inviters ${nanoid(4)}`, modulePermissions: { team_members: 'operate' } })).json() as { id: string; name: string };
    const member = seedUser(orgId, 'viewer');
    await as(admin).post(`/api/team/roles/${leads.id}/members`, { userId: member.userId });
    const detail = (await as(admin).get(`/api/team/members/${member.userId}/access`)).json() as {
      modules: { module: string; level: string; visible: boolean; via: { name: string; level: string }[] }[];
    };
    const team = detail.modules.find((m) => m.module === 'team_members')!;
    expect(team).toMatchObject({ level: 'operate', visible: true });
    expect(team.via.map((v) => [v.name, v.level])).toEqual([[leads.name, 'operate'], ['Viewer', 'view']]);
    expect(detail.modules.find((m) => m.module === 'audit')).toMatchObject({ level: 'none', visible: false, via: [] });
    expect(web1).toBeTruthy();
  });
});
