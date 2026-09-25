import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { users, sessions, memberships, organizations } from '../../db/schema.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  createSession,
  findUserSession,
  invalidateSession,
  publicSessionId,
  setActiveOrg,
} from '../../auth/session.js';
import { requireAuth, resolveMembership, ROLES, SUSPENDED_MESSAGE, type Role } from '../../auth/middleware.js';
import { audit } from '../../audit/index.js';
import { and, asc, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { OrgSummary, SessionInfo } from '@smt/shared';

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

function asRole(role: string): Role {
  return ROLES.includes(role as Role) ? (role as Role) : 'viewer';
}

export async function authRoutes(app: FastifyInstance) {
  // Tighter than the global limit: this is the only unauthenticated password check.
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const db = getDb();

    // Emails are case-insensitive in practice; lower() also matches rows stored
    // before addresses were normalized.
    const user = db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email}`)
      .get();
    if (!user || !user.passwordHash) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    // The password was right, so saying why is not an oracle for anything.
    const resolved = resolveMembership(user.id);
    if (resolved.status === 'suspended') {
      return reply.status(403).send({ error: SUSPENDED_MESSAGE });
    }
    const membership = resolved.status === 'ok' ? resolved.membership : undefined;

    const session = await createSession(user.id, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      activeOrgId: membership?.orgId,
    });
    reply.setCookie('smt_session', session.id, { httpOnly: true, sameSite: 'lax', path: '/' });

    if (membership) {
      // Not behind requireAuth, so fill in who this is for the audit row
      req.user = { id: user.id, email: user.email, displayName: user.displayName };
      req.orgId = membership.orgId;
      await audit(req, 'user.login', 'user', user.id, user.email);
    }
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

  /** Organizations the caller belongs to, for the org switcher. */
  app.get('/orgs', { preHandler: requireAuth }, async (req): Promise<OrgSummary[]> => {
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
  app.post('/switch-org', { preHandler: requireAuth }, async (req, reply) => {
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
