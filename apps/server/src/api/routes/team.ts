import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { requireAuth, requireRole, ROLES, type Role } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { invites, memberships, organizations, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { createSession } from '../../auth/session.js';
import {
  canGrantRole,
  emailsMatch,
  generateInviteToken,
  inviteExpiry,
  inviteState,
  maskEmail,
  wouldOrphanOrg,
} from '../../auth/invite.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';

const roleSchema = z.enum(ROLES);

const createInviteSchema = z.object({
  // trim() before email() — a pasted address often carries whitespace
  email: z.string().trim().email().max(254),
  role: roleSchema.default('viewer'),
});

const changeRoleSchema = z.object({ role: roleSchema });

const acceptInviteSchema = z.object({
  /** Proves the redeemer is the person the invite was sent to, not just a link holder. */
  email: z.string().trim().email().max(254),
  displayName: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
});

function inviteLink(token: string): string {
  return `${config.baseUrl.replace(/\/$/, '')}/invite/${token}`;
}

function orgMembers(orgId: string) {
  return getDb()
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.orgId, orgId))
    .all();
}

/** Authenticated team management: who is in the org, and who has been asked. */
export async function teamRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/members', async (req) => {
    return getDb()
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: memberships.role,
        joinedAt: memberships.joinedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, req.orgId))
      .all();
  });

  app.patch('/members/:userId', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { role } = changeRoleSchema.parse(req.body);
    const db = getDb();

    if (userId === req.user.id) {
      return reply.status(400).send({ error: 'You cannot change your own role' });
    }
    if (!canGrantRole(req.role, role)) {
      return reply.status(403).send({ error: `You cannot grant the ${role} role` });
    }

    const member = db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
      .get();
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });

    // Demoting someone above you would let an admin unseat an owner.
    if (!canGrantRole(req.role, member.role as Role)) {
      return reply
        .status(403)
        .send({ error: `You cannot modify a member with the ${member.role} role` });
    }
    if (wouldOrphanOrg(orgMembers(req.orgId), userId, role)) {
      return reply.status(400).send({ error: 'The organization must keep at least one owner' });
    }

    db.update(memberships)
      .set({ role })
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
      .run();

    const target = db.select().from(users).where(eq(users.id, userId)).get();
    await audit(req, 'member.role_change', 'member', userId, target?.email, {
      from: member.role,
      to: role,
    });
    return { userId, role };
  });

  app.delete('/members/:userId', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const db = getDb();

    if (userId === req.user.id) {
      return reply.status(400).send({ error: 'You cannot remove yourself' });
    }

    const member = db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
      .get();
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });

    if (!canGrantRole(req.role, member.role as Role)) {
      return reply
        .status(403)
        .send({ error: `You cannot remove a member with the ${member.role} role` });
    }
    if (wouldOrphanOrg(orgMembers(req.orgId), userId, null)) {
      return reply.status(400).send({ error: 'The organization must keep at least one owner' });
    }

    const target = db.select().from(users).where(eq(users.id, userId)).get();
    db.delete(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
      .run();

    await audit(req, 'member.remove', 'member', userId, target?.email);
    return reply.status(204).send();
  });

  app.get('/invites', { preHandler: requireRole('admin') }, async (req) => {
    const rows = getDb()
      .select()
      .from(invites)
      .where(and(eq(invites.orgId, req.orgId), isNull(invites.acceptedAt)))
      .orderBy(desc(invites.createdAt))
      .all();

    // No `link` here by design: the URL is shown once, at creation. Re-reading it
    // from the API would make every admin session a way to recover a live invite.
    return rows.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      state: inviteState(invite),
    }));
  });

  app.post('/invites', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = createInviteSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const db = getDb();

    if (!canGrantRole(req.role, body.role)) {
      return reply.status(403).send({ error: `You cannot invite someone as ${body.role}` });
    }

    const existingUser = db.select().from(users).where(eq(users.email, email)).get();
    if (existingUser) {
      const alreadyMember = db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, existingUser.id), eq(memberships.orgId, req.orgId)))
        .get();
      if (alreadyMember) {
        return reply.status(409).send({ error: 'That person is already a member' });
      }
      return reply
        .status(409)
        .send({ error: 'An account already uses that email address' });
    }

    const pending = db
      .select()
      .from(invites)
      .where(and(eq(invites.orgId, req.orgId), eq(invites.email, email), isNull(invites.acceptedAt)))
      .get();
    if (pending && inviteState(pending) === 'valid') {
      return reply.status(409).send({ error: 'That email already has a pending invite' });
    }

    const id = nanoid();
    const token = generateInviteToken();
    db.insert(invites)
      .values({
        id,
        orgId: req.orgId,
        email,
        role: body.role,
        token,
        invitedBy: req.user.id,
        expiresAt: inviteExpiry(),
      })
      .run();

    await audit(req, 'user.invite', 'invite', id, email, { role: body.role });
    // The only time the link is ever returned.
    return reply.status(201).send({
      id,
      email,
      role: body.role,
      expiresAt: inviteExpiry(),
      state: 'valid' as const,
      link: inviteLink(token),
    });
  });

  app.delete('/invites/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const invite = db
      .select()
      .from(invites)
      .where(and(eq(invites.id, id), eq(invites.orgId, req.orgId)))
      .get();
    if (!invite) return reply.status(404).send({ error: 'Not found' });

    db.delete(invites).where(eq(invites.id, id)).run();
    await audit(req, 'member.remove', 'invite', id, invite.email);
    return reply.status(204).send();
  });
}

/**
 * The two unauthenticated halves of the flow: reading an invite and accepting
 * it. Registered separately so the auth hook above does not apply.
 */
export async function publicInviteRoutes(app: FastifyInstance) {
  app.get('/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const db = getDb();

    const invite = db.select().from(invites).where(eq(invites.token, token)).get();
    if (!invite) return reply.status(404).send({ error: 'Invite not found' });

    const org = db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, invite.orgId))
      .get();

    return {
      // Masked: holding the link must not reveal the address needed to redeem it.
      emailHint: maskEmail(invite.email),
      role: invite.role,
      organizationName: org?.name ?? 'the organization',
      state: inviteState(invite),
    };
  });

  app.post(
    '/:token/accept',
    // Tighter than the global limit: the email check is guessable given enough tries.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const body = acceptInviteSchema.parse(req.body);
      const db = getDb();

      const invite = db.select().from(invites).where(eq(invites.token, token)).get();
      if (!invite) return reply.status(404).send({ error: 'Invite not found' });

      const state = inviteState(invite);
      if (state !== 'valid') {
        return reply
          .status(410)
          .send({ error: state === 'accepted' ? 'Invite already used' : 'Invite has expired' });
      }

      // The link proves possession; the address proves it reached the right person.
      if (!emailsMatch(body.email, invite.email)) {
        return reply
          .status(403)
          .send({ error: 'That email address does not match this invite' });
      }

      // An invite must never be able to set a password on an existing account.
      const existing = db.select().from(users).where(eq(users.email, invite.email)).get();
      if (existing) {
        return reply
          .status(409)
          .send({ error: 'An account already uses that email address — sign in instead' });
      }

      const userId = nanoid();
      const passwordHash = await hashPassword(body.password);

      db.transaction(() => {
        db.insert(users)
          .values({ id: userId, email: invite.email, displayName: body.displayName, passwordHash })
          .run();
        db.insert(memberships)
          .values({ userId, orgId: invite.orgId, role: invite.role })
          .run();
        db.update(invites)
          .set({ acceptedAt: new Date().toISOString() })
          .where(eq(invites.id, invite.id))
          .run();
      });

      const session = await createSession(userId);
      reply.setCookie('smt_session', session.id, { httpOnly: true, sameSite: 'lax', path: '/' });

      return reply.status(201).send({
        user: { id: userId, email: invite.email, displayName: body.displayName },
        orgId: invite.orgId,
        role: invite.role,
      });
    },
  );
}
