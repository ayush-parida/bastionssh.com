import type { FastifyRequest, FastifyReply } from 'fastify';
import { validateSession } from './session.js';
import { getDb } from '../db/index.js';
import { users, memberships } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; displayName: string };
    orgId: string;
  }
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
}
