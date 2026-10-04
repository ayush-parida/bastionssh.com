import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * The access engine (custom roles spec §4): level resolution from the base
 * role, custom roles and personal grants; scope; expiry; tag and namespace
 * selectors; 404 vs 403; SQL and in-memory filters agreeing; explain; the
 * revoke diff; and the Docker/Kubernetes matrices read per resource. The
 * live-access closer is a spy; its own behaviour is in live-revocation.test.ts.
 */
const spies = vi.hoisted(() => ({
  revoke: vi.fn((_userId: string, _scope?: unknown) => ({ terminals: 1, sftp: 0, docker: 0, kube: 0, agents: 0 })),
}));
vi.mock('../revoke.js', () => ({ revokeLiveAccess: spies.revoke }));

import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { dockerPermissions, kubePermissions } from '@smt/shared';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import {
  auditLog,
  cronJobs,
  ftpConnections,
  kubeClusters,
  memberServerAccess,
  memberships,
  resourceGrants,
  roleMembers,
  roles,
  servers,
} from '../../db/schema.js';
import { seedOrg, seedServer, seedUser } from '../../api/routes/test-utils.js';
import { canAccessServer, serverScope } from '../server-access.js';
import { clusterNamespaces } from '../cluster-access.js';
import { sweepExpiredAccess } from '../access-grants.js';
import { permissionsFor } from '../../docker/permissions.js';
import { kubePermissionsFor } from '../../kube/permissions.js';
import { dockerSettings } from '../../docker/settings.js';
import { kubeSettings } from '../../kube/settings.js';
import { SSHBroker, type TerminalChannel } from '../../ssh/broker.js';
import {
  accessibleFilter,
  accessibleIds,
  authorize,
  baseLevel,
  explain,
  filterAccessible,
  levelFor,
  lostAccess,
  requiredLevel,
  requireResource,
  revokeAfterChange,
  roleForLevel,
  snapshotAccess,
} from './index.js';

const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

let orgId: string;
let admin: ReturnType<typeof seedUser>;

function role(name: string, members: { userId: string; expiresAt?: string | null }[] = []): string {
  const id = nanoid();
  getDb().insert(roles).values({ id, orgId, name, createdBy: admin.userId }).run();
  for (const m of members) {
    getDb().insert(roleMembers).values({ roleId: id, userId: m.userId, orgId, expiresAt: m.expiresAt ?? null }).run();
  }
  return id;
}

function grant(
  principal: { role: string } | { user: string },
  g: Partial<typeof resourceGrants.$inferInsert> & Pick<typeof resourceGrants.$inferInsert, 'resourceType' | 'level'>,
): string {
  const id = nanoid();
  getDb()
    .insert(resourceGrants)
    .values({
      id,
      orgId,
      principalType: 'role' in principal ? 'role' : 'user',
      principalId: 'role' in principal ? principal.role : principal.user,
      selector: g.resourceId ? 'id' : g.tag ? 'tag' : 'all',
      ...g,
    })
    .run();
  return id;
}

function restrict(userId: string) {
  getDb().update(memberships).set({ serverAccess: 'restricted' }).where(eq(memberships.userId, userId)).run();
}

function cluster(name: string): string {
  const id = nanoid();
  getDb()
    .insert(kubeClusters)
    .values({ id, orgId, name, apiUrl: 'https://10.0.0.5:6443', authType: 'token', encryptedCredential: 'x', credentialHint: 'h', createdBy: admin.userId })
    .run();
  return id;
}

const who = (userId: string) => ({ orgId, userId });

describe('access engine', () => {
  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-engine');
    admin = seedUser(orgId, 'admin');
  });

  beforeEach(() => {
    spies.revoke.mockClear();
  });

  describe('levels', () => {
    it('maps base roles, actions and Docker/Kubernetes roles', () => {
      expect(['viewer', 'operator', 'admin', 'owner', 'nonsense'].map(baseLevel)).toEqual(['view', 'operate', 'manage', 'manage', 'view']);
      expect(roleForLevel('view')).toBe('viewer');
      expect(roleForLevel('operate')).toBe('operator');
      expect(roleForLevel('manage')).toBe('admin');
      expect(requiredLevel('server', 'terminal')).toBe('operate');
      expect(requiredLevel('server', 'delete')).toBe('manage');
      expect(requiredLevel('cluster', 'view')).toBe('view');
      expect(requiredLevel('saved_command', 'run')).toBe('operate');
      // Unknown actions are never cheaper than manage
      expect(requiredLevel('server', 'nope' as 'view')).toBe('manage');
    });
  });

  describe('resolution', () => {
    it('raises an all-scope member on a role’s resources only', () => {
      const viewer = seedUser(orgId, 'viewer');
      const s1 = seedServer(orgId, admin.userId, 'r1');
      const s2 = seedServer(orgId, admin.userId, 'r2');
      const web = role('Raise team', [{ userId: viewer.userId }]);
      grant({ role: web }, { resourceType: 'server', resourceId: s1, level: 'operate' });

      expect(levelFor(who(viewer.userId), 'server', s1)?.level).toBe('operate');
      expect(levelFor(who(viewer.userId), 'server', s2)?.level).toBe('view');
      expect(serverScope(who(viewer.userId))).toEqual({ all: true });
    });

    it('denies a role-scoped member everything by default, of every type', () => {
      const member = seedUser(orgId, 'operator');
      restrict(member.userId);
      const s1 = seedServer(orgId, admin.userId, 'deny');
      const ftp = nanoid();
      getDb().insert(ftpConnections).values({ id: ftp, orgId, name: 'f', host: 'h', username: 'u', encryptedPassword: 'x', createdBy: admin.userId }).run();
      expect(canAccessServer(who(member.userId), s1)).toBe(false);
      expect(levelFor(who(member.userId), 'ftp_connection', ftp)).toBeNull();
      for (const type of ['server', 'cluster', 'ftp_connection', 'storage_connection', 'cloud_account', 'saved_command', 'cron_job'] as const) {
        expect(accessibleIds(who(member.userId), type), type).toEqual({ all: false, ids: [] });
      }
    });

    it('takes the highest of every role and personal grant, and drops expired ones', () => {
      const member = seedUser(orgId, 'viewer');
      restrict(member.userId);
      const s1 = seedServer(orgId, admin.userId, 'hi');
      const a = role('Lo', [{ userId: member.userId }]);
      const b = role('Hi', [{ userId: member.userId, expiresAt: FUTURE }]);
      const c = role('Gone', [{ userId: member.userId, expiresAt: PAST }]);
      grant({ role: a }, { resourceType: 'server', resourceId: s1, level: 'view' });
      grant({ role: b }, { resourceType: 'server', resourceId: s1, level: 'operate' });
      grant({ role: c }, { resourceType: 'server', resourceId: s1, level: 'manage' });
      grant({ user: member.userId }, { resourceType: 'server', resourceId: s1, level: 'manage', expiresAt: PAST });
      expect(levelFor(who(member.userId), 'server', s1)?.level).toBe('operate');

      grant({ user: member.userId }, { resourceType: 'server', resourceId: s1, level: 'manage', expiresAt: FUTURE });
      expect(levelFor(who(member.userId), 'server', s1)?.level).toBe('manage');
    });

    it('evaluates tag selectors live, in SQL and in memory alike', () => {
      const member = seedUser(orgId, 'viewer');
      restrict(member.userId);
      const tagged = seedServer(orgId, admin.userId, 'fe-1', ['frontend', 'eu']);
      const other = seedServer(orgId, admin.userId, 'be-1', ['backend']);
      const broken = seedServer(orgId, admin.userId, 'bad');
      getDb().update(servers).set({ tags: 'not json' }).where(eq(servers.id, broken)).run();
      const fe = role('Frontend', [{ userId: member.userId }]);
      grant({ role: fe }, { resourceType: 'server', tag: 'frontend', level: 'operate' });

      const visible = () =>
        getDb()
          .select({ id: servers.id })
          .from(servers)
          .where(and(eq(servers.orgId, orgId), accessibleFilter(who(member.userId), 'server', servers.id)))
          .all()
          .map((r) => r.id)
          .sort();
      expect(visible()).toEqual([tagged]);
      expect(filterAccessible(who(member.userId), 'server', [tagged, other, broken], (s) => s)).toEqual([tagged]);
      expect(levelFor(who(member.userId), 'server', tagged)?.level).toBe('operate');
      expect(levelFor(who(member.userId), 'server', other)).toBeNull();

      // Tagging a server covers it at once
      getDb().update(servers).set({ tags: JSON.stringify(['backend', 'frontend']) }).where(eq(servers.id, other)).run();
      expect(visible()).toEqual([tagged, other].sort());
      expect(canAccessServer(who(member.userId), other)).toBe(true);

      // Filters on other server-id columns work the same
      const job = nanoid();
      getDb()
        .insert(cronJobs)
        .values({ id: job, orgId, serverId: other, name: 'j', schedule: '* * * * *', inlineCommand: 'true', createdBy: admin.userId })
        .run();
      const jobs = getDb()
        .select({ id: cronJobs.id })
        .from(cronJobs)
        .where(and(eq(cronJobs.orgId, orgId), accessibleFilter(who(member.userId), 'server', cronJobs.serverId)))
        .all();
      expect(jobs.map((j) => j.id)).toEqual([job]);
    });

    it('gives every resource of a type through an "all" selector', () => {
      const member = seedUser(orgId, 'viewer');
      restrict(member.userId);
      const s1 = seedServer(orgId, admin.userId, 'every');
      grant({ user: member.userId }, { resourceType: 'server', level: 'view' });
      expect(serverScope(who(member.userId))).toEqual({ all: true });
      expect(accessibleFilter(who(member.userId), 'server', servers.id)).toBeUndefined();
      expect(levelFor(who(member.userId), 'server', s1)?.level).toBe('view');
      expect(accessibleIds(who(member.userId), 'cluster')).toEqual({ all: false, ids: [] });
    });

    it('narrows clusters to namespaces, per grant', () => {
      const member = seedUser(orgId, 'viewer');
      restrict(member.userId);
      const k = cluster('shop-prod');
      const shop = role('Shop', [{ userId: member.userId }]);
      grant({ role: shop }, { resourceType: 'cluster', resourceId: k, level: 'operate', namespaces: JSON.stringify(['shop']) });
      grant({ user: member.userId }, { resourceType: 'cluster', resourceId: k, level: 'view', namespaces: JSON.stringify(['web']) });

      expect(clusterNamespaces(who(member.userId), k)).toEqual(['shop', 'web']);
      expect(levelFor(who(member.userId), 'cluster', k, { namespace: 'shop' })?.level).toBe('operate');
      expect(levelFor(who(member.userId), 'cluster', k, { namespace: 'web' })?.level).toBe('view');
      expect(levelFor(who(member.userId), 'cluster', k, { namespace: 'kube-system' })).toBeNull();

      // Unreadable namespaces count for nothing
      const other = cluster('other');
      grant({ user: member.userId }, { resourceType: 'cluster', resourceId: other, level: 'manage', namespaces: '{oops' });
      expect(levelFor(who(member.userId), 'cluster', other)).toBeNull();
    });

    it('gives owners and admins manage everywhere, whatever their scope or roles', () => {
      const owner = seedUser(orgId, 'owner');
      const s1 = seedServer(orgId, admin.userId, 'own');
      restrict(admin.userId);
      expect(levelFor(who(admin.userId), 'server', s1)?.level).toBe('manage');
      expect(levelFor(who(owner.userId), 'server', s1)?.level).toBe('manage');
      getDb().update(memberships).set({ serverAccess: 'all' }).where(eq(memberships.userId, admin.userId)).run();
    });

    it('gives a suspended member, or someone from another org, nothing', () => {
      const member = seedUser(orgId, 'operator');
      const s1 = seedServer(orgId, admin.userId, 'susp');
      getDb().update(memberships).set({ status: 'suspended' }).where(eq(memberships.userId, member.userId)).run();
      expect(levelFor(who(member.userId), 'server', s1)).toBeNull();

      const elsewhere = seedOrg('org-engine-other');
      const stranger = seedUser(elsewhere, 'owner');
      expect(levelFor({ orgId: elsewhere, userId: stranger.userId }, 'server', s1)).toBeNull();
      // A grant on another org's resource does not reach it either
      expect(canAccessServer(who(stranger.userId), s1)).toBe(false);
    });

    it('caps every level at view for a read-only API token', () => {
      const s1 = seedServer(orgId, admin.userId, 'ro');
      const req = { orgId, user: { id: admin.userId, email: '', displayName: '' }, apiTokenReadOnly: true };
      expect(levelFor(req, 'server', s1)?.level).toBe('view');
      expect(authorize(req, 'server', s1, 'terminal').status).toBe(403);
      expect(levelFor({ ...req, apiTokenReadOnly: false }, 'server', s1)?.level).toBe('manage');
    });
  });

  describe('authorize and requireResource', () => {
    it('answers 404 without access, 403 when the level is too low, 200 otherwise', async () => {
      const member = seedUser(orgId, 'viewer');
      restrict(member.userId);
      const seen = seedServer(orgId, admin.userId, 'seen');
      const hidden = seedServer(orgId, admin.userId, 'hidden');
      grant({ user: member.userId }, { resourceType: 'server', resourceId: seen, level: 'view' });

      expect(authorize(who(member.userId), 'server', seen, 'view')).toMatchObject({ ok: true, status: 200, level: 'view' });
      expect(authorize(who(member.userId), 'server', seen, 'terminal')).toMatchObject({ ok: false, status: 403, required: 'operate' });
      expect(authorize(who(member.userId), 'server', hidden, 'view')).toMatchObject({ ok: false, status: 404 });
      expect(authorize(who(member.userId), 'server', 'no-such-server', 'view').status).toBe(404);

      const app = Fastify();
      app.addHook('preHandler', async (req) => {
        req.user = { id: member.userId, email: '', displayName: '' };
        req.orgId = orgId;
      });
      app.get('/servers/:id/terminal', { preHandler: requireResource('server', 'terminal') }, async () => ({ ok: true }));
      app.get('/servers/:id', { preHandler: requireResource('server', 'view') }, async () => ({ ok: true }));
      expect((await app.inject(`/servers/${seen}`)).statusCode).toBe(200);
      const forbidden = await app.inject(`/servers/${seen}/terminal`);
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().error).toMatch(/operate/);
      const missing = await app.inject(`/servers/${hidden}/terminal`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'Server not found' });
      await app.close();
    });
  });

  describe('explain', () => {
    it('lists every reason, highest first, with names, selectors and expiry', () => {
      const member = seedUser(orgId, 'operator');
      const s1 = seedServer(orgId, admin.userId, 'web-1', ['frontend']);
      const web = role('Web team', [{ userId: member.userId, expiresAt: FUTURE }]);
      grant({ role: web }, { resourceType: 'server', tag: 'frontend', level: 'manage' });
      const personal = grant({ user: member.userId }, { resourceType: 'server', resourceId: s1, level: 'view', expiresAt: FUTURE });

      const result = explain(who(member.userId), 'server', s1);
      expect(result.level).toBe('manage');
      expect(result.via).toEqual([
        { kind: 'role', name: 'Web team', roleId: web, level: 'manage', selector: 'tag', tag: 'frontend', expiresAt: FUTURE },
        { kind: 'base', name: 'operator', level: 'operate' },
        { kind: 'grant', name: 'personal', grantId: personal, level: 'view', selector: 'id', expiresAt: FUTURE },
      ]);
      expect(explain(who(member.userId), 'server', 'nope')).toEqual({ resourceType: 'server', resourceId: 'nope', level: null, via: [] });
    });
  });

  describe('Docker and Kubernetes per resource', () => {
    it('reads the matrices at the level held on that server or cluster', () => {
      const viewer = seedUser(orgId, 'viewer');
      const s1 = seedServer(orgId, admin.userId, 'dock-1');
      const s2 = seedServer(orgId, admin.userId, 'dock-2');
      const k1 = cluster('kube-raise');
      const ops = role('Docker ops', [{ userId: viewer.userId }]);
      grant({ role: ops }, { resourceType: 'server', resourceId: s1, level: 'operate' });
      grant({ role: ops }, { resourceType: 'cluster', resourceId: k1, level: 'manage' });
      const req = { orgId, role: 'viewer' as const, user: { id: viewer.userId, email: '', displayName: '' } };

      expect(permissionsFor(req, s1)).toEqual(dockerPermissions('operator', dockerSettings(orgId)));
      expect(permissionsFor(req, s2)).toEqual(dockerPermissions('viewer', dockerSettings(orgId)));
      expect(permissionsFor(req)).toEqual(dockerPermissions('viewer', dockerSettings(orgId)));
      expect(kubePermissionsFor(req, k1)).toEqual(kubePermissions('admin', kubeSettings(orgId)));

      // A role-scoped operator granted only view gets no more than view there
      const op = seedUser(orgId, 'operator');
      restrict(op.userId);
      grant({ user: op.userId }, { resourceType: 'server', resourceId: s2, level: 'view' });
      const opReq = { orgId, role: 'operator' as const, user: { id: op.userId, email: '', displayName: '' } };
      expect(permissionsFor(opReq, s2).inspect).toBe(false);
    });

    it('gives a namespace-narrowed grant no more than view on the cluster as a whole', () => {
      const member = seedUser(orgId, 'viewer');
      restrict(member.userId);
      const k = cluster('kube-narrow');
      grant({ user: member.userId }, { resourceType: 'cluster', resourceId: k, level: 'manage', namespaces: JSON.stringify(['shop']) });
      const req = { orgId, role: 'viewer' as const, user: { id: member.userId, email: '', displayName: '' } };

      // Full level inside the namespace…
      expect(levelFor(who(member.userId), 'cluster', k, { namespace: 'shop' })?.level).toBe('manage');
      // …but cordoning nodes or editing the cluster is not a namespace's to give
      expect(levelFor(who(member.userId), 'cluster', k)?.level).toBe('view');
      expect(authorize(who(member.userId), 'cluster', k, 'cordon').status).toBe(403);
      expect(kubePermissionsFor(req, k)).toEqual(kubePermissions('viewer', kubeSettings(orgId)));
      expect(accessibleIds(who(member.userId), 'cluster')).toEqual({ all: false, ids: [k] });
      expect(accessibleIds(who(member.userId), 'cluster', 'operate')).toEqual({ all: false, ids: [] });

      // A whole-cluster grant alongside still counts in full
      grant({ user: member.userId }, { resourceType: 'cluster', resourceId: k, level: 'operate' });
      expect(levelFor(who(member.userId), 'cluster', k)?.level).toBe('operate');
      expect(accessibleIds(who(member.userId), 'cluster', 'operate')).toEqual({ all: false, ids: [k] });
    });
  });

  describe('revocation', () => {
    it('diffs snapshots by visibility and by operate level', () => {
      const member = seedUser(orgId, 'viewer');
      restrict(member.userId);
      const s1 = seedServer(orgId, admin.userId, 'rv-1');
      const s2 = seedServer(orgId, admin.userId, 'rv-2');
      const ops = role('Revokable', [{ userId: member.userId }]);
      const g1 = grant({ role: ops }, { resourceType: 'server', resourceId: s1, level: 'operate' });
      grant({ user: member.userId }, { resourceType: 'server', resourceId: s2, level: 'view' });
      grant({ user: member.userId }, { resourceType: 'server', resourceId: s1, level: 'view' });

      const before = snapshotAccess(orgId, [member.userId]);
      expect(revokeAfterChange(orgId, [member.userId], before).size).toBe(0);
      expect(spies.revoke).not.toHaveBeenCalled();

      // Operate on s1 goes; s1 stays visible: shells there close, streams stay
      getDb().delete(resourceGrants).where(eq(resourceGrants.id, g1)).run();
      const after = snapshotAccess(orgId, [member.userId]);
      expect(lostAccess(before.get(member.userId)!, after.get(member.userId)!)).toEqual([{ type: 'server', level: 'operate' }]);
      const closed = revokeAfterChange(orgId, [member.userId], before);
      expect(closed.get(member.userId)).toMatchObject({ terminals: 1 });
      const [userId, scope] = spies.revoke.mock.calls[0]! as [string, Record<string, string[]>];
      expect(userId).toBe(member.userId);
      expect([...scope.keepServerIds!].sort()).toEqual([s1, s2].sort());
      expect(scope.keepShellServerIds).toEqual([]);
      expect(scope.keepClusterIds).toEqual([]);

      // Leaving the role closes only what was on its resources
      spies.revoke.mockClear();
      const before2 = snapshotAccess(orgId, [member.userId]);
      getDb().delete(roleMembers).where(eq(roleMembers.roleId, ops)).run();
      expect(revokeAfterChange(orgId, [member.userId], before2).size).toBe(0);
    });

    it('weighs pod shells in their namespace: narrowing a grant closes the shells it no longer covers, and only those', () => {
      const member = seedUser(orgId, 'viewer');
      restrict(member.userId);
      const k = cluster('ns-shells');
      const s1 = seedServer(orgId, admin.userId, 'ns-shells-server');
      const team = role('Shop shells', [{ userId: member.userId }]);
      const g = grant({ role: team }, { resourceType: 'cluster', resourceId: k, level: 'operate', namespaces: JSON.stringify(['shop', 'web']) });
      const serverGrant = grant({ role: team }, { resourceType: 'server', resourceId: s1, level: 'view' });
      const ends = { shop: vi.fn(), web: vi.fn() };
      const shell = (namespace: 'shop' | 'web') => {
        const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), writable: true, write: vi.fn(), setWindow: vi.fn() });
        return SSHBroker.adoptSession(
          {
            server: { id: '', host: '', port: 0, username: '' },
            userId: member.userId,
            orgId,
            cols: 80,
            rows: 24,
            pod: { clusterId: k, namespace, name: `${namespace}-1`, container: 'app' },
          },
          channel as unknown as TerminalChannel,
          ends[namespace],
        );
      };
      const shop = shell('shop');
      const web = shell('web');

      // Narrowed to `shop`: the per-type sets do not change, the `web` shell still closes
      const before = snapshotAccess(orgId, [member.userId]);
      getDb().update(resourceGrants).set({ namespaces: JSON.stringify(['shop']) }).where(eq(resourceGrants.id, g)).run();
      const closed = revokeAfterChange(orgId, [member.userId], before);
      expect(closed.get(member.userId)).toMatchObject({ terminals: 1 });
      expect(ends.web).toHaveBeenCalled();
      expect(ends.shop).not.toHaveBeenCalled();
      expect(SSHBroker.getSessionForUser(web, member.userId, orgId)).toBeUndefined();
      expect(SSHBroker.getSessionForUser(shop, member.userId, orgId)).toBeDefined();

      // Losing something else keeps the cluster's shells where the member still operates
      spies.revoke.mockClear();
      const before2 = snapshotAccess(orgId, [member.userId]);
      getDb().delete(resourceGrants).where(eq(resourceGrants.id, serverGrant)).run();
      revokeAfterChange(orgId, [member.userId], before2);
      const scope = spies.revoke.mock.calls[0]![1] as Record<string, string[]>;
      expect(scope.keepShellClusterIds).toEqual([k]);
      expect(ends.shop).not.toHaveBeenCalled();
      void SSHBroker.close(shop, { userId: member.userId, orgId });
    });

    it('sweeps expired role memberships and grants, closes what they gave and audits it', () => {
      const member = seedUser(orgId, 'operator');
      restrict(member.userId);
      const kept = seedServer(orgId, admin.userId, 'sw-kept');
      const lost = seedServer(orgId, admin.userId, 'sw-lost');
      const lostToo = seedServer(orgId, admin.userId, 'sw-lost-2');
      const k = cluster('sw-cluster');
      getDb().insert(memberServerAccess).values({ orgId, userId: member.userId, serverId: kept }).run();
      const oncall = role('On call', [{ userId: member.userId, expiresAt: FUTURE }]);
      grant({ role: oncall }, { resourceType: 'server', resourceId: lost, level: 'operate' });
      const personal = grant({ user: member.userId }, { resourceType: 'server', resourceId: lostToo, level: 'operate', expiresAt: FUTURE });
      grant({ user: member.userId }, { resourceType: 'cluster', resourceId: k, level: 'view' });
      expect(canAccessServer(who(member.userId), lost)).toBe(true);

      getDb().update(roleMembers).set({ expiresAt: PAST }).where(eq(roleMembers.roleId, oncall)).run();
      getDb().update(resourceGrants).set({ expiresAt: PAST }).where(eq(resourceGrants.id, personal)).run();
      const result = sweepExpiredAccess();
      expect(result.roleMembers).toBeGreaterThanOrEqual(1);
      expect(result.grants).toBeGreaterThanOrEqual(1);
      expect(getDb().select().from(roleMembers).where(eq(roleMembers.roleId, oncall)).all()).toEqual([]);
      expect(canAccessServer(who(member.userId), lost)).toBe(false);
      expect(canAccessServer(who(member.userId), lostToo)).toBe(false);

      const call = spies.revoke.mock.calls.find(([userId]) => userId === member.userId);
      expect(call).toBeTruthy();
      const scope = call![1] as Record<string, string[]>;
      expect(scope.keepServerIds).toEqual([kept]);
      expect(scope.keepShellServerIds).toEqual([kept]);
      expect(scope.keepClusterIds).toEqual([k]);

      const audits = getDb().select().from(auditLog).where(eq(auditLog.orgId, orgId)).all();
      const memberAudit = audits.find((a) => a.action === 'member.access_expired' && a.resourceId === member.userId);
      expect(JSON.parse(memberAudit!.metadata!)).toMatchObject({
        servers: [],
        grants: [{ type: 'server', selector: 'id', resourceId: lostToo, level: 'operate' }],
        roles: [{ id: oncall, name: 'On call' }],
        live: { terminals: 1 },
      });
      expect(audits.some((a) => a.action === 'role.member_expired' && a.resourceId === oncall)).toBe(true);
    });

    it('closes what a role grant gave every member of the role when it expires', () => {
      const a = seedUser(orgId, 'viewer');
      const b = seedUser(orgId, 'viewer');
      restrict(a.userId);
      restrict(b.userId);
      const s1 = seedServer(orgId, admin.userId, 'rg-1');
      const team = role('Temp team', [{ userId: a.userId }, { userId: b.userId }]);
      const g = grant({ role: team }, { resourceType: 'server', resourceId: s1, level: 'view', expiresAt: FUTURE });
      getDb().update(resourceGrants).set({ expiresAt: PAST }).where(eq(resourceGrants.id, g)).run();
      sweepExpiredAccess();
      const users = spies.revoke.mock.calls.map(([userId]) => userId);
      expect(users).toEqual(expect.arrayContaining([a.userId, b.userId]));
      const audits = getDb().select().from(auditLog).where(and(eq(auditLog.action, 'role.grant_expired'), eq(auditLog.resourceId, team))).all();
      expect(audits).toHaveLength(1);
    });
  });
});
