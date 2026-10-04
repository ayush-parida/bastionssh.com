import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { and, eq, like } from 'drizzle-orm';
import {
  BUILT_IN_ROLE_DEFAULTS,
  BUILT_IN_ROLES,
  MODULE_KEYS,
  MODULES,
  RESOURCE_TYPES,
  type MeAccess,
  type MeModules,
  type ModuleKey,
  type ModuleLevel,
  type ModulePermissions,
} from '@smt/shared';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { apiTokens, memberships, organizations, resourceGrants, roleMembers, roles, savedCommands } from '../../db/schema.js';
import { generateApiToken } from '../token.js';
import { requireAuth } from '../middleware.js';
import { seedOrg, seedServer, seedUser } from '../../api/routes/test-utils.js';
import { buildApp } from '../../api/app.js';
import { legacyRoleFor, noModules, parseModulePermissions } from './levels.js';
import { levelFor } from './authorize.js';
import { resolveAccess } from './resolve.js';
import {
  accessSummary,
  canAssignRole,
  canGrant,
  hasModule,
  isOrgOwner,
  isOwner,
  moduleLevel,
  requireModule,
  requireOwner,
  visibleModules,
} from './modules.js';

/**
 * Module permissions (unified roles spec §3, §4): the built-in roles' defaults,
 * the union of roles, parked grants, the visibility rule, owner-only checks,
 * `requireModule`'s 404/403, `/api/me`, and the delegation guard.
 */

let orgId: string;
let owner: ReturnType<typeof seedUser>;
let admin: ReturnType<typeof seedUser>;

const who = (userId: string) => ({ orgId, userId });
const builtin = (system: string) => `builtin:${orgId}:${system}`;

/** A custom role with these module levels (null = from before module permissions) and members. */
function role(modules: ModulePermissions | null, userIds: string[] = [], expiresAt: string | null = null): string {
  const id = nanoid();
  getDb()
    .insert(roles)
    .values({ id, orgId, name: `r-${id}`, createdBy: admin.userId, modulePermissions: modules ? JSON.stringify(modules) : null })
    .run();
  for (const userId of userIds) getDb().insert(roleMembers).values({ roleId: id, userId, orgId, expiresAt }).run();
  return id;
}

function grant(
  principal: { role: string } | { user: string },
  g: {
    resourceType: (typeof RESOURCE_TYPES)[number];
    level: 'view' | 'operate' | 'manage';
    resourceId?: string;
    tag?: string;
    namespaces?: string[];
    expiresAt?: string;
  },
) {
  getDb()
    .insert(resourceGrants)
    .values({
      id: nanoid(),
      orgId,
      principalType: 'role' in principal ? 'role' : 'user',
      principalId: 'role' in principal ? principal.role : principal.user,
      resourceType: g.resourceType,
      selector: g.resourceId ? 'id' : g.tag ? 'tag' : 'all',
      resourceId: g.resourceId ?? null,
      tag: g.tag ?? null,
      namespaces: g.namespaces ? JSON.stringify(g.namespaces) : null,
      level: g.level,
      expiresAt: g.expiresAt ?? null,
    })
    .run();
}

/** A member holding exactly these roles (their built-in one taken away). */
function memberWith(...roleIds: string[]) {
  const member = seedUser(orgId, 'viewer');
  getDb().delete(roleMembers).where(eq(roleMembers.userId, member.userId)).run();
  for (const roleId of roleIds) getDb().insert(roleMembers).values({ roleId, userId: member.userId, orgId }).run();
  return member;
}

function readOnlyHeaders(userId: string) {
  const token = generateApiToken();
  getDb()
    .insert(apiTokens)
    .values({ id: nanoid(), userId, name: 'ro', hashedToken: token.hashedToken, prefix: token.prefix, scopes: JSON.stringify(['read']) })
    .run();
  return { authorization: `Bearer ${token.token}` };
}

describe('module permissions', () => {
  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-modules');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
  });

  describe('built-in roles', () => {
    it('gives every new org the built-in roles with their defaults, and Viewer as the default role', () => {
      const rows = getDb().select().from(roles).where(and(eq(roles.orgId, orgId), like(roles.id, 'builtin:%'))).all();
      expect(rows.map((r) => r.system).sort()).toEqual([...BUILT_IN_ROLES].sort());
      for (const row of rows) {
        const defaults = BUILT_IN_ROLE_DEFAULTS[row.system as keyof typeof BUILT_IN_ROLE_DEFAULTS];
        expect(row.name).toBe(defaults.name);
        expect(parseModulePermissions(row.modulePermissions), row.system!).toEqual(defaults.modules);
        const grants = getDb().select().from(resourceGrants).where(eq(resourceGrants.principalId, row.id)).all();
        // Owner reaches everything without grants; No access has none
        const expected = row.system === 'owner' || defaults.grantLevel === null ? [] : RESOURCE_TYPES.map((type) => ({ type, level: defaults.grantLevel }));
        expect(grants.map((g) => ({ type: g.resourceType, level: g.level })).sort((a, b) => a.type.localeCompare(b.type))).toEqual(
          [...expected].sort((a, b) => a.type.localeCompare(b.type)),
        );
        expect(grants.every((g) => g.selector === 'all' && g.namespaces === null && g.expiresAt === null)).toBe(true);
      }
      expect(getDb().select({ id: organizations.defaultRoleId }).from(organizations).where(eq(organizations.id, orgId)).get()?.id).toBe(
        builtin('viewer'),
      );
    });

    it('amounts to the base role it replaces, and to less once a built-in loses a module', () => {
      const of = (modules: ModulePermissions) => legacyRoleFor({ ...noModules(), ...modules });
      expect(of(BUILT_IN_ROLE_DEFAULTS.admin.modules)).toBe('admin');
      expect(of(BUILT_IN_ROLE_DEFAULTS.operator.modules)).toBe('operator');
      expect(of(BUILT_IN_ROLE_DEFAULTS.viewer.modules)).toBe('viewer');
      expect(of({})).toBe('viewer');
      expect(of({ ...BUILT_IN_ROLE_DEFAULTS.admin.modules, audit: 'view' })).toBe('operator');
      // Resource modules do not decide it: items come from grants
      expect(of({ ...BUILT_IN_ROLE_DEFAULTS.operator.modules, servers: 'none', saved_commands: 'operate' })).toBe('operator');
    });

    it('makes holders of the Owner role owners, and nobody else', () => {
      expect(isOwner(who(owner.userId))).toBe(true);
      expect(isOrgOwner(orgId, owner.userId)).toBe(true);
      expect(isOwner(who(admin.userId))).toBe(false);
      expect(isOrgOwner(orgId, admin.userId)).toBe(false);
      expect(MODULE_KEYS.every((key) => hasModule(who(owner.userId), key, 'manage'))).toBe(true);
      // A read-only token never acts as an owner, and reads only
      const ro = { orgId, user: { id: owner.userId, email: '', displayName: '' }, apiTokenReadOnly: true };
      expect(isOwner(ro)).toBe(false);
      expect(moduleLevel(ro, 'settings')).toBe('view');
    });
  });

  describe('union', () => {
    it('takes the highest level any held role gives, and drops expired memberships', () => {
      const a = role({ audit: 'view', ai: 'view' });
      const b = role({ audit: 'operate' });
      const gone = role({ agents: 'manage' });
      const member = memberWith(a, b);
      getDb().insert(roleMembers).values({ roleId: gone, userId: member.userId, orgId, expiresAt: '2000-01-01T00:00:00.000Z' }).run();
      expect(moduleLevel(who(member.userId), 'audit')).toBe('operate');
      expect(moduleLevel(who(member.userId), 'ai')).toBe('view');
      expect(moduleLevel(who(member.userId), 'agents')).toBe('none');
      expect(moduleLevel(who(member.userId), 'settings')).toBe('none');
    });

    it('ignores malformed module permissions and caps levels at what a module uses', () => {
      expect(parseModulePermissions('{not json')).toEqual({});
      expect(parseModulePermissions('["servers"]')).toEqual({});
      expect(parseModulePermissions('{"servers":"root","nope":"view","dashboard":"manage","ai":"operate"}')).toEqual({ dashboard: 'view', ai: 'operate' });
      const member = memberWith(role({ dashboard: 'manage' as ModuleLevel }));
      expect(moduleLevel(who(member.userId), 'dashboard')).toBe('view');
      expect(hasModule(who(member.userId), 'dashboard', 'manage')).toBe(true);
    });

    it('parks a role’s grants while it has their module off, and personal grants while no role has it on', () => {
      const s1 = seedServer(orgId, admin.userId, 'parked');
      const off = role({ servers: 'none', dashboard: 'view' });
      grant({ role: off }, { resourceType: 'server', resourceId: s1, level: 'manage' });
      const member = memberWith(off, builtin('none'));
      grant({ user: member.userId }, { resourceType: 'server', resourceId: s1, level: 'operate' });
      expect(levelFor(who(member.userId), 'server', s1)).toBeNull();

      // Another role turning Servers on lets the personal grant count, not the parked role grant
      const on = role({ servers: 'view' });
      getDb().insert(roleMembers).values({ roleId: on, userId: member.userId, orgId }).run();
      expect(levelFor(who(member.userId), 'server', s1)?.level).toBe('operate');
    });

    it('lets a custom role from before module permissions turn on the modules of its grants', () => {
      const s1 = seedServer(orgId, admin.userId, 'legacy-role');
      const old = role(null);
      grant({ role: old }, { resourceType: 'server', resourceId: s1, level: 'operate' });
      const member = memberWith(old);
      expect(levelFor(who(member.userId), 'server', s1)?.level).toBe('operate');
      expect(moduleLevel(who(member.userId), 'servers')).toBe('view');
      expect(moduleLevel(who(member.userId), 'containers')).toBe('view');
      expect(moduleLevel(who(member.userId), 'kubernetes')).toBe('none');
    });
  });

  describe('visibility', () => {
    it('shows nothing to a member with No access, or with no roles at all', () => {
      for (const member of [memberWith(builtin('none')), memberWith()]) {
        expect(visibleModules(who(member.userId))).toEqual([]);
        const summary = accessSummary(who(member.userId));
        expect(summary.noAccess).toBe(true);
        expect(summary.owner).toBe(false);
        expect(Object.values(summary.modules).every((l) => l === 'none')).toBe(true);
        expect(Object.values(summary.resources).every((r) => !r.all && r.count === 0)).toBe(true);
      }
    });

    it('hides a resource module with nothing in it, and shows it once an item is granted or it may create', () => {
      const viewer = seedUser(orgId, 'viewer');
      // Role-scoped through the old endpoint's column: migration 0025's trigger gives them "Viewer (modules only)"
      getDb().update(memberships).set({ scope: 'roles' }).where(eq(memberships.userId, viewer.userId)).run();
      expect(resolveAccess(who(viewer.userId)).roles.map((r) => r.id)).toEqual([`modules-only:${orgId}:viewer`]);
      const shown = () => visibleModules(who(viewer.userId)).map((m) => m.module);
      expect(shown()).not.toContain('servers');
      expect(shown()).toContain('dashboard');
      expect(shown()).toContain('team_members');

      const s1 = seedServer(orgId, admin.userId, 'now-visible');
      grant({ user: viewer.userId }, { resourceType: 'server', resourceId: s1, level: 'view' });
      expect(shown()).toContain('servers');
      expect(shown()).toContain('containers');
      expect(shown()).not.toContain('saved_commands');

      // A command bound to a server they cannot see does not count
      const s2 = seedServer(orgId, admin.userId, 'hidden');
      const cmd = nanoid();
      getDb().insert(savedCommands).values({ id: cmd, orgId, name: 'c', command: 'uptime', serverId: s2, createdBy: admin.userId }).run();
      grant({ user: viewer.userId }, { resourceType: 'saved_command', resourceId: cmd, level: 'view' });
      expect(shown()).not.toContain('saved_commands');

      // `manage` on a resource module shows it with nothing in it: they may create there
      const creator = memberWith(role({ ftp: 'manage' }));
      expect(visibleModules(who(creator.userId))).toEqual([{ module: 'ftp', level: 'manage' }]);
    });

    it('counts saved commands and cron jobs as listed, with their servers, never the org total', () => {
      const shown = seedServer(orgId, admin.userId, 'count-shown');
      const hidden = seedServer(orgId, admin.userId, 'count-hidden');
      const r = role({ servers: 'view', saved_commands: 'view', cron_jobs: 'view' });
      grant({ role: r }, { resourceType: 'server', resourceId: shown, level: 'view' });
      grant({ role: r }, { resourceType: 'saved_command', level: 'view' });
      grant({ role: r }, { resourceType: 'cron_job', level: 'view' });
      const member = memberWith(r);
      const before = accessSummary(who(member.userId)).resources;
      for (const serverId of [shown, hidden, null]) {
        getDb().insert(savedCommands).values({ id: nanoid(), orgId, name: 'n', command: 'uptime', serverId, createdBy: admin.userId }).run();
      }
      const after = accessSummary(who(member.userId)).resources;
      // The one on their server and the one on none; not the one on a server they cannot see
      expect(after.saved_command).toEqual({ all: true, count: before.saved_command.count + 2 });
      expect(after.saved_command.count).toBeLessThan(accessSummary(who(admin.userId)).resources.saved_command.count);
    });

    it('shows every module to admins, in catalogue order', () => {
      expect(visibleModules(who(admin.userId)).map((m) => m.module)).toEqual(MODULES.map((m) => m.key));
    });
  });

  describe('gates and /api/me', () => {
    let gate: FastifyInstance;
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeAll(async () => {
      gate = Fastify();
      gate.addHook('preHandler', requireAuth);
      gate.get('/audit/export', { preHandler: requireModule('audit', 'operate') }, async () => ({ ok: true }));
      gate.get('/servers/new', { preHandler: requireModule('servers', 'manage') }, async () => ({ ok: true }));
      gate.get('/owner', { preHandler: requireOwner() }, async () => ({ ok: true }));
      await gate.ready();
      app = await buildApp();
    });

    afterAll(async () => {
      await gate.close();
      await app.close();
    });

    const status = async (url: string, headers: Record<string, string>) => (await gate.inject({ method: 'GET', url, headers })).statusCode;

    it('answers 404 for a module that is off or hidden, 403 below the level, and lets the rest through', async () => {
      const viewer = seedUser(orgId, 'viewer');
      expect(await status('/audit/export', viewer.headers)).toBe(404);
      expect(await status('/servers/new', viewer.headers)).toBe(403);

      const auditor = memberWith(role({ audit: 'view' }));
      expect(await status('/audit/export', auditor.headers)).toBe(403);
      // Servers off for them: not there at all
      expect(await status('/servers/new', auditor.headers)).toBe(404);

      expect(await status('/audit/export', admin.headers)).toBe(200);
      expect(await status('/servers/new', admin.headers)).toBe(200);
      // A read-only token reads only
      expect(await status('/audit/export', readOnlyHeaders(admin.userId))).toBe(403);
    });

    it('keeps owner-only actions to owners', async () => {
      expect(await status('/owner', owner.headers)).toBe(200);
      expect(await status('/owner', admin.headers)).toBe(403);
      expect(await status('/owner', readOnlyHeaders(owner.userId))).toBe(403);
    });

    it('tells the caller which modules to show and what they hold', async () => {
      const viewer = seedUser(orgId, 'viewer');
      const modules = (await app.inject({ method: 'GET', url: '/api/me/modules', headers: viewer.headers })).json() as MeModules;
      expect(modules.modules).toEqual(visibleModules(who(viewer.userId)));
      expect(modules.modules.find((m) => m.module === 'monitoring')).toEqual({ module: 'monitoring', level: 'operate' });
      expect(modules.modules.map((m) => m.module)).not.toContain('audit');

      const access = (await app.inject({ method: 'GET', url: '/api/me/access', headers: viewer.headers })).json() as MeAccess;
      expect(access.roles.map((r) => r.system)).toEqual(['viewer']);
      expect(access.owner).toBe(false);
      expect(access.noAccess).toBe(false);
      expect(access.modules.audit).toBe('none');
      expect(access.resources.server.all).toBe(true);
      expect(access.resources.server.count).toBeGreaterThan(0);

      const nobody = memberWith(builtin('none'));
      const empty = (await app.inject({ method: 'GET', url: '/api/me/access', headers: nobody.headers })).json() as MeAccess;
      expect(empty).toMatchObject({ noAccess: true, visible: [], owner: false });
      expect(empty.roles.map((r) => r.name)).toEqual(['No access']);
      expect((await app.inject({ method: 'GET', url: '/api/me/modules', headers: nobody.headers })).json()).toEqual({ modules: [] });
    });

    it('treats a member with only No access as a viewer at the gates not yet on modules', () => {
      const nobody = memberWith(builtin('none'));
      expect(resolveAccess(who(nobody.userId)).role).toBe('viewer');
    });
  });

  describe('delegation guard', () => {
    const tagged: Record<string, string> = {};
    // The guard reads grants, never the cluster itself
    const k1 = 'dg-cluster';

    beforeAll(() => {
      tagged.web = seedServer(orgId, admin.userId, 'dg-web', ['web']);
      tagged.db = seedServer(orgId, admin.userId, 'dg-db', ['db']);
      tagged.both = seedServer(orgId, admin.userId, 'dg-both', ['web', 'db']);
    });

    it('lets owners give anything, and admins anything but the Owner role', () => {
      const everything = {
        modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, 'manage'])) as Record<ModuleKey, ModuleLevel>,
        grants: RESOURCE_TYPES.map((resourceType) => ({ resourceType, selector: 'all' as const, level: 'manage' as const })),
      };
      expect(canGrant(who(owner.userId), everything)).toEqual({ ok: true, missing: [] });
      expect(canGrant(who(admin.userId), everything).ok).toBe(true);
      expect(canAssignRole(who(admin.userId), builtin('admin')).ok).toBe(true);
      expect(canAssignRole(who(admin.userId), builtin('owner'))).toEqual({ ok: false, missing: ['the Owner role'] });
      expect(canAssignRole(who(owner.userId), builtin('owner')).ok).toBe(true);
      expect(canAssignRole(who(admin.userId), 'no-such-role').ok).toBe(false);
    });

    it('allows only modules held at the same or a higher level', () => {
      const lead = memberWith(role({ team_members: 'operate', team_roles: 'view', audit: 'view' }));
      const ask = (modules: ModulePermissions) => canGrant(who(lead.userId), { modules });
      expect(ask({ team_members: 'operate', audit: 'view' }).ok).toBe(true);
      expect(ask({ team_members: 'view', settings: 'none' }).ok).toBe(true);
      expect(ask({ team_roles: 'manage' })).toEqual({ ok: false, missing: ['Roles & access: manage'] });
      expect(ask({ audit: 'operate', settings: 'manage' }).missing).toEqual(['Audit Log: operate', 'Organization settings: manage']);
      // A level above what the module uses is the module's highest
      expect(ask({ team_members: 'manage' }).ok).toBe(true);
    });

    it('allows a resource selector only within what the actor reaches: id ⊆ tag ⊆ all', () => {
      const r = role({ servers: 'view' });
      grant({ role: r }, { resourceType: 'server', tag: 'web', level: 'manage' });
      const lead = memberWith(r);
      const ok = (g: Parameters<typeof canGrant>[1]['grants']) => canGrant(who(lead.userId), { grants: g }).ok;
      expect(ok([{ resourceType: 'server', selector: 'tag', tag: 'web', level: 'manage' }])).toBe(true);
      expect(ok([{ resourceType: 'server', selector: 'tag', tag: 'web', level: 'operate' }])).toBe(true);
      expect(ok([{ resourceType: 'server', selector: 'id', resourceId: tagged.web, level: 'manage' }])).toBe(true);
      expect(ok([{ resourceType: 'server', selector: 'id', resourceId: tagged.both, level: 'operate' }])).toBe(true);
      expect(ok([{ resourceType: 'server', selector: 'id', resourceId: tagged.db, level: 'view' }])).toBe(false);
      expect(ok([{ resourceType: 'server', selector: 'tag', tag: 'db', level: 'view' }])).toBe(false);
      expect(ok([{ resourceType: 'server', selector: 'all', level: 'view' }])).toBe(false);
      expect(ok([{ resourceType: 'cluster', selector: 'all', level: 'view' }])).toBe(false);

      const one = role({ servers: 'view' });
      grant({ role: one }, { resourceType: 'server', resourceId: tagged.db, level: 'operate' });
      const holder = memberWith(one);
      const can = (level: 'view' | 'operate' | 'manage') =>
        canGrant(who(holder.userId), { grants: [{ resourceType: 'server', selector: 'id', resourceId: tagged.db, level }] }).ok;
      expect([can('view'), can('operate'), can('manage')]).toEqual([true, true, false]);
      // An id grant never covers a tag, even one only that server carries
      expect(canGrant(who(holder.userId), { grants: [{ resourceType: 'server', selector: 'tag', tag: 'db', level: 'view' }] }).ok).toBe(false);
    });

    it('allows cluster namespaces only within those the actor holds, across roles', () => {
      const shop = role({ kubernetes: 'view' });
      const a = role({ kubernetes: 'view' });
      grant({ role: shop }, { resourceType: 'cluster', resourceId: k1, namespaces: ['shop'], level: 'manage' });
      grant({ role: a }, { resourceType: 'cluster', resourceId: k1, namespaces: ['a'], level: 'operate' });
      const lead = memberWith(shop, a);
      const ok = (namespaces: string[] | null, level: 'view' | 'operate' | 'manage') =>
        canGrant(who(lead.userId), { grants: [{ resourceType: 'cluster', selector: 'id', resourceId: k1, namespaces, level }] }).ok;
      expect(ok(['shop'], 'manage')).toBe(true);
      expect(ok(['shop', 'a'], 'operate')).toBe(true);
      expect(ok(['shop', 'a'], 'manage')).toBe(false);
      expect(ok(['shop', 'b'], 'view')).toBe(false);
      expect(ok(null, 'view')).toBe(false);
      expect(ok([], 'view')).toBe(false);
    });

    it('caps a read-only actor at view and refuses members who are not active', () => {
      const ro = { orgId, user: { id: admin.userId, email: '', displayName: '' }, apiTokenReadOnly: true };
      expect(canGrant(ro, { modules: { audit: 'view' }, grants: [{ resourceType: 'server', selector: 'all', level: 'view' }] }).ok).toBe(true);
      expect(canGrant(ro, { modules: { audit: 'operate' } }).ok).toBe(false);
      expect(canGrant(ro, { grants: [{ resourceType: 'server', selector: 'all', level: 'operate' }] }).ok).toBe(false);
      expect(canGrant({ orgId, userId: 'nobody' }, {})).toEqual({ ok: false, missing: ['an active membership'] });
    });

    it('never lets a role or grant held for a while be given for longer, to anyone or to oneself', () => {
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      const later = new Date(Date.now() + 7_200_000).toISOString();
      const lead = role({ team_roles: 'manage', servers: 'view' });
      grant({ role: lead }, { resourceType: 'server', tag: 'web', level: 'manage' });
      const temp = seedUser(orgId, 'viewer');
      getDb().delete(roleMembers).where(eq(roleMembers.userId, temp.userId)).run();
      getDb().insert(roleMembers).values({ roleId: lead, userId: temp.userId, orgId, expiresAt: soon }).run();
      const actor = who(temp.userId);
      const tagWeb = { resourceType: 'server' as const, selector: 'tag' as const, tag: 'web', level: 'manage' as const };

      // Permanent (or longer than they hold it): refused, and says what is missing
      expect(canGrant(actor, { modules: { team_roles: 'manage' } })).toEqual({ ok: false, missing: ['Roles & access: manage'] });
      expect(canGrant(actor, { grants: [tagWeb] }).ok).toBe(false);
      expect(canGrant(actor, { grants: [tagWeb] }, { expiresAt: later }).ok).toBe(false);
      expect(canAssignRole(actor, lead).ok).toBe(false);
      expect(canAssignRole(actor, lead, { expiresAt: later }).ok).toBe(false);
      // Until they lose it themselves, or sooner: fine
      expect(canGrant(actor, { modules: { team_roles: 'manage' }, grants: [tagWeb] }, { expiresAt: soon }).ok).toBe(true);
      expect(canAssignRole(actor, lead, { expiresAt: soon }).ok).toBe(true);

      // A personal grant held for a while counts the same way
      const permanent = memberWith(role({ servers: 'view' }));
      grant({ user: permanent.userId }, { resourceType: 'server', resourceId: tagged.db, level: 'operate', expiresAt: soon });
      const db = { resourceType: 'server' as const, selector: 'id' as const, resourceId: tagged.db, level: 'operate' as const };
      expect(canGrant(who(permanent.userId), { grants: [db] }).ok).toBe(false);
      expect(canGrant(who(permanent.userId), { grants: [db] }, { expiresAt: soon }).ok).toBe(true);

      // An owner whose Owner role ends is no owner for longer than that
      const tempOwner = memberWith();
      getDb().insert(roleMembers).values({ roleId: builtin('owner'), userId: tempOwner.userId, orgId, expiresAt: soon }).run();
      expect(canGrant(who(tempOwner.userId), { modules: { settings: 'manage' } }).ok).toBe(false);
      expect(canGrant(who(tempOwner.userId), { modules: { settings: 'manage' } }, { expiresAt: soon }).ok).toBe(true);
      expect(canAssignRole(who(tempOwner.userId), builtin('owner')).ok).toBe(false);
      expect(canAssignRole(who(tempOwner.userId), builtin('owner'), { expiresAt: soon }).ok).toBe(true);
      expect(canAssignRole(who(owner.userId), builtin('owner'), { expiresAt: later }).ok).toBe(true);
    });

    it('lets an operator assign Viewer but not Operator-plus-more or Admin', () => {
      const operator = seedUser(orgId, 'operator');
      expect(canAssignRole(who(operator.userId), builtin('viewer')).ok).toBe(true);
      expect(canAssignRole(who(operator.userId), builtin('operator')).ok).toBe(true);
      expect(canAssignRole(who(operator.userId), builtin('none')).ok).toBe(true);
      const result = canAssignRole(who(operator.userId), builtin('admin'));
      expect(result.ok).toBe(false);
      expect(result.missing).toContain('Organization settings: manage');
      expect(result.missing).toContain('all servers: manage');
    });
  });
});
