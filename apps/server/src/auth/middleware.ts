import type { FastifyRequest, FastifyReply } from 'fastify';
import { touchSession, validateSession } from './session.js';
import { getDb } from '../db/index.js';
import { users, memberships, apiTokens } from '../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import {
  bearerFrom,
  effectiveRole,
  isExpired,
  parseApiToken,
  secretMatches,
  type TokenScope,
} from './token.js';
import {
  orgRequiresPasskey,
  orgRestrictsBackupCodeSessions,
  PASSKEY_REQUIRED_MESSAGE,
  RECOVERY_ONLY_MESSAGE,
  TOKEN_PASSKEY_REQUIRED_MESSAGE,
} from './passkey.js';

/** Ordered least- to most-privileged; every role implies the ones before it. */
export const ROLES = ['viewer', 'operator', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; displayName: string };
    orgId: string;
    role: Role;
    /** True when the caller authenticated with an API token rather than a session. */
    viaApiToken: boolean;
    /** The session cookie that authenticated this request; null for API tokens. */
    sessionId: string | null;
    /** The session signed in or stepped up with a passkey. Always false for API tokens. */
    passkeyVerified: boolean;
    /**
     * Signed in with a backup code, not yet stepped up, in an org that holds
     * such sessions to enrolling a passkey. Only `recoveryAllowed` routes run.
     */
    recoveryOnly: boolean;
  }
  interface FastifyContextConfig {
    /**
     * Reachable by a session that has not yet used a passkey, even in an org
     * that requires one — just enough to find out why, enroll or verify, sign
     * out, or move to another org.
     */
    passkeyExempt?: boolean;
    /**
     * Reachable by a backup-code session held to recovery: enough to add a
     * passkey, verify with it, see who is signed in, sign out or switch org.
     */
    recoveryAllowed?: boolean;
  }
}

export const SUSPENDED_MESSAGE =
  'Your access to this organization has been suspended. Contact an organization admin.';

type Membership = typeof memberships.$inferSelect;

export type MembershipResolution =
  | { status: 'ok'; membership: Membership }
  /** Memberships exist, but none the caller may use right now. */
  | { status: 'suspended' }
  | { status: 'none' };

/**
 * Pick the org a request acts in: the preferred one (a session's active org)
 * when it is still an active membership, else the oldest active membership.
 * A suspended membership is never chosen — suspension would otherwise only
 * last until the next fallback.
 */
export function resolveMembership(userId: string, preferredOrgId?: string | null): MembershipResolution {
  const rows = getDb()
    .select()
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.joinedAt))
    .all();
  if (rows.length === 0) return { status: 'none' };

  const active = rows.filter((m) => m.status === 'active');
  const preferred = preferredOrgId ? active.find((m) => m.orgId === preferredOrgId) : undefined;
  const chosen = preferred ?? active[0];
  return chosen ? { status: 'ok', membership: chosen } : { status: 'suspended' };
}

export function rank(role: string): number {
  const index = ROLES.indexOf(role as Role);
  // Unknown roles are treated as the least privileged, never the most
  return index === -1 ? 0 : index;
}

/**
 * Gate a route on a minimum role. Must run after `requireAuth`, which is what
 * populates `req.role` from the caller's membership.
 *
 *   app.post('/', { preHandler: requireRole('admin') }, handler)
 */
export function requireRole(minimum: Role) {
  return async function roleGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.role) return reply.status(401).send({ error: 'Unauthorized' });
    if (rank(req.role) < rank(minimum)) {
      return reply
        .status(403)
        .send({ error: `Requires ${minimum} role or higher (you are ${req.role})` });
    }
  };
}

type TokenAuth =
  /** No `smt_…` bearer was presented — fall through to session auth. */
  | { status: 'absent' }
  /** One of ours, but unknown, wrong, or past its expiry. */
  | { status: 'invalid' }
  | { status: 'ok'; userId: string; scopes: TokenScope[]; passkeyVerified: boolean };

/**
 * Resolve the caller from an `Authorization: Bearer smt_…` header.
 *
 * Only headers carrying our own token format are claimed. Anything else — a
 * different scheme, another service's bearer added by a proxy — is left alone
 * so a valid session cookie still authenticates the request.
 */
async function resolveApiToken(req: FastifyRequest): Promise<TokenAuth> {
  const raw = bearerFrom(req.headers.authorization);
  if (!raw) return { status: 'absent' };

  const parsed = parseApiToken(raw);
  if (!parsed) return { status: 'absent' };

  const db = getDb();
  const token = db.select().from(apiTokens).where(eq(apiTokens.prefix, parsed.prefix)).get();
  if (!token) return { status: 'invalid' };
  if (!secretMatches(parsed.secret, token.hashedToken)) return { status: 'invalid' };
  if (isExpired(token.expiresAt)) return { status: 'invalid' };

  // Best-effort: a failed bookkeeping write must not fail the request.
  try {
    db.update(apiTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiTokens.id, token.id))
      .run();
  } catch {
    /* ignore */
  }

  let scopes: TokenScope[] = [];
  try {
    scopes = JSON.parse(token.scopes) as TokenScope[];
  } catch {
    scopes = [];
  }

  return { status: 'ok', userId: token.userId, scopes, passkeyVerified: token.passkeyVerified };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const db = getDb();

  // A bearer token identifies a caller just as a session cookie does, but it
  // may also cap what that caller is allowed to do.
  const apiToken = await resolveApiToken(req);
  let userId: string;
  let scopes: TokenScope[] | null = null;
  let tokenPasskeyVerified = false;
  let session: Awaited<ReturnType<typeof validateSession>> = null;

  if (apiToken.status === 'ok') {
    userId = apiToken.userId;
    scopes = apiToken.scopes;
    tokenPasskeyVerified = apiToken.passkeyVerified;
  } else {
    if (apiToken.status === 'invalid') {
      // A presented-but-unusable token should say so, not fall through to
      // "no credentials" and confuse whoever is debugging their script.
      return reply.status(401).send({ error: 'Invalid or expired API token' });
    }
    const sessionId = req.cookies['smt_session'];
    if (!sessionId) return reply.status(401).send({ error: 'Unauthorized' });

    session = await validateSession(sessionId);
    if (!session) return reply.status(401).send({ error: 'Session expired' });
    userId = session.userId;
  }

  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  // Resolve orgId from URL param, else the session's chosen org, else the first active one
  const orgIdParam = (req.params as Record<string, string>)['orgId'];
  let membership: Membership | undefined;
  if (orgIdParam) {
    membership = db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, orgIdParam)))
      .get();
    if (!membership) return reply.status(403).send({ error: 'Forbidden' });
    if (membership.status !== 'active') return reply.status(403).send({ error: SUSPENDED_MESSAGE });
  } else {
    const resolved = resolveMembership(user.id, session?.activeOrgId);
    if (resolved.status === 'suspended') return reply.status(403).send({ error: SUSPENDED_MESSAGE });
    if (resolved.status === 'none') return reply.status(403).send({ error: 'Forbidden' });
    membership = resolved.membership;
  }

  // A session must have signed in or stepped up with a passkey; a token must
  // have been minted by such a session. Only sessions get the exempt routes —
  // they exist to reach enrollment and verification, which tokens cannot do.
  const passkeyMissing = scopes
    ? !tokenPasskeyVerified
    : !session!.passkeyVerified && !req.routeOptions.config.passkeyExempt;
  if (passkeyMissing && orgRequiresPasskey(membership.orgId)) {
    return reply.status(403).send({
      error: scopes ? TOKEN_PASSKEY_REQUIRED_MESSAGE : PASSKEY_REQUIRED_MESSAGE,
      code: 'PASSKEY_REQUIRED',
    });
  }

  // A backup code got this session in; until it verifies with a passkey it may
  // only enroll one, in orgs that ask for that (the default)
  const recoveryOnly = !!session?.recoveryOnly && orgRestrictsBackupCodeSessions(membership.orgId);
  if (recoveryOnly && !req.routeOptions.config.recoveryAllowed) {
    return reply.status(403).send({ error: RECOVERY_ONLY_MESSAGE, code: 'RECOVERY_ONLY' });
  }

  const membershipRole = ROLES.includes(membership.role as Role)
    ? (membership.role as Role)
    : 'viewer';

  // Role checks only guard routes that ask for one; a read-only token must not
  // change anything even where a viewer session may (profile, own tokens).
  if (scopes && !scopes.includes('write') && !SAFE_METHODS.has(req.method)) {
    return reply.status(403).send({ error: 'This API token is read-only' });
  }

  req.user = { id: user.id, email: user.email, displayName: user.displayName };
  req.orgId = membership.orgId;
  // A token can only narrow what its owner may do, never widen it.
  req.role = scopes ? effectiveRole(membershipRole, scopes) : membershipRole;
  req.viaApiToken = scopes !== null;
  req.sessionId = session?.id ?? null;
  req.passkeyVerified = session?.passkeyVerified ?? false;
  req.recoveryOnly = recoveryOnly;

  if (session) touchSession(session, req.ip);
}
