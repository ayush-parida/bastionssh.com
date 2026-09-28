import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { getDb } from '../../db/index.js';
import { users, sessions, memberships, organizations, passkeys, userDevices } from '../../db/schema.js';
import { hashPassword, verifyAgainstNothing, verifyPassword } from '../../auth/password.js';
import {
  createSession,
  findUserSession,
  invalidateSession,
  publicSessionId,
  setActiveOrg,
} from '../../auth/session.js';
import { requireAuth, resolveMembership, ROLES, SUSPENDED_MESSAGE, type Role } from '../../auth/middleware.js';
import {
  anyActiveOrgRequiresPasskey,
  authenticationOptions,
  consumeChallenge,
  findPasskeyByCredential,
  issueChallenge,
  markSessionPasskeyVerified,
  MAX_PASSKEYS_PER_USER,
  orgRequiresPasskey,
  FIRST_ENROLLMENT_MAX_SESSION_AGE_MS,
  notifyBackupCodeUsed,
  notifyBackupCodesGenerated,
  notifyPasskeyAdded,
  parseTransports,
  passkeyCount,
  requireBrowserSession,
  requireStepUpIfPasskeys,
  STEP_UP_MESSAGE,
  toPasskeyInfo,
  userPasskeys,
  verifyAssertion,
} from '../../auth/passkey.js';
import {
  backupCodeStatus,
  deleteBackupCodes,
  generateBackupCodes,
  redeemBackupCode,
  remainingBackupCodes,
} from '../../auth/backup-codes.js';
import { audit, auditForAccount } from '../../audit/index.js';
import {
  accountKey,
  clearLoginFailures,
  FAILED_LOGIN_THRESHOLD,
  lockoutStatus,
  notifyAccountLocked,
  notifyNewDeviceSignIn,
  recordFailedLogin,
  recordSignInDevice,
  type Lockout,
} from '../../auth/login-security.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import { config } from '../../config/index.js';
import { and, asc, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type {
  BackupCodeSignedIn,
  BackupCodeStatus,
  GeneratedBackupCodes,
  KnownDevice,
  Me,
  OrgSummary,
  PasskeyInfo,
  PasskeyLoginStep,
  SessionInfo,
  SignedIn,
} from '@smt/shared';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
});

const switchOrgSchema = z.object({ orgId: z.string().min(1) });

/**
 * A browser's WebAuthn response. Only the credential id is read here; the
 * library checks the rest, so everything else passes through untouched.
 */
const credentialSchema = z.object({ id: z.string().min(1).max(1024) }).passthrough();

const ticketLoginSchema = z.object({
  ticket: z.string().min(1).max(200),
  response: credentialSchema,
});

/** Accepts the code however it was typed; normalizeBackupCode sorts out case, dashes and spaces. */
const backupCodeLoginSchema = z.object({
  ticket: z.string().min(1).max(200),
  code: z.string().min(1).max(64),
});

const challengeResponseSchema = z.object({
  challengeId: z.string().min(1).max(100),
  response: credentialSchema,
});

const passkeyNameSchema = z.string().trim().min(1).max(100);

const registerVerifySchema = challengeResponseSchema.extend({
  name: passkeyNameSchema.optional(),
  /** Required for a first passkey: the password again, so a stolen session alone cannot enroll one. */
  currentPassword: z.string().min(1).max(200).optional(),
});

const registerOptionsSchema = z.object({ currentPassword: z.string().min(1).max(200).optional() });

const renamePasskeySchema = z.object({ name: passkeyNameSchema });

/** Tighter than the global limit, like /login: these are unauthenticated credential checks. */
const SIGN_IN_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

const asAssertion = (r: z.infer<typeof credentialSchema>) => r as unknown as AuthenticationResponseJSON;

function asRole(role: string): Role {
  return ROLES.includes(role as Role) ? (role as Role) : 'viewer';
}

type Account = typeof users.$inferSelect;
type LoginMethod = 'password' | 'password+passkey' | 'password+backup_code' | 'passkey';

/**
 * The membership a new sign-in lands in, or a 403 already sent when every one
 * is suspended. Same rule for password and passkey sign-in.
 */
function signInMembership(userId: string, reply: FastifyReply) {
  const resolved = resolveMembership(userId);
  if (resolved.status === 'suspended') {
    reply.status(403).send({ error: SUSPENDED_MESSAGE });
    return null;
  }
  return { membership: resolved.status === 'ok' ? resolved.membership : undefined };
}

/** Refuse a password sign-in while the account's password step is paused. */
function sendLocked(reply: FastifyReply, lock: Lockout) {
  const minutes = Math.max(1, Math.ceil(lock.retryAfterSeconds / 60));
  return reply
    .status(429)
    .header('Retry-After', String(lock.retryAfterSeconds))
    .send({
      error: `Too many failed sign-in attempts. Try your password again in ${minutes} minute${minutes === 1 ? '' : 's'}, or sign in with a passkey.`,
      code: 'ACCOUNT_LOCKED',
      retryAfter: lock.retryAfterSeconds,
    });
}

function membershipOrgIds(userId: string): string[] {
  return getDb()
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .all()
    .map((m) => m.orgId);
}

/**
 * Create the session for a completed sign-in, set its cookie, and audit it.
 * Also where every sign-in method checks for a new device.
 */
async function startSession(
  req: FastifyRequest,
  reply: FastifyReply,
  user: Account,
  membership: typeof memberships.$inferSelect | undefined,
  method: LoginMethod,
  auditDetails: Record<string, unknown> = {},
): Promise<SignedIn> {
  // A backup code is the recovery path for the passkey factor, so it counts as one
  const passkeyVerified = method !== 'password';
  const session = await createSession(user.id, {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    activeOrgId: membership?.orgId,
    passkeyVerified,
  });
  reply.setCookie('smt_session', session.id, { httpOnly: true, sameSite: 'lax', path: '/' });
  // A passkey is proof enough: it ends any pause the password step is under
  if (method === 'passkey') clearLoginFailures(accountKey(user.email));
  const device = recordSignInDevice(user.id, req.ip, req.headers['user-agent'], session.id);

  if (membership) {
    // Not behind requireAuth, so fill in who this is for the audit row
    req.user = { id: user.id, email: user.email, displayName: user.displayName };
    req.orgId = membership.orgId;
    if (method === 'password') await audit(req, 'user.login', 'user', user.id, user.email);
    else if (method === 'password+backup_code') {
      await audit(req, 'user.login_backup_code', 'user', user.id, user.email, { method, ...auditDetails });
    } else await audit(req, 'user.login_passkey', 'user', user.id, user.email, { method });
    if (device.isNew) {
      await audit(req, 'user.login_new_device', 'user', user.id, user.email, {
        method,
        device: device.label,
        network: device.ipPrefix,
      });
    }
  }
  if (device.isNew) notifyNewDeviceSignIn(user, device, req.ip);
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    orgId: membership?.orgId ?? null,
    role: asRole(membership?.role ?? 'viewer'),
    passkeyVerified,
    // A password-only sign-in means no passkey exists; the org says one must
    passkeyEnrollmentRequired: !passkeyVerified && !!membership && orgRequiresPasskey(membership.orgId),
  };
}

export async function authRoutes(app: FastifyInstance) {
  // Tighter than the global limit: this is the only unauthenticated password check.
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const db = getDb();

    // Per account, on top of the per-IP limit: guesses spread over many
    // addresses still pause the password step. Addresses with no account are
    // counted the same way, so the answer does not reveal which exist.
    const key = accountKey(body.email);
    const lock = lockoutStatus(key);
    if (lock) return sendLocked(reply, lock);
    const attempt = recordFailedLogin(key);

    // Emails are case-insensitive in practice; lower() also matches rows stored
    // before addresses were normalized.
    const user = db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email}`)
      .get();
    const valid = user?.passwordHash
      ? await verifyPassword(body.password, user.passwordHash)
      : await verifyAgainstNothing(body.password);
    if (!valid || !user) {
      if (user) {
        const orgIds = membershipOrgIds(user.id);
        auditForAccount(req, user, orgIds, 'user.login_failed', { reason: 'bad_password' });
        if (attempt.locked) {
          auditForAccount(req, user, orgIds, 'user.login_locked', {
            failures: FAILED_LOGIN_THRESHOLD,
            lockedForSeconds: attempt.locked.retryAfterSeconds,
            lockouts: attempt.locked.lockouts,
          });
          if (attempt.notify) notifyAccountLocked(user, attempt.locked, req.ip);
        }
      }
      if (attempt.locked) return sendLocked(reply, attempt.locked);
      return reply.status(401).send({ error: 'Invalid credentials' });
    }
    clearLoginFailures(key);

    // The password was right, so saying why is not an oracle for anything.
    const landing = signInMembership(user.id, reply);
    if (!landing) return reply;

    // With a passkey on the account the password is only half of it: hand back
    // a short-lived ticket to finish with, and no session yet.
    const credentials = userPasskeys(user.id);
    if (credentials.length) {
      const options = await authenticationOptions(credentials);
      const { ticket } = issueChallenge('second_factor', options.challenge, { userId: user.id, withTicket: true });
      return { step: 'passkey', ticket: ticket!, options } satisfies PasskeyLoginStep;
    }

    return startSession(req, reply, user, landing.membership, 'password');
  });

  /** Second half of a password login: the ticket from /login plus a passkey assertion. */
  app.post('/login/passkey', { config: SIGN_IN_RATE_LIMIT }, async (req, reply) => {
    const body = ticketLoginSchema.parse(req.body);
    const pending = consumeChallenge('second_factor', { ticket: body.ticket });
    if (!pending?.userId) {
      return reply.status(401).send({ error: 'This sign-in has expired. Enter your password again.' });
    }

    const passkey = findPasskeyByCredential(body.response.id, pending.userId);
    if (!passkey || !(await verifyAssertion(asAssertion(body.response), pending.challenge, passkey))) {
      return reply.status(401).send({ error: 'Passkey verification failed. Enter your password and try again.' });
    }

    const user = getDb().select().from(users).where(eq(users.id, pending.userId)).get();
    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });
    // Re-checked: the membership may have changed while the ticket was out
    const landing = signInMembership(user.id, reply);
    if (!landing) return reply;
    return startSession(req, reply, user, landing.membership, 'password+passkey');
  });

  /**
   * Second half of a password login without the passkey: the same ticket plus
   * one of the account's backup codes. It stands in for the passkey, so the
   * session is passkey-verified. Never accepted where a passkey alone would
   * do (passwordless sign-in) or to re-confirm one (step-up). A wrong code
   * counts against the ticket rather than spending it, up to a limit.
   */
  app.post('/login/backup-code', { config: SIGN_IN_RATE_LIMIT }, async (req, reply) => {
    const body = backupCodeLoginSchema.parse(req.body);
    // Membership is checked before the code is spent: a suspension that landed
    // while the ticket was out must not also burn one of the user's codes
    const result = redeemBackupCode(
      body.ticket,
      body.code,
      (userId) => resolveMembership(userId).status !== 'suspended',
    );
    if (result.status === 'refused') return reply.status(403).send({ error: SUSPENDED_MESSAGE });
    if (result.status === 'expired') {
      return reply
        .status(401)
        .send({ error: 'This sign-in has expired. Enter your password again.', code: 'SIGN_IN_EXPIRED' });
    }
    if (result.status === 'wrong') {
      return reply.status(401).send(
        result.attemptsLeft
          ? {
              error: `That backup code is not valid or has already been used (${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left).`,
              attemptsLeft: result.attemptsLeft,
            }
          : { error: 'Too many wrong backup codes. Enter your password again.', code: 'SIGN_IN_EXPIRED', attemptsLeft: 0 },
      );
    }

    const user = getDb().select().from(users).where(eq(users.id, result.userId)).get();
    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });
    // Synchronous since the redemption above, so this sees the membership it admitted
    const landing = signInMembership(user.id, reply);
    if (!landing) return reply;

    const remaining = remainingBackupCodes(user.id);
    const signedIn = await startSession(req, reply, user, landing.membership, 'password+backup_code', { remaining });
    notifyBackupCodeUsed(user, remaining, req.ip);
    return { ...signedIn, backupCodesRemaining: remaining } satisfies BackupCodeSignedIn;
  });

  /** Passwordless sign-in, step one: a challenge any of the user's discoverable passkeys can answer. */
  app.post('/passkey/options', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async () => {
    const options = await authenticationOptions();
    const { id } = issueChallenge('login', options.challenge);
    return { challengeId: id, options };
  });

  /** Passwordless sign-in, step two. The passkey names the account; user verification makes it enough. */
  app.post('/passkey/verify', { config: SIGN_IN_RATE_LIMIT }, async (req, reply) => {
    const body = challengeResponseSchema.parse(req.body);
    const pending = consumeChallenge('login', { id: body.challengeId });
    if (!pending) return reply.status(401).send({ error: 'This sign-in has expired. Try again.' });

    const passkey = findPasskeyByCredential(body.response.id);
    if (!passkey) {
      return reply
        .status(401)
        .send({ error: 'This passkey is not registered here. Sign in with your password instead.' });
    }
    if (!(await verifyAssertion(asAssertion(body.response), pending.challenge, passkey))) {
      return reply.status(401).send({ error: 'Passkey verification failed' });
    }

    const user = getDb().select().from(users).where(eq(users.id, passkey.userId)).get();
    if (!user) return reply.status(401).send({ error: 'Passkey verification failed' });
    const landing = signInMembership(user.id, reply);
    if (!landing) return reply;
    return startSession(req, reply, user, landing.membership, 'passkey');
  });

  app.post('/logout', { preHandler: requireAuth, config: { passkeyExempt: true } }, async (req, reply) => {
    const sessionId = req.cookies['smt_session'];
    if (sessionId) await invalidateSession(sessionId);
    reply.clearCookie('smt_session');
    await audit(req, 'user.logout', 'user', req.user.id, req.user.email);
    return { ok: true };
  });

  /** The caller's own signed-in browsers. */
  app.get('/sessions', { preHandler: requireAuth }, async (req): Promise<SessionInfo[]> => {
    const rows = getDb()
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, req.user.id), gt(sessions.expiresAt, new Date().toISOString())))
      .orderBy(desc(sessions.lastSeenAt))
      .all();
    return rows.map((s) => ({
      id: publicSessionId(s.id),
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      current: s.id === req.sessionId,
    }));
  });

  /** Sign out every session but the one making the request. */
  app.delete('/sessions', { preHandler: requireAuth }, async (req) => {
    const revoked = getDb()
      .delete(sessions)
      .where(
        req.sessionId
          ? and(eq(sessions.userId, req.user.id), ne(sessions.id, req.sessionId))
          : eq(sessions.userId, req.user.id),
      )
      .run().changes;
    await audit(req, 'user.sessions_revoked', 'user', req.user.id, req.user.email, {
      scope: 'others',
      count: revoked,
    });
    return { revoked };
  });

  app.delete('/sessions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = findUserSession(req.user.id, id);
    if (!target) return reply.status(404).send({ error: 'Session not found' });

    await invalidateSession(target.id);
    if (target.id === req.sessionId) reply.clearCookie('smt_session');
    await audit(req, 'user.sessions_revoked', 'user', req.user.id, req.user.email, {
      scope: 'one',
      count: 1,
    });
    return reply.status(204).send();
  });

  /** Where the caller's account has signed in from; a sign-in from anywhere else is emailed. */
  app.get('/devices', { preHandler: requireAuth }, async (req): Promise<KnownDevice[]> => {
    return getDb()
      .select({
        id: userDevices.id,
        label: userDevices.label,
        ipPrefix: userDevices.ipPrefix,
        firstSeenAt: userDevices.firstSeenAt,
        lastSeenAt: userDevices.lastSeenAt,
      })
      .from(userDevices)
      .where(eq(userDevices.userId, req.user.id))
      .orderBy(desc(userDevices.lastSeenAt))
      .all();
  });

  /** Forget a device, so the next sign-in from it is reported as new. */
  app.delete('/devices/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = getDb()
      .delete(userDevices)
      .where(and(eq(userDevices.id, id), eq(userDevices.userId, req.user.id)))
      .run().changes;
    if (!removed) return reply.status(404).send({ error: 'Device not found' });
    return reply.status(204).send();
  });

  /** Organizations the caller belongs to, for the org switcher. */
  app.get('/orgs', { preHandler: requireAuth, config: { passkeyExempt: true } }, async (req): Promise<OrgSummary[]> => {
    return getDb()
      .select({
        orgId: memberships.orgId,
        name: organizations.name,
        slug: organizations.slug,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.orgId, organizations.id))
      .where(eq(memberships.userId, req.user.id))
      .orderBy(asc(memberships.joinedAt))
      .all()
      .map((m) => ({
        ...m,
        role: asRole(m.role),
        status: m.status === 'suspended' ? 'suspended' : 'active',
        current: m.orgId === req.orgId,
      }));
  });

  /** Make another of the caller's orgs the one this browser session works in. */
  app.post('/switch-org', { preHandler: requireAuth, config: { passkeyExempt: true } }, async (req, reply) => {
    const { orgId } = switchOrgSchema.parse(req.body);
    // An API token has no session to remember the choice on
    if (!req.sessionId) {
      return reply.status(400).send({ error: 'Switching organization requires a signed-in session' });
    }

    const membership = getDb()
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, req.user.id), eq(memberships.orgId, orgId)))
      .get();
    if (!membership) return reply.status(404).send({ error: 'Not a member of that organization' });
    if (membership.status !== 'active') return reply.status(403).send({ error: SUSPENDED_MESSAGE });

    setActiveOrg(req.sessionId, orgId);
    return { user: req.user, orgId, role: asRole(membership.role) };
  });

  /** Who is signed in, and enough about passkeys for the web app to route an unverified session. */
  app.get('/me', { preHandler: requireAuth, config: { passkeyExempt: true } }, async (req): Promise<Me> => {
    return {
      ...req.user,
      orgId: req.orgId,
      role: req.role,
      passkeyVerified: req.passkeyVerified,
      requirePasskey: orgRequiresPasskey(req.orgId),
      passkeyCount: passkeyCount(req.user.id),
      backupCodesRemaining: remainingBackupCodes(req.user.id),
    };
  });

  app.patch('/me', { preHandler: requireAuth }, async (req) => {
    const body = updateProfileSchema.parse(req.body);
    const db = getDb();

    db.update(users)
      .set({ displayName: body.displayName, updatedAt: new Date().toISOString() })
      .where(eq(users.id, req.user.id))
      .run();

    return { ...req.user, displayName: body.displayName, orgId: req.orgId, role: req.role };
  });

  app.post('/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const body = changePasswordSchema.parse(req.body);
    const db = getDb();

    // An API token proves possession of a key, not knowledge of the password.
    // Changing credentials should require the credential.
    if (req.viaApiToken) {
      return reply
        .status(403)
        .send({ error: 'Password changes require signing in, not an API token' });
    }

    // With a passkey on the account, the password alone must not be able to replace itself
    if (!requireStepUpIfPasskeys(req, reply)) return reply;

    const user = db.select().from(users).where(eq(users.id, req.user.id)).get();
    if (!user?.passwordHash) {
      return reply.status(400).send({ error: 'This account has no password set' });
    }

    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return reply.status(403).send({ error: 'Current password is incorrect' });
    }

    db.update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date().toISOString() })
      .where(eq(users.id, user.id))
      .run();

    // Every other session was authenticated with the old password — end them,
    // keeping only the one making this change.
    const currentSessionId = req.cookies['smt_session'];
    db.delete(sessions)
      .where(
        currentSessionId
          ? and(eq(sessions.userId, user.id), ne(sessions.id, currentSessionId))
          : eq(sessions.userId, user.id),
      )
      .run();

    await audit(req, 'user.password_change', 'user', user.id, user.email);
    return { ok: true };
  });

  // ── Backup codes ────────────────────────────────────────────────────────────

  /** How many of the current set are left. Never the codes themselves. */
  app.get('/backup-codes', { preHandler: requireAuth }, async (req): Promise<BackupCodeStatus> => {
    return backupCodeStatus(req.user.id);
  });

  /**
   * A new set of backup codes, replacing any earlier one. Only for accounts
   * with a passkey — a password-only sign-in has no second step to recover —
   * and only from a session that has used a passkey (or a backup code), so a
   * password alone cannot mint a way around the passkey.
   */
  app.post('/backup-codes', { preHandler: requireAuth }, async (req, reply): Promise<GeneratedBackupCodes | undefined> => {
    if (!requireBrowserSession(req, reply, 'Backup codes are managed from a signed-in browser, not with an API token')) {
      return reply;
    }
    if (passkeyCount(req.user.id) === 0) {
      return reply.status(400).send({ error: 'Add a passkey before generating backup codes' });
    }
    if (!req.passkeyVerified) {
      return reply.status(403).send({ error: STEP_UP_MESSAGE, code: 'PASSKEY_STEP_UP_REQUIRED' });
    }

    const generated = generateBackupCodes(req.user.id);
    // The last passkey went while this request was on its way
    if (!generated) return reply.status(400).send({ error: 'Add a passkey before generating backup codes' });

    await audit(req, 'user.backup_codes_generated', 'user', req.user.id, req.user.email, {
      count: generated.codes.length,
      replaced: generated.replaced,
    });
    notifyBackupCodesGenerated(req.user, req.ip);
    // Plaintext codes: keep them out of every browser and proxy cache
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send({
      codes: generated.codes,
      total: generated.codes.length,
      remaining: generated.codes.length,
      createdAt: generated.createdAt,
    } satisfies GeneratedBackupCodes);
  });

  // ── Passkeys ────────────────────────────────────────────────────────────────

  app.get('/passkeys', { preHandler: requireAuth }, async (req): Promise<PasskeyInfo[]> => {
    return getDb()
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, req.user.id))
      .orderBy(asc(passkeys.createdAt))
      .all()
      .map(toPasskeyInfo);
  });

  /**
   * The extra proof a first passkey needs. Anyone who got hold of the password
   * could otherwise enroll their own passkey before the owner does and, under
   * a passkey policy, lock the owner out. So: a freshly signed-in session, and
   * the password again. Sends the refusal and returns false when not met.
   */
  async function firstEnrollmentAllowed(
    req: FastifyRequest & { sessionId: string },
    reply: FastifyReply,
    currentPassword: string | undefined,
  ): Promise<boolean> {
    const session = getDb().select().from(sessions).where(eq(sessions.id, req.sessionId)).get();
    if (!session || Date.now() - new Date(session.createdAt).getTime() > FIRST_ENROLLMENT_MAX_SESSION_AGE_MS) {
      reply.status(403).send({
        error: 'For your first passkey, sign in again (within the last 15 minutes) and retry',
        code: 'REAUTH_REQUIRED',
      });
      return false;
    }
    const user = getDb().select().from(users).where(eq(users.id, req.user.id)).get();
    // An account without a password has nothing a thief could have stolen
    if (!user?.passwordHash) return true;
    if (!currentPassword) {
      reply.status(400).send({ error: 'Enter your password to create your first passkey', code: 'PASSWORD_REQUIRED' });
      return false;
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      reply.status(403).send({ error: 'Current password is incorrect', code: 'PASSWORD_REQUIRED' });
      return false;
    }
    return true;
  }

  /**
   * Start adding a passkey. The first one may come from a password-only
   * session — that is how enrollment works — but needs a fresh session and the
   * password again. Any later one needs a session that has already used a
   * passkey, or a stolen password could add its own.
   */
  app.post(
    '/passkeys/register/options',
    // Checks the password for a first passkey, so limited like /login
    { preHandler: requireAuth, config: { passkeyExempt: true, ...SIGN_IN_RATE_LIMIT } },
    async (req, reply) => {
      const body = registerOptionsSchema.parse(req.body ?? {});
      if (!requireBrowserSession(req, reply)) return reply;
      const existing = userPasskeys(req.user.id);
      if (existing.length && !req.passkeyVerified) {
        return reply.status(403).send({ error: STEP_UP_MESSAGE, code: 'PASSKEY_STEP_UP_REQUIRED' });
      }
      if (existing.length >= MAX_PASSKEYS_PER_USER) {
        return reply.status(409).send({ error: `You can register up to ${MAX_PASSKEYS_PER_USER} passkeys` });
      }
      // Checked here too so a refusal comes before the device prompt, not after
      if (!existing.length && !(await firstEnrollmentAllowed(req, reply, body.currentPassword))) return reply;

      const options = await generateRegistrationOptions({
        rpName: config.webauthn.rpName,
        rpID: config.webauthn.rpId,
        userName: req.user.email,
        userID: new TextEncoder().encode(req.user.id),
        userDisplayName: req.user.displayName,
        attestationType: 'none',
        excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: parseTransports(p.transports) })),
        // Discoverable so it can sign in without a username; verified so it is a full sign-in
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      const { id } = issueChallenge('register', options.challenge, {
        userId: req.user.id,
        sessionHash: publicSessionId(req.sessionId),
      });
      return { challengeId: id, options };
    },
  );

  app.post(
    '/passkeys/register/verify',
    { preHandler: requireAuth, config: { passkeyExempt: true, ...SIGN_IN_RATE_LIMIT } },
    async (req, reply) => {
      const body = registerVerifySchema.parse(req.body);
      if (!requireBrowserSession(req, reply)) return reply;
      const pending = consumeChallenge(
        'register',
        { id: body.challengeId },
        { userId: req.user.id, sessionHash: publicSessionId(req.sessionId) },
      );
      if (!pending) return reply.status(400).send({ error: 'This passkey request has expired. Try again.' });

      const existing = passkeyCount(req.user.id);
      if (existing && !req.passkeyVerified) {
        return reply.status(403).send({ error: STEP_UP_MESSAGE, code: 'PASSKEY_STEP_UP_REQUIRED' });
      }
      if (!existing && !(await firstEnrollmentAllowed(req, reply, body.currentPassword))) return reply;

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.response as unknown as RegistrationResponseJSON,
          expectedChallenge: pending.challenge,
          expectedOrigin: config.webauthn.origins,
          expectedRPID: config.webauthn.rpId,
          requireUserVerification: true,
        });
      } catch (err) {
        return reply.status(400).send({ error: `The passkey could not be verified: ${(err as Error).message}` });
      }
      if (!verification.verified) return reply.status(400).send({ error: 'The passkey could not be verified' });

      const info = verification.registrationInfo;
      const sessionId = req.sessionId;
      const db = getDb();
      // Everything the checks above relied on is re-read and written in one
      // synchronous transaction: another browser may have added or removed a
      // passkey during the awaits.
      const outcome = db.transaction(() => {
        const count = passkeyCount(req.user.id);
        if (count && !req.passkeyVerified) return { refused: 'step_up' as const };
        if (count >= MAX_PASSKEYS_PER_USER) return { refused: 'limit' as const };
        if (findPasskeyByCredential(info.credential.id)) return { refused: 'duplicate' as const };

        const row = {
          id: nanoid(),
          userId: req.user.id,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: info.credential.counter,
          transports: JSON.stringify(info.credential.transports ?? []),
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          name: body.name ?? `Passkey ${count + 1}`,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        };
        db.insert(passkeys).values(row).run();

        // Creating it took user verification on the authenticator, which is the
        // same proof a passkey sign-in gives — so it verifies this session. On a
        // first passkey every other password-only session ends: if this was the
        // owner, a thief's session goes; if a thief, the owner notices.
        let otherSessionsRevoked = 0;
        if (count === 0) {
          otherSessionsRevoked = db
            .delete(sessions)
            .where(and(eq(sessions.userId, req.user.id), ne(sessions.id, sessionId), eq(sessions.passkeyVerified, false)))
            .run().changes;
        }
        if (!req.passkeyVerified) markSessionPasskeyVerified(sessionId);
        return { row, first: count === 0, otherSessionsRevoked };
      });

      if ('refused' in outcome) {
        if (outcome.refused === 'step_up') {
          return reply.status(403).send({ error: STEP_UP_MESSAGE, code: 'PASSKEY_STEP_UP_REQUIRED' });
        }
        return reply.status(409).send({
          error:
            outcome.refused === 'limit'
              ? `You can register up to ${MAX_PASSKEYS_PER_USER} passkeys`
              : 'This passkey is already registered',
        });
      }

      const { row, first, otherSessionsRevoked } = outcome;
      // Live terminals, file sessions and agent streams are tracked per user,
      // not per browser, so this also ends ones this browser opened.
      const live = otherSessionsRevoked ? revokeLiveAccess(req.user.id) : undefined;
      await audit(req, 'user.passkey_added', 'passkey', row.id, row.name, {
        deviceType: row.deviceType,
        backedUp: row.backedUp,
        ...(first && { firstPasskey: true, passwordConfirmed: true, otherSessionsRevoked }),
        ...(live && { live }),
      });
      notifyPasskeyAdded(req.user, row.name, req.ip);
      return reply.status(201).send({ passkey: toPasskeyInfo(row), passkeyVerified: true });
    },
  );

  /** Confirm an existing passkey in the current session — before adding or removing one, or to satisfy an org policy. */
  app.post(
    '/passkeys/step-up/options',
    { preHandler: requireAuth, config: { passkeyExempt: true } },
    async (req, reply) => {
      if (!requireBrowserSession(req, reply)) return reply;
      const credentials = userPasskeys(req.user.id);
      if (!credentials.length) return reply.status(409).send({ error: 'You have no passkeys yet' });

      const options = await authenticationOptions(credentials);
      const { id } = issueChallenge('step_up', options.challenge, {
        userId: req.user.id,
        sessionHash: publicSessionId(req.sessionId),
      });
      return { challengeId: id, options };
    },
  );

  app.post(
    '/passkeys/step-up/verify',
    { preHandler: requireAuth, config: { passkeyExempt: true } },
    async (req, reply) => {
      const body = challengeResponseSchema.parse(req.body);
      if (!requireBrowserSession(req, reply)) return reply;
      const pending = consumeChallenge(
        'step_up',
        { id: body.challengeId },
        { userId: req.user.id, sessionHash: publicSessionId(req.sessionId) },
      );
      if (!pending) return reply.status(400).send({ error: 'This passkey request has expired. Try again.' });

      const passkey = findPasskeyByCredential(body.response.id, req.user.id);
      if (!passkey || !(await verifyAssertion(asAssertion(body.response), pending.challenge, passkey))) {
        // Not 401: the session itself is still good
        return reply.status(400).send({ error: 'Passkey verification failed' });
      }

      markSessionPasskeyVerified(req.sessionId);
      await audit(req, 'user.login_passkey', 'user', req.user.id, req.user.email, { method: 'step_up' });
      return { passkeyVerified: true };
    },
  );

  app.patch('/passkeys/:id', { preHandler: requireAuth }, async (req, reply): Promise<PasskeyInfo | undefined> => {
    const { id } = req.params as { id: string };
    const { name } = renamePasskeySchema.parse(req.body);
    const db = getDb();
    const passkey = db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, req.user.id)))
      .get();
    if (!passkey) return reply.status(404).send({ error: 'Passkey not found' });

    db.update(passkeys).set({ name }).where(eq(passkeys.id, id)).run();
    return toPasskeyInfo({ ...passkey, name });
  });

  /** Remove a passkey. Needs a passkey-verified session, and never strands an org that requires one. */
  app.delete('/passkeys/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireBrowserSession(req, reply)) return reply;
    if (!req.passkeyVerified) {
      return reply.status(403).send({ error: STEP_UP_MESSAGE, code: 'PASSKEY_STEP_UP_REQUIRED' });
    }

    const db = getDb();
    const passkey = db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, req.user.id)))
      .get();
    if (!passkey) return reply.status(404).send({ error: 'Passkey not found' });

    // Count and delete together, so two concurrent deletes cannot both see "not the last one"
    const removed = db.transaction(() => {
      const count = passkeyCount(req.user.id);
      if (count === 1 && anyActiveOrgRequiresPasskey(req.user.id)) return false;
      db.delete(passkeys).where(eq(passkeys.id, id)).run();
      // Backup codes stand in for a passkey; with none left they would only be
      // waiting to come back to life with the next one
      if (count === 1) deleteBackupCodes(req.user.id);
      return true;
    });
    if (!removed) {
      return reply.status(409).send({
        error: 'An organization you belong to requires passkeys, so you cannot remove your last one. Add another first.',
      });
    }

    await audit(req, 'user.passkey_removed', 'passkey', id, passkey.name);
    return reply.status(204).send();
  });
}
