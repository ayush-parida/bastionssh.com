import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Time-limited access: requests, decisions, time-bound grants and their
 * expiry. The live-access closers and the notifier are spied on; their own
 * behaviour is covered elsewhere (live-revocation.test.ts, notifications).
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
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { accessRequests, auditLog, memberServerAccess, memberships, users } from '../../db/schema.js';
import { canAccessServer } from '../../auth/server-access.js';
import { extendGrants, sweepExpiredAccess } from '../../auth/access-grants.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

describe('time-limited access', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: Who;
  let unrestricted: Who;
  let serverA: string;
  let serverB: string;
  let serverC: string;

  // A fresh address per call keeps this busy suite clear of the global rate limit
  let calls = 0;
  const remoteAddress = () => `10.77.${(++calls >> 8) & 255}.${calls & 255}`;
  const as = (who: Who) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: who.headers, remoteAddress: remoteAddress() }),
    post: (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, headers: who.headers, payload: payload ?? {}, remoteAddress: remoteAddress() }),
    put: (url: string, payload: object) =>
      app.inject({ method: 'PUT', url, headers: who.headers, payload, remoteAddress: remoteAddress() }),
    patch: (url: string, payload: object) =>
      app.inject({ method: 'PATCH', url, headers: who.headers, payload, remoteAddress: remoteAddress() }),
  });

  /** A fresh operator restricted to `serverIds`. */
  async function restrictedMember(serverIds: string[] = [serverA]): Promise<Who> {
    const member = seedUser(orgId, 'operator');
    const res = await as(admin).put(`/api/team/members/${member.userId}/access`, {
      serverAccess: 'restricted',
      serverIds,
    });
    expect(res.statusCode).toBe(200);
    return member;
  }

  async function request(who: Who, body: object = {}) {
    return as(who).post('/api/access-requests', {
      serverIds: [serverB],
      reason: 'deploy hotfix',
      durationMinutes: 120,
      ...body,
    });
  }

  function grantRow(userId: string, serverId: string) {
    return getDb()
      .select()
      .from(memberServerAccess)
      .where(and(eq(memberServerAccess.userId, userId), eq(memberServerAccess.serverId, serverId)))
      .get();
  }

  function expireGrant(userId: string, serverId: string) {
    getDb()
      .update(memberServerAccess)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(and(eq(memberServerAccess.userId, userId), eq(memberServerAccess.serverId, serverId)))
      .run();
  }

  function emailOf(userId: string) {
    return getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).get()!.email;
  }

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-jit');
    admin = seedUser(orgId, 'admin');
    unrestricted = seedUser(orgId, 'operator');
    serverA = seedServer(orgId, admin.userId, 'alpha');
    serverB = seedServer(orgId, admin.userId, 'bravo');
    serverC = seedServer(orgId, admin.userId, 'charlie');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('requestable servers', () => {
    it('lists every server by name only, marking what is granted', async () => {
      const member = await restrictedMember();
      const res = await as(member).get('/api/access-requests/servers');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.restricted).toBe(true);
      expect(body.settings).toEqual({ restrictedSeeServerNames: true, maxRequestMinutes: 480 });
      expect(body.servers.map((s: { name: string }) => s.name)).toEqual(['alpha', 'bravo', 'charlie']);
      expect(Object.keys(body.servers[0]).sort()).toEqual(['granted', 'id', 'name']);
      expect(body.servers[0].granted).toEqual({ expiresAt: null });
      expect(body.servers[1].granted).toBeNull();
    });

    it('gives members who see everything nothing to request', async () => {
      const body = (await as(unrestricted).get('/api/access-requests/servers')).json();
      expect(body).toMatchObject({ restricted: false, servers: [] });
    });

    it('hides the names of ungranted servers when the org turns names off', async () => {
      const member = await restrictedMember();
      expect((await as(unrestricted).patch('/api/access-requests/settings', { restrictedSeeServerNames: false })).statusCode).toBe(403);
      const off = await as(admin).patch('/api/access-requests/settings', { restrictedSeeServerNames: false });
      expect(off.statusCode).toBe(200);
      try {
        const names = (await as(member).get('/api/access-requests/servers')).json().servers.map((s: { name: string }) => s.name);
        expect(names).toEqual(['alpha']);
        // A server they cannot see answers like one that does not exist
        expect((await request(member)).statusCode).toBe(400);
        expect((await request(member, { serverIds: ['nope'] })).json().error).toBe((await request(member)).json().error);
      } finally {
        await as(admin).patch('/api/access-requests/settings', { restrictedSeeServerNames: true });
      }
      const audited = getDb().select().from(auditLog).where(eq(auditLog.action, 'org.access_request_policy')).all();
      expect(audited.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('requesting', () => {
    it('creates a pending request, audits it and tells the admins', async () => {
      const member = await restrictedMember();
      const res = await request(member);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'pending',
        userId: member.userId,
        servers: [{ id: serverB, name: 'bravo' }],
        durationMinutes: 120,
        reason: 'deploy hotfix',
      });
      expect(spies.notify).toHaveBeenCalledTimes(1);
      const [notifiedOrg, notice, emails] = spies.notify.mock.calls[0] as unknown as [string, { event: string }, string[]];
      expect(notifiedOrg).toBe(orgId);
      expect(notice.event).toBe('access_request.created');
      expect(emails).toContain(emailOf(admin.userId));
      expect(emails).not.toContain(emailOf(member.userId));
      const row = getDb().select().from(auditLog).where(eq(auditLog.resourceId, res.json().id)).get();
      expect(row?.action).toBe('access_request.create');
    });

    it('keeps member-typed text from pinging or linking in chat channels', async () => {
      const member = await restrictedMember();
      const res = await request(member, { reason: '@everyone <!channel> <https://evil.test|jira>' });
      expect(res.statusCode).toBe(201);
      // Stored as typed; only the notice is defused
      expect(res.json().reason).toBe('@everyone <!channel> <https://evil.test|jira>');
      const [, notice] = spies.notify.mock.calls[0] as unknown as [string, { message: string; details: [string, string][] }];
      for (const text of [notice.message, Object.fromEntries(notice.details).Reason!]) {
        expect(text).not.toMatch(/@everyone|[<>]/);
        expect(text).toContain('@​everyone');
      }
    });

    it('caps how many requests a member creates in an hour, cancelled ones included', async () => {
      const member = await restrictedMember();
      for (let i = 0; i < 20; i++) {
        const id = (await request(member)).json().id;
        expect((await as(member).post(`/api/access-requests/${id}/cancel`)).statusCode).toBe(200);
      }
      vi.clearAllMocks();
      const res = await request(member);
      expect(res.statusCode).toBe(429);
      expect(spies.notify).not.toHaveBeenCalled();
    });

    it('refuses more than the org maximum', async () => {
      const member = await restrictedMember();
      const res = await request(member, { durationMinutes: 481 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/at most 8h/);
    });

    it('refuses servers already granted permanently, and members who see everything', async () => {
      const member = await restrictedMember();
      expect((await request(member, { serverIds: [serverA] })).statusCode).toBe(400);
      expect((await request(unrestricted)).statusCode).toBe(400);
      expect((await request(admin)).statusCode).toBe(400);
    });

    it('shows members only their own requests, admins everyone’s', async () => {
      const one = await restrictedMember();
      const two = await restrictedMember();
      const mine = (await request(one)).json().id;
      const theirs = (await request(two)).json().id;
      const ids = (await as(one).get('/api/access-requests')).json().map((r: { id: string }) => r.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
      expect((await as(unrestricted).get('/api/access-requests')).json()).toEqual([]);
      const all = (await as(admin).get('/api/access-requests?status=pending')).json().map((r: { id: string }) => r.id);
      expect(all).toEqual(expect.arrayContaining([mine, theirs]));
    });

    it('lets only the requester cancel, and only while pending', async () => {
      const member = await restrictedMember();
      const id = (await request(member)).json().id;
      expect((await as(unrestricted).post(`/api/access-requests/${id}/cancel`)).statusCode).toBe(404);
      const res = await as(member).post(`/api/access-requests/${id}/cancel`);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('cancelled');
      expect((await as(member).post(`/api/access-requests/${id}/cancel`)).statusCode).toBe(409);
      expect((await as(admin).post(`/api/access-requests/${id}/approve`)).statusCode).toBe(409);
    });
  });

  describe('deciding', () => {
    it('is admin-only', async () => {
      const member = await restrictedMember();
      const id = (await request(member)).json().id;
      expect((await as(unrestricted).post(`/api/access-requests/${id}/approve`)).statusCode).toBe(403);
      expect((await as(unrestricted).post(`/api/access-requests/${id}/deny`)).statusCode).toBe(403);
      expect((await as(member).post(`/api/access-requests/${id}/approve`)).statusCode).toBe(403);
      expect(grantRow(member.userId, serverB)).toBeUndefined();
    });

    it('never lets someone approve their own request', async () => {
      const member = await restrictedMember();
      const id = (await request(member)).json().id;
      // Promoted to admin while the request was open
      expect((await as(admin).patch(`/api/team/members/${member.userId}`, { role: 'admin' })).statusCode).toBe(200);
      const res = await as(member).post(`/api/access-requests/${id}/approve`);
      expect(res.statusCode).toBe(403);
      expect((await as(member).post(`/api/access-requests/${id}/deny`)).statusCode).toBe(403);
      expect(grantRow(member.userId, serverB)).toBeUndefined();
    });

    it('approves for a shortened time, granting until then and telling the requester', async () => {
      const member = await restrictedMember();
      const id = (await request(member)).json().id;
      expect((await as(member).get(`/api/servers/${serverB}`)).statusCode).toBe(404);

      expect((await as(admin).post(`/api/access-requests/${id}/approve`, { durationMinutes: 121 })).statusCode).toBe(400);
      const before = Date.now();
      const res = await as(admin).post(`/api/access-requests/${id}/approve`, { durationMinutes: 30, note: 'be quick' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'approved', approvedMinutes: 30, decidedBy: admin.userId, decisionNote: 'be quick' });

      const grant = grantRow(member.userId, serverB)!;
      const expires = new Date(grant.expiresAt!).getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 30 * 60_000);
      expect(expires).toBeLessThan(before + 31 * 60_000);
      expect(grant).toMatchObject({ grantedBy: admin.userId, reason: 'deploy hotfix' });
      expect(res.json().expiresAt).toBe(grant.expiresAt);

      expect((await as(member).get(`/api/servers/${serverB}`)).statusCode).toBe(200);
      const access = (await as(admin).get(`/api/team/members/${member.userId}/access`)).json();
      expect(access.grants).toEqual(
        expect.arrayContaining([expect.objectContaining({ serverId: serverB, expiresAt: grant.expiresAt })]),
      );

      const approved = spies.notify.mock.calls.find((c) => (c[1] as { event: string }).event === 'access_request.approved');
      expect(approved?.[2]).toEqual([emailOf(member.userId)]);
      expect(getDb().select().from(auditLog).where(and(eq(auditLog.resourceId, id), eq(auditLog.action, 'access_request.approve'))).get()).toBeTruthy();

      // Decided once
      expect((await as(admin).post(`/api/access-requests/${id}/approve`)).statusCode).toBe(409);
      expect((await as(admin).post(`/api/access-requests/${id}/deny`)).statusCode).toBe(409);
    });

    it('denies without granting anything', async () => {
      const member = await restrictedMember();
      const id = (await request(member)).json().id;
      const res = await as(admin).post(`/api/access-requests/${id}/deny`, { note: 'not today' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'denied', decisionNote: 'not today' });
      expect(grantRow(member.userId, serverB)).toBeUndefined();
      const denied = spies.notify.mock.calls.find((c) => (c[1] as { event: string }).event === 'access_request.denied');
      expect(denied?.[2]).toEqual([emailOf(member.userId)]);
    });

    it('cannot approve a request that lapsed undecided', async () => {
      const member = await restrictedMember();
      const id = (await request(member)).json().id;
      getDb()
        .update(accessRequests)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(accessRequests.id, id))
        .run();
      expect((await as(admin).post(`/api/access-requests/${id}/approve`)).statusCode).toBe(409);
      sweepExpiredAccess();
      expect(getDb().select().from(accessRequests).where(eq(accessRequests.id, id)).get()?.status).toBe('expired');
    });

    it('refuses to approve for a suspended member, even if the request was left pending', async () => {
      const member = await restrictedMember();
      const id = (await request(member)).json().id;
      // Suspended behind the API's back, so the request is still pending
      getDb()
        .update(memberships)
        .set({ status: 'suspended' })
        .where(and(eq(memberships.userId, member.userId), eq(memberships.orgId, orgId)))
        .run();
      const res = await as(admin).post(`/api/access-requests/${id}/approve`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/suspended/);
      expect(grantRow(member.userId, serverB)).toBeUndefined();
      expect(getDb().select().from(accessRequests).where(eq(accessRequests.id, id)).get()?.status).toBe('pending');
    });

    it('cancels pending requests when the member is suspended or removed', async () => {
      const requestsOf = (userId: string) =>
        getDb().select().from(accessRequests).where(eq(accessRequests.userId, userId)).all();

      const suspended = await restrictedMember();
      const first = (await request(suspended)).json().id;
      expect((await as(admin).post(`/api/team/members/${suspended.userId}/suspend`)).statusCode).toBe(200);
      expect(requestsOf(suspended.userId)).toEqual([
        expect.objectContaining({
          id: first,
          status: 'cancelled',
          decidedBy: admin.userId,
          decisionNote: 'Cancelled automatically: the member was suspended',
        }),
      ]);
      expect((await as(admin).post(`/api/access-requests/${first}/approve`)).statusCode).toBe(409);
      // Reactivating does not bring the request back
      expect((await as(admin).post(`/api/team/members/${suspended.userId}/reactivate`)).statusCode).toBe(200);
      expect(requestsOf(suspended.userId)[0]!.status).toBe('cancelled');
      expect(grantRow(suspended.userId, serverB)).toBeUndefined();

      const removed = await restrictedMember();
      const second = (await request(removed)).json().id;
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/team/members/${removed.userId}`,
        headers: admin.headers,
        remoteAddress: remoteAddress(),
      });
      expect(res.statusCode).toBe(204);
      expect(requestsOf(removed.userId)).toEqual([
        expect.objectContaining({ id: second, status: 'cancelled', decisionNote: 'Cancelled automatically: the member was removed' }),
      ]);
      const audit = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.resourceId, removed.userId), eq(auditLog.action, 'member.remove')))
        .get();
      expect(JSON.parse(audit!.metadata!)).toMatchObject({ accessRequestsCancelled: 1 });
    });

    it('never shortens access the member already has', async () => {
      const member = await restrictedMember([serverA]);
      const later = new Date(Date.now() + 10 * 60 * 60_000).toISOString();
      const sooner = new Date(Date.now() + 60 * 60_000).toISOString();
      extendGrants(orgId, member.userId, [serverB], { expiresAt: later, grantedBy: admin.userId, reason: null });
      const changed = extendGrants(orgId, member.userId, [serverA, serverB, serverC], {
        expiresAt: sooner,
        grantedBy: admin.userId,
        reason: 'x',
      });
      expect(changed).toEqual([serverC]);
      expect(grantRow(member.userId, serverA)?.expiresAt).toBeNull();
      expect(grantRow(member.userId, serverB)?.expiresAt).toBe(later);
    });
  });

  describe('direct time-bound grants', () => {
    it('grants for a duration, keeps an expiry on re-save, and can make it permanent', async () => {
      const member = await restrictedMember();
      const url = `/api/team/members/${member.userId}/access`;
      const first = await as(admin).put(url, {
        serverAccess: 'restricted',
        serverIds: [serverA, serverB],
        expiresInMinutes: { [serverB]: 60 },
      });
      expect(first.statusCode).toBe(200);
      const expiresAt = grantRow(member.userId, serverB)!.expiresAt!;
      expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
      expect(grantRow(member.userId, serverA)!.expiresAt).toBeNull();

      // Saving again without a duration keeps the expiry as it was
      await as(admin).put(url, { serverAccess: 'restricted', serverIds: [serverA, serverB] });
      expect(grantRow(member.userId, serverB)!.expiresAt).toBe(expiresAt);

      await as(admin).put(url, { serverAccess: 'restricted', serverIds: [serverA, serverB], expiresInMinutes: { [serverB]: null } });
      expect(grantRow(member.userId, serverB)!.expiresAt).toBeNull();

      const tooLong = await as(admin).put(url, {
        serverAccess: 'restricted',
        serverIds: [serverB],
        expiresInMinutes: { [serverB]: 365 * 24 * 60 + 1 },
      });
      expect(tooLong.statusCode).toBe(400);
    });

    it('keeps a grant that lapsed while the dialog was open lapsed on save', async () => {
      const member = await restrictedMember();
      const url = `/api/team/members/${member.userId}/access`;
      await as(admin).put(url, { serverAccess: 'restricted', serverIds: [serverA, serverB], expiresInMinutes: { [serverB]: 5 } });
      expireGrant(member.userId, serverB);
      const res = await as(admin).put(url, { serverAccess: 'restricted', serverIds: [serverA, serverB] });
      expect(res.json().serverIds).toEqual([serverA]);
      expect(canAccessServer({ orgId, userId: member.userId }, serverB)).toBe(false);
    });
  });

  describe('expiry', () => {
    it('stops counting an expired grant on every route before the sweep runs', async () => {
      const member = await restrictedMember();
      await as(admin).put(`/api/team/members/${member.userId}/access`, {
        serverAccess: 'restricted',
        serverIds: [serverA, serverB],
        expiresInMinutes: { [serverB]: 60 },
      });
      expect((await as(member).get(`/api/servers/${serverB}`)).statusCode).toBe(200);

      expireGrant(member.userId, serverB);

      expect(canAccessServer({ orgId, userId: member.userId }, serverB)).toBe(false);
      expect((await as(member).get('/api/servers')).json().map((s: { id: string }) => s.id)).toEqual([serverA]);
      expect((await as(member).get(`/api/servers/${serverB}`)).statusCode).toBe(404);
      expect((await as(member).post('/api/ssh-sessions', { serverId: serverB })).statusCode).toBe(404);
      expect((await as(member).get(`/api/sftp/${serverB}/list`)).statusCode).toBe(404);
      expect((await as(member).get(`/api/monitoring/servers/${serverB}`)).statusCode).toBe(404);
      expect((await as(member).get('/api/ai/context')).json().servers.map((s: { id: string }) => s.id)).toEqual([serverA]);

      const access = (await as(admin).get(`/api/team/members/${member.userId}/access`)).json();
      expect(access.serverIds).toEqual([serverA]);
      const row = (await as(admin).get('/api/team/members')).json().find((m: { userId: string }) => m.userId === member.userId);
      expect(row.serverCount).toBe(1);
    });

    it('sweeps expired grants, closes what is open on them and audits it', async () => {
      const member = await restrictedMember();
      await as(admin).put(`/api/team/members/${member.userId}/access`, {
        serverAccess: 'restricted',
        serverIds: [serverA, serverB, serverC],
        expiresInMinutes: { [serverB]: 60, [serverC]: 60 },
      });
      expireGrant(member.userId, serverB);
      vi.clearAllMocks();

      const result = sweepExpiredAccess();
      expect(result.grants).toBeGreaterThanOrEqual(1);
      expect(grantRow(member.userId, serverB)).toBeUndefined();
      expect(grantRow(member.userId, serverC)).toBeTruthy();

      // Only what is open on the expired server closes; the rest is kept
      const keep = expect.arrayContaining([serverA, serverC]);
      expect(spies.terminals).toHaveBeenCalledWith(member.userId, { orgId, keepServerIds: keep });
      expect(spies.sftp).toHaveBeenCalledWith(member.userId, { orgId, keepServerIds: keep });
      expect(spies.agents).toHaveBeenCalledWith(member.userId, { orgId });
      const kept = (spies.terminals.mock.calls[0] as unknown as [string, { keepServerIds: string[] }])[1].keepServerIds;
      expect(kept).not.toContain(serverB);

      const audited = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'member.access_expired'), eq(auditLog.resourceId, member.userId)))
        .get();
      expect(audited).toMatchObject({ actorId: 'system', orgId });
      expect(JSON.parse(audited!.metadata!).servers).toEqual([serverB]);

      // Nothing left to expire
      vi.clearAllMocks();
      sweepExpiredAccess();
      expect(spies.terminals).not.toHaveBeenCalledWith(member.userId, expect.anything());
    });

    it('closes nothing for a member who meanwhile sees every server', async () => {
      const member = await restrictedMember();
      await as(admin).put(`/api/team/members/${member.userId}/access`, {
        serverAccess: 'restricted',
        serverIds: [serverB],
        expiresInMinutes: { [serverB]: 60 },
      });
      await as(admin).put(`/api/team/members/${member.userId}/access`, {
        serverAccess: 'all',
        serverIds: [serverB],
      });
      expireGrant(member.userId, serverB);
      vi.clearAllMocks();
      sweepExpiredAccess();
      expect(grantRow(member.userId, serverB)).toBeUndefined();
      expect(spies.terminals).not.toHaveBeenCalled();
    });

    it('expires grants that came from an approved request', async () => {
      const member = await restrictedMember();
      const id = (await request(member)).json().id;
      await as(admin).post(`/api/access-requests/${id}/approve`, { durationMinutes: 5 });
      expect(canAccessServer({ orgId, userId: member.userId }, serverB)).toBe(true);
      vi.clearAllMocks();
      sweepExpiredAccess(new Date(Date.now() + 6 * 60_000));
      expect(grantRow(member.userId, serverB)).toBeUndefined();
      expect(canAccessServer({ orgId, userId: member.userId }, serverB)).toBe(false);
      expect(spies.terminals).toHaveBeenCalledWith(member.userId, { orgId, keepServerIds: [serverA] });
    });
  });
});
