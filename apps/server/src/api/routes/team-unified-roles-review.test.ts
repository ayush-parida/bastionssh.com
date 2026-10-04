import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Regression tests from the authorization review of the org-modules sweep
 * (unified roles spec §4.2, §7): ways a member who may manage some of Team &
 * Access could give more than they hold, or take from peers, through the
 * compatible endpoints, the stored base role, invites and the default role.
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
import { BUILT_IN_ROLE_DEFAULTS, MODULES_ONLY_DEFAULTS, type ModuleLevel } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { invites, memberships, roleMembers } from '../../db/schema.js';
import { levelFor, moduleLevel } from '../../auth/access/index.js';
import { roleIdForBaseRole } from '../../auth/access/members.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

describe('Team & Access review regressions', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: Who;
  let web1: string;
  let db1: string;

  let calls = 0;
  const remoteAddress = () => `10.81.${(++calls >> 8) & 255}.${calls & 255}`;
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

  async function accept(inviteId: string, email: string) {
    const token = getDb().select().from(invites).where(eq(invites.id, inviteId)).get()!.token;
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      payload: { email, displayName: 'Invitee', password: 'correct horse battery' },
      remoteAddress: remoteAddress(),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    return accepted.json().user.id as string;
  }

  /** Operator's org features without its resources: what makes the stored base role read "operator". */
  const OPERATOR_FEATURES = Object.fromEntries(
    Object.entries(BUILT_IN_ROLE_DEFAULTS.operator.modules).filter(
      ([key]) => !['servers', 'containers', 'kubernetes', 'ftp', 'storage', 'cloud', 'saved_commands', 'cron_jobs'].includes(key),
    ),
  ) as Record<string, ModuleLevel>;

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-unified-review');
    owner = seedUser(orgId, 'owner');
    web1 = seedServer(orgId, owner.userId, 'web-1', ['frontend']);
    db1 = seedServer(orgId, owner.userId, 'db-1', ['backend']);
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives an invite with an empty role list No access, not the default role', async () => {
    // An inviter holding nothing but Members: they could not give Viewer
    const inviters = await role('Bare inviters', { team_members: 'operate' });
    const inviter = await memberWith([inviters.id]);
    expect((await as(inviter).post('/api/team/invites', { email: 'nothing@example.com' })).statusCode).toBe(403);
    const res = await as(inviter).post('/api/team/invites', { email: 'empty@example.com', roleIds: [] });
    expect(res.statusCode, res.body).toBe(201);
    const userId = await accept(res.json().id, 'empty@example.com');
    expect(heldRoleIds(userId)).toEqual([builtIn('none')]);
    expect(moduleLevel({ orgId, userId }, 'servers')).toBe('none');
  });

  it('gives No access, not the default role, when every role an invite named is gone', async () => {
    const gone = await role('Gone soon', { audit: 'view' });
    const res = await as(owner).post('/api/team/invites', { email: 'gone@example.com', roleIds: [gone.id] });
    expect(res.statusCode, res.body).toBe(201);
    expect((await as(owner).delete(`/api/team/roles/${gone.id}`)).statusCode).toBe(204);
    const userId = await accept(res.json().id, 'gone@example.com');
    expect(heldRoleIds(userId)).toEqual([builtIn('none')]);
  });

  it('checks the compatible server-access endpoint’s grants with the delegation guard', async () => {
    // A lead who manages roles and holds web-1 only
    const leads = await role('Web leads', { ...BUILT_IN_ROLE_DEFAULTS.viewer.modules, team_roles: 'manage' }, [
      { resourceType: 'server', selector: 'id', resourceId: web1, level: 'view' },
    ]);
    const lead = await memberWith([leads.id]);
    const target = await memberWith([`modules-only:${orgId}:viewer`]);
    expect(getDb().select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, target.userId))).get()!.scope).toBe('roles');

    const denied = await as(lead).put(`/api/team/members/${target.userId}/access`, { serverAccess: 'restricted', serverIds: [db1] });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(level(target.userId, db1)).toBeNull();

    const allowed = await as(lead).put(`/api/team/members/${target.userId}/access`, { serverAccess: 'restricted', serverIds: [web1] });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(level(target.userId, web1)).toBe('view');

    // Nor can it take away what the lead does not hold
    const grantedByOwner = await as(owner).put(`/api/team/members/${target.userId}/access`, { serverAccess: 'restricted', serverIds: [web1, db1] });
    expect(grantedByOwner.statusCode, grantedByOwner.body).toBe(200);
    expect((await as(lead).put(`/api/team/members/${target.userId}/access`, { serverAccess: 'restricted', serverIds: [web1] })).statusCode).toBe(403);
    expect(level(target.userId, db1)).toBe('view');
  });

  it('never raises a member’s mirrored server grants by giving them a custom role', async () => {
    const target = await memberWith([`modules-only:${orgId}:viewer`]);
    expect((await as(owner).put(`/api/team/members/${target.userId}/access`, { serverAccess: 'restricted', serverIds: [db1] })).statusCode).toBe(200);
    expect(level(target.userId, db1)).toBe('view');

    // A lead holding Operator's org features (no server at all) gives them to the target
    const features = await role('Operator features', OPERATOR_FEATURES);
    const leads = await role('Feature leads', { ...OPERATOR_FEATURES, team_roles: 'manage' });
    const lead = await memberWith([leads.id]);
    const res = await as(lead).post(`/api/team/roles/${features.id}/members`, { userId: target.userId });
    expect(res.statusCode, res.body).toBe(201);
    // Still view: the grant follows the member's built-in role, never a custom one
    expect(level(target.userId, db1)).toBe('view');
    const row = getDb().select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, target.userId))).get()!;
    expect(row.role).toBe('viewer');
  });

  it('weighs the mirrored grants a change of built-in role raises with the delegation guard', async () => {
    const target = await memberWith([`modules-only:${orgId}:viewer`]);
    expect((await as(owner).put(`/api/team/members/${target.userId}/access`, { serverAccess: 'restricted', serverIds: [db1] })).statusCode).toBe(200);
    roleIdForBaseRole(orgId, 'operator', 'roles');
    // A lead holding Operator (modules only) and web-1, not db-1
    const leads = await role('Operator leads', { ...MODULES_ONLY_DEFAULTS.operator.modules, team_roles: 'manage' }, [
      { resourceType: 'server', selector: 'id', resourceId: web1, level: 'operate' },
    ]);
    const lead = await memberWith([leads.id]);
    const res = await as(lead).post(`/api/team/roles/modules-only:${orgId}:operator/members`, { userId: target.userId });
    expect(res.statusCode, res.body).toBe(403);
    expect(level(target.userId, db1)).toBe('view');
    // Someone holding db-1 at operate may
    const ok = await as(owner).post(`/api/team/roles/modules-only:${orgId}:operator/members`, { userId: target.userId });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(level(target.userId, db1)).toBe('operate');
  });

  it('keeps an admin from taking access from fellow admins by editing the Admin role', async () => {
    const admin = seedUser(orgId, 'admin');
    const peer = seedUser(orgId, 'admin');
    const { team_roles: _dropped, ...rest } = BUILT_IN_ROLE_DEFAULTS.admin.modules;
    const edit = await as(admin).patch(`/api/team/roles/${builtIn('admin')}`, { modules: rest });
    expect(edit.statusCode, edit.body).toBe(403);
    expect(moduleLevel({ orgId, userId: peer.userId }, 'team_roles')).toBe('manage');
    expect((await as(admin).put(`/api/team/roles/${builtIn('admin')}/grants`, { grants: [] })).statusCode).toBe(403);
    expect(level(peer.userId, db1)).toBe('manage');

    // Adding to it takes nothing away, and roles held by members below them stay editable
    const { kubernetes: _k, ...viewerRest } = BUILT_IN_ROLE_DEFAULTS.viewer.modules;
    seedUser(orgId, 'viewer');
    const viewerEdit = await as(admin).patch(`/api/team/roles/${builtIn('viewer')}`, { modules: viewerRest });
    expect(viewerEdit.statusCode, viewerEdit.body).toBe(200);
    expect((await as(admin).post(`/api/team/roles/${builtIn('viewer')}/reset`)).statusCode).toBe(200);
    // Owners may
    const ownerEdit = await as(owner).patch(`/api/team/roles/${builtIn('admin')}`, { modules: rest });
    expect(ownerEdit.statusCode, ownerEdit.body).toBe(200);
    expect(moduleLevel({ orgId, userId: peer.userId }, 'team_roles')).toBe('none');
    expect((await as(owner).post(`/api/team/roles/${builtIn('admin')}/reset`)).statusCode).toBe(200);
  });

  it('keeps the default role from being deleted out from under the org', async () => {
    const guests = await role('Guests', { dashboard: 'view' });
    expect((await as(owner).put('/api/team/default-role', { roleId: guests.id })).statusCode).toBe(200);
    try {
      const res = await as(owner).delete(`/api/team/roles/${guests.id}`);
      expect(res.statusCode, res.body).toBe(409);
    } finally {
      await as(owner).put('/api/team/default-role', { roleId: builtIn('viewer') });
    }
    expect((await as(owner).delete(`/api/team/roles/${guests.id}`)).statusCode).toBe(204);
  });
});
