import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, loginFailures, passkeys, userDevices, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { accountKey, FAILED_LOGIN_THRESHOLD } from '../../auth/login-security.js';
import { seedOrg, seedSession, seedUser } from './test-utils.js';

const fake = vi.hoisted(() => {
  let n = 0;
  return {
    nextChallenge: () => `challenge-${++n}`,
    smtp: true,
    sendEmail: vi.fn(async (_msg: { to: string[]; subject: string; text: string }) => {}),
  };
});

vi.mock('../../auth/revoke.js', () => ({ revokeLiveAccess: () => ({ terminals: 0, sftp: 0, docker: 0, agents: 0 }) }));

vi.mock('../../notifications/email.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../notifications/email.js')>()),
  emailAvailable: () => fake.smtp,
  sendEmail: fake.sendEmail,
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: async (opts: { rpID: string; allowCredentials?: unknown }) => ({
    challenge: fake.nextChallenge(),
    rpId: opts.rpID,
    allowCredentials: opts.allowCredentials,
  }),
  generateRegistrationOptions: async () => ({ challenge: fake.nextChallenge() }),
  verifyAuthenticationResponse: async (opts: {
    response: { id: string; challenge: string; counter: number };
    expectedChallenge: string;
    credential: { id: string; counter: number };
  }) => ({
    verified: opts.response.challenge === opts.expectedChallenge && opts.response.id === opts.credential.id,
    authenticationInfo: { newCounter: opts.response.counter, credentialBackedUp: true },
  }),
  verifyRegistrationResponse: async () => ({ verified: false }),
}));

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const FIREFOX_LINUX_NEWER = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

describe('login security', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  // The login route is rate-limited per address; spread guesses over many
  let address = 0;
  const spread = () => `10.20.${Math.floor(++address / 250)}.${address % 250}`;

  async function seedPerson() {
    const member = seedUser(orgId, 'operator');
    const email = `${nanoid(8).toLowerCase()}@corp.test`;
    const password = 'the-password';
    getDb()
      .update(users)
      .set({ email, passwordHash: await hashPassword(password) })
      .where(eq(users.id, member.userId))
      .run();
    return { ...member, email, password };
  }

  const login = (email: string, password: string, ip = spread(), ua = FIREFOX_LINUX) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
      remoteAddress: ip,
      headers: { 'user-agent': ua },
    });

  const auditOf = (userId: string, action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, userId), eq(auditLog.action, action)))
      .all();

  const mailsAbout = (pattern: RegExp) => fake.sendEmail.mock.calls.filter((c) => pattern.test(c[0].subject));

  async function lockOut(email: string) {
    const results = [];
    for (let i = 0; i < FAILED_LOGIN_THRESHOLD; i++) results.push(await login(email, 'wrong-password'));
    return results;
  }

  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();
    orgId = seedOrg('login-security');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    fake.smtp = true;
    fake.sendEmail.mockClear();
  });

  describe('failed password attempts', () => {
    it('pauses password sign-in after repeated failures from any address, audits and emails the owner', async () => {
      const person = await seedPerson();
      const results = await lockOut(person.email);
      expect(results.slice(0, -1).map((r) => r.statusCode)).toEqual(Array(FAILED_LOGIN_THRESHOLD - 1).fill(401));
      const locked = results[results.length - 1]!;
      expect(locked.statusCode).toBe(429);
      expect(locked.json()).toMatchObject({ code: 'ACCOUNT_LOCKED', retryAfter: 60 });
      expect(locked.headers['retry-after']).toBe('60');

      // Even the right password is refused while paused, from a fresh address
      const right = await login(person.email, person.password);
      expect(right.statusCode).toBe(429);
      expect(right.cookies.find((c) => c.name === 'smt_session')).toBeUndefined();

      expect(auditOf(person.userId, 'user.login_failed')).toHaveLength(FAILED_LOGIN_THRESHOLD);
      const lockRows = auditOf(person.userId, 'user.login_locked');
      expect(lockRows).toHaveLength(1);
      expect(lockRows[0]!.orgId).toBe(orgId);
      expect(JSON.parse(lockRows[0]!.metadata!)).toMatchObject({ failures: 5, lockedForSeconds: 60, lockouts: 1 });

      const mails = mailsAbout(/Failed sign-in attempts/);
      expect(mails).toHaveLength(1);
      expect(mails[0]![0].to).toEqual([person.email]);
      expect(mails[0]![0].text).toContain('passkey still works');
    });

    it('treats an address with no account exactly the same, without auditing anything', async () => {
      const email = `${nanoid(8).toLowerCase()}@nobody.test`;
      const results = await lockOut(email);
      expect(results.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 429]);
      expect(results[4]!.json().code).toBe('ACCOUNT_LOCKED');
      expect(getDb().select().from(auditLog).all().filter((a) => a.actorEmail === email)).toHaveLength(0);
      expect(fake.sendEmail).not.toHaveBeenCalled();
    });

    it('stores only a keyed hash of the address', async () => {
      const email = `${nanoid(8).toLowerCase()}@nobody.test`;
      await login(email, 'wrong');
      const rows = getDb().select().from(loginFailures).all();
      expect(JSON.stringify(rows)).not.toContain(email);
      expect(rows.some((r) => r.accountKey === accountKey(email))).toBe(true);
      // Case and whitespace do not make a separate counter
      expect(accountKey(` ${email.toUpperCase()} `)).toBe(accountKey(email));
    });

    it('backs off exponentially on repeated pauses, and emails at most once an hour', async () => {
      const person = await seedPerson();
      await lockOut(person.email);
      const key = accountKey(person.email);
      // Let the first pause run out
      getDb()
        .update(loginFailures)
        .set({ lockedUntil: new Date(Date.now() - 1000).toISOString() })
        .where(eq(loginFailures.accountKey, key))
        .run();

      const second = (await lockOut(person.email))[FAILED_LOGIN_THRESHOLD - 1]!;
      expect(second.statusCode).toBe(429);
      expect(second.json().retryAfter).toBe(120);
      expect(auditOf(person.userId, 'user.login_locked')).toHaveLength(2);
      expect(mailsAbout(/Failed sign-in attempts/)).toHaveLength(1);
    });

    it('lets the right password in once the pause is over, and forgets the failures', async () => {
      const person = await seedPerson();
      await lockOut(person.email);
      const key = accountKey(person.email);
      getDb()
        .update(loginFailures)
        .set({ lockedUntil: new Date(Date.now() - 1000).toISOString() })
        .where(eq(loginFailures.accountKey, key))
        .run();

      expect((await login(person.email, person.password)).statusCode).toBe(200);
      expect(getDb().select().from(loginFailures).where(eq(loginFailures.accountKey, key)).get()).toBeUndefined();
    });

    it('does not count a correct password toward the pause', async () => {
      const person = await seedPerson();
      for (let i = 0; i < FAILED_LOGIN_THRESHOLD * 2; i++) {
        expect((await login(person.email, person.password)).statusCode).toBe(200);
      }
    });

    it('also pauses the password check on an invite for an existing account', async () => {
      const person = await seedPerson();
      // An admin of another org holds an invite link for the account's address
      const inviterOrg = seedOrg(`inviter-${nanoid(6)}`);
      const inviter = seedUser(inviterOrg, 'admin');
      const created = await app.inject({
        method: 'POST',
        url: '/api/team/invites',
        headers: inviter.headers,
        payload: { email: person.email, role: 'viewer' },
      });
      expect(created.statusCode).toBe(201);
      const token = (created.json().link as string).split('/invite/')[1]!;
      const accept = (password: string) =>
        app.inject({
          method: 'POST',
          url: `/api/invites/${token}/accept`,
          payload: { email: person.email, password },
          remoteAddress: spread(),
        });

      const results = [];
      for (let i = 0; i < FAILED_LOGIN_THRESHOLD; i++) results.push(await accept('wrong-password'));
      expect(results.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 429]);
      expect(auditOf(person.userId, 'user.login_failed')).toHaveLength(FAILED_LOGIN_THRESHOLD);
      expect(auditOf(person.userId, 'user.login_locked')).toHaveLength(1);

      // The right password is refused while paused, here and on /login
      const right = await accept(person.password);
      expect(right.statusCode).toBe(429);
      expect(right.cookies.find((c) => c.name === 'smt_session')).toBeUndefined();
      expect((await login(person.email, person.password)).statusCode).toBe(429);
    });

    it('is ended by a passkey sign-in, which is never paused', async () => {
      const person = await seedPerson();
      const credentialId = `cred-${nanoid(10)}`;
      getDb()
        .insert(passkeys)
        .values({
          id: nanoid(),
          userId: person.userId,
          credentialId,
          publicKey: Buffer.from([1, 2, 3]),
          transports: '["internal"]',
          deviceType: 'multiDevice',
          backedUp: true,
          name: 'Laptop',
        })
        .run();
      await lockOut(person.email);

      const opts = await app.inject({ method: 'POST', url: '/api/auth/passkey/options', remoteAddress: spread() });
      const { challengeId, options } = opts.json();
      const signedIn = await app.inject({
        method: 'POST',
        url: '/api/auth/passkey/verify',
        remoteAddress: spread(),
        payload: {
          challengeId,
          response: { id: credentialId, rawId: credentialId, type: 'public-key', challenge: options.challenge, counter: 1 },
        },
      });
      expect(signedIn.statusCode).toBe(200);
      expect(
        getDb().select().from(loginFailures).where(eq(loginFailures.accountKey, accountKey(person.email))).get(),
      ).toBeUndefined();

      // The password step works again (and asks for the passkey, as it should)
      const again = await login(person.email, person.password);
      expect(again.statusCode).toBe(200);
      expect(again.json().step).toBe('passkey');
    });
  });

  describe('new-device sign-ins', () => {
    it('does not alert on an account’s very first sign-in', async () => {
      const person = await seedPerson();
      expect((await login(person.email, person.password, '198.51.100.7')).statusCode).toBe(200);
      expect(mailsAbout(/New sign-in/)).toHaveLength(0);
      expect(auditOf(person.userId, 'user.login_new_device')).toHaveLength(0);
      expect(getDb().select().from(userDevices).where(eq(userDevices.userId, person.userId)).all()).toHaveLength(1);
    });

    it('alerts on a new network or browser, not on a browser update or a neighbouring address', async () => {
      const person = await seedPerson();
      await login(person.email, person.password, '198.51.100.7', FIREFOX_LINUX);

      // Same /24, newer Firefox: the same device
      await login(person.email, person.password, '198.51.100.99', FIREFOX_LINUX_NEWER);
      expect(mailsAbout(/New sign-in/)).toHaveLength(0);

      // Another network
      await login(person.email, person.password, '203.0.113.5', FIREFOX_LINUX);
      let mails = mailsAbout(/New sign-in/);
      expect(mails).toHaveLength(1);
      expect(mails[0]![0].to).toEqual([person.email]);
      expect(mails[0]![0].text).toContain('Firefox on Linux, from 203.0.113.5 (203.0.113.0/24)');

      // Another browser on a known network
      await login(person.email, person.password, '198.51.100.7', CHROME_MAC);
      mails = mailsAbout(/New sign-in/);
      expect(mails).toHaveLength(2);
      expect(mails[1]![0].text).toContain('Chrome on macOS');

      const rows = auditOf(person.userId, 'user.login_new_device');
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({ method: 'password', network: expect.any(String) });
      expect(rows.every((r) => r.orgId === orgId)).toBe(true);
    });

    it('learns an existing account’s devices from its sessions, so the first alert is a real one', async () => {
      const person = await seedPerson();
      // seedSession signs in from 127.0.0.1 as "vitest"
      await seedSession(person.userId);
      await login(person.email, person.password, '127.0.0.1', 'vitest');
      expect(mailsAbout(/New sign-in/)).toHaveLength(0);
      await login(person.email, person.password, '192.0.2.1', 'vitest');
      expect(mailsAbout(/New sign-in/)).toHaveLength(1);
    });

    it('alerts on a new device when an existing account signs in by accepting an invite', async () => {
      const person = await seedPerson();
      await login(person.email, person.password, '198.51.100.7', FIREFOX_LINUX);
      const inviterOrg = seedOrg(`inviter-${nanoid(6)}`);
      const inviter = seedUser(inviterOrg, 'admin');
      const created = await app.inject({
        method: 'POST',
        url: '/api/team/invites',
        headers: inviter.headers,
        payload: { email: person.email, role: 'viewer' },
      });
      const token = (created.json().link as string).split('/invite/')[1]!;
      const joined = await app.inject({
        method: 'POST',
        url: `/api/invites/${token}/accept`,
        payload: { email: person.email, password: person.password },
        remoteAddress: '203.0.113.5',
        headers: { 'user-agent': CHROME_MAC },
      });
      expect(joined.statusCode).toBe(201);
      expect(mailsAbout(/New sign-in/)).toHaveLength(1);
      const rows = auditOf(person.userId, 'user.login_new_device');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.orgId).toBe(inviterOrg);
    });

    it('lists the caller’s devices and forgets one on request', async () => {
      const person = await seedPerson();
      await login(person.email, person.password, '198.51.100.7', FIREFOX_LINUX);
      await login(person.email, person.password, '203.0.113.5', CHROME_MAC);
      const other = await seedPerson();
      await login(other.email, other.password, '198.51.100.7', FIREFOX_LINUX);

      const list = await app.inject({ method: 'GET', url: '/api/auth/devices', headers: person.headers });
      expect(list.statusCode).toBe(200);
      const devices = list.json() as { id: string; label: string; ipPrefix: string }[];
      expect(devices.map((d) => `${d.label} ${d.ipPrefix}`).sort()).toEqual([
        'Chrome on macOS 203.0.113.0/24',
        'Firefox on Linux 198.51.100.0/24',
      ]);
      expect(JSON.stringify(devices)).not.toMatch(/deviceHash|device_hash/);

      const theirs = getDb().select().from(userDevices).where(eq(userDevices.userId, other.userId)).get()!;
      const cross = await app.inject({ method: 'DELETE', url: `/api/auth/devices/${theirs.id}`, headers: person.headers });
      expect(cross.statusCode).toBe(404);

      const del = await app.inject({ method: 'DELETE', url: `/api/auth/devices/${devices[0]!.id}`, headers: person.headers });
      expect(del.statusCode).toBe(204);
      const after = await app.inject({ method: 'GET', url: '/api/auth/devices', headers: person.headers });
      expect(after.json()).toHaveLength(1);
    });
  });
});
