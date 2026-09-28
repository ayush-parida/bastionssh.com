import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, backupCodes, memberships, passkeys, sessions, users, webauthnChallenges } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { hashBackupCode, normalizeBackupCode } from '../../auth/backup-codes.js';
import { seedOrg, seedSession, seedUser } from './test-utils.js';

/** Enough of @simplewebauthn/server for the routes: fresh challenges, and assertions that verify when they match. */
const fake = vi.hoisted(() => {
  let n = 0;
  return {
    nextChallenge: () => `challenge-${++n}`,
    smtp: true,
    sendEmail: vi.fn(async (_msg: { to: string[]; subject: string; text: string }) => {}),
  };
});

vi.mock('../../auth/revoke.js', () => ({ revokeLiveAccess: () => ({ terminals: 0, sftp: 0, agents: 0 }) }));

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

type Role = 'owner' | 'admin' | 'operator' | 'viewer';
type Headers = Record<string, string>;

const CODE_FORMAT = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

describe('backup codes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  // Sign-in routes are rate-limited per address; give each call its own
  let address = 0;
  const from = () => `10.8.${Math.floor(++address / 250)}.${address % 250}`;

  async function seedPerson(role: Role = 'operator', org = orgId) {
    const member = seedUser(org, role);
    const email = `${nanoid(8).toLowerCase()}@corp.test`;
    const password = 'the-password';
    getDb()
      .update(users)
      .set({ email, passwordHash: await hashPassword(password) })
      .where(eq(users.id, member.userId))
      .run();
    return { ...member, email, password };
  }

  function addPasskey(userId: string) {
    const id = nanoid();
    const credentialId = `cred-${nanoid(10)}`;
    getDb()
      .insert(passkeys)
      .values({
        id,
        userId,
        credentialId,
        publicKey: Buffer.from([1, 2, 3]),
        transports: '["internal"]',
        deviceType: 'multiDevice',
        backedUp: true,
        name: 'Laptop',
      })
      .run();
    return { id, credentialId };
  }

  async function verifiedSession(userId: string) {
    const s = await seedSession(userId);
    getDb().update(sessions).set({ passkeyVerified: true }).where(eq(sessions.id, s.sessionId)).run();
    return s;
  }

  const post = (url: string, payload: unknown, headers: Headers = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers, remoteAddress: from() });
  const get = (url: string, headers: Headers) => app.inject({ method: 'GET', url, headers });
  const del = (url: string, headers: Headers) => app.inject({ method: 'DELETE', url, headers });

  /** Password step of a sign-in; the ticket a backup code (or passkey) finishes. */
  async function ticketFor(person: { email: string; password: string }): Promise<string> {
    const res = await post('/api/auth/login', { email: person.email, password: person.password });
    expect(res.json().step).toBe('passkey');
    return res.json().ticket;
  }

  const useCode = (ticket: string, code: string) => post('/api/auth/login/backup-code', { ticket, code });

  /** A person with a passkey and a fresh set of codes. */
  async function withCodes(role: Role = 'operator') {
    const person = await seedPerson(role);
    const passkey = addPasskey(person.userId);
    const browser = await verifiedSession(person.userId);
    const res = await post('/api/auth/backup-codes', {}, browser.headers);
    expect(res.statusCode).toBe(201);
    return { ...person, passkey, browser, codes: res.json().codes as string[], cacheControl: res.headers['cache-control'] };
  }

  function cookieOf(res: { cookies: { name: string; value: string }[] }) {
    const value = res.cookies.find((c) => c.name === 'smt_session')?.value;
    return value ? { sessionId: value, headers: { cookie: `smt_session=${value}` } } : null;
  }

  const codeRows = (userId: string) => getDb().select().from(backupCodes).where(eq(backupCodes.userId, userId)).all();
  const ticketRows = (userId: string) =>
    getDb().select().from(webauthnChallenges).where(eq(webauthnChallenges.userId, userId)).all();
  const auditOf = (userId: string) =>
    getDb().select().from(auditLog).where(eq(auditLog.resourceId, userId)).all();

  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();
    orgId = seedOrg('backup-codes');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    fake.smtp = true;
    fake.sendEmail.mockClear();
  });

  describe('codes', () => {
    it('normalizes case, dashes, spaces and the letters Crockford reads as digits', () => {
      expect(normalizeBackupCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
      expect(normalizeBackupCode('ab cd e\tfg-h-jk')).toBe('ABCDEFGHJK');
      expect(normalizeBackupCode('0O1iL')).toBe('00111');
      expect(hashBackupCode('abcde fghjk')).toBe(hashBackupCode('ABCDE-FGHJK'));
    });

    it('is a keyed hash, not a plain digest of the code', async () => {
      const { createHash } = await import('crypto');
      const hash = hashBackupCode('ABCDE-FGHJK');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toBe(createHash('sha256').update('ABCDEFGHJK').digest('hex'));
    });
  });

  describe('generating', () => {
    it('returns ten unambiguous codes once, and stores only their hashes', async () => {
      const person = await withCodes();
      expect(person.codes).toHaveLength(10);
      expect(new Set(person.codes).size).toBe(10);
      for (const code of person.codes) expect(code).toMatch(CODE_FORMAT);

      const rows = codeRows(person.userId);
      expect(rows).toHaveLength(10);
      const stored = JSON.stringify(rows);
      for (const code of person.codes) {
        expect(stored).not.toContain(code);
        expect(stored).not.toContain(code.replace('-', ''));
      }
      expect(rows.map((r) => r.codeHash).sort()).toEqual(person.codes.map(hashBackupCode).sort());

      const status = await get('/api/auth/backup-codes', person.browser.headers);
      expect(status.json()).toEqual({ total: 10, remaining: 10, createdAt: rows[0]!.createdAt });
      expect(person.cacheControl).toBe('no-store');
      expect(status.body).not.toContain(person.codes[0]);

      const audit = auditOf(person.userId).find((a) => a.action === 'user.backup_codes_generated');
      expect(JSON.parse(audit!.metadata!)).toEqual({ count: 10, replaced: 0 });
    });

    it('needs a passkey on the account', async () => {
      const person = await seedPerson();
      const browser = await seedSession(person.userId);
      const res = await post('/api/auth/backup-codes', {}, browser.headers);
      expect(res.statusCode).toBe(400);
      expect(codeRows(person.userId)).toHaveLength(0);
    });

    it('needs a passkey-verified browser session', async () => {
      const person = await seedPerson();
      addPasskey(person.userId);
      const unverified = await seedSession(person.userId);
      const refused = await post('/api/auth/backup-codes', {}, unverified.headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');
      // An API token is never enough
      expect((await post('/api/auth/backup-codes', {}, person.headers)).statusCode).toBe(403);
      expect(codeRows(person.userId)).toHaveLength(0);
    });

    it('replaces the old set, whose codes then stop working', async () => {
      const person = await withCodes();
      const again = await post('/api/auth/backup-codes', {}, person.browser.headers);
      expect(again.statusCode).toBe(201);
      const fresh = again.json().codes as string[];
      expect(fresh.some((c) => person.codes.includes(c))).toBe(false);
      expect(codeRows(person.userId)).toHaveLength(10);

      const old = await useCode(await ticketFor(person), person.codes[0]!);
      expect(old.statusCode).toBe(401);
      const ok = await useCode(await ticketFor(person), fresh[0]!);
      expect(ok.statusCode).toBe(200);

      const audits = auditOf(person.userId).filter((a) => a.action === 'user.backup_codes_generated');
      expect(JSON.parse(audits.at(-1)!.metadata!)).toMatchObject({ replaced: 10 });
    });

    it('emails the owner when SMTP is configured, and not otherwise', async () => {
      const person = await withCodes();
      expect(fake.sendEmail).toHaveBeenCalledTimes(1);
      expect(fake.sendEmail.mock.calls[0]![0]).toMatchObject({
        to: [person.email],
        subject: expect.stringMatching(/New backup codes/),
      });
      // The email says codes were made, never what they are
      expect(fake.sendEmail.mock.calls[0]![0].text).not.toContain(person.codes[0]);

      fake.smtp = false;
      fake.sendEmail.mockClear();
      await post('/api/auth/backup-codes', {}, person.browser.headers);
      expect(fake.sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('signing in', () => {
    it('finishes a password sign-in with a verified session and spends the code', async () => {
      const person = await withCodes();
      fake.sendEmail.mockClear();
      const ticket = await ticketFor(person);

      const res = await useCode(ticket, person.codes[3]!);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        user: { id: person.userId },
        orgId,
        passkeyVerified: true,
        passkeyEnrollmentRequired: false,
        backupCodesRemaining: 9,
      });
      const session = cookieOf(res)!;
      const row = getDb().select().from(sessions).where(eq(sessions.id, session.sessionId)).get();
      expect(row?.passkeyVerified).toBe(true);

      const used = codeRows(person.userId).find((r) => r.codeHash === hashBackupCode(person.codes[3]!));
      expect(used?.usedAt).toBeTruthy();
      // The ticket is spent with it
      expect(ticketRows(person.userId)).toHaveLength(0);

      const audit = auditOf(person.userId).find((a) => a.action === 'user.login_backup_code');
      expect(JSON.parse(audit!.metadata!)).toEqual({ method: 'password+backup_code', remaining: 9 });

      // Signing in from a new address also sends the new-device notice; this one is about the code
      const codeMails = fake.sendEmail.mock.calls.filter((c) => /backup code was used/.test(c[0].subject));
      expect(codeMails).toHaveLength(1);
      expect(codeMails[0]![0]).toMatchObject({
        to: [person.email],
        text: expect.stringContaining('9 unused codes are left'),
      });

      const me = await get('/api/auth/me', session.headers);
      expect(me.json()).toMatchObject({ passkeyVerified: true, passkeyCount: 1, backupCodesRemaining: 9 });
      const status = await get('/api/auth/backup-codes', session.headers);
      expect(status.json()).toMatchObject({ total: 10, remaining: 9 });
    });

    it('accepts a code typed in lower case, without the dash, or with spaces', async () => {
      const person = await withCodes();
      const [a, b, c] = person.codes as [string, string, string];
      expect((await useCode(await ticketFor(person), a.toLowerCase())).statusCode).toBe(200);
      expect((await useCode(await ticketFor(person), b.replace('-', ''))).statusCode).toBe(200);
      expect((await useCode(await ticketFor(person), ` ${c.slice(0, 3)} ${c.slice(3).toLowerCase()} `)).statusCode).toBe(
        200,
      );
    });

    it('does not accept a code twice', async () => {
      const person = await withCodes();
      expect((await useCode(await ticketFor(person), person.codes[0]!)).statusCode).toBe(200);
      const reuse = await useCode(await ticketFor(person), person.codes[0]!);
      expect(reuse.statusCode).toBe(401);
      expect(cookieOf(reuse)).toBeNull();
    });

    it('lets exactly one of two concurrent uses of the same code through', async () => {
      const person = await withCodes();
      const [t1, t2] = [await ticketFor(person), await ticketFor(person)];
      const results = await Promise.all([useCode(t1, person.codes[0]!), useCode(t2, person.codes[0]!)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
      const res = await get('/api/auth/backup-codes', person.browser.headers);
      expect(res.json().remaining).toBe(9);
    });

    it('counts wrong codes against the ticket and drops it after five', async () => {
      const person = await withCodes();
      const ticket = await ticketFor(person);

      for (let left = 4; left >= 1; left--) {
        const wrong = await useCode(ticket, 'AAAAA-AAAAA');
        expect(wrong.statusCode).toBe(401);
        expect(wrong.json()).toMatchObject({ attemptsLeft: left });
        expect(wrong.json().code).toBeUndefined();
      }
      // Still good after four misses
      expect(ticketRows(person.userId)[0]?.attempts).toBe(4);

      const fifth = await useCode(ticket, 'AAAAA-AAAAA');
      expect(fifth.statusCode).toBe(401);
      expect(fifth.json()).toMatchObject({ attemptsLeft: 0, code: 'SIGN_IN_EXPIRED' });
      expect(ticketRows(person.userId)).toHaveLength(0);

      // Even the right code is too late now, and it is not spent
      const late = await useCode(ticket, person.codes[0]!);
      expect(late.statusCode).toBe(401);
      expect(late.json().code).toBe('SIGN_IN_EXPIRED');
      expect(codeRows(person.userId).every((r) => r.usedAt === null)).toBe(true);
    });

    it('keeps the ticket usable for the passkey after a wrong code', async () => {
      const person = await withCodes();
      const res = await post('/api/auth/login', { email: person.email, password: person.password });
      const { ticket, options } = res.json();
      expect((await useCode(ticket, 'AAAAA-AAAAA')).statusCode).toBe(401);
      const done = await post('/api/auth/login/passkey', {
        ticket,
        response: { id: person.passkey.credentialId, rawId: person.passkey.credentialId, type: 'public-key', challenge: options.challenge, counter: 1 },
      });
      expect(done.statusCode).toBe(200);
    });

    it('is rate-limited like the other sign-in routes', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login/backup-code',
          payload: { ticket: 'nope', code: 'AAAAA-AAAAA' },
          remoteAddress: '10.7.0.1',
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('refuses a member suspended while the ticket was out, without spending the code or counting a try', async () => {
      const person = await withCodes();
      const ticket = await ticketFor(person);
      const setStatus = (status: string) =>
        getDb()
          .update(memberships)
          .set({ status })
          .where(and(eq(memberships.userId, person.userId), eq(memberships.orgId, orgId)))
          .run();
      setStatus('suspended');
      try {
        const res = await useCode(ticket, person.codes[0]!);
        expect(res.statusCode).toBe(403);
        expect(cookieOf(res)).toBeNull();
        expect(codeRows(person.userId).every((r) => r.usedAt === null)).toBe(true);
        // The pending sign-in ends: the password step would refuse too
        expect(ticketRows(person.userId)).toHaveLength(0);
        expect(auditOf(person.userId).some((a) => a.action === 'user.login_backup_code')).toBe(false);
        expect(fake.sendEmail.mock.calls.some((c) => /backup code was used/.test(c[0].subject))).toBe(false);
      } finally {
        setStatus('active');
      }
      // Reinstated, the same code still works
      expect((await useCode(await ticketFor(person), person.codes[0]!)).statusCode).toBe(200);
    });

    it('counts concurrent wrong codes on one ticket exactly, never past the limit', async () => {
      const person = await withCodes();
      const ticket = await ticketFor(person);
      const results = await Promise.all(Array.from({ length: 12 }, () => useCode(ticket, 'AAAAA-AAAAA')));
      const left = results.map((r) => r.json().attemptsLeft).filter((n) => n !== undefined).sort();
      expect(left).toEqual([0, 1, 2, 3, 4]);
      expect(results.filter((r) => r.json().code === 'SIGN_IN_EXPIRED')).toHaveLength(8);
      expect(ticketRows(person.userId)).toHaveLength(0);
      expect((await useCode(ticket, person.codes[0]!)).statusCode).toBe(401);
    });

    it("refuses another user's code", async () => {
      const mine = await withCodes();
      const theirs = await withCodes();
      const res = await useCode(await ticketFor(mine), theirs.codes[0]!);
      expect(res.statusCode).toBe(401);
      expect(codeRows(theirs.userId).every((r) => r.usedAt === null)).toBe(true);
    });

    it('refuses an unknown or expired ticket', async () => {
      const person = await withCodes();
      expect((await useCode('not-a-ticket', person.codes[0]!)).json().code).toBe('SIGN_IN_EXPIRED');

      const ticket = await ticketFor(person);
      getDb()
        .update(webauthnChallenges)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(webauthnChallenges.userId, person.userId))
        .run();
      const res = await useCode(ticket, person.codes[0]!);
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('SIGN_IN_EXPIRED');
      expect(codeRows(person.userId).every((r) => r.usedAt === null)).toBe(true);
    });

    it('is not a way past the password: other sign-in and step-up routes ignore codes', async () => {
      const person = await withCodes();

      // Passwordless sign-in takes a passkey assertion and nothing else
      const { challengeId } = (await post('/api/auth/passkey/options', {})).json();
      const passwordless = await post('/api/auth/passkey/verify', { challengeId, code: person.codes[0] });
      expect(passwordless.statusCode).toBe(400);
      expect(cookieOf(passwordless)).toBeNull();

      // A ticket-less backup-code sign-in is not a thing
      expect((await post('/api/auth/login/backup-code', { code: person.codes[0] })).statusCode).toBe(400);

      // Step-up confirms a passkey, never a code
      const unverified = await seedSession(person.userId);
      const step = (await post('/api/auth/passkeys/step-up/options', {}, unverified.headers)).json();
      const stepUp = await post(
        '/api/auth/passkeys/step-up/verify',
        { challengeId: step.challengeId, code: person.codes[0] },
        unverified.headers,
      );
      expect(stepUp.statusCode).toBe(400);
      expect(getDb().select().from(sessions).where(eq(sessions.id, unverified.sessionId)).get()?.passkeyVerified).toBe(
        false,
      );
      expect(codeRows(person.userId).every((r) => r.usedAt === null)).toBe(true);
    });
  });

  describe('removal', () => {
    it('clears the codes with the last passkey, not before', async () => {
      const person = await withCodes();
      const second = addPasskey(person.userId);

      expect((await del(`/api/auth/passkeys/${second.id}`, person.browser.headers)).statusCode).toBe(204);
      expect(codeRows(person.userId)).toHaveLength(10);

      expect((await del(`/api/auth/passkeys/${person.passkey.id}`, person.browser.headers)).statusCode).toBe(204);
      expect(codeRows(person.userId)).toHaveLength(0);
      expect((await get('/api/auth/me', person.browser.headers)).json().backupCodesRemaining).toBe(0);
    });

    it('clears the codes on an admin passkey reset', async () => {
      const admin = await seedPerson('admin');
      const adminBrowser = await seedSession(admin.userId);
      const person = await withCodes('viewer');
      const ticket = await ticketFor(person);

      const res = await del(`/api/team/members/${person.userId}/passkeys`, adminBrowser.headers);
      expect(res.statusCode).toBe(200);
      expect(codeRows(person.userId)).toHaveLength(0);
      // The pending ticket went too, so a code cannot finish it
      expect((await useCode(ticket, person.codes[0]!)).statusCode).toBe(401);
      const audit = auditOf(person.userId).find((a) => a.action === 'member.passkeys_reset');
      expect(JSON.parse(audit!.metadata!)).toMatchObject({ removed: 1, backupCodesRemoved: 10 });
    });
  });

  it('reports remaining codes on /me', async () => {
    const person = await seedPerson();
    const browser = await seedSession(person.userId);
    expect((await get('/api/auth/me', browser.headers)).json().backupCodesRemaining).toBe(0);
    const withSet = await withCodes();
    expect((await get('/api/auth/me', withSet.browser.headers)).json().backupCodesRemaining).toBe(10);
  });
});
