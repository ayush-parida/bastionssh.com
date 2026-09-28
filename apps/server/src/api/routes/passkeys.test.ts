import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, memberships, organizations, passkeys, sessions, users, webauthnChallenges } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { addMembership, seedOrg, seedSession, seedUser } from './test-utils.js';

/**
 * A stand-in for @simplewebauthn/server that keeps the parts the routes rely
 * on: challenges are fresh per call, a response only verifies against the
 * challenge and credential it names, and a counter that fails to advance is
 * rejected the way the library rejects it.
 */
const fake = vi.hoisted(() => {
  let n = 0;
  return {
    nextChallenge: () => `challenge-${++n}`,
    verifyCalls: [] as { requireUserVerification?: boolean; expectedOrigin: unknown; expectedRPID: unknown }[],
    revokeLiveAccess: vi.fn((_userId: string, _scope?: { orgId?: string }) => ({ terminals: 1, sftp: 0, agents: 0 })),
    sendEmail: vi.fn(async (_msg: { to: string[]; subject: string; text: string }) => {}),
  };
});

// Live terminals and agent streams are per user; record who would lose them
vi.mock('../../auth/revoke.js', () => ({ revokeLiveAccess: fake.revokeLiveAccess }));

// As if SMTP were configured, so the passkey-added notice is sent
vi.mock('../../notifications/email.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../notifications/email.js')>()),
  emailAvailable: () => true,
  sendEmail: fake.sendEmail,
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: async (opts: { rpID: string; allowCredentials?: unknown; userVerification?: string }) => ({
    challenge: fake.nextChallenge(),
    rpId: opts.rpID,
    allowCredentials: opts.allowCredentials,
    userVerification: opts.userVerification,
  }),
  generateRegistrationOptions: async (opts: {
    rpID: string;
    rpName: string;
    userName: string;
    excludeCredentials?: unknown;
    authenticatorSelection?: unknown;
  }) => ({
    challenge: fake.nextChallenge(),
    rp: { id: opts.rpID, name: opts.rpName },
    user: { name: opts.userName },
    excludeCredentials: opts.excludeCredentials,
    authenticatorSelection: opts.authenticatorSelection,
  }),
  verifyAuthenticationResponse: async (opts: {
    response: { id: string; challenge: string; counter: number };
    expectedChallenge: string;
    credential: { id: string; counter: number };
    requireUserVerification?: boolean;
    expectedOrigin: unknown;
    expectedRPID: unknown;
  }) => {
    fake.verifyCalls.push(opts);
    const { response, credential } = opts;
    if ((response.counter > 0 || credential.counter > 0) && response.counter <= credential.counter) {
      throw new Error(`Response counter value ${response.counter} was lower than expected ${credential.counter}`);
    }
    return {
      verified: response.challenge === opts.expectedChallenge && response.id === credential.id,
      authenticationInfo: {
        credentialID: response.id,
        newCounter: response.counter,
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        origin: 'http://localhost:8080',
        rpID: 'localhost',
      },
    };
  },
  verifyRegistrationResponse: async (opts: {
    response: { id: string; challenge: string };
    expectedChallenge: string;
    requireUserVerification?: boolean;
  }) => {
    if (opts.response.challenge !== opts.expectedChallenge || opts.requireUserVerification !== true) {
      return { verified: false };
    }
    return {
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: { id: opts.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
        credentialType: 'public-key',
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        origin: 'http://localhost:8080',
      },
    };
  },
}));

type Role = 'owner' | 'admin' | 'operator' | 'viewer';
type Headers = Record<string, string>;

describe('passkeys', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  // Sign-in routes are rate-limited per address; give each call its own
  let address = 0;
  const from = () => `10.9.${Math.floor(++address / 250)}.${address % 250}`;

  async function seedPerson(orgId: string, role: Role, password = 'the-password') {
    const member = seedUser(orgId, role);
    const email = `${nanoid(8).toLowerCase()}@corp.test`;
    getDb()
      .update(users)
      .set({ email, passwordHash: await hashPassword(password) })
      .where(eq(users.id, member.userId))
      .run();
    return { ...member, email, password };
  }

  function addPasskey(userId: string, counter = 0) {
    const credentialId = `cred-${nanoid(10)}`;
    getDb()
      .insert(passkeys)
      .values({
        id: nanoid(),
        userId,
        credentialId,
        publicKey: Buffer.from([1, 2, 3]),
        counter,
        transports: '["internal"]',
        deviceType: 'multiDevice',
        backedUp: true,
        name: 'Laptop',
      })
      .run();
    return credentialId;
  }

  /** A browser session already verified with a passkey. */
  async function verifiedSession(userId: string) {
    const s = await seedSession(userId);
    getDb().update(sessions).set({ passkeyVerified: true }).where(eq(sessions.id, s.sessionId)).run();
    return s;
  }

  const requirePasskeys = (orgId: string, on = true) =>
    getDb().update(organizations).set({ requirePasskey: on }).where(eq(organizations.id, orgId)).run();

  const post = (url: string, payload: unknown, headers: Headers = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers, remoteAddress: from() });

  const get = (url: string, headers: Headers) => app.inject({ method: 'GET', url, headers });

  const login = (email: string, password: string) => post('/api/auth/login', { email, password });

  const assertion = (id: string, challenge: string, counter = 1) => ({ id, rawId: id, type: 'public-key', challenge, counter });

  function cookieOf(res: { cookies: { name: string; value: string }[] }) {
    const value = res.cookies.find((c) => c.name === 'smt_session')?.value;
    return value ? { sessionId: value, headers: { cookie: `smt_session=${value}` } } : null;
  }

  const sessionRow = (id: string) => getDb().select().from(sessions).where(eq(sessions.id, id)).get();
  const sessionsOf = (userId: string) => getDb().select().from(sessions).where(eq(sessions.userId, userId)).all();
  const passkeyRows = (userId: string) => getDb().select().from(passkeys).where(eq(passkeys.userId, userId)).all();
  const auditActions = (resourceId: string) =>
    getDb()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resourceId, resourceId))
      .all()
      .map((a) => a.action);

  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('password login with a passkey as second factor', () => {
    let orgId: string;
    beforeAll(() => {
      orgId = seedOrg('pk-login');
    });

    it('holds back the session until the passkey answers the ticket', async () => {
      const person = await seedPerson(orgId, 'operator');
      const cred = addPasskey(person.userId, 4);

      const first = await login(person.email, person.password);
      expect(first.statusCode).toBe(200);
      const step = first.json();
      expect(step.step).toBe('passkey');
      expect(step.options.allowCredentials).toEqual([{ id: cred, transports: ['internal'] }]);
      expect(step.options.userVerification).toBe('required');
      expect(cookieOf(first)).toBeNull();
      expect(sessionsOf(person.userId)).toHaveLength(0);
      // Only the hash of the ticket is stored
      const stored = getDb()
        .select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.userId, person.userId))
        .get();
      expect(stored?.ticketHash).toBeTruthy();
      expect(stored?.ticketHash).not.toBe(step.ticket);

      const done = await post('/api/auth/login/passkey', {
        ticket: step.ticket,
        response: assertion(cred, step.options.challenge, 5),
      });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({ orgId, role: 'operator', passkeyVerified: true, passkeyEnrollmentRequired: false });
      const session = cookieOf(done)!;
      expect(sessionRow(session.sessionId)?.passkeyVerified).toBe(true);
      expect(fake.verifyCalls.at(-1)).toMatchObject({
        requireUserVerification: true,
        expectedOrigin: ['http://localhost:8080'],
        expectedRPID: 'localhost',
      });

      // The counter moves forward and the use is recorded
      const [row] = passkeyRows(person.userId);
      expect(row?.counter).toBe(5);
      expect(row?.lastUsedAt).toBeTruthy();
      expect(auditActions(person.userId)).toContain('user.login_passkey');

      const me = await get('/api/auth/me', session.headers);
      expect(me.json()).toMatchObject({ passkeyVerified: true, requirePasskey: false, passkeyCount: 1 });
    });

    it('uses a ticket once, even when the attempt fails', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const cred = addPasskey(person.userId);
      const step = (await login(person.email, person.password)).json();

      const wrong = await post('/api/auth/login/passkey', { ticket: step.ticket, response: assertion(cred, 'not-it') });
      expect(wrong.statusCode).toBe(401);
      const retry = await post('/api/auth/login/passkey', {
        ticket: step.ticket,
        response: assertion(cred, step.options.challenge),
      });
      expect(retry.statusCode).toBe(401);
      expect(sessionsOf(person.userId)).toHaveLength(0);

      const again = (await login(person.email, person.password)).json();
      const ok = await post('/api/auth/login/passkey', {
        ticket: again.ticket,
        response: assertion(cred, again.options.challenge),
      });
      expect(ok.statusCode).toBe(200);
      const replay = await post('/api/auth/login/passkey', {
        ticket: again.ticket,
        response: assertion(cred, again.options.challenge, 2),
      });
      expect(replay.statusCode).toBe(401);
    });

    it('refuses an expired ticket', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const cred = addPasskey(person.userId);
      const step = (await login(person.email, person.password)).json();
      getDb()
        .update(webauthnChallenges)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(webauthnChallenges.userId, person.userId))
        .run();

      const res = await post('/api/auth/login/passkey', {
        ticket: step.ticket,
        response: assertion(cred, step.options.challenge),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatch(/expired/);
    });

    it("does not accept someone else's passkey for the ticket", async () => {
      const person = await seedPerson(orgId, 'viewer');
      addPasskey(person.userId);
      const other = await seedPerson(orgId, 'viewer');
      const otherCred = addPasskey(other.userId);
      const step = (await login(person.email, person.password)).json();

      const res = await post('/api/auth/login/passkey', {
        ticket: step.ticket,
        response: assertion(otherCred, step.options.challenge),
      });
      expect(res.statusCode).toBe(401);
    });

    it('refuses a counter that did not advance', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const cred = addPasskey(person.userId, 10);
      const step = (await login(person.email, person.password)).json();

      const res = await post('/api/auth/login/passkey', {
        ticket: step.ticket,
        response: assertion(cred, step.options.challenge, 9),
      });
      expect(res.statusCode).toBe(401);
      expect(passkeyRows(person.userId)[0]?.counter).toBe(10);
    });

    it('gives a password-only account a session as before', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const res = await login(person.email, person.password);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ passkeyVerified: false, passkeyEnrollmentRequired: false });
      expect(sessionRow(cookieOf(res)!.sessionId)?.passkeyVerified).toBe(false);
    });
  });

  describe('passwordless sign-in', () => {
    let orgId: string;
    beforeAll(() => {
      orgId = seedOrg('pk-passwordless');
    });

    async function options() {
      const res = await post('/api/auth/passkey/options', {});
      expect(res.statusCode).toBe(200);
      return res.json() as { challengeId: string; options: { challenge: string; allowCredentials?: unknown } };
    }

    it('signs in with a discoverable passkey alone', async () => {
      const person = await seedPerson(orgId, 'admin');
      const cred = addPasskey(person.userId);
      const { challengeId, options: opts } = await options();
      // Discoverable: the browser picks the account
      expect(opts.allowCredentials).toBeUndefined();

      const res = await post('/api/auth/passkey/verify', { challengeId, response: assertion(cred, opts.challenge) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ user: { id: person.userId }, orgId, role: 'admin', passkeyVerified: true });
      expect(sessionRow(cookieOf(res)!.sessionId)?.passkeyVerified).toBe(true);
      expect(passkeyRows(person.userId)[0]?.counter).toBe(1);
    });

    it('uses a challenge once, and not after it expires', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const cred = addPasskey(person.userId);

      const a = await options();
      expect((await post('/api/auth/passkey/verify', { challengeId: a.challengeId, response: assertion(cred, a.options.challenge, 1) })).statusCode).toBe(200);
      expect((await post('/api/auth/passkey/verify', { challengeId: a.challengeId, response: assertion(cred, a.options.challenge, 2) })).statusCode).toBe(401);

      const b = await options();
      getDb()
        .update(webauthnChallenges)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(webauthnChallenges.id, b.challengeId))
        .run();
      const late = await post('/api/auth/passkey/verify', { challengeId: b.challengeId, response: assertion(cred, b.options.challenge, 3) });
      expect(late.statusCode).toBe(401);
      expect(getDb().select().from(webauthnChallenges).where(eq(webauthnChallenges.id, b.challengeId)).get()).toBeUndefined();
    });

    it('prunes expired challenges when issuing new ones', async () => {
      getDb()
        .insert(webauthnChallenges)
        .values({ id: 'stale', challenge: 'x', purpose: 'login', expiresAt: '2000-01-01T00:00:00.000Z' })
        .run();
      await options();
      expect(getDb().select().from(webauthnChallenges).where(eq(webauthnChallenges.id, 'stale')).get()).toBeUndefined();
    });

    it('rejects an unknown credential', async () => {
      const { challengeId, options: opts } = await options();
      const res = await post('/api/auth/passkey/verify', { challengeId, response: assertion('cred-nobody', opts.challenge) });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatch(/not registered/);
    });

    it('rejects a counter regression', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const cred = addPasskey(person.userId, 7);
      const { challengeId, options: opts } = await options();
      const res = await post('/api/auth/passkey/verify', { challengeId, response: assertion(cred, opts.challenge, 7) });
      expect(res.statusCode).toBe(401);
    });

    it('refuses someone whose only membership is suspended', async () => {
      const person = await seedPerson(orgId, 'operator');
      const cred = addPasskey(person.userId);
      getDb()
        .update(memberships)
        .set({ status: 'suspended' })
        .where(and(eq(memberships.userId, person.userId), eq(memberships.orgId, orgId)))
        .run();

      const { challengeId, options: opts } = await options();
      const res = await post('/api/auth/passkey/verify', { challengeId, response: assertion(cred, opts.challenge) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/suspended/);
      expect(sessionsOf(person.userId)).toHaveLength(0);
    });
  });

  describe('org policy enforcement', () => {
    let orgId: string;
    beforeAll(() => {
      orgId = seedOrg('pk-enforced');
      requirePasskeys(orgId);
    });

    it('sends a password-only sign-in to enroll', async () => {
      const person = await seedPerson(orgId, 'operator');
      const res = await login(person.email, person.password);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ passkeyVerified: false, passkeyEnrollmentRequired: true });
    });

    it('refuses an unverified session everywhere but the allowlist', async () => {
      const person = await seedPerson(orgId, 'operator');
      const browser = await seedSession(person.userId);

      const blocked = await get('/api/servers', browser.headers);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe('PASSKEY_REQUIRED');
      expect((await get('/api/auth/sessions', browser.headers)).json().code).toBe('PASSKEY_REQUIRED');

      const me = await get('/api/auth/me', browser.headers);
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ passkeyVerified: false, requirePasskey: true, passkeyCount: 0 });
      expect((await get('/api/auth/orgs', browser.headers)).statusCode).toBe(200);
      expect((await post('/api/auth/switch-org', { orgId }, browser.headers)).statusCode).toBe(200);
      expect(
        (await post('/api/auth/passkeys/register/options', { currentPassword: person.password }, browser.headers)).statusCode,
      ).toBe(200);
      expect((await post('/api/auth/logout', {}, browser.headers)).statusCode).toBe(200);
    });

    it('lets verified sessions through', async () => {
      const person = await seedPerson(orgId, 'operator');
      addPasskey(person.userId);
      const browser = await verifiedSession(person.userId);
      expect((await get('/api/servers', browser.headers)).statusCode).toBe(200);
    });

    it('refuses API tokens not minted from a passkey-verified session', async () => {
      const person = await seedPerson(orgId, 'operator');
      // seedUser's token predates any passkey
      const old = await get('/api/servers', person.headers);
      expect(old.statusCode).toBe(403);
      expect(old.json()).toMatchObject({ code: 'PASSKEY_REQUIRED', error: expect.stringMatching(/new token/) });
      expect((await get('/api/auth/me', person.headers)).statusCode).toBe(403);

      addPasskey(person.userId);
      const browser = await verifiedSession(person.userId);
      const minted = await post('/api/tokens', { name: 'ci', scopes: ['read'] }, browser.headers);
      expect(minted.statusCode).toBe(201);
      expect(minted.json().passkeyVerified).toBe(true);
      const res = await get('/api/servers', { authorization: `Bearer ${minted.json().token}` });
      expect(res.statusCode).toBe(200);
    });

    it('keeps a token from a relaxed org unverified, so it cannot act in a strict one', async () => {
      const relaxed = seedOrg('pk-token-relaxed');
      const person = await seedPerson(relaxed, 'operator');
      const minted = await post('/api/tokens', { name: 'ci', scopes: ['read'] }, (await seedSession(person.userId)).headers);
      expect(minted.statusCode).toBe(201);
      expect(minted.json().passkeyVerified).toBe(false);
      const bearer = { authorization: `Bearer ${minted.json().token}` };
      expect((await get('/api/servers', bearer)).statusCode).toBe(200);

      // Moved to a strict org: the same token no longer works
      addMembership(person.userId, orgId, 'operator');
      getDb()
        .delete(memberships)
        .where(and(eq(memberships.userId, person.userId), eq(memberships.orgId, relaxed)))
        .run();
      const res = await get('/api/servers', bearer);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('PASSKEY_REQUIRED');
    });

    it('only applies in the org that requires it', async () => {
      const person = await seedPerson(orgId, 'operator');
      const relaxed = seedOrg('pk-relaxed');
      addMembership(person.userId, relaxed, 'operator');
      const browser = await seedSession(person.userId);

      expect((await post('/api/auth/switch-org', { orgId: relaxed }, browser.headers)).statusCode).toBe(200);
      expect((await get('/api/servers', browser.headers)).statusCode).toBe(200);
      // ...and minting a token there still needs a passkey, since a token is not tied to one org
      const token = await post('/api/tokens', { name: 'ci', scopes: ['read'] }, browser.headers);
      expect(token.statusCode).toBe(403);
      expect(token.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');
    });

    it('lets a verified session create API tokens', async () => {
      const person = await seedPerson(orgId, 'operator');
      addPasskey(person.userId);
      const browser = await verifiedSession(person.userId);
      expect((await post('/api/tokens', { name: 'ci', scopes: ['read'] }, browser.headers)).statusCode).toBe(201);
    });
  });

  describe('registration', () => {
    let orgId: string;
    beforeAll(() => {
      orgId = seedOrg('pk-register');
      requirePasskeys(orgId);
    });

    const PASSWORD = 'the-password';
    const credential = (id: string, challenge: string) => ({ id, rawId: id, type: 'public-key', challenge });

    async function register(headers: Headers, credentialId = `cred-${nanoid(8)}`, name?: string) {
      const opts = await post('/api/auth/passkeys/register/options', { currentPassword: PASSWORD }, headers);
      if (opts.statusCode !== 200) return opts;
      const { challengeId, options } = opts.json();
      return post(
        '/api/auth/passkeys/register/verify',
        { challengeId, name, currentPassword: PASSWORD, response: credential(credentialId, options.challenge) },
        headers,
      );
    }

    it('enrolls a first passkey with the password, verifies the session and ends other password-only ones', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const browser = await seedSession(person.userId);
      const otherUnverified = await seedSession(person.userId);
      const otherVerified = await verifiedSession(person.userId);
      fake.revokeLiveAccess.mockClear();
      fake.sendEmail.mockClear();

      const opts = await post('/api/auth/passkeys/register/options', { currentPassword: PASSWORD }, browser.headers);
      expect(opts.statusCode).toBe(200);
      expect(opts.json().options).toMatchObject({
        rp: { id: 'localhost', name: 'BastionSSH' },
        user: { name: person.email },
        excludeCredentials: [],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });

      const res = await post(
        '/api/auth/passkeys/register/verify',
        {
          challengeId: opts.json().challengeId,
          name: 'MacBook',
          currentPassword: PASSWORD,
          response: credential('cred-first', opts.json().options.challenge),
        },
        browser.headers,
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ passkey: { name: 'MacBook', deviceType: 'multiDevice', backedUp: true }, passkeyVerified: true });
      expect(sessionRow(browser.sessionId)?.passkeyVerified).toBe(true);
      expect(passkeyRows(person.userId)[0]).toMatchObject({ credentialId: 'cred-first', transports: '["internal"]' });
      expect((await get('/api/servers', browser.headers)).statusCode).toBe(200);

      // Other password-only sessions are gone; a passkey-verified one stays
      expect(sessionRow(otherUnverified.sessionId)).toBeUndefined();
      expect(sessionRow(otherVerified.sessionId)).toBeDefined();
      expect(fake.revokeLiveAccess).toHaveBeenCalledWith(person.userId);

      const [row] = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.resourceId, passkeyRows(person.userId)[0]!.id), eq(auditLog.action, 'user.passkey_added')))
        .all();
      expect(JSON.parse(row!.metadata!)).toMatchObject({ firstPasskey: true, passwordConfirmed: true, otherSessionsRevoked: 1 });

      expect(fake.sendEmail).toHaveBeenCalledTimes(1);
      expect(fake.sendEmail.mock.calls[0]![0]).toMatchObject({ to: [person.email], subject: expect.stringMatching(/passkey was added/) });
    });

    it('needs the current password for a first passkey', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const browser = await seedSession(person.userId);

      const missing = await post('/api/auth/passkeys/register/options', {}, browser.headers);
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe('PASSWORD_REQUIRED');
      const wrong = await post('/api/auth/passkeys/register/options', { currentPassword: 'guess' }, browser.headers);
      expect(wrong.statusCode).toBe(403);

      // ...at verification too, not only when asking for options
      const opts = (await post('/api/auth/passkeys/register/options', { currentPassword: PASSWORD }, browser.headers)).json();
      const res = await post(
        '/api/auth/passkeys/register/verify',
        { challengeId: opts.challengeId, currentPassword: 'guess', response: credential('cred-np', opts.options.challenge) },
        browser.headers,
      );
      expect(res.statusCode).toBe(403);
      expect(passkeyRows(person.userId)).toHaveLength(0);
      expect(sessionRow(browser.sessionId)?.passkeyVerified).toBe(false);
    });

    it('needs a recent sign-in for a first passkey', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const browser = await seedSession(person.userId);
      getDb()
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() })
        .where(eq(sessions.id, browser.sessionId))
        .run();

      const res = await post('/api/auth/passkeys/register/options', { currentPassword: PASSWORD }, browser.headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('REAUTH_REQUIRED');
    });

    it('lets only one of two concurrent first enrollments through', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const a = await seedSession(person.userId);
      const b = await seedSession(person.userId);
      const optsA = (await post('/api/auth/passkeys/register/options', { currentPassword: PASSWORD }, a.headers)).json();
      const optsB = (await post('/api/auth/passkeys/register/options', { currentPassword: PASSWORD }, b.headers)).json();

      const results = await Promise.all([
        post(
          '/api/auth/passkeys/register/verify',
          { challengeId: optsA.challengeId, currentPassword: PASSWORD, response: credential('cred-race-a', optsA.options.challenge) },
          a.headers,
        ),
        post(
          '/api/auth/passkeys/register/verify',
          { challengeId: optsB.challengeId, currentPassword: PASSWORD, response: credential('cred-race-b', optsB.options.challenge) },
          b.headers,
        ),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403]);
      expect(passkeyRows(person.userId)).toHaveLength(1);
    });

    it('needs a verified session to add another, and excludes existing ones', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const existing = addPasskey(person.userId);
      const browser = await seedSession(person.userId);

      const refused = await post('/api/auth/passkeys/register/options', {}, browser.headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');

      // Step up with the existing passkey
      const up = await post('/api/auth/passkeys/step-up/options', {}, browser.headers);
      expect(up.statusCode).toBe(200);
      const verified = await post(
        '/api/auth/passkeys/step-up/verify',
        { challengeId: up.json().challengeId, response: assertion(existing, up.json().options.challenge) },
        browser.headers,
      );
      expect(verified.statusCode).toBe(200);
      expect(sessionRow(browser.sessionId)?.passkeyVerified).toBe(true);

      // No password needed once there is a passkey to confirm with
      const opts = await post('/api/auth/passkeys/register/options', {}, browser.headers);
      expect(opts.statusCode).toBe(200);
      expect(opts.json().options.excludeCredentials).toEqual([{ id: existing, transports: ['internal'] }]);
      expect((await register(browser.headers)).statusCode).toBe(201);
      expect(passkeyRows(person.userId)).toHaveLength(2);
    });

    it('binds a registration challenge to the session that asked for it', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const a = await seedSession(person.userId);
      const b = await seedSession(person.userId);
      const opts = (await post('/api/auth/passkeys/register/options', { currentPassword: PASSWORD }, a.headers)).json();

      const res = await post(
        '/api/auth/passkeys/register/verify',
        { challengeId: opts.challengeId, currentPassword: PASSWORD, response: credential('cred-x', opts.options.challenge) },
        b.headers,
      );
      expect(res.statusCode).toBe(400);
      expect(passkeyRows(person.userId)).toHaveLength(0);
    });

    it('refuses a registration answering a different challenge', async () => {
      const person = await seedPerson(orgId, 'viewer');
      const browser = await seedSession(person.userId);
      const opts = (await post('/api/auth/passkeys/register/options', { currentPassword: PASSWORD }, browser.headers)).json();
      const res = await post(
        '/api/auth/passkeys/register/verify',
        { challengeId: opts.challengeId, currentPassword: PASSWORD, response: credential('cred-y', 'something-else') },
        browser.headers,
      );
      expect(res.statusCode).toBe(400);
      expect(sessionRow(browser.sessionId)?.passkeyVerified).toBe(false);
    });

    it('is not available to API tokens', async () => {
      const person = await seedPerson(seedOrg('pk-register-token'), 'viewer');
      expect((await post('/api/auth/passkeys/register/options', {}, person.headers)).statusCode).toBe(403);
    });
  });

  describe('password and token changes with a passkey on the account', () => {
    it('need a passkey-verified session even without an org policy', async () => {
      const person = await seedPerson(seedOrg('pk-credentials'), 'viewer');
      addPasskey(person.userId);
      const plain = await seedSession(person.userId);

      const change = (headers: Headers) =>
        post('/api/auth/change-password', { currentPassword: person.password, newPassword: 'a-new-password' }, headers);
      const mint = (headers: Headers) => post('/api/tokens', { name: 'ci', scopes: ['read'] }, headers);

      for (const res of [await change(plain.headers), await mint(plain.headers)]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');
      }
      const verified = await verifiedSession(person.userId);
      expect((await mint(verified.headers)).statusCode).toBe(201);
      expect((await change(verified.headers)).statusCode).toBe(200);
    });
  });

  describe('managing passkeys', () => {
    it('lists and renames', async () => {
      const orgId = seedOrg('pk-manage');
      const person = await seedPerson(orgId, 'viewer');
      addPasskey(person.userId);
      const browser = await seedSession(person.userId);

      const list = await get('/api/auth/passkeys', browser.headers);
      expect(list.statusCode).toBe(200);
      const [pk] = list.json();
      expect(pk).toMatchObject({ name: 'Laptop', deviceType: 'multiDevice', backedUp: true, lastUsedAt: null });
      expect(pk).not.toHaveProperty('publicKey');
      expect(pk).not.toHaveProperty('credentialId');

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/auth/passkeys/${pk.id}`,
        headers: browser.headers,
        payload: { name: 'Work laptop' },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().name).toBe('Work laptop');
    });

    it('deletes only from a verified session, and never the last one under a policy', async () => {
      const orgId = seedOrg('pk-delete');
      const person = await seedPerson(orgId, 'viewer');
      addPasskey(person.userId);
      addPasskey(person.userId);
      const [first, second] = passkeyRows(person.userId);
      const del = (id: string, headers: Headers) =>
        app.inject({ method: 'DELETE', url: `/api/auth/passkeys/${id}`, headers });

      const unverified = await seedSession(person.userId);
      const refused = await del(first!.id, unverified.headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');
      expect((await del(first!.id, person.headers)).statusCode).toBe(403); // API token

      const browser = await verifiedSession(person.userId);
      requirePasskeys(orgId);
      expect((await del(first!.id, browser.headers)).statusCode).toBe(204);
      const last = await del(second!.id, browser.headers);
      expect(last.statusCode).toBe(409);
      expect(passkeyRows(person.userId)).toHaveLength(1);

      requirePasskeys(orgId, false);
      expect((await del(second!.id, browser.headers)).statusCode).toBe(204);
      expect(auditActions(first!.id)).toContain('user.passkey_removed');
    });
  });

  describe('org setting', () => {
    let orgId: string;
    let owner: Awaited<ReturnType<typeof seedPerson>>;
    beforeAll(async () => {
      orgId = seedOrg('pk-settings');
      owner = await seedPerson(orgId, 'owner');
    });

    const patch = (headers: Headers, requirePasskey: boolean) =>
      app.inject({ method: 'PATCH', url: '/api/team/settings', headers, payload: { requirePasskey } });

    it('shows who has no passkey to admins only', async () => {
      const withKey = await seedPerson(orgId, 'viewer');
      addPasskey(withKey.userId);
      await seedPerson(orgId, 'viewer');
      const admin = await seedPerson(orgId, 'admin');
      addPasskey(admin.userId);

      const forAdmin = await get('/api/team/settings', admin.headers);
      expect(forAdmin.statusCode).toBe(200);
      // The owner and the second viewer
      expect(forAdmin.json()).toEqual({ requirePasskey: false, backupCodeRecoveryOnly: true, membersWithoutPasskey: 2 });
      const adminList = (await get('/api/team/members', admin.headers)).json();
      expect(adminList.find((m: { userId: string }) => m.userId === withKey.userId).passkeyCount).toBe(1);

      const forViewer = await get('/api/team/settings', withKey.headers);
      expect(forViewer.json()).toEqual({ requirePasskey: false, backupCodeRecoveryOnly: true });
      const viewerList = (await get('/api/team/members', withKey.headers)).json();
      expect(viewerList.every((m: object) => !('passkeyCount' in m))).toBe(true);
    });

    it('is owner-only, and enabling needs the owner’s passkey-verified session', async () => {
      const admin = await seedPerson(orgId, 'admin');
      addPasskey(admin.userId);
      expect((await patch((await verifiedSession(admin.userId)).headers, true)).statusCode).toBe(403);

      // No passkey of their own yet
      const noKey = await patch((await seedSession(owner.userId)).headers, true);
      expect(noKey.statusCode).toBe(403);
      expect(noKey.json().error).toMatch(/Add a passkey/);

      addPasskey(owner.userId);
      expect((await patch(owner.headers, true)).statusCode).toBe(403); // API token
      expect((await patch((await seedSession(owner.userId)).headers, true)).statusCode).toBe(403);

      const ownerBrowser = await verifiedSession(owner.userId);
      const ok = await patch(ownerBrowser.headers, true);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().requirePasskey).toBe(true);
      expect(auditActions(orgId)).toContain('org.passkey_policy');

      // Turning it off does not need a step-up, but does need access to the org
      const off = await patch(ownerBrowser.headers, false);
      expect(off.statusCode).toBe(200);
      expect(off.json().requirePasskey).toBe(false);
    });

    it('ends live access for members with no passkey-verified session when enabled', async () => {
      const org = seedOrg('pk-settings-live');
      const boss = await seedPerson(org, 'owner');
      addPasskey(boss.userId);
      const bossBrowser = await verifiedSession(boss.userId);
      const verified = await seedPerson(org, 'operator');
      await verifiedSession(verified.userId);
      const unverified = await seedPerson(org, 'operator');
      await seedSession(unverified.userId);
      const signedOut = await seedPerson(org, 'viewer');
      fake.revokeLiveAccess.mockClear();

      expect((await patch(bossBrowser.headers, true)).statusCode).toBe(200);
      const revoked = fake.revokeLiveAccess.mock.calls.map(([userId, scope]) => ({ userId, scope }));
      expect(revoked).toEqual(
        expect.arrayContaining([
          { userId: unverified.userId, scope: { orgId: org } },
          { userId: signedOut.userId, scope: { orgId: org } },
        ]),
      );
      expect(revoked.map((r) => r.userId)).not.toContain(verified.userId);
      expect(revoked.map((r) => r.userId)).not.toContain(boss.userId);
    });
  });

  describe('admin passkey reset', () => {
    let orgId: string;
    let admin: Awaited<ReturnType<typeof seedPerson>>;
    let adminBrowser: Headers;
    beforeAll(async () => {
      orgId = seedOrg('pk-reset');
      admin = await seedPerson(orgId, 'admin');
      adminBrowser = (await seedSession(admin.userId)).headers;
    });

    const reset = (userId: string, headers: Headers) =>
      app.inject({ method: 'DELETE', url: `/api/team/members/${userId}/passkeys`, headers });
    const browser = async (user: { userId: string }) => (await seedSession(user.userId)).headers;

    it('removes the passkeys, ends sessions and pending sign-ins, and shows in the member list', async () => {
      const person = await seedPerson(orgId, 'operator');
      addPasskey(person.userId);
      addPasskey(person.userId);
      await seedSession(person.userId);
      await login(person.email, person.password); // leaves a pending ticket

      const members = (await get('/api/team/members', admin.headers)).json();
      expect(members.find((m: { userId: string }) => m.userId === person.userId).passkeyCount).toBe(2);

      const res = await reset(person.userId, adminBrowser);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: 2, revoked: 1 });
      expect(passkeyRows(person.userId)).toHaveLength(0);
      expect(sessionsOf(person.userId)).toHaveLength(0);
      expect(getDb().select().from(webauthnChallenges).where(eq(webauthnChallenges.userId, person.userId)).all()).toHaveLength(0);
      expect(auditActions(person.userId)).toContain('member.passkeys_reset');

      // Back in with the password alone, ready to enroll again
      const again = await login(person.email, person.password);
      expect(again.json()).toMatchObject({ passkeyVerified: false });
    });

    it('is not available to API tokens, for passkeys or password reset links', async () => {
      const person = await seedPerson(orgId, 'operator');
      addPasskey(person.userId);
      expect((await reset(person.userId, admin.headers)).statusCode).toBe(403);
      const link = await post(`/api/team/members/${person.userId}/password-reset`, {}, admin.headers);
      expect(link.statusCode).toBe(403);
      expect(passkeyRows(person.userId)).toHaveLength(1);
    });

    it('needs the actor to confirm their own passkey when they have one', async () => {
      const org = seedOrg('pk-reset-stepup');
      const actor = await seedPerson(org, 'admin');
      addPasskey(actor.userId);
      const person = await seedPerson(org, 'operator');
      addPasskey(person.userId);

      const plain = await browser(actor);
      for (const res of [
        await reset(person.userId, plain),
        await post(`/api/team/members/${person.userId}/password-reset`, {}, plain),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');
      }
      expect(passkeyRows(person.userId)).toHaveLength(1);

      const verified = (await verifiedSession(actor.userId)).headers;
      expect((await post(`/api/team/members/${person.userId}/password-reset`, {}, verified)).statusCode).toBe(201);
      expect((await reset(person.userId, verified)).statusCode).toBe(200);
    });

    it('needs a strictly higher rank', async () => {
      const peer = await seedPerson(orgId, 'admin');
      addPasskey(peer.userId);
      const owner = await seedPerson(orgId, 'owner');
      const otherOwner = await seedPerson(orgId, 'owner');
      const operator = await seedPerson(orgId, 'operator');

      expect((await reset(admin.userId, adminBrowser)).statusCode).toBe(400); // self
      expect((await reset(peer.userId, adminBrowser)).statusCode).toBe(403);
      expect((await reset(owner.userId, adminBrowser)).statusCode).toBe(403);
      expect((await reset(otherOwner.userId, await browser(owner))).statusCode).toBe(403);
      expect((await reset(peer.userId, await browser(operator))).statusCode).toBe(403);
      expect(passkeyRows(peer.userId)).toHaveLength(1);
      expect((await reset(peer.userId, await browser(owner))).statusCode).toBe(200);
    });

    it('refuses someone who also belongs to another org', async () => {
      const person = await seedPerson(orgId, 'viewer');
      addPasskey(person.userId);
      addMembership(person.userId, seedOrg('pk-reset-elsewhere'), 'owner');
      const res = await reset(person.userId, adminBrowser);
      expect(res.statusCode).toBe(409);
      expect(passkeyRows(person.userId)).toHaveLength(1);
    });
  });
});
