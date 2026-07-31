import type { FastifyRequest, FastifyReply } from 'fastify';
import { validateSession } from './session.js';
import { getDb } from '../db/index.js';
import { users, memberships } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

/** Ordered least- to most-privileged; every role implies the ones before it. */
export const ROLES = ['viewer', 'operator', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; displayName: string };
    orgId: string;
    role: Role;
  }
}

function rank(role: string): number {
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

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const sessionId = req.cookies['smt_session'];
  if (!sessionId) return reply.status(401).send({ error: 'Unauthorized' });

  const session = await validateSession(sessionId);
  if (!session) return reply.status(401).send({ error: 'Session expired' });

  const db = getDb();
  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
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

  req.user = { id: user.id, email: user.email, displayName: user.displayName };
  req.orgId = membership.orgId;
  req.role = ROLES.includes(membership.role as Role) ? (membership.role as Role) : 'viewer';
}
