import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { users, sessions, memberships } from '../../db/schema.js';
import { verifyPassword } from '../../auth/password.js';
import { createSession, invalidateSession } from '../../auth/session.js';
import { requireAuth } from '../../auth/middleware.js';
import { eq } from 'drizzle-orm';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const db = getDb();

    const user = db.select().from(users).where(eq(users.email, body.email)).get();
    if (!user || !user.passwordHash) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const membership = db.select().from(memberships).where(eq(memberships.userId, user.id)).get();
    const session = await createSession(user.id);
    reply.setCookie('smt_session', session.id, { httpOnly: true, sameSite: 'lax', path: '/' });
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      orgId: membership?.orgId ?? null,
      role: membership?.role ?? 'viewer',
    };
  });

  app.post('/logout', { preHandler: requireAuth }, async (req, reply) => {
    const sessionId = req.cookies['smt_session'];
    if (sessionId) await invalidateSession(sessionId);
    reply.clearCookie('smt_session');
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    return { ...req.user, orgId: req.orgId, role: req.role };
  });
}
