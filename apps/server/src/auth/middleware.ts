import type { FastifyRequest, FastifyReply } from 'fastify';
import { validateSession } from './session.js';
import { getDb } from '../db/index.js';
import { users, memberships, apiTokens } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import {
  bearerFrom,
  effectiveRole,
  isExpired,
  parseApiToken,
  secretMatches,
  type TokenScope,
} from './token.js';

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
  }
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
  | { status: 'ok'; userId: string; scopes: TokenScope[] };

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

  return { status: 'ok', userId: token.userId, scopes };
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const db = getDb();

  // A bearer token identifies a caller just as a session cookie does, but it
  // may also cap what that caller is allowed to do.
  const apiToken = await resolveApiToken(req);
  let userId: string;
  let scopes: TokenScope[] | null = null;

  if (apiToken.status === 'ok') {
    userId = apiToken.userId;
    scopes = apiToken.scopes;
  } else {
    if (apiToken.status === 'invalid') {
      // A presented-but-unusable token should say so, not fall through to
      // "no credentials" and confuse whoever is debugging their script.
      return reply.status(401).send({ error: 'Invalid or expired API token' });
    }
    const sessionId = req.cookies['smt_session'];
    if (!sessionId) return reply.status(401).send({ error: 'Unauthorized' });

    const session = await validateSession(sessionId);
    if (!session) return reply.status(401).send({ error: 'Session expired' });
    userId = session.userId;
  }

  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return reply.status(401).send({ error: 'Unauthorized' });

  // Resolve orgId from URL param or default to user's first org
  const orgIdParam = (req.params as Record<string, string>)['orgId'];
  const membership = orgIdParam
    ? db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, orgIdParam)))
        .get()
    : db.select().from(memberships).where(eq(memberships.userId, user.id)).get();

  if (!membership) return reply.status(403).send({ error: 'Forbidden' });

  const membershipRole = ROLES.includes(membership.role as Role)
    ? (membership.role as Role)
    : 'viewer';

  req.user = { id: user.id, email: user.email, displayName: user.displayName };
  req.orgId = membership.orgId;
  // A token can only narrow what its owner may do, never widen it.
  req.role = scopes ? effectiveRole(membershipRole, scopes) : membershipRole;
  req.viaApiToken = scopes !== null;
}
