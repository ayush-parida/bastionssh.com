import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { users, sessions, memberships } from '../../db/schema.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { createSession, invalidateSession } from '../../auth/session.js';
import { requireAuth } from '../../auth/middleware.js';
import { audit } from '../../audit/index.js';
import { and, eq, ne } from 'drizzle-orm';

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
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
}
