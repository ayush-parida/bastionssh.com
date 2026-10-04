import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Org modules and Team & Access under unified roles (unified roles spec
 * §3.2, §4.2, §4.3, §7): module gates (404 off, 403 below), the delegation
 * guard over every Team & Access write (actor permission sets × target
 * permission sets), member role assignment, built-in edit / reset / clone,
 * invites, the default role, SSO roles, access-request approvals, owner-only
 * actions and the last owner, audit rows and revocation. The live-access
 * closers are spied on; their own behaviour is covered elsewhere.
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
import { BUILT_IN_ROLE_DEFAULTS, type ModuleLevel, type Role } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, invites, memberships, roleMembers, ssoProviders } from '../../db/schema.js';
import { moduleLevel, moduleRank } from '../../auth/access/index.js';
import { outranks, permanentOwnerIds, type RankRule } from '../../auth/access/members.js';
import { resolveSsoAccount, type IdTokenClaims } from '../../auth/sso.js';
import { seedOrg, seedServer, seedSession, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

describe('Team & Access with unified roles', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: Who;
  let admin: Who;
  let web1: string;
  let db1: string;

  let calls = 0;
  const remoteAddress = () => `10.79.${(++calls >> 8) & 255}.${calls & 255}`;
  const as = (who: Who) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: who.headers, remoteAddress: remoteAddress() }),
    post: (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, headers: who.headers, payload: payload ?? {}, remoteAddress: remoteAddress() }),
    put: (url: string, payload: object) => app.inject({ method: 'PUT', url, headers: who.headers, payload, remoteAddress: remoteAddress() }),
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

  const builtIn = (system: string) => `builtin:${orgId}:${system}`;
  const heldRoleIds = (userId: string) =>
    getDb()
      .select({ roleId: roleMembers.roleId })
      .from(roleMembers)
      .where(and(eq(roleMembers.orgId, orgId), eq(roleMembers.userId, userId)))
      .all()
      .map((r) => r.roleId)
      .sort();

  /** A custom role made by the owner (who may give anything). */
  async function role(name: string, modules: Record<string, ModuleLevel>, grants: object[] = []) {
    const res = await as(owner).post('/api/team/roles', { name: `${name} ${nanoid(4)}`, modules, grants });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; name: string };
  }

  /** A member holding exactly `roleIds` (each until `expiresAt`), set by the owner. */
  async function memberWith(roleIds: string[], expiresAt?: string): Promise<Who> {
    const member = seedUser(orgId, 'viewer');
    const res = await as(owner).put(`/api/team/members/${member.userId}/roles`, {
      roles: roleIds.map((roleId) => ({ roleId, ...(expiresAt && { expiresAt }) })),
    });
    expect(res.statusCode, res.body).toBe(200);
    return member;
  }

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-unified-team');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    web1 = seedServer(orgId, admin.userId, 'web-1', ['frontend']);
    seedServer(orgId, admin.userId, 'web-2', ['frontend']);
    db1 = seedServer(orgId, admin.userId, 'db-1', ['backend']);
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Module gates ────────────────────────────────────────────────────────────

  describe('org module gates', () => {
    /** Every route of the org modules this sweep moved, with a body that passes validation. */
    const ROUTES: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: () => string; body?: object }[] = [
      { method: 'GET', url: () => '/api/audit' },
      { method: 'GET', url: () => '/api/audit/export' },
      { method: 'GET', url: () => '/api/audit/settings' },
      { method: 'PUT', url: () => '/api/audit/settings/retention', body: { retentionDays: 90 } },
      { method: 'DELETE', url: () => '/api/audit/forwarding' },
      { method: 'GET', url: () => '/api/keys' },
      { method: 'POST', url: () => '/api/keys/generate', body: { name: 'k' } },
      { method: 'DELETE', url: () => '/api/keys/nope' },
      { method: 'GET', url: () => '/api/agents' },
      { method: 'POST', url: () => '/api/agents', body: { name: 'a' } },
      { method: 'GET', url: () => '/api/team/members' },
      { method: 'PUT', url: () => `/api/team/members/${admin.userId}/roles`, body: { roles: [] } },
      { method: 'PATCH', url: () => `/api/team/members/${admin.userId}`, body: { role: 'viewer' } },
      { method: 'POST', url: () => `/api/team/members/${admin.userId}/suspend` },
      { method: 'GET', url: () => '/api/team/invites' },
      { method: 'POST', url: () => '/api/team/invites', body: { email: 'x@example.com' } },
      { method: 'GET', url: () => '/api/team/roles' },
      { method: 'POST', url: () => '/api/team/roles', body: { name: 'Nope' } },
      { method: 'GET', url: () => '/api/team/access/resources' },
      { method: 'GET', url: () => '/api/team/default-role' },
      { method: 'PUT', url: () => '/api/team/default-role', body: { roleId: 'x' } },
      { method: 'PATCH', url: () => '/api/team/settings', body: { requirePasskey: false } },
      { method: 'GET', url: () => '/api/sso' },
      { method: 'GET', url: () => '/api/admin/backups' },
      { method: 'GET', url: () => '/api/notifications/channels' },
      { method: 'POST', url: () => '/api/notifications/channels', body: {} },
      { method: 'POST', url: () => '/api/ai/providers', body: {} },
      { method: 'PATCH', url: () => '/api/access-requests/settings', body: {} },
      { method: 'POST', url: () => '/api/access-requests/nope/approve' },
    ];

    it('answers 404 on every one of them to a member with No access', async () => {
      const nobody = await memberWith([]);
      expect(heldRoleIds(nobody.userId)).toEqual([builtIn('none')]);
      for (const route of ROUTES) {
        const res = await app.inject({
          method: route.method,
          url: route.url(),
          headers: nobody.headers,
          ...(route.body && { payload: route.body }),
          remoteAddress: remoteAddress(),
        });
        expect(res.statusCode, `${route.method} ${route.url()}`).toBe(404);
      }
      // Their own account still works
      expect((await as(nobody).get('/api/auth/me')).statusCode).toBe(200);
      expect((await as(nobody).get('/api/me/modules')).json()).toEqual({ modules: [] });
    });

    it('answers 404 where a module is off and 403 where it is on but too low', async () => {
      const viewer = seedUser(orgId, 'viewer');
      // Off for viewers by default
      expect((await as(viewer).get('/api/audit')).statusCode).toBe(404);
      expect((await as(viewer).get('/api/agents')).statusCode).toBe(404);
      expect((await as(viewer).get('/api/team/roles')).statusCode).toBe(404);
      // On at view: listing works, managing is 403
      expect((await as(viewer).get('/api/keys')).statusCode).toBe(200);
      expect((await as(viewer).post('/api/keys/generate', { name: 'k' })).statusCode).toBe(403);
      expect((await as(viewer).get('/api/team/members')).statusCode).toBe(200);
      expect((await as(viewer).post(`/api/team/members/${admin.userId}/suspend`)).statusCode).toBe(403);

      // A custom role reading the audit log, and no more
      const auditors = await role('Auditors', { audit: 'view' });
      const auditor = await memberWith([auditors.id]);
      expect((await as(auditor).get('/api/audit')).statusCode).toBe(200);
      expect((await as(auditor).get('/api/audit/export')).statusCode).toBe(403);
      expect((await as(auditor).get('/api/audit/settings')).statusCode).toBe(403);
      expect((await as(auditor).get('/api/keys')).statusCode).toBe(404);
    });

    it('keeps formerly owner-only settings with owners, even for a role holding the module at manage', async () => {
      const signIn = await role('Sign-in admins', { team_sign_in: 'manage', audit: 'manage', settings: 'manage' });
      const lead = await memberWith([signIn.id]);
      expect((await as(lead).patch('/api/team/settings', { requirePasskey: false })).statusCode).toBe(403);
      expect((await as(lead).get('/api/sso')).statusCode).toBe(403);
      expect((await as(lead).put('/api/audit/settings/retention', { retentionDays: 90 })).statusCode).toBe(403);
      expect((await as(lead).get('/api/admin/backups')).statusCode).toBe(403);
      expect((await as(admin).get('/api/sso')).statusCode).toBe(403);
      expect((await as(owner).get('/api/sso')).statusCode).toBe(200);
      // Settings at manage does set the default role — to one they could give themselves
      expect((await as(lead).put('/api/team/default-role', { roleId: builtIn('viewer') })).statusCode).toBe(403);
      expect((await as(lead).put('/api/team/default-role', { roleId: builtIn('none') })).statusCode).toBe(200);
      expect((await as(owner).put('/api/team/default-role', { roleId: builtIn('viewer') })).statusCode).toBe(200);
    });
  });

  // ── The delegation guard ────────────────────────────────────────────────────

  describe('delegation guard (actor permission sets × target permission sets)', () => {
    const LEVELS: ModuleLevel[] = ['none', 'view', 'operate', 'manage'];

    it('lets a role be created only with module levels the creator holds', async () => {
      for (const held of LEVELS) {
        const lead = await memberWith([(await role(`Leads ${held}`, { team_roles: 'manage', audit: held })).id]);
        for (const wanted of LEVELS) {
          const res = await as(lead).post('/api/team/roles', { name: `Made ${nanoid(6)}`, modules: { audit: wanted } });
          const allowed = moduleRank(wanted) <= moduleRank(held);
          expect(res.statusCode, `held ${held}, wanted ${wanted}: ${res.body}`).toBe(allowed ? 201 : 403);
          if (!allowed) expect(res.json().missing).toEqual([`Audit Log: ${wanted}`]);
        }
      }
    });

    /** What an actor holds on servers, and the oracle for whether it covers a wanted grant. */
    const HELD = [
      { name: 'nothing', grant: null },
      { name: 'web-1 operate', grant: { resourceType: 'server', selector: 'id', resource: 'web1', level: 'operate' } },
      { name: 'tag frontend operate', grant: { resourceType: 'server', selector: 'tag', tag: 'frontend', level: 'operate' } },
      { name: 'all servers view', grant: { resourceType: 'server', selector: 'all', level: 'view' } },
      { name: 'all servers manage', grant: { resourceType: 'server', selector: 'all', level: 'manage' } },
    ] as const;
    const WANTED = [
      { name: 'web-1 view', selector: 'id', resource: 'web1', level: 'view' },
      { name: 'web-1 operate', selector: 'id', resource: 'web1', level: 'operate' },
      { name: 'web-1 manage', selector: 'id', resource: 'web1', level: 'manage' },
      { name: 'db-1 view', selector: 'id', resource: 'db1', level: 'view' },
      { name: 'tag frontend operate', selector: 'tag', tag: 'frontend', level: 'operate' },
      { name: 'tag backend view', selector: 'tag', tag: 'backend', level: 'view' },
      { name: 'all servers view', selector: 'all', level: 'view' },
      { name: 'all servers operate', selector: 'all', level: 'operate' },
    ] as const;
    const LEVEL_RANK = { view: 0, operate: 1, manage: 2 } as const;
    const TAGS: Record<string, string> = { web1: 'frontend', db1: 'backend' };

    function covers(held: (typeof HELD)[number]['grant'], wanted: (typeof WANTED)[number]): boolean {
      if (!held || LEVEL_RANK[held.level] < LEVEL_RANK[wanted.level]) return false;
      if (held.selector === 'all') return true;
      if (held.selector === 'tag') {
        return wanted.selector === 'tag' ? wanted.tag === held.tag : wanted.selector === 'id' && TAGS[wanted.resource] === held.tag;
      }
      return wanted.selector === 'id' && wanted.resource === held.resource;
    }

    const toInput = (g: { selector: string; resource?: string; tag?: string; level: string }) => ({
      resourceType: 'server',
      selector: g.selector,
      ...(g.resource && { resourceId: g.resource === 'web1' ? web1 : db1 }),
      ...(g.tag && { tag: g.tag }),
      level: g.level,
    });

    it('lets a role be given grants, a member personal grants, only within what the actor holds (id ⊆ tag ⊆ all)', async () => {
      for (const held of HELD) {
        const leads = await role(`Grant leads`, { team_roles: 'manage', servers: 'manage' }, held.grant ? [toInput(held.grant)] : []);
        const lead = await memberWith([leads.id]);
        const target = await memberWith([builtIn('none')]);
        for (const wanted of WANTED) {
          const allowed = covers(held.grant, wanted);
          const made = await as(lead).post('/api/team/roles', { name: `G ${nanoid(6)}`, modules: {}, grants: [toInput(wanted)] });
          expect(made.statusCode, `role: held ${held.name}, wanted ${wanted.name}`).toBe(allowed ? 201 : 403);
          const personal = await as(lead).put(`/api/team/members/${target.userId}/grants`, { grants: [toInput(wanted)] });
          expect(personal.statusCode, `personal: held ${held.name}, wanted ${wanted.name}`).toBe(allowed ? 200 : 403);
          // Back to nothing, which needs the same (taking away)
          const cleared = await as(lead).put(`/api/team/members/${target.userId}/grants`, { grants: [] });
          expect(cleared.statusCode).toBe(200);
        }
      }
    });

    it('lets a role be assigned only by someone holding all of it, for as long; Owner only by owners', async () => {
      const contents: { name: string; modules: Record<string, ModuleLevel>; grants: object[] }[] = [
        { name: 'audit view', modules: { audit: 'view' }, grants: [] },
        { name: 'audit manage', modules: { audit: 'manage' }, grants: [] },
        { name: 'web-1 operate', modules: { servers: 'operate' }, grants: [{ resourceType: 'server', selector: 'id', resourceId: web1, level: 'operate' }] },
        { name: 'all servers operate', modules: { servers: 'operate' }, grants: [{ resourceType: 'server', selector: 'all', level: 'operate' }] },
      ];
      const targets = [];
      for (const c of contents) targets.push({ ...c, id: (await role(c.name, c.modules, c.grants)).id });
      const actors = [
        { name: 'audit operate + web-1 operate', modules: { team_roles: 'manage', audit: 'operate', servers: 'operate' } as Record<string, ModuleLevel>, grants: [{ resourceType: 'server', selector: 'id', resourceId: web1, level: 'operate' }], can: ['audit view', 'web-1 operate'] },
        { name: 'audit manage + all operate', modules: { team_roles: 'manage', audit: 'manage', servers: 'operate' } as Record<string, ModuleLevel>, grants: [{ resourceType: 'server', selector: 'all', level: 'operate' }], can: ['audit view', 'audit manage', 'web-1 operate', 'all servers operate'] },
        { name: 'roles manage only', modules: { team_roles: 'manage' } as Record<string, ModuleLevel>, grants: [], can: [] },
      ];
      for (const actor of actors) {
        const lead = await memberWith([(await role(actor.name, actor.modules, actor.grants)).id]);
        for (const t of targets) {
          const member = await memberWith([builtIn('none')]);
          const res = await as(lead).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: t.id }] });
          const allowed = actor.can.includes(t.name);
          expect(res.statusCode, `${actor.name} gives ${t.name}: ${res.body}`).toBe(allowed ? 200 : 403);
          expect(heldRoleIds(member.userId)).toEqual(allowed ? [t.id] : [builtIn('none')]);
          const viaRoute = await as(lead).post(`/api/team/roles/${t.id}/members`, { userId: (await memberWith([builtIn('none')])).userId });
          expect(viaRoute.statusCode, `${actor.name} adds to ${t.name}`).toBe(allowed ? 201 : 403);
        }
        // Owner is owner-only; Admin is everything, so beyond any of them
        const member = await memberWith([builtIn('none')]);
        expect((await as(lead).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: builtIn('owner') }] })).statusCode).toBe(403);
        expect((await as(lead).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: builtIn('admin') }] })).statusCode).toBe(403);
      }
      // An admin gives Admin, not Owner; an owner gives Owner
      const member = await memberWith([builtIn('none')]);
      expect((await as(admin).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: builtIn('owner') }] })).json().missing).toEqual(['the Owner role']);
      expect((await as(admin).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: builtIn('admin') }] })).statusCode).toBe(200);
      expect((await as(owner).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: builtIn('owner') }] })).statusCode).toBe(200);
    });

    it('never lets a role held for a while be given for longer, or anyone give themselves anything', async () => {
      const leads = await role('Temporary leads', { team_roles: 'manage', audit: 'manage' });
      const soon = new Date(Date.now() + 60 * 60_000).toISOString();
      const lead = await memberWith([leads.id], soon);
      const auditors = await role('Auditors (temp)', { audit: 'view' });
      const member = await memberWith([builtIn('none')]);
      const forGood = await as(lead).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: auditors.id }] });
      expect(forGood.statusCode).toBe(403);
      const shorter = new Date(Date.now() + 30 * 60_000).toISOString();
      expect((await as(lead).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: auditors.id, expiresAt: shorter }] })).statusCode).toBe(200);
      expect((await as(lead).put(`/api/team/members/${lead.userId}/roles`, { roles: [] })).statusCode).toBe(400);
      expect((await as(lead).post(`/api/team/roles/${auditors.id}/members`, { userId: lead.userId })).statusCode).toBe(400);
    });

    it('lets a role be edited only by changing what the editor holds', async () => {
      const leads = await role('Edit leads', { team_roles: 'manage', audit: 'operate' });
      const lead = await memberWith([leads.id]);
      const target = await role('Edited', { audit: 'view' });
      expect((await as(lead).patch(`/api/team/roles/${target.id}`, { modules: { audit: 'operate' } })).statusCode).toBe(200);
      expect((await as(lead).patch(`/api/team/roles/${target.id}`, { modules: { audit: 'manage' } })).statusCode).toBe(403);
      // Taking away needs the same: a module the editor lacks cannot be removed by them either
      const heavy = await role('Heavy', { audit: 'view', agents: 'manage' });
      expect((await as(lead).patch(`/api/team/roles/${heavy.id}`, { modules: { audit: 'view' } })).statusCode).toBe(403);
      expect((await as(lead).delete(`/api/team/roles/${heavy.id}`)).statusCode).toBe(403);
      // A change it may make is audited with before, after and how the guard let it through
      const row = audits('role.update', target.id).at(-1)!;
      expect(row.meta).toMatchObject({ before: { modules: { audit: 'view' } }, after: { modules: { audit: 'operate' } }, delegation: expect.any(String) });
    });
  });

  // ── Members and their roles ─────────────────────────────────────────────────

  describe('member roles', () => {
    it('replaces a member’s roles with several, audited before and after, and an empty list is No access', async () => {
      const web = await role('Web team', { servers: 'operate' }, [{ resourceType: 'server', selector: 'tag', tag: 'frontend', level: 'operate' }]);
      const member = seedUser(orgId, 'operator');
      expect(heldRoleIds(member.userId)).toEqual([builtIn('operator')]);
      const res = await as(admin).put(`/api/team/members/${member.userId}/roles`, {
        roles: [{ roleId: builtIn('viewer') }, { roleId: web.id }],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().roles.map((r: { roleId: string }) => r.roleId)).toEqual([builtIn('viewer'), web.id]);
      const row = audits('member.roles_change', member.userId).at(-1)!;
      expect(row.meta).toMatchObject({
        before: [{ roleId: builtIn('operator'), name: 'Operator' }],
        after: [{ roleId: builtIn('viewer'), name: 'Viewer' }, { roleId: web.id }],
      });
      // The compatible fields follow
      const listed = (await as(admin).get('/api/team/members')).json().find((m: { userId: string }) => m.userId === member.userId);
      expect(listed).toMatchObject({ role: 'viewer', scope: 'all' });
      expect(listed.roles.map((r: { system: string | null }) => r.system)).toEqual(['viewer', null]);

      // Lost operate on the servers: their terminals there close
      expect(spies.terminals).toHaveBeenCalled();

      expect((await as(admin).put(`/api/team/members/${member.userId}/roles`, { roles: [] })).json().roles).toEqual([
        expect.objectContaining({ roleId: builtIn('none'), system: 'none' }),
      ]);
      expect(moduleLevel({ orgId, userId: member.userId }, 'servers')).toBe('none');
    });

    it('closes AI streams when the AI Assistant goes', async () => {
      const member = seedUser(orgId, 'operator');
      expect(moduleLevel({ orgId, userId: member.userId }, 'ai')).toBe('view');
      spies.agents.mockReturnValueOnce(1);
      await as(admin).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: builtIn('viewer') }] });
      expect(spies.agents).toHaveBeenCalledWith(member.userId, { orgId });
      const row = audits('member.roles_change', member.userId).at(-1)!;
      expect(row.meta.live).toMatchObject({ agents: 1 });
    });

    it('keeps peers from demoting each other and the org from losing its last owner', async () => {
      const otherAdmin = seedUser(orgId, 'admin');
      expect((await as(admin).put(`/api/team/members/${otherAdmin.userId}/roles`, { roles: [{ roleId: builtIn('viewer') }] })).statusCode).toBe(403);
      expect(heldRoleIds(otherAdmin.userId)).toEqual([builtIn('admin')]);
      // Adding a custom role to a peer takes nothing away
      const extra = await role('Extra', { audit: 'view' });
      expect(
        (await as(admin).put(`/api/team/members/${otherAdmin.userId}/roles`, { roles: [{ roleId: builtIn('admin') }, { roleId: extra.id }] })).statusCode,
      ).toBe(200);

      const org = seedOrg('org-unified-last-owner');
      const only = seedUser(org, 'owner');
      const temp = seedUser(org, 'viewer');
      const soon = new Date(Date.now() + 60 * 60_000).toISOString();
      const asOwner = (url: string, payload: object) =>
        app.inject({ method: 'PUT', url, headers: only.headers, payload, remoteAddress: remoteAddress() });
      expect((await asOwner(`/api/team/members/${temp.userId}/roles`, { roles: [{ roleId: `builtin:${org}:owner`, expiresAt: soon }] })).statusCode).toBe(200);
      expect(permanentOwnerIds(org)).toEqual([only.userId]);
      // A temporary owner does not keep the org from being orphaned
      const suspend = await app.inject({ method: 'POST', url: `/api/team/members/${only.userId}/suspend`, headers: temp.headers, remoteAddress: remoteAddress() });
      expect(suspend.statusCode).toBe(400);
      const demote = await app.inject({
        method: 'PUT',
        url: `/api/team/members/${only.userId}/roles`,
        headers: temp.headers,
        payload: { roles: [{ roleId: `builtin:${org}:admin` }] },
        remoteAddress: remoteAddress(),
      });
      // Nor can someone who is an owner only for a while take Owner from one for good
      expect(demote.statusCode).toBe(403);
      expect(demote.json().missing).toContain('the Owner role');
      // The only permanent owner cannot drop it themselves either
      expect((await asOwner(`/api/team/members/${only.userId}/roles`, { roles: [] })).statusCode).toBe(400);
    });

    it('maps the old base-role and scope endpoints onto role assignments', async () => {
      const member = seedUser(orgId, 'viewer');
      const extra = await role('Kept', { audit: 'view' });
      await as(admin).put(`/api/team/members/${member.userId}/roles`, { roles: [{ roleId: builtIn('viewer') }, { roleId: extra.id }] });
      expect((await as(admin).patch(`/api/team/members/${member.userId}`, { role: 'operator' })).statusCode).toBe(200);
      expect(heldRoleIds(member.userId)).toEqual([builtIn('operator'), extra.id].sort());
      expect((await as(admin).patch(`/api/team/members/${member.userId}`, { scope: 'roles' })).statusCode).toBe(200);
      expect(heldRoleIds(member.userId)).toEqual([extra.id, `modules-only:${orgId}:operator`].sort());
      expect((await as(admin).patch(`/api/team/members/${member.userId}`, { scope: 'all' })).statusCode).toBe(200);
      expect(heldRoleIds(member.userId)).toEqual([builtIn('operator'), extra.id].sort());
      const row = getDb().select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, member.userId))).get()!;
      expect(row).toMatchObject({ role: 'operator', scope: 'all' });
    });
  });

  // ── Built-in roles ──────────────────────────────────────────────────────────

  describe('built-in roles', () => {
    it('lists built-ins first, Owner and No access locked', async () => {
      const list = (await as(admin).get('/api/team/roles')).json() as { system: string | null; editable: boolean; deletable: boolean }[];
      expect(list.slice(0, 5).map((r) => r.system)).toEqual(['owner', 'admin', 'operator', 'viewer', 'none']);
      expect(list.slice(0, 5).map((r) => r.editable)).toEqual([false, true, true, true, false]);
      expect(list.every((r) => r.deletable === (r.system === null))).toBe(true);
      expect((await as(admin).patch(`/api/team/roles/${builtIn('none')}`, { modules: { audit: 'view' } })).statusCode).toBe(400);
      expect((await as(admin).post(`/api/team/roles/${builtIn('owner')}/reset`)).statusCode).toBe(400);
      expect((await as(admin).patch(`/api/team/roles/${builtIn('viewer')}`, { name: 'Watchers' })).statusCode).toBe(400);
    });

    it('edits Viewer to drop Kubernetes for every viewer, and resets it to its defaults', async () => {
      const viewer = seedUser(orgId, 'viewer');
      expect(moduleLevel({ orgId, userId: viewer.userId }, 'kubernetes')).toBe('view');
      const { kubernetes: _dropped, ...rest } = BUILT_IN_ROLE_DEFAULTS.viewer.modules;
      const edited = await as(admin).patch(`/api/team/roles/${builtIn('viewer')}`, { modules: rest });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(moduleLevel({ orgId, userId: viewer.userId }, 'kubernetes')).toBe('none');
      expect((await as(viewer).get('/api/me/modules')).json().modules.map((m: { module: string }) => m.module)).not.toContain('kubernetes');

      // Drop its grants too, then put everything back
      expect((await as(admin).put(`/api/team/roles/${builtIn('viewer')}/grants`, { grants: [] })).statusCode).toBe(200);
      const reset = await as(admin).post(`/api/team/roles/${builtIn('viewer')}/reset`);
      expect(reset.statusCode, reset.body).toBe(200);
      expect(reset.json().modules).toEqual(BUILT_IN_ROLE_DEFAULTS.viewer.modules);
      expect(reset.json().grants).toHaveLength(7);
      expect(moduleLevel({ orgId, userId: viewer.userId }, 'kubernetes')).toBe('view');
      expect(audits('role.reset', builtIn('viewer')).at(-1)!.meta).toMatchObject({
        before: { grants: [] },
        after: { modules: BUILT_IN_ROLE_DEFAULTS.viewer.modules },
      });
    });

    it('clones any role into an editable custom role, Owner without the owner-only actions', async () => {
      const clone = await as(admin).post(`/api/team/roles/${builtIn('operator')}/clone`, { name: 'On call' });
      expect(clone.statusCode, clone.body).toBe(201);
      expect(clone.json()).toMatchObject({ system: null, editable: true, deletable: true, modules: BUILT_IN_ROLE_DEFAULTS.operator.modules });
      expect(clone.json().grants).toHaveLength(7);
      // An admin holds all an Owner clone gives (everything managed) — it is not Owner
      const ownerClone = await as(admin).post(`/api/team/roles/${builtIn('owner')}/clone`);
      expect(ownerClone.statusCode).toBe(201);
      expect(ownerClone.json()).toMatchObject({ name: 'Owner (copy)', system: null });
      const operator = seedUser(orgId, 'operator');
      expect((await as(operator).post(`/api/team/roles/${builtIn('operator')}/clone`)).statusCode).toBe(404);
    });
  });

  // ── Invites and the default role ────────────────────────────────────────────

  describe('invites and the default role', () => {
    it('invites with roles the inviter holds, and the invitee joins holding them', async () => {
      const inviters = await role('Inviters', { team_members: 'operate', audit: 'view' });
      const inviter = await memberWith([inviters.id]);
      const auditors = await role('Invited auditors', { audit: 'view' });
      expect((await as(inviter).post('/api/team/invites', { email: 'nope@example.com', role: 'admin' })).statusCode).toBe(403);
      expect((await as(inviter).post('/api/team/invites', { email: 'nope@example.com', roleIds: [builtIn('admin')] })).statusCode).toBe(403);
      const res = await as(inviter).post('/api/team/invites', { email: 'auditor@example.com', roleIds: [auditors.id] });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().roles).toEqual([{ id: auditors.id, name: auditors.name, system: null }]);

      const token = getDb().select().from(invites).where(eq(invites.id, res.json().id)).get()!.token;
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/invites/${token}/accept`,
        payload: { email: 'auditor@example.com', displayName: 'Aud', password: 'correct horse battery' },
        remoteAddress: remoteAddress(),
      });
      expect(accepted.statusCode, accepted.body).toBe(201);
      expect(heldRoleIds(accepted.json().user.id)).toEqual([auditors.id]);
    });

    it('gives the org’s default role to an invite naming none', async () => {
      const auditors = await role('Default auditors', { audit: 'view' });
      expect((await as(admin).put('/api/team/default-role', { roleId: builtIn('owner') })).statusCode).toBe(400);
      const set = await as(admin).put('/api/team/default-role', { roleId: auditors.id });
      expect(set.json()).toMatchObject({ roleId: auditors.id });
      expect(audits('org.default_role', orgId).at(-1)!.meta).toMatchObject({ before: { roleId: builtIn('viewer') }, after: { roleId: auditors.id } });
      try {
        const res = await as(admin).post('/api/team/invites', { email: 'default@example.com' });
        expect(res.json().roles).toEqual([expect.objectContaining({ id: auditors.id })]);
      } finally {
        await as(admin).put('/api/team/default-role', { roleId: builtIn('viewer') });
      }
    });
  });

  // ── SSO ─────────────────────────────────────────────────────────────────────

  describe('single sign-on roles', () => {
    it('only lets SSO give roles its configurer could, never Owner', async () => {
      const session = await seedSession(owner.userId);
      const put = (body: object) =>
        app.inject({
          method: 'PUT',
          url: '/api/sso',
          headers: session.headers,
          payload: { issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 's', allowedDomains: ['example.com'], ...body },
          remoteAddress: remoteAddress(),
        });
      expect((await put({ defaultRoleId: builtIn('owner') })).statusCode).toBe(400);
      expect((await put({ groupsClaim: 'groups', roleMappings: [{ group: 'x', roleId: 'missing' }] })).statusCode).toBe(400);
      const ok = await put({ defaultRoleId: builtIn('none'), groupsClaim: 'groups', roleMappings: [{ group: 'ops', roleId: builtIn('operator') }] });
      expect(ok.statusCode, ok.body).toBeLessThan(300);
      expect(ok.json()).toMatchObject({ defaultRoleId: builtIn('none'), roleMappings: [{ group: 'ops', roleId: builtIn('operator') }] });
    });

    it('provisions with the mapped or default role, and keeps mapped roles in step with the groups claim', async () => {
      const org = seedOrg('org-unified-sso');
      const by = seedUser(org, 'owner');
      const ops = `builtin:${org}:operator`;
      const id = nanoid();
      getDb()
        .insert(ssoProviders)
        .values({
          id,
          orgId: org,
          issuer: 'https://idp.example.com',
          clientId: 'c',
          encryptedClientSecret: 'x',
          allowedDomains: JSON.stringify(['example.com']),
          defaultRole: `builtin:${org}:none`,
          autoProvision: true,
          groupsClaim: 'groups',
          roleMappings: JSON.stringify([{ group: 'ops', role: 'viewer', roleId: ops }]),
          createdBy: by.userId,
        })
        .run();
      const provider = getDb().select().from(ssoProviders).where(eq(ssoProviders.id, id)).get()!;
      const claims = (sub: string, groups: string[]) =>
        ({ sub, email: `${sub}@example.com`, email_verified: true, groups }) as unknown as IdTokenClaims;
      const held = (userId: string) =>
        getDb().select({ roleId: roleMembers.roleId }).from(roleMembers).where(and(eq(roleMembers.orgId, org), eq(roleMembers.userId, userId))).all().map((r) => r.roleId);

      const plain = resolveSsoAccount(provider, claims('plain', []));
      expect(held(plain.user.id)).toEqual([`builtin:${org}:none`]);
      const operator = resolveSsoAccount(provider, claims('opsy', ['ops']));
      expect(held(operator.user.id)).toEqual([ops]);
      // Leaving the group takes the mapped role away (and nothing else is touched)
      const left = resolveSsoAccount(provider, claims('opsy', []));
      expect(left.rolesChange).toEqual({ before: [ops], after: [] });
      expect(held(operator.user.id)).toEqual([`builtin:${org}:none`]);
      expect(left.accessBefore).toBeDefined();
    });
  });

  // ── Access requests ─────────────────────────────────────────────────────────

  describe('access requests', () => {
    it('lets an approver approve only what they hold, for as long', async () => {
      // The AI Assistant too: an operate grant opens it for a requester without it
      const approvers = await role('Approvers', { team_roles: 'manage', servers: 'operate', ai: 'view' }, [
        { resourceType: 'server', selector: 'tag', tag: 'frontend', level: 'operate' },
      ]);
      const approver = await memberWith([approvers.id]);
      const requester = seedUser(orgId, 'viewer');
      expect((await as(admin).patch(`/api/team/members/${requester.userId}`, { scope: 'roles' })).statusCode).toBe(200);
      const ask = async (resourceId: string) => {
        const res = await as(requester).post('/api/access-requests', {
          resourceType: 'server',
          resourceIds: [resourceId],
          level: 'operate',
          reason: 'on call',
          durationMinutes: 60,
        });
        expect(res.statusCode, res.body).toBe(201);
        return res.json().id as string;
      };
      const forDb = await ask(db1);
      const refused = await as(approver).post(`/api/access-requests/${forDb}/approve`);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().missing).toEqual([`server ${db1}: operate`]);
      const forWeb = await ask(web1);
      const approved = await as(approver).post(`/api/access-requests/${forWeb}/approve`);
      expect(approved.statusCode, approved.body).toBe(200);
      expect(audits('access_request.approve', forWeb).at(-1)!.meta).toMatchObject({ delegation: 'within the actor’s own access' });
    });
  });

  // ── Equivalence with the base-role order ────────────────────────────────────

  describe('equivalence', () => {
    /** The rank rules of team.ts before unified roles. */
    const ORDER: Role[] = ['viewer', 'operator', 'admin', 'owner'];
    function before(actor: Role, target: Role, rule: RankRule): boolean {
      const r = (x: Role) => ORDER.indexOf(x);
      if (rule === 'atOrBelow') return r(target) <= r(actor);
      if (rule === 'below' && actor === 'owner' && target === 'owner') return true;
      return r(target) < r(actor);
    }

    it('decides who may act on whom exactly as the base roles did, with the built-ins at their defaults', () => {
      const org = seedOrg('org-unified-rank');
      const members = Object.fromEntries(ORDER.map((r) => [r, seedUser(org, r).userId])) as Record<Role, string>;
      for (const actor of ORDER) {
        for (const target of ORDER) {
          for (const rule of ['atOrBelow', 'below', 'strictlyBelow'] as RankRule[]) {
            const targetId = actor === target ? seedUser(org, target).userId : members[target];
            expect(outranks(org, members[actor], targetId, rule), `${actor} → ${target} (${rule})`).toBe(before(actor, target, rule));
          }
        }
      }
    });

    it('keeps role-scoped members below admins (the only ones who act on members by default)', async () => {
      const scoped = seedUser(orgId, 'operator');
      expect((await as(admin).patch(`/api/team/members/${scoped.userId}`, { scope: 'roles' })).statusCode).toBe(200);
      const viewer = seedUser(orgId, 'viewer');
      expect(outranks(orgId, admin.userId, scoped.userId, 'strictlyBelow')).toBe(true);
      expect(outranks(orgId, scoped.userId, admin.userId, 'atOrBelow')).toBe(false);
      expect(outranks(orgId, admin.userId, viewer.userId, 'below')).toBe(true);
      // Between a scoped operator and a viewer, neither holds all the other does (the viewer sees
      // every resource) — which only matters to a custom role with Members or Roles & access
      expect(outranks(orgId, scoped.userId, viewer.userId, 'atOrBelow')).toBe(false);
    });
  });
});
