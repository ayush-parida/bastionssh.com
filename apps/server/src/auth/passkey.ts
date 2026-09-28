import { createHash, randomBytes } from 'crypto';
import { and, count, eq, inArray, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PasskeyInfo } from '@smt/shared';
import { getDb } from '../db/index.js';
import { memberships, organizations, passkeys, sessions, webauthnChallenges } from '../db/schema.js';
import { config } from '../config/index.js';
import { emailAvailable, sendEmail } from '../notifications/email.js';
import logger from '../logger.js';

/** How long a ceremony (or a password-checked login waiting for its passkey) may take. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Enough for every device someone owns; a bound on what one account can store. */
export const MAX_PASSKEYS_PER_USER = 20;

export type ChallengePurpose = 'register' | 'login' | 'second_factor' | 'step_up';

type Passkey = typeof passkeys.$inferSelect;
type Challenge = typeof webauthnChallenges.$inferSelect;

export const PASSKEY_REQUIRED_MESSAGE =
  'This organization requires signing in with a passkey. Verify with your passkey, or add one, to continue.';

export const TOKEN_PASSKEY_REQUIRED_MESSAGE =
  'This organization requires passkeys, and this API token was not created from a passkey-verified session. Create a new token after signing in with your passkey.';

export const STEP_UP_MESSAGE = 'Confirm with one of your existing passkeys first';

export const RECOVERY_ONLY_MESSAGE =
  'You signed in with a backup code. Add a new passkey and verify with it before doing anything else.';

/**
 * A first passkey may only be enrolled from a session this young (plus the
 * password again), so a stolen password or an old unattended browser cannot
 * quietly add an attacker's passkey.
 */
export const FIRST_ENROLLMENT_MAX_SESSION_AGE_MS = 15 * 60 * 1000;

export function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

/**
 * Remember a challenge until it is answered or expires. Expired rows are
 * pruned on the way in, so the table only ever holds live ceremonies.
 * Returns the row id and, for `second_factor`, the ticket that redeems it.
 */
export function issueChallenge(
  purpose: ChallengePurpose,
  challenge: string,
  bind: { userId?: string; sessionHash?: string; withTicket?: boolean } = {},
): { id: string; ticket?: string } {
  const db = getDb();
  const now = new Date();
  db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now.toISOString())).run();

  const id = nanoid();
  const ticket = bind.withTicket ? randomBytes(32).toString('base64url') : undefined;
  db.insert(webauthnChallenges)
    .values({
      id,
      challenge,
      purpose,
      userId: bind.userId ?? null,
      sessionHash: bind.sessionHash ?? null,
      ticketHash: ticket ? hashTicket(ticket) : null,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    })
    .run();
  return { id, ticket };
}

/**
 * Take a challenge out of the table, whatever happens next: a failed attempt
 * starts a new ceremony rather than retrying this one. Null when it does not
 * exist, was already used, belongs to someone else, or has expired.
 */
export function consumeChallenge(
  purpose: ChallengePurpose,
  lookup: { id: string } | { ticket: string },
  bind: { userId?: string; sessionHash?: string } = {},
): Challenge | null {
  const db = getDb();
  const row = db
    .delete(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.purpose, purpose),
        'id' in lookup
          ? eq(webauthnChallenges.id, lookup.id)
          : eq(webauthnChallenges.ticketHash, hashTicket(lookup.ticket)),
      ),
    )
    .returning()
    .get();
  if (!row) return null;
  if (new Date(row.expiresAt) <= new Date()) return null;
  if (bind.userId !== undefined && row.userId !== bind.userId) return null;
  if (bind.sessionHash !== undefined && row.sessionHash !== bind.sessionHash) return null;
  return row;
}

export function userPasskeys(userId: string): Passkey[] {
  return getDb().select().from(passkeys).where(eq(passkeys.userId, userId)).all();
}

export function passkeyCount(userId: string): number {
  return getDb().select({ n: count() }).from(passkeys).where(eq(passkeys.userId, userId)).get()?.n ?? 0;
}

export function parseTransports(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function toPasskeyInfo(p: Passkey): PasskeyInfo {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    deviceType: p.deviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice',
    backedUp: p.backedUp,
  };
}

/**
 * Options for `navigator.credentials.get()`. With `credentials`, only those may
 * answer (the second step of a password login, a step-up); without, the
 * browser offers whatever discoverable passkey the user picks.
 */
export function authenticationOptions(credentials?: Passkey[]): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: config.webauthn.rpId,
    allowCredentials: credentials?.map((p) => ({ id: p.credentialId, transports: parseTransports(p.transports) })),
    // A passkey on its own is a full sign-in, so it must prove who, not just that someone is there
    userVerification: 'required',
  });
}

/**
 * Check an assertion against a stored passkey and record its use. False for
 * anything short of a verified, user-verified response — including a
 * signature counter that went backwards, which suggests a cloned authenticator.
 */
export async function verifyAssertion(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  passkey: Passkey,
): Promise<boolean> {
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.webauthn.origins,
      expectedRPID: config.webauthn.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.counter,
        transports: parseTransports(passkey.transports),
      },
      requireUserVerification: true,
    });
  } catch {
    return false;
  }
  if (!result.verified) return false;

  getDb()
    .update(passkeys)
    .set({
      counter: result.authenticationInfo.newCounter,
      backedUp: result.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date().toISOString(),
    })
    .where(eq(passkeys.id, passkey.id))
    .run();
  return true;
}

export function findPasskeyByCredential(credentialId: string, userId?: string): Passkey | undefined {
  return getDb()
    .select()
    .from(passkeys)
    .where(
      userId
        ? and(eq(passkeys.credentialId, credentialId), eq(passkeys.userId, userId))
        : eq(passkeys.credentialId, credentialId),
    )
    .get();
}

export function orgRequiresPasskey(orgId: string): boolean {
  return (
    getDb()
      .select({ requirePasskey: organizations.requirePasskey })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .get()?.requirePasskey ?? false
  );
}

/**
 * Whether a session signed in with a backup code is held to enrolling a
 * passkey and verifying with it in this org. On unless an owner turned it off.
 */
export function orgRestrictsBackupCodeSessions(orgId: string): boolean {
  return (
    getDb()
      .select({ on: organizations.backupCodeRecoveryOnly })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .get()?.on ?? true
  );
}

/** Whether any org the user can currently act in requires passkeys. */
export function anyActiveOrgRequiresPasskey(userId: string): boolean {
  const orgIds = getDb()
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .all()
    .map((m) => m.orgId);
  if (!orgIds.length) return false;
  return !!getDb()
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(inArray(organizations.id, orgIds), eq(organizations.requirePasskey, true)))
    .get();
}

/** A passkey was used in this session, which also ends a backup-code recovery. */
export function markSessionPasskeyVerified(sessionId: string) {
  getDb()
    .update(sessions)
    .set({ passkeyVerified: true, recoveryOnly: false })
    .where(eq(sessions.id, sessionId))
    .run();
}

/** Actions that need a person at a browser; an API token cannot do them. Sends 403 when not. */
export function requireBrowserSession(
  req: FastifyRequest,
  reply: FastifyReply,
  error = 'Passkeys are managed from a signed-in browser, not with an API token',
): req is FastifyRequest & { sessionId: string } {
  if (req.sessionId) return true;
  reply.status(403).send({ error });
  return false;
}

/**
 * Sensitive actions (credentials, other people's accounts) need a session that
 * has used a passkey whenever the actor has one — a password alone must not
 * be enough to do what the passkey protects — and always in an org that
 * requires passkeys. Sends 403 PASSKEY_STEP_UP_REQUIRED and returns false when
 * the caller must step up first.
 */
export function requireStepUpIfPasskeys(req: FastifyRequest, reply: FastifyReply, orgId?: string): boolean {
  if (req.passkeyVerified) return true;
  if (passkeyCount(req.user.id) === 0 && !(orgId && orgRequiresPasskey(orgId))) return true;
  reply.status(403).send({ error: STEP_UP_MESSAGE, code: 'PASSKEY_STEP_UP_REQUIRED' });
  return false;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Email the account owner about a change to how they sign in, when the
 * operator configured SMTP. Best-effort and never awaited by the request: if
 * it was not them, this is how they find out.
 */
export function notifyAccountOwner(
  user: { email: string; displayName: string },
  subject: string,
  what: string,
  notice: string,
  advice = 'If this was not you, ask an organization admin to reset your passkeys and your password right away.',
) {
  if (!emailAvailable()) return;
  const lines = [`Hi ${user.displayName},`, what, advice];
  sendEmail({
    to: [user.email],
    subject,
    text: lines.join('\n\n'),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(''),
  }).catch((err) => logger.warn({ err }, `Could not send the ${notice} notice`));
}

export function notifyPasskeyAdded(user: { email: string; displayName: string }, passkeyName: string, ip: string) {
  notifyAccountOwner(
    user,
    `A passkey was added to your ${config.webauthn.rpName} account`,
    `A passkey named "${passkeyName}" was added to your ${config.webauthn.rpName} account on ${new Date().toUTCString()} from ${ip}.`,
    'passkey-added',
  );
}

export function notifyBackupCodesGenerated(user: { email: string; displayName: string }, ip: string) {
  notifyAccountOwner(
    user,
    `New backup codes for your ${config.webauthn.rpName} account`,
    `A new set of backup codes was generated for your ${config.webauthn.rpName} account on ${new Date().toUTCString()} from ${ip}. Any earlier codes no longer work.`,
    'backup-codes-generated',
  );
}

export function notifyBackupCodeUsed(user: { email: string; displayName: string }, remaining: number, ip: string) {
  notifyAccountOwner(
    user,
    `A backup code was used to sign in to your ${config.webauthn.rpName} account`,
    `A backup code was used instead of a passkey to sign in to your ${config.webauthn.rpName} account on ${new Date().toUTCString()} from ${ip}. ${remaining} unused ${remaining === 1 ? 'code is' : 'codes are'} left.`,
    'backup-code-used',
  );
}
