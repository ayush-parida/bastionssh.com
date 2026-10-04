import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Escalation attempts against Team & Access (unified roles spec §4.2, §4.3,
 * §7), by members who hold only part of it: Members at `operate` alone, a
 * lead with Roles & access at `manage` over a subset of servers, and a role
 * managing servers by tag. Each tries to assign, edit or clone roles, invite
 * with roles, approve requests, edit built-ins, reach SSO or the default
 * role, or switch parked grants back on — anything that would give more
 * than they hold themselves.
 */
const spies = vi.hoisted(() => ({
  terminals: vi.fn(() => 0),
  sftp: vi.fn(() => 0),
  agents: vi.fn(() => 0),
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

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { ModuleLevel } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { roleMembers } from '../../db/schema.js';
import { levelFor, moduleLevel } from '../../auth/access/index.js';
import { seedOrg, seedServer, seedSession, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

describe('Team & Access escalation attempts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: Who;
  let web1: string;
  let db1: string;
  /** Members at `operate`, nothing else. */
  let inviter: Who;
  /** Roles & access at `manage`, Servers at `view`, servers tagged frontend at `operate`; no AI Assistant. */
  let lead: Who;
  let leadRole: string;
  /** Servers at `manage` and Roles & access at `manage`, servers tagged frontend at `manage`. */
  let tagManager: Who;

  let calls = 0;
  const remoteAddress = () => `10.82.${(++calls >> 8) & 255}.${calls & 255}`;
  const as = (who: Who) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: who.headers, remoteAddress: remoteAddress() }),
    post: (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, headers: who.headers, payload: payload ?? {}, remoteAddress: remoteAddress() }),
    put: (url: string, payload: object) => app.inject({ method: 'PUT', url, headers: who.headers, payload, remoteAddress: remoteAddress() }),
    patch: (url: string, payload: object) =>
      app.inject({ method: 'PATCH', url, headers: who.headers, payload, remoteAddress: remoteAddress() }),
    delete: (url: string) => app.inject({ method: 'DELETE', url, headers: who.headers, remoteAddress: remoteAddress() }),
  });

  const level = (userId: string, serverId: string) => levelFor({ orgId, userId }, 'server', serverId)?.level ?? null;
  const builtIn = (system: string) => `builtin:${orgId}:${system}`;
  const heldRoleIds = (userId: string) =>
    getDb()
      .select({ roleId: roleMembers.roleId })
      .from(roleMembers)
      .where(and(eq(roleMembers.orgId, orgId), eq(roleMembers.userId, userId)))
      .all()
      .map((r) => r.roleId)
      .sort();

  async function role(name: string, modules: Record<string, ModuleLevel>, grants: object[] = []) {
    const res = await as(owner).post('/api/team/roles', { name: `${name} ${nanoid(4)}`, modules, grants });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; name: string };
  }

  async function memberWith(roleIds: string[]): Promise<Who> {
    const member = seedUser(orgId, 'viewer');
    const res = await as(owner).put(`/api/team/members/${member.userId}/roles`, { roles: roleIds.map((roleId) => ({ roleId })) });
    expect(res.statusCode, res.body).toBe(200);
    return member;
  }

  /** A No access member with "All servers: manage" given personally — parked, since no role has Servers on. */
  async function parkedAllServers(roleIds = [builtIn('none')]): Promise<Who> {
    const member = await memberWith(roleIds);
    const res = await as(owner).put(`/api/team/members/${member.userId}/grants`, {
      grants: [{ resourceType: 'server', selector: 'all', level: 'manage' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(level(member.userId, db1)).toBeNull();
    return member;
  }

  const allServersView = { resourceType: 'server', selector: 'all', level: 'view' };
  const frontend = (lvl: string) => ({ resourceType: 'server', selector: 'tag', tag: 'frontend', level: lvl });

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-unified-escalation');
    owner = seedUser(orgId, 'owner');
    web1 = seedServer(orgId, owner.userId, 'web-1', ['frontend']);
    db1 = seedServer(orgId, owner.userId, 'db-1', ['backend']);
    app = await buildApp();
    await app.ready();

    inviter = await memberWith([(await role('Inviters', { team_members: 'operate' })).id]);
    leadRole = (await role('Leads', { team_roles: 'manage', servers: 'view' }, [frontend('operate')])).id;
    lead = await memberWith([leadRole]);
    tagManager = await memberWith([(await role('Frontend admins', { team_roles: 'manage', servers: 'manage' }, [frontend('manage')])).id]);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Members at operate, nothing else ─────────────────────────────────────────

  it('lets Members-only invite with nothing above their own roles', async () => {
    for (const roleIds of [[builtIn('viewer')], [builtIn('admin')], [builtIn('owner')], [leadRole]]) {
      const res = await as(inviter).post('/api/team/invites', { email: `x-${nanoid(6)}@example.com`, roleIds });
      expect(res.statusCode, `${roleIds} ${res.body}`).toBe(403);
    }
    for (const role of ['viewer', 'operator', 'admin', 'owner']) {
      expect((await as(inviter).post('/api/team/invites', { email: `y-${nanoid(6)}@example.com`, role })).statusCode).toBe(403);
    }
  });

  it('keeps Members-only out of roles, grants, approvals, SSO and the default role', async () => {
    const target = await memberWith([builtIn('none')]);
    const attempts = [
      as(inviter).post('/api/team/roles', { name: 'Mine', modules: { team_members: 'operate' } }),
      as(inviter).put(`/api/team/members/${target.userId}/roles`, { roles: [{ roleId: builtIn('viewer') }] }),
      as(inviter).post(`/api/team/roles/${leadRole}/members`, { userId: target.userId }),
      as(inviter).put(`/api/team/members/${target.userId}/grants`, { grants: [allServersView] }),
      as(inviter).patch(`/api/team/members/${target.userId}`, { role: 'operator' }),
      as(inviter).post(`/api/team/roles/${builtIn('viewer')}/clone`, {}),
      as(inviter).patch(`/api/team/roles/${builtIn('viewer')}`, { modules: { team_members: 'operate' } }),
      as(inviter).post('/api/access-requests/nope/approve', {}),
      as(inviter).put('/api/team/default-role', { roleId: builtIn('admin') }),
      as(inviter).get('/api/sso'),
      as(inviter).put('/api/sso', { defaultRole: 'admin' }),
    ];
    for (const [i, res] of (await Promise.all(attempts)).entries()) expect(res.statusCode, `attempt ${i}: ${res.body}`).toBe(404);
    expect(heldRoleIds(target.userId)).toEqual([builtIn('none')]);
  });

  it('refuses Members-only to lock out a member holding more than they do', async () => {
    const viewer = await memberWith([builtIn('viewer')]);
    expect((await as(inviter).post(`/api/team/members/${viewer.userId}/suspend`)).statusCode).toBe(403);
    expect((await as(inviter).delete(`/api/team/members/${viewer.userId}`)).statusCode).toBe(403);
    expect((await as(inviter).delete(`/api/team/members/${viewer.userId}/sessions`)).statusCode).toBe(403);
  });

  it('counts parked personal grants when weighing who may take over an account', async () => {
    const session = await seedSession(inviter.userId);
    const browser: Who = { userId: inviter.userId, headers: session.headers };
    // Nothing held, nothing parked: strictly below the inviter, so a reset is theirs to issue
    const empty = await memberWith([builtIn('none')]);
    expect((await as(browser).post(`/api/team/members/${empty.userId}/password-reset`)).statusCode).toBe(201);
    // "All servers: manage" parked: whoever holds the account gets it back with any role
    const parked = await parkedAllServers();
    const res = await as(browser).post(`/api/team/members/${parked.userId}/password-reset`);
    expect(res.statusCode, res.body).toBe(403);
    expect((await as(inviter).post(`/api/team/members/${parked.userId}/suspend`)).statusCode).toBe(403);
  });

  it('marks on the member list what the caller may do to each member', async () => {
    const viewer = await memberWith([builtIn('viewer')]);
    const empty = await memberWith([builtIn('none')]);
    const list = (await as(inviter).get('/api/team/members')).json() as { userId: string; actions?: { lockOut: boolean; reset: boolean } }[];
    expect(list.find((m) => m.userId === viewer.userId)?.actions).toEqual({ lockOut: false, reset: false });
    expect(list.find((m) => m.userId === empty.userId)?.actions).toEqual({ lockOut: true, reset: true });
    expect(list.find((m) => m.userId === inviter.userId)?.actions).toBeUndefined();
    // Roles & access alone does not act on members
    expect(((await as(lead).get('/api/team/members')).json() as { actions?: unknown }[]).every((m) => m.actions === undefined)).toBe(true);
  });

  // ── A lead managing roles over a subset ──────────────────────────────────────

  it('lets a lead make roles only within their own access', async () => {
    const tries: [object[], Record<string, ModuleLevel>, number][] = [
      [[allServersView], { servers: 'view' }, 403],
      [[{ resourceType: 'server', selector: 'tag', tag: 'backend', level: 'view' }], { servers: 'view' }, 403],
      [[frontend('manage')], { servers: 'view' }, 403],
      [[{ resourceType: 'server', selector: 'id', resourceId: db1, level: 'view' }], { servers: 'view' }, 403],
      [[frontend('operate')], { servers: 'manage' }, 403],
      [[frontend('operate')], { servers: 'view', audit: 'view' }, 403],
      [[frontend('operate')], { servers: 'view', team_members: 'operate' }, 403],
      [[frontend('operate')], { servers: 'view' }, 201],
    ];
    for (const [grants, modules, status] of tries) {
      const res = await as(lead).post('/api/team/roles', { name: `Lead made ${nanoid(4)}`, modules, grants });
      expect(res.statusCode, `${JSON.stringify([grants, modules])} ${res.body}`).toBe(status);
    }
  });

  it('refuses a lead cloning or editing roles above them, built-ins included', async () => {
    for (const system of ['owner', 'admin', 'operator', 'viewer']) {
      expect((await as(lead).post(`/api/team/roles/${builtIn(system)}/clone`, {})).statusCode, system).toBe(403);
    }
    const viewer = builtIn('viewer');
    const viewerModules = (await as(owner).get(`/api/team/roles/${viewer}`)).json().modules as Record<string, ModuleLevel>;
    // Giving Viewer more, or taking from it what the lead does not hold
    expect((await as(lead).patch(`/api/team/roles/${viewer}`, { modules: { ...viewerModules, audit: 'view' } })).statusCode).toBe(403);
    expect((await as(lead).patch(`/api/team/roles/${viewer}`, { modules: { ...viewerModules, kubernetes: 'none' } })).statusCode).toBe(403);
    expect((await as(lead).put(`/api/team/roles/${viewer}/grants`, { grants: [] })).statusCode).toBe(403);
    expect((await as(lead).patch(`/api/team/roles/${builtIn('owner')}`, { description: 'mine' })).statusCode).toBe(400);
    expect((await as(lead).put(`/api/team/roles/${builtIn('none')}/grants`, { grants: [allServersView] })).statusCode).toBe(400);
    // Their own role: nothing to raise it with, and never onto themselves
    expect((await as(lead).put(`/api/team/roles/${leadRole}/grants`, { grants: [frontend('manage')] })).statusCode).toBe(403);
    expect((await as(lead).post(`/api/team/roles/${leadRole}/members`, { userId: lead.userId })).statusCode).toBe(400);
    expect((await as(lead).put(`/api/team/members/${lead.userId}/roles`, { roles: [{ roleId: builtIn('admin') }] })).statusCode).toBe(400);
  });

  it('refuses a lead assigning a role, base role or old access list beyond their own', async () => {
    const target = await memberWith([builtIn('none')]);
    expect((await as(lead).put(`/api/team/members/${target.userId}/roles`, { roles: [{ roleId: builtIn('viewer') }] })).statusCode).toBe(403);
    expect((await as(lead).post(`/api/team/roles/${builtIn('operator')}/members`, { userId: target.userId })).statusCode).toBe(403);
    expect((await as(lead).patch(`/api/team/members/${target.userId}`, { role: 'admin' })).statusCode).toBe(403);
    expect((await as(lead).patch(`/api/team/members/${target.userId}`, { role: 'viewer' })).statusCode).toBe(403);
    expect((await as(lead).put(`/api/team/members/${target.userId}/grants`, { grants: [{ resourceType: 'server', selector: 'id', resourceId: db1, level: 'view' }] })).statusCode).toBe(403);
    expect((await as(lead).put(`/api/team/members/${target.userId}/access`, { serverAccess: 'restricted', serverIds: [db1] })).statusCode).toBe(403);
    expect(heldRoleIds(target.userId)).toEqual([builtIn('none')]);
    expect(level(target.userId, db1)).toBeNull();
  });

  it('refuses giving a role that switches a member’s parked personal grants back on', async () => {
    const frontendViewers = await role('Frontend viewers', { servers: 'view' }, [frontend('view')]);
    // A custom role with nothing on, so no built-in is taken away (which needs more on its own)
    const parked = await parkedAllServers([(await role('Quiet', {})).id]);
    // The lead holds everything this role gives, but not the "All servers: manage" it would wake
    const res = await as(lead).post(`/api/team/roles/${frontendViewers.id}/members`, { userId: parked.userId });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().missing).toContain('all servers: manage');
    expect(level(parked.userId, db1)).toBeNull();
    // The owner holds it: allowed, and the grant counts again
    expect((await as(owner).post(`/api/team/roles/${frontendViewers.id}/members`, { userId: parked.userId })).statusCode).toBe(201);
    expect(level(parked.userId, db1)).toBe('manage');
  });

  it('refuses turning a module on in a role whose members have personal grants parked there', async () => {
    const quiet = await role('Quiet', {});
    const parked = await parkedAllServers();
    expect((await as(owner).put(`/api/team/members/${parked.userId}/roles`, { roles: [{ roleId: quiet.id }] })).statusCode).toBe(200);
    const res = await as(lead).patch(`/api/team/roles/${quiet.id}`, { modules: { servers: 'view' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(level(parked.userId, db1)).toBeNull();
    // Turning it off again (parking them) is the same change the other way
    expect((await as(owner).patch(`/api/team/roles/${quiet.id}`, { modules: { servers: 'view' } })).statusCode).toBe(200);
    expect(level(parked.userId, db1)).toBe('manage');
    expect((await as(lead).patch(`/api/team/roles/${quiet.id}`, { modules: {} })).statusCode).toBe(403);
    expect((await as(lead).delete(`/api/team/roles/${quiet.id}`)).statusCode).toBe(403);
  });

  it('refuses a personal operate grant that would open the AI Assistant the actor lacks', async () => {
    const frontendViewers = await role('Frontend viewers', { servers: 'view' }, [frontend('view')]);
    const member = await memberWith([frontendViewers.id]);
    expect(moduleLevel({ orgId, userId: member.userId }, 'ai')).toBe('none');
    const operate = { resourceType: 'server', selector: 'id', resourceId: web1, level: 'operate' };
    const res = await as(lead).put(`/api/team/members/${member.userId}/grants`, { grants: [operate] });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().missing).toContain('AI Assistant: view');
    expect(moduleLevel({ orgId, userId: member.userId }, 'ai')).toBe('none');
    // A view grant opens nothing
    expect((await as(lead).put(`/api/team/members/${member.userId}/grants`, { grants: [{ ...operate, level: 'view' }] })).statusCode).toBe(200);
    // A lead who has the assistant may
    const assisted = await memberWith([leadRole, (await role('Assistant', { ai: 'view' })).id]);
    expect((await as(assisted).put(`/api/team/members/${member.userId}/grants`, { grants: [operate] })).statusCode).toBe(200);
    expect(moduleLevel({ orgId, userId: member.userId }, 'ai')).toBe('view');
  });

  it('refuses a lead approving requests beyond their own access', async () => {
    const frontendViewers = await role('Frontend viewers', { servers: 'view' }, [frontend('view')]);
    const requester = await memberWith([frontendViewers.id]);
    const ask = async (payload: object) => {
      const res = await as(requester).post('/api/access-requests', { reason: 'on call', durationMinutes: 60, ...payload });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const everything = await role('Everything view', { servers: 'view' }, [allServersView]);
    const refused = [
      await ask({ resourceType: 'server', resourceIds: [web1], level: 'manage' }),
      // Operate on a server opens the AI Assistant, which the lead lacks
      await ask({ resourceType: 'server', resourceIds: [web1], level: 'operate' }),
      await ask({ roleId: everything.id }),
    ];
    for (const id of refused) {
      const res = await as(lead).post(`/api/access-requests/${id}/approve`, {});
      expect(res.statusCode, res.body).toBe(403);
    }
    expect(level(requester.userId, db1)).toBeNull();
    expect(level(requester.userId, web1)).toBe('view');
  });

  it('refuses approving a role request that wakes the requester’s parked personal grants', async () => {
    const frontendViewers = await role('Frontend viewers', { servers: 'view' }, [frontend('view')]);
    const parked = await parkedAllServers();
    const asked = await as(parked).post('/api/access-requests', { roleId: frontendViewers.id, reason: 'on call', durationMinutes: 60 });
    expect(asked.statusCode, asked.body).toBe(201);
    const res = await as(lead).post(`/api/access-requests/${asked.json().id}/approve`, {});
    expect(res.statusCode, res.body).toBe(403);
    expect(level(parked.userId, db1)).toBeNull();
  });

  // ── A role managing servers by tag ───────────────────────────────────────────

  it('keeps a tag-scoped server manager within the tag', async () => {
    const bad = [
      [allServersView],
      [{ resourceType: 'server', selector: 'tag', tag: 'backend', level: 'view' }],
      [{ resourceType: 'server', selector: 'id', resourceId: db1, level: 'view' }],
      [{ resourceType: 'cluster', selector: 'all', level: 'view' }],
    ];
    for (const grants of bad) {
      const res = await as(tagManager).post('/api/team/roles', { name: `Tagged ${nanoid(4)}`, modules: { servers: 'view' }, grants });
      expect(res.statusCode, `${JSON.stringify(grants)} ${res.body}`).toBe(403);
    }
    const made = await as(tagManager).post('/api/team/roles', {
      name: `Tagged ${nanoid(4)}`,
      modules: { servers: 'manage' },
      grants: [frontend('manage'), { resourceType: 'server', selector: 'id', resourceId: web1, level: 'manage' }],
    });
    expect(made.statusCode, made.body).toBe(201);
    // Re-tagging a server out of reach to bring it in: it is not there for them
    expect((await as(tagManager).patch(`/api/servers/${db1}`, { tags: ['backend', 'frontend'] })).statusCode).toBe(404);
    expect(level(tagManager.userId, db1)).toBeNull();
    // Nor through the SSO default role or a mapping
    expect((await as(tagManager).put('/api/sso', { defaultRole: 'viewer', defaultRoleId: made.json().id })).statusCode).toBe(404);
    expect((await as(tagManager).put('/api/team/default-role', { roleId: made.json().id })).statusCode).toBe(404);
  });
});
