import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, memberships, passwordResets, sessions, users } from '../../db/schema.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { LAST_SEEN_THROTTLE_MS, touchSession } from '../../auth/session.js';
import { addMembership, seedOrg, seedSession, seedUser } from './test-utils.js';

describe('team & access', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: ReturnType<typeof seedUser>;
  let admin: ReturnType<typeof seedUser>;

  /** A member with a known email and password, so login can be exercised. */
  async function seedPerson(org: string, role: 'owner' | 'admin' | 'operator' | 'viewer', password = 'old-password') {
    const member = seedUser(org, role);
    const email = `${nanoid(8).toLowerCase()}@corp.test`;
    getDb()
      .update(users)
      .set({ email, passwordHash: await hashPassword(password) })
      .where(eq(users.id, member.userId))
      .run();
    return { ...member, email, password };
  }

  const login = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  const sessionCount = (userId: string) =>
    getDb().select().from(sessions).where(eq(sessions.userId, userId)).all().length;

  const auditActions = (resourceId: string) =>
    getDb()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resourceId, resourceId))
      .all()
      .map((a) => a.action);

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-team');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('suspension', () => {
    it('blocks API tokens, session cookies and login, and ends sessions', async () => {
      const member = await seedPerson(orgId, 'operator');
      const browser = await seedSession(member.userId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/team/members/${member.userId}/suspend`,
        headers: admin.headers,
      });
      expect(res.statusCode).toBe(200);
      expect(sessionCount(member.userId)).toBe(0);

      // The old cookie is gone entirely
      const stale = await app.inject({ method: 'GET', url: '/api/auth/me', headers: browser.headers });
      expect(stale.statusCode).toBe(401);

      // A fresh cookie (however obtained) is refused with a clear reason
      const fresh = await seedSession(member.userId);
      const viaCookie = await app.inject({ method: 'GET', url: '/api/auth/me', headers: fresh.headers });
      expect(viaCookie.statusCode).toBe(403);
      expect(viaCookie.json().error).toMatch(/suspended/);

      const viaToken = await app.inject({ method: 'GET', url: '/api/servers', headers: member.headers });
      expect(viaToken.statusCode).toBe(403);
      expect(viaToken.json().error).toMatch(/suspended/);

      const signIn = await login(member.email, member.password);
      expect(signIn.statusCode).toBe(403);
      expect(signIn.json().error).toMatch(/suspended/);

      const members = (await app.inject({ method: 'GET', url: '/api/team/members', headers: admin.headers })).json();
      expect(members.find((m: { userId: string }) => m.userId === member.userId).status).toBe('suspended');

      // Reactivation restores access
      const back = await app.inject({
        method: 'POST',
        url: `/api/team/members/${member.userId}/reactivate`,
        headers: admin.headers,
      });
      expect(back.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/servers', headers: member.headers })).statusCode).toBe(200);
      expect(auditActions(member.userId)).toEqual(expect.arrayContaining(['member.suspend', 'member.reactivate']));
    });

    it('only blocks the org it applies to', async () => {
      const member = await seedPerson(orgId, 'viewer');
      const otherOrg = seedOrg('org-team-other');
      addMembership(member.userId, otherOrg, 'viewer');

      await app.inject({ method: 'POST', url: `/api/team/members/${member.userId}/suspend`, headers: admin.headers });

      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: member.headers });
      expect(me.statusCode).toBe(200);
      expect(me.json().orgId).toBe(otherOrg);
    });

    it('applies the rank guards', async () => {
      const suspend = (userId: string, headers: Record<string, string>) =>
        app.inject({ method: 'POST', url: `/api/team/members/${userId}/suspend`, headers });

      expect((await suspend(admin.userId, admin.headers)).statusCode).toBe(400); // self
      expect((await suspend(owner.userId, admin.headers)).statusCode).toBe(403); // above
      const operator = seedUser(orgId, 'operator');
      expect((await suspend(admin.userId, operator.headers)).statusCode).toBe(403); // not an admin
      expect((await suspend('nobody', admin.headers)).statusCode).toBe(404);
    });

    it('lets an owner suspend another owner, but not an admin', async () => {
      const org = seedOrg('org-owners');
      const a = seedUser(org, 'owner');
      const b = seedUser(org, 'owner');
      const orgAdmin = seedUser(org, 'admin');
      const bySuspend = (userId: string, headers: Record<string, string>) =>
        app.inject({ method: 'POST', url: `/api/team/members/${userId}/suspend`, headers });

      expect((await bySuspend(b.userId, orgAdmin.headers)).statusCode).toBe(403);
      expect((await bySuspend(b.userId, a.headers)).statusCode).toBe(200);
      // Suspending again is a no-op, not an error
      expect((await bySuspend(b.userId, a.headers)).statusCode).toBe(200);
    });
  });

  describe('password reset', () => {
    // Issuing a reset needs a signed-in browser, not an API token
    async function issue(userId: string, actor = admin) {
      const { headers } = await seedSession(actor.userId);
      return app.inject({ method: 'POST', url: `/api/team/members/${userId}/password-reset`, headers });
    }
    const tokenOf = (link: string) => link.split('/reset-password/')[1]!;

    it('issues a one-time link that sets the password and ends every session', async () => {
      const member = await seedPerson(orgId, 'operator');
      await seedSession(member.userId);

      const issued = await issue(member.userId);
      expect(issued.statusCode).toBe(201);
      const { link } = issued.json();
      expect(link).toMatch(/^http:\/\/localhost:8080\/reset-password\//);
      const token = tokenOf(link);

      // Only a hash is stored
      const row = getDb().select().from(passwordResets).where(eq(passwordResets.userId, member.userId)).get()!;
      expect(row.tokenHash).not.toContain(token);

      const preview = await app.inject({ method: 'GET', url: `/api/password-reset/${token}` });
      expect(preview.json()).toMatchObject({ state: 'valid' });
      expect(preview.json().emailHint).not.toBe(member.email);

      const short = await app.inject({ method: 'POST', url: `/api/password-reset/${token}`, payload: { password: 'short' } });
      expect(short.statusCode).toBe(400);

      const used = await app.inject({
        method: 'POST',
        url: `/api/password-reset/${token}`,
        payload: { password: 'brand-new-password' },
      });
      expect(used.statusCode).toBe(200);
      expect(sessionCount(member.userId)).toBe(0);

      const stored = getDb().select().from(users).where(eq(users.id, member.userId)).get()!;
      expect(await verifyPassword('brand-new-password', stored.passwordHash!)).toBe(true);

      const reuse = await app.inject({
        method: 'POST',
        url: `/api/password-reset/${token}`,
        payload: { password: 'another-password' },
      });
      expect(reuse.statusCode).toBe(410);
      expect((await app.inject({ method: 'GET', url: `/api/password-reset/${token}` })).json().state).toBe('used');
      expect(auditActions(member.userId)).toEqual(
        expect.arrayContaining(['user.password_reset_issued', 'user.password_reset_used']),
      );
    });

    it('refuses an expired link', async () => {
      const member = await seedPerson(orgId, 'viewer');
      const token = tokenOf((await issue(member.userId)).json().link);
      getDb()
        .update(passwordResets)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(passwordResets.userId, member.userId))
        .run();

      const res = await app.inject({ method: 'POST', url: `/api/password-reset/${token}`, payload: { password: 'brand-new-password' } });
      expect(res.statusCode).toBe(410);
    });

    it('retires the previous link when a new one is issued', async () => {
      const member = await seedPerson(orgId, 'viewer');
      const first = tokenOf((await issue(member.userId)).json().link);
      await issue(member.userId);
      expect((await app.inject({ method: 'GET', url: `/api/password-reset/${first}` })).statusCode).toBe(404);
    });

    it('applies the rank guards and refuses members of other orgs', async () => {
      expect((await issue(owner.userId)).statusCode).toBe(403);
      expect((await issue(admin.userId)).statusCode).toBe(400);

      const shared = await seedPerson(orgId, 'viewer');
      addMembership(shared.userId, seedOrg('org-elsewhere'), 'owner');
      expect((await issue(shared.userId)).statusCode).toBe(409);
    });
  });

  describe('sessions', () => {
    it('lists own sessions without exposing the cookie value, and revokes them', async () => {
      const member = await seedPerson(orgId, 'operator');
      const current = await seedSession(member.userId);
      const other = await seedSession(member.userId);
      const third = await seedSession(member.userId);

      const list = await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: current.headers });
      expect(list.statusCode).toBe(200);
      const rows = list.json() as { id: string; current: boolean; userAgent: string }[];
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.current)).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(other.sessionId);
      expect(rows[0]!.userAgent).toBe('vitest');

      const target = rows.find((r) => !r.current)!;
      const del = await app.inject({ method: 'DELETE', url: `/api/auth/sessions/${target.id}`, headers: current.headers });
      expect(del.statusCode).toBe(204);
      expect(sessionCount(member.userId)).toBe(2);

      // Someone else's handle is not found
      const stranger = await seedSession(admin.userId);
      const foreign = await app.inject({ method: 'DELETE', url: `/api/auth/sessions/${target.id}`, headers: stranger.headers });
      expect(foreign.statusCode).toBe(404);

      const others = await app.inject({ method: 'DELETE', url: '/api/auth/sessions', headers: current.headers });
      expect(others.statusCode).toBe(200);
      const left = getDb().select().from(sessions).where(eq(sessions.userId, member.userId)).all();
      expect(left.map((s) => s.id)).toEqual([current.sessionId]);
      void third;
    });

    it('lets an admin sign a member out everywhere', async () => {
      const member = await seedPerson(orgId, 'viewer');
      await seedSession(member.userId);
      await seedSession(member.userId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/team/members/${member.userId}/sessions`,
        headers: admin.headers,
      });
      expect(res.json()).toEqual({ revoked: 2 });
      expect(sessionCount(member.userId)).toBe(0);

      const up = await app.inject({ method: 'DELETE', url: `/api/team/members/${owner.userId}/sessions`, headers: admin.headers });
      expect(up.statusCode).toBe(403);
    });

    it('throttles last-seen writes', () => {
      const member = seedUser(orgId, 'viewer');
      const id = nanoid();
      const seen = new Date().toISOString();
      getDb()
        .insert(sessions)
        .values({ id, userId: member.userId, expiresAt: new Date(Date.now() + 60_000).toISOString(), lastSeenAt: seen })
        .run();
      const lastSeen = () => getDb().select().from(sessions).where(eq(sessions.id, id)).get()!.lastSeenAt;

      touchSession({ id, lastSeenAt: seen }, '10.0.0.1', new Date(Date.parse(seen) + 1000));
      expect(lastSeen()).toBe(seen);
      const later = new Date(Date.parse(seen) + LAST_SEEN_THROTTLE_MS + 1);
      touchSession({ id, lastSeenAt: seen }, '10.0.0.1', later);
      expect(lastSeen()).toBe(later.toISOString());
    });

    it('records login and logout in the audit log', async () => {
      const member = await seedPerson(orgId, 'viewer');
      const signIn = await login(member.email, member.password);
      expect(signIn.statusCode).toBe(200);
      const cookie = signIn.cookies.find((c) => c.name === 'smt_session')!.value;
      const row = getDb().select().from(sessions).where(eq(sessions.id, cookie)).get()!;
      expect(row.activeOrgId).toBe(orgId);

      await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: `smt_session=${cookie}` } });
      expect(auditActions(member.userId)).toEqual(expect.arrayContaining(['user.login', 'user.logout']));
    });
  });

  describe('inviting an existing account', () => {
    let otherOrg: string;
    let otherAdmin: ReturnType<typeof seedUser>;

    beforeAll(() => {
      otherOrg = seedOrg('org-inviter');
      otherAdmin = seedUser(otherOrg, 'admin');
    });

    const invite = async (email: string, role = 'operator') =>
      app.inject({ method: 'POST', url: '/api/team/invites', headers: otherAdmin.headers, payload: { email, role } });
    const tokenOf = (link: string) => link.split('/invite/')[1]!;
    const accept = (token: string, payload: object, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, headers, payload });

    it('still refuses someone who is already a member', async () => {
      const existing = await seedPerson(otherOrg, 'viewer');
      expect((await invite(existing.email)).statusCode).toBe(409);
    });

    it('joins with the account password and leaves the password alone', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const created = await invite(person.email.toUpperCase());
      expect(created.statusCode).toBe(201);
      expect(created.json().existingAccount).toBe(true);
      const token = tokenOf(created.json().link);

      // The public preview does not reveal whether the address has an account
      const preview = await app.inject({ method: 'GET', url: `/api/invites/${token}` });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).not.toHaveProperty('existingAccount');

      expect((await accept(token, {})).statusCode).toBe(401);
      expect((await accept(token, { email: person.email, password: 'wrong-password' })).statusCode).toBe(401);
      // A new-account payload must not overwrite the existing password
      expect(
        (await accept(token, { email: person.email, displayName: 'x', password: 'attacker-password' })).statusCode,
      ).toBe(401);

      const ok = await accept(token, { email: person.email, password: person.password });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().orgId).toBe(otherOrg);

      const joined = getDb()
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, person.userId), eq(memberships.orgId, otherOrg)))
        .get();
      expect(joined?.role).toBe('operator');
      const stored = getDb().select().from(users).where(eq(users.id, person.userId)).get()!;
      expect(await verifyPassword(person.password, stored.passwordHash!)).toBe(true);
    });

    it('requires a signed-in session to be the invited account', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const token = tokenOf((await invite(person.email)).json().link);

      const wrong = await seedSession(admin.userId);
      const refused = await accept(token, {}, wrong.headers);
      expect(refused.statusCode).toBe(403);

      const right = await seedSession(person.userId);
      const ok = await accept(token, {}, right.headers);
      expect(ok.statusCode).toBe(201);
      // The browser lands in the org it just joined
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: right.headers });
      expect(me.json().orgId).toBe(otherOrg);
    });

    it('keeps the new-account path working', async () => {
      const email = `new-${nanoid(6).toLowerCase()}@corp.test`;
      const created = await invite(email);
      expect(created.json().existingAccount).toBe(false);
      const res = await accept(tokenOf(created.json().link), { email, displayName: 'New', password: 'new-password' });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('org switching', () => {
    it('lists orgs and remembers the choice on the session', async () => {
      const person = await seedPerson(orgId, 'operator');
      const second = seedOrg('org-second');
      addMembership(person.userId, second, 'admin');
      const browser = await seedSession(person.userId);

      const orgs = (await app.inject({ method: 'GET', url: '/api/auth/orgs', headers: browser.headers })).json();
      expect(orgs).toHaveLength(2);
      expect(orgs.find((o: { current: boolean }) => o.current).orgId).toBe(orgId);

      const switched = await app.inject({
        method: 'POST',
        url: '/api/auth/switch-org',
        headers: browser.headers,
        payload: { orgId: second },
      });
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({ orgId: second, role: 'admin' });

      const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: browser.headers })).json();
      expect(me).toMatchObject({ orgId: second, role: 'admin' });

      const stranger = await app.inject({
        method: 'POST',
        url: '/api/auth/switch-org',
        headers: browser.headers,
        payload: { orgId: seedOrg('org-not-mine') },
      });
      expect(stranger.statusCode).toBe(404);

      const viaToken = await app.inject({
        method: 'POST',
        url: '/api/auth/switch-org',
        headers: person.headers,
        payload: { orgId: second },
      });
      expect(viaToken.statusCode).toBe(400);
    });

    it('falls back when the active org suspends the member', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const second = seedOrg('org-fallback');
      const secondAdmin = seedUser(second, 'admin');
      addMembership(person.userId, second, 'viewer');
      const browser = await seedSession(person.userId);
      await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: browser.headers, payload: { orgId: second } });

      // Suspension ends the session; a new one lands in the org still open to them
      await app.inject({ method: 'POST', url: `/api/team/members/${person.userId}/suspend`, headers: secondAdmin.headers });
      const again = await seedSession(person.userId);
      const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: again.headers })).json();
      expect(me.orgId).toBe(orgId);

      const blocked = await app.inject({
        method: 'POST',
        url: '/api/auth/switch-org',
        headers: again.headers,
        payload: { orgId: second },
      });
      expect(blocked.statusCode).toBe(403);
    });
  });

  describe('rank guards for account actions', () => {
    const act = (method: 'POST' | 'DELETE', path: string, headers: Record<string, string>) =>
      app.inject({ method, url: `/api/team/members/${path}`, headers });
    // Password resets need a signed-in browser, not an API token
    const browser = async (user: { userId: string }) => (await seedSession(user.userId)).headers;

    it('stops an admin suspending, reactivating, signing out or resetting another admin', async () => {
      const org = seedOrg('org-peer-admins');
      const a = seedUser(org, 'admin');
      const b = seedUser(org, 'admin');
      seedUser(org, 'owner');

      expect((await act('POST', `${b.userId}/suspend`, a.headers)).statusCode).toBe(403);
      expect((await act('POST', `${b.userId}/reactivate`, a.headers)).statusCode).toBe(403);
      expect((await act('DELETE', `${b.userId}/sessions`, a.headers)).statusCode).toBe(403);
      expect((await act('POST', `${b.userId}/password-reset`, await browser(a))).statusCode).toBe(403);

      // Still fine on someone below them
      const op = seedUser(org, 'operator');
      expect((await act('POST', `${op.userId}/suspend`, a.headers)).statusCode).toBe(200);
      expect((await act('POST', `${op.userId}/reactivate`, a.headers)).statusCode).toBe(200);
      expect((await act('DELETE', `${op.userId}/sessions`, a.headers)).statusCode).toBe(200);
    });

    it('lets an owner act on an admin, and on another owner except for a password reset', async () => {
      const org = seedOrg('org-owner-peers');
      const a = seedUser(org, 'owner');
      const b = seedUser(org, 'owner');
      const orgAdmin = seedUser(org, 'admin');

      expect((await act('POST', `${orgAdmin.userId}/password-reset`, await browser(a))).statusCode).toBe(201);
      expect((await act('DELETE', `${b.userId}/sessions`, a.headers)).statusCode).toBe(200);
      expect((await act('POST', `${b.userId}/suspend`, a.headers)).statusCode).toBe(200);
      expect((await act('POST', `${b.userId}/reactivate`, a.headers)).statusCode).toBe(200);
      // Nobody can take over an owner's account through a reset link
      const reset = await act('POST', `${b.userId}/password-reset`, await browser(a));
      expect(reset.statusCode).toBe(403);
      expect(reset.json().error).toMatch(/owner/);
    });

    it('keeps an owner able to lock out nobody but others', async () => {
      const org = seedOrg('org-last-owner');
      const a = seedUser(org, 'owner');
      const b = seedUser(org, 'owner');
      expect((await act('POST', `${a.userId}/suspend`, a.headers)).statusCode).toBe(400);
      expect((await act('POST', `${b.userId}/suspend`, a.headers)).statusCode).toBe(200);
      // b is suspended and cannot act back on the last active owner
      expect((await act('POST', `${a.userId}/suspend`, b.headers)).statusCode).toBe(403);
    });

    const changeRole = (userId: string, role: string, headers: Record<string, string>) =>
      app.inject({ method: 'PATCH', url: `/api/team/members/${userId}`, headers, payload: { role } });
    const roleOf = (org: string, userId: string) =>
      getDb()
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.orgId, org)))
        .get()?.role;

    it('stops an admin demoting or removing another admin', async () => {
      const org = seedOrg('org-peer-admin-roles');
      const a = seedUser(org, 'admin');
      const b = seedUser(org, 'admin');
      seedUser(org, 'owner');

      const demote = await changeRole(b.userId, 'viewer', a.headers);
      expect(demote.statusCode).toBe(403);
      expect(demote.json().error).toMatch(/as much access as you/);
      expect((await act('DELETE', b.userId, a.headers)).statusCode).toBe(403);
      expect(roleOf(org, b.userId)).toBe('admin');

      // Promoting someone below them to their own rank is still fine
      const op = seedUser(org, 'operator');
      expect((await changeRole(op.userId, 'admin', a.headers)).statusCode).toBe(200);
      expect(roleOf(org, op.userId)).toBe('admin');
      // ...after which they are peers, and the same rule applies
      expect((await changeRole(op.userId, 'operator', a.headers)).statusCode).toBe(403);

      const viewer = seedUser(org, 'viewer');
      expect((await changeRole(viewer.userId, 'operator', a.headers)).statusCode).toBe(200);
      expect((await act('DELETE', viewer.userId, a.headers)).statusCode).toBe(204);
    });

    it('stops an admin acting on an owner', async () => {
      const org = seedOrg('org-admin-vs-owner');
      const a = seedUser(org, 'admin');
      const o = seedUser(org, 'owner');
      expect((await changeRole(o.userId, 'admin', a.headers)).statusCode).toBe(403);
      expect((await act('DELETE', o.userId, a.headers)).statusCode).toBe(403);
      expect(roleOf(org, o.userId)).toBe('owner');
    });

    it('lets an owner demote or remove another owner, but never the last one', async () => {
      const org = seedOrg('org-owner-roles');
      const a = seedUser(org, 'owner');
      const b = seedUser(org, 'owner');
      const c = seedUser(org, 'owner');

      expect((await changeRole(b.userId, 'admin', a.headers)).statusCode).toBe(200);
      expect(roleOf(org, b.userId)).toBe('admin');
      expect((await act('DELETE', c.userId, a.headers)).statusCode).toBe(204);

      // a is now the only owner: nobody can remove or demote them, not even themselves
      expect((await changeRole(a.userId, 'admin', a.headers)).statusCode).toBe(400);
      expect((await act('DELETE', a.userId, a.headers)).statusCode).toBe(400);
      expect((await changeRole(a.userId, 'admin', b.headers)).statusCode).toBe(403);
      expect((await act('DELETE', a.userId, b.headers)).statusCode).toBe(403);
      expect(roleOf(org, a.userId)).toBe('owner');
    });
  });

  describe('password reset redemption re-checks membership', () => {
    const tokenOf = (link: string) => link.split('/reset-password/')[1]!;
    const issue = async (userId: string) =>
      tokenOf(
        (
          await app.inject({
            method: 'POST',
            url: `/api/team/members/${userId}/password-reset`,
            headers: (await seedSession(admin.userId)).headers,
          })
        ).json().link,
      );
    const redeem = (token: string) =>
      app.inject({ method: 'POST', url: `/api/password-reset/${token}`, payload: { password: 'brand-new-password' } });
    const openResets = (userId: string) =>
      getDb().select().from(passwordResets).where(eq(passwordResets.userId, userId)).all();

    it('refuses and voids a link once the member is suspended', async () => {
      const member = await seedPerson(orgId, 'viewer');
      const token = await issue(member.userId);
      await app.inject({ method: 'POST', url: `/api/team/members/${member.userId}/suspend`, headers: admin.headers });

      const res = await redeem(token);
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toMatch(/membership/);
      // Voided for good, even after reactivation
      await app.inject({ method: 'POST', url: `/api/team/members/${member.userId}/reactivate`, headers: admin.headers });
      expect((await redeem(token)).statusCode).toBe(404);
      const stored = getDb().select().from(users).where(eq(users.id, member.userId)).get()!;
      expect(await verifyPassword(member.password, stored.passwordHash!)).toBe(true);
    });

    it('refuses a link once the account belongs to another org', async () => {
      const member = await seedPerson(orgId, 'viewer');
      const token = await issue(member.userId);
      addMembership(member.userId, seedOrg('org-joined-later'), 'owner');

      const res = await redeem(token);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/more than one organization/);
      expect(openResets(member.userId)).toHaveLength(0);
      const stored = getDb().select().from(users).where(eq(users.id, member.userId)).get()!;
      expect(await verifyPassword(member.password, stored.passwordHash!)).toBe(true);
    });

    it('deletes open links when the member is removed', async () => {
      const member = await seedPerson(orgId, 'viewer');
      const token = await issue(member.userId);
      const del = await app.inject({ method: 'DELETE', url: `/api/team/members/${member.userId}`, headers: admin.headers });
      expect(del.statusCode).toBe(204);
      expect(openResets(member.userId)).toHaveLength(0);
      expect((await redeem(token)).statusCode).toBe(404);
    });

    it('deletes open links when the account accepts an invite to another org', async () => {
      const member = await seedPerson(orgId, 'viewer');
      const token = await issue(member.userId);
      const otherOrg = seedOrg('org-invites-member');
      const otherAdmin = seedUser(otherOrg, 'admin');
      const link = (
        await app.inject({
          method: 'POST',
          url: '/api/team/invites',
          headers: otherAdmin.headers,
          payload: { email: member.email, role: 'viewer' },
        })
      ).json().link as string;
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/invites/${link.split('/invite/')[1]}/accept`,
        payload: { email: member.email, password: member.password },
      });
      expect(accepted.statusCode).toBe(201);
      expect(openResets(member.userId)).toHaveLength(0);
      expect((await redeem(token)).statusCode).toBe(404);
    });
  });
});
