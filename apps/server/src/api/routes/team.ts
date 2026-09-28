import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { MemberServerAccess, OrgMember, OrgSecuritySettings, PasswordResetLink } from '@smt/shared';
import { rank, requireAuth, requireRole, ROLES, type Role } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import {
  invites,
  memberServerAccess,
  memberships,
  organizations,
  passkeys,
  passwordResets,
  servers,
  sessions,
  users,
  webauthnChallenges,
} from '../../db/schema.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  createSession,
  invalidateUserSessions,
  setActiveOrg,
  validateSession,
} from '../../auth/session.js';
import {
  generateResetToken,
  hashResetToken,
  resetExpiry,
  resetLink,
} from '../../auth/password-reset.js';
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
import { revokeLiveAccess } from '../../auth/revoke.js';
import { passkeyCount, requireBrowserSession, requireStepUpIfPasskeys } from '../../auth/passkey.js';
import { deleteBackupCodes } from '../../auth/backup-codes.js';
import {
  accountKey,
  clearLoginFailures,
  lockoutStatus,
  notifyNewDeviceSignIn,
  recordFailedLogin,
  recordSignInDevice,
  reportFailedPassword,
  sendLocked,
  type SignInDevice,
} from '../../auth/login-security.js';
import { config } from '../../config/index.js';
import { activeGrantFilter } from '../../auth/server-access.js';
import { activeGrants, MAX_GRANT_MINUTES, minutesFromNow } from '../../auth/access-grants.js';

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

/** Joining with an account that already exists: its credentials, unless already signed in. */
const joinInviteSchema = z.object({
  email: z.string().trim().max(254).optional(),
  password: z.string().max(200).optional(),
});

const settingsSchema = z.object({ requirePasskey: z.boolean() });

const serverAccessSchema = z.object({
  serverAccess: z.enum(['all', 'restricted']),
  serverIds: z.array(z.string().min(1)).max(1000).default([]),
  // Per server: minutes from now for a time-bound grant, null for permanent.
  // A server left out keeps the expiry it already has; a new one is permanent.
  expiresInMinutes: z
    .record(z.string(), z.number().int().min(1).max(MAX_GRANT_MINUTES).nullable())
    .default({}),
});

function inviteLink(token: string): string {
  return `${config.baseUrl.replace(/\/$/, '')}/invite/${token}`;
}

/**
 * Members who count toward "the org keeps an owner". A suspended owner cannot
 * sign in, so an org whose only owners are suspended is as good as orphaned.
 */
function activeOrgMembers(orgId: string) {
  return getDb()
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, 'active')))
    .all();
}

function findUserByEmail(email: string) {
  // lower() also matches rows stored before addresses were normalized
  return getDb()
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
    .get();
}

/**
 * How far above the target the actor must rank:
 *  - `atOrBelow`: the target's rank is at most the actor's (a peer is fine).
 *  - `below`: strictly lower, except that owners may act on other owners —
 *    for actions that lock someone out but hand over nothing (suspend,
 *    reactivate, sign out). Admins cannot do these to each other.
 *  - `strictlyBelow`: strictly lower, no exceptions — for a password reset,
 *    which hands the actor the target's account. Nobody can reset an owner.
 */
type RankRule = 'atOrBelow' | 'below' | 'strictlyBelow';

function outranks(actor: Role, target: Role, rule: RankRule): boolean {
  if (rule === 'atOrBelow') return canGrantRole(actor, target);
  if (rule === 'below' && actor === 'owner' && target === 'owner') return true;
  return rank(target) < rank(actor);
}

/**
 * Shared guard for acting on another member: not yourself, only someone in
 * this org, and only someone the actor outranks per `rule`. Sends the error
 * and returns undefined when the action is not allowed.
 */
function targetMember(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  verb: string,
  rule: RankRule,
) {
  if (userId === req.user.id) {
    reply.status(400).send({ error: `You cannot ${verb} yourself` });
    return undefined;
  }
  const member = getDb()
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
    .get();
  if (!member) {
    reply.status(404).send({ error: 'Not a member of this organization' });
    return undefined;
  }
  if (!outranks(req.role, member.role as Role, rule)) {
    reply.status(403).send({ error: `You cannot ${verb} a member with the ${member.role} role` });
    return undefined;
  }
  return member;
}

function orgSettings(orgId: string): OrgSecuritySettings {
  const db = getDb();
  const org = db
    .select({ requirePasskey: organizations.requirePasskey })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .get();
  const withoutPasskey = db
    .select({ n: count() })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.status, 'active'),
        sql`not exists (select 1 from ${passkeys} where ${passkeys.userId} = ${memberships.userId})`,
      ),
    )
    .get();
  return { requirePasskey: org?.requirePasskey ?? false, membersWithoutPasskey: withoutPasskey?.n ?? 0 };
}

/** End live access in `orgId` for active members (bar `exceptUserId`) with no passkey-verified session. */
function revokeUnverifiedLiveAccess(orgId: string, exceptUserId: string) {
  const db = getDb();
  const members = db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.status, 'active'),
        ne(memberships.userId, exceptUserId),
        sql`not exists (select 1 from ${sessions} where ${sessions.userId} = ${memberships.userId} and ${sessions.passkeyVerified} = 1)`,
      ),
    )
    .all();
  const total = { members: 0, terminals: 0, sftp: 0, agents: 0 };
  for (const { userId } of members) {
    const r = revokeLiveAccess(userId, { orgId });
    if (r.terminals + r.sftp + r.agents === 0) continue;
    total.members++;
    total.terminals += r.terminals;
    total.sftp += r.sftp;
    total.agents += r.agents;
  }
  return total;
}

function userEmail(userId: string) {
  return getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email;
}

/** Authenticated team management: who is in the org, and who has been asked. */
export async function teamRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/members', async (req): Promise<OrgMember[]> => {
    const db = getDb();
    const rows = db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: memberships.role,
        joinedAt: memberships.joinedAt,
        status: memberships.status,
        suspendedAt: memberships.suspendedAt,
        serverAccess: memberships.serverAccess,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, req.orgId))
      .all();

    const userIds = rows.map((r) => r.userId);
    const grants = new Map(
      userIds.length
        ? db
            .select({ userId: memberServerAccess.userId, n: count() })
            .from(memberServerAccess)
            .where(
              and(
                eq(memberServerAccess.orgId, req.orgId),
                inArray(memberServerAccess.userId, userIds),
                activeGrantFilter(),
              ),
            )
            .groupBy(memberServerAccess.userId)
            .all()
            .map((g) => [g.userId, g.n])
        : [],
    );
    const lastSeen = new Map(
      userIds.length
        ? db
            .select({ userId: sessions.userId, at: max(sessions.lastSeenAt) })
            .from(sessions)
            .where(inArray(sessions.userId, userIds))
            .groupBy(sessions.userId)
            .all()
            .map((s) => [s.userId, s.at])
        : [],
    );
    // Who has enrolled is an admin's concern (recovery, the policy warning), not everyone's
    const seesPasskeys = rank(req.role) >= rank('admin');
    const passkeyCounts = new Map(
      userIds.length && seesPasskeys
        ? db
            .select({ userId: passkeys.userId, n: count() })
            .from(passkeys)
            .where(inArray(passkeys.userId, userIds))
            .groupBy(passkeys.userId)
            .all()
            .map((p) => [p.userId, p.n])
        : [],
    );

    return rows.map((r) => ({
      ...r,
      role: r.role as Role,
      status: r.status === 'suspended' ? 'suspended' : 'active',
      serverAccess: r.serverAccess === 'restricted' ? 'restricted' : 'all',
      serverCount: grants.get(r.userId) ?? 0,
      lastActiveAt: lastSeen.get(r.userId) ?? null,
      ...(seesPasskeys && { passkeyCount: passkeyCounts.get(r.userId) ?? 0 }),
    }));
  });

  /** Org-wide security policy. Every member may read it; the count is what owners weigh before enabling. */
  app.get('/settings', async (req): Promise<OrgSecuritySettings> => {
    const settings = orgSettings(req.orgId);
    return rank(req.role) >= rank('admin') ? settings : { requirePasskey: settings.requirePasskey };
  });

  /**
   * Owners only. Turning the requirement on needs the owner's own session to
   * have used a passkey — proof they can still get in once it applies.
   */
  app.patch('/settings', { preHandler: requireRole('owner') }, async (req, reply) => {
    const { requirePasskey } = settingsSchema.parse(req.body);
    const before = orgSettings(req.orgId);

    if (requirePasskey && !before.requirePasskey && !req.passkeyVerified) {
      return reply.status(403).send({
        error:
          passkeyCount(req.user.id) === 0
            ? 'Add a passkey to your own account before requiring them'
            : 'Verify with your passkey before requiring them for everyone',
        code: 'PASSKEY_STEP_UP_REQUIRED',
      });
    }

    if (requirePasskey !== before.requirePasskey) {
      getDb()
        .update(organizations)
        .set({ requirePasskey, updatedAt: new Date().toISOString() })
        .where(eq(organizations.id, req.orgId))
        .run();
      // Open terminals, file sessions and agent streams were started without a
      // passkey and would outlive the switch. They are tracked per user, not
      // per browser, so end them in this org for every member with no
      // passkey-verified session at all. Members who have one keep theirs.
      const live = requirePasskey ? revokeUnverifiedLiveAccess(req.orgId, req.user.id) : undefined;
      await audit(req, 'org.passkey_policy', 'organization', req.orgId, undefined, {
        requirePasskey,
        membersWithoutPasskey: before.membersWithoutPasskey,
        ...(live && { live }),
      });
    }
    return orgSettings(req.orgId);
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
    if (wouldOrphanOrg(activeOrgMembers(req.orgId), userId, role)) {
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
    if (wouldOrphanOrg(activeOrgMembers(req.orgId), userId, null)) {
      return reply.status(400).send({ error: 'The organization must keep at least one owner' });
    }

    const target = db.select().from(users).where(eq(users.id, userId)).get();
    db.transaction(() => {
      db.delete(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
        .run();
      // Grants belong to the membership; a later re-invite starts from nothing
      db.delete(memberServerAccess)
        .where(and(eq(memberServerAccess.userId, userId), eq(memberServerAccess.orgId, req.orgId)))
        .run();
      // A reset link issued here must not outlive the membership that justified it
      db.delete(passwordResets)
        .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)))
        .run();
    });
    // Terminals, file sessions and agent chats already open in this org end now
    const live = revokeLiveAccess(userId, { orgId: req.orgId });

    await audit(req, 'member.remove', 'member', userId, target?.email, { live });
    return reply.status(204).send();
  });

  /** Block a member from this org without removing them. Ends all their sessions. */
  app.post('/members/:userId/suspend', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const member = targetMember(req, reply, userId, 'suspend', 'below');
    if (!member) return reply;

    if (member.status !== 'suspended') {
      if (wouldOrphanOrg(activeOrgMembers(req.orgId), userId, null)) {
        return reply
          .status(400)
          .send({ error: 'The organization must keep at least one active owner' });
      }
      getDb()
        .update(memberships)
        .set({ status: 'suspended', suspendedAt: new Date().toISOString(), suspendedBy: req.user.id })
        .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
        .run();
      // Sessions are per user, not per org — a live cookie would keep working
      // until expiry if left, so every one goes.
      const revoked = invalidateUserSessions(userId);
      // Ending the browser sessions does not end what they already opened here
      const live = revokeLiveAccess(userId, { orgId: req.orgId });
      await audit(req, 'member.suspend', 'member', userId, userEmail(userId), {
        sessionsRevoked: revoked,
        live,
      });
    }
    return { userId, status: 'suspended' as const };
  });

  app.post('/members/:userId/reactivate', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const member = targetMember(req, reply, userId, 'reactivate', 'below');
    if (!member) return reply;

    if (member.status !== 'active') {
      getDb()
        .update(memberships)
        .set({ status: 'active', suspendedAt: null, suspendedBy: null })
        .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
        .run();
      await audit(req, 'member.reactivate', 'member', userId, userEmail(userId));
    }
    return { userId, status: 'active' as const };
  });

  app.get('/members/:userId/access', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const db = getDb();
    const member = db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
      .get();
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });

    // Expired grants are gone as far as anyone is concerned, even before the sweep deletes them
    const grants = activeGrants(req.orgId, userId);
    return {
      serverAccess: member.serverAccess === 'restricted' ? 'restricted' : 'all',
      serverIds: grants.map((g) => g.serverId),
      grants,
    } satisfies MemberServerAccess;
  });

  /** Replace a member's server access wholesale: the mode and the full list of granted servers. */
  app.put('/members/:userId/access', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = serverAccessSchema.parse(req.body);
    const member = targetMember(req, reply, userId, 'change server access for', 'atOrBelow');
    if (!member) return reply;

    if (body.serverAccess === 'restricted' && rank(member.role) >= rank('admin')) {
      return reply
        .status(400)
        .send({ error: 'Owners and admins always have access to every server' });
    }

    const db = getDb();
    const serverIds = [...new Set(body.serverIds)];
    if (serverIds.length) {
      const known = db
        .select({ id: servers.id })
        .from(servers)
        .where(and(eq(servers.orgId, req.orgId), inArray(servers.id, serverIds)))
        .all();
      if (known.length !== serverIds.length) {
        return reply.status(400).send({ error: 'Unknown server in serverIds' });
      }
    }

    const memberGrants = and(eq(memberServerAccess.userId, userId), eq(memberServerAccess.orgId, req.orgId));
    // Existing rows, expired or not: a grant that lapses while the dialog is
    // open must stay lapsed on save, never turn permanent.
    const existing = new Map(
      db.select().from(memberServerAccess).where(memberGrants).all().map((g) => [g.serverId, g]),
    );
    const now = Date.now();
    const rows = serverIds.map((serverId) => {
      const minutes = body.expiresInMinutes[serverId];
      const prior = existing.get(serverId);
      if (minutes === undefined && prior) {
        return { serverId, expiresAt: prior.expiresAt, grantedBy: prior.grantedBy, reason: prior.reason, createdAt: prior.createdAt };
      }
      return {
        serverId,
        expiresAt: minutes == null ? null : minutesFromNow(minutes, now),
        grantedBy: req.user.id,
        reason: null,
        createdAt: new Date(now).toISOString(),
      };
    });

    db.transaction(() => {
      db.update(memberships)
        .set({ serverAccess: body.serverAccess })
        .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
        .run();
      db.delete(memberServerAccess).where(memberGrants).run();
      for (const row of rows) {
        db.insert(memberServerAccess).values({ orgId: req.orgId, userId, ...row }).run();
      }
    });

    const nowIso = new Date(now).toISOString();
    const grants = rows.filter((r) => r.expiresAt === null || r.expiresAt > nowIso);
    const grantedIds = grants.map((g) => g.serverId);
    // Narrowed: anything already open on a server no longer granted closes now
    const live =
      body.serverAccess === 'restricted'
        ? revokeLiveAccess(userId, { orgId: req.orgId, keepServerIds: grantedIds })
        : undefined;

    await audit(req, 'member.access_change', 'member', userId, userEmail(userId), {
      from: member.serverAccess,
      to: body.serverAccess,
      servers: grantedIds.length,
      timeBound: grants.filter((g) => g.expiresAt !== null).length,
      ...(live && { live }),
    });
    return {
      serverAccess: body.serverAccess,
      serverIds: grantedIds,
      grants: grants.map(({ serverId, expiresAt, grantedBy, reason }) => ({ serverId, expiresAt, grantedBy, reason })),
    } satisfies MemberServerAccess;
  });

  /** Issue a one-time link that lets the member set a new password. Shown once. */
  app.post('/members/:userId/password-reset', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    // Hands over someone else's account: a person at a browser, and as strongly signed in as they can be
    if (!requireBrowserSession(req, reply, 'Issuing a password reset requires a signed-in browser, not an API token')) {
      return reply;
    }
    const member = targetMember(req, reply, userId, 'reset the password of', 'strictlyBelow');
    if (!member) return reply;
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return reply;
    const db = getDb();

    // A password is per account, not per org. An admin here must not be able to
    // take over someone who is also a member — perhaps an owner — elsewhere.
    const elsewhere = db
      .select({ orgId: memberships.orgId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), ne(memberships.orgId, req.orgId)))
      .get();
    if (elsewhere) {
      return reply.status(409).send({
        error: 'This person also belongs to another organization, so their password cannot be reset from here',
      });
    }

    const token = generateResetToken();
    const expiresAt = resetExpiry();
    const id = nanoid();
    db.transaction(() => {
      // Only the newest link works; issuing again quietly retires the old one
      db.delete(passwordResets)
        .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)))
        .run();
      db.insert(passwordResets)
        .values({ id, userId, orgId: req.orgId, tokenHash: hashResetToken(token), expiresAt, createdBy: req.user.id })
        .run();
    });

    await audit(req, 'user.password_reset_issued', 'user', userId, userEmail(userId), { resetId: id });
    // The only time the link is ever returned.
    return reply.status(201).send({ link: resetLink(token), expiresAt } satisfies PasswordResetLink);
  });

  /**
   * Recovery for a lost passkey: remove all of a member's passkeys and sign
   * them out. They sign in with their password and enroll again.
   */
  app.delete('/members/:userId/passkeys', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    // Strictly higher, like a password reset: removing the second factor is half a takeover
    if (!requireBrowserSession(req, reply, 'Resetting passkeys requires a signed-in browser, not an API token')) {
      return reply;
    }
    const member = targetMember(req, reply, userId, 'reset the passkeys of', 'strictlyBelow');
    if (!member) return reply;
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return reply;
    const db = getDb();

    // Passkeys are per account, not per org — same reasoning as a password reset
    const elsewhere = db
      .select({ orgId: memberships.orgId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), ne(memberships.orgId, req.orgId)))
      .get();
    if (elsewhere) {
      return reply.status(409).send({
        error: 'This person also belongs to another organization, so their passkeys cannot be reset from here',
      });
    }

    const removed = db.transaction(() => {
      const n = db.delete(passkeys).where(eq(passkeys.userId, userId)).run().changes;
      // Backup codes stand in for the passkeys, so they go with them
      const codes = deleteBackupCodes(userId);
      // A pending sign-in ticket or ceremony must not complete against the old state
      db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, userId)).run();
      return { n, codes };
    });
    const revoked = invalidateUserSessions(userId);
    const live = revokeLiveAccess(userId);

    await audit(req, 'member.passkeys_reset', 'member', userId, userEmail(userId), {
      removed: removed.n,
      backupCodesRemoved: removed.codes,
      sessionsRevoked: revoked,
      live,
    });
    return { removed: removed.n, revoked };
  });

  /** Sign a member out of every browser. */
  app.delete('/members/:userId/sessions', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const member = targetMember(req, reply, userId, 'sign out', 'below');
    if (!member) return reply;

    const revoked = invalidateUserSessions(userId);
    // Everywhere means everywhere: live terminals, file sessions and agent chats too
    const live = revokeLiveAccess(userId);
    await audit(req, 'user.sessions_revoked', 'member', userId, userEmail(userId), {
      scope: 'all',
      count: revoked,
      live,
    });
    return { revoked };
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

    // Someone with an account elsewhere can be invited; they accept by signing in.
    const existingUser = findUserByEmail(email);
    if (existingUser) {
      const alreadyMember = db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, existingUser.id), eq(memberships.orgId, req.orgId)))
        .get();
      if (alreadyMember) {
        return reply.status(409).send({ error: 'That person is already a member' });
      }
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
      existingAccount: !!existingUser,
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
      // Deliberately no hint of whether the address already has an account:
      // the page offers both paths and the accept endpoint decides.
    };
  });

  app.post(
    '/:token/accept',
    // Tighter than the global limit: the email check is guessable given enough tries.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const db = getDb();

      const invite = db.select().from(invites).where(eq(invites.token, token)).get();
      if (!invite) return reply.status(404).send({ error: 'Invite not found' });

      const state = inviteState(invite);
      if (state !== 'valid') {
        return reply
          .status(410)
          .send({ error: state === 'accepted' ? 'Invite already used' : 'Invite has expired' });
      }

      // An existing account joins by proving it is that account — never by
      // having its password overwritten through the invite.
      const existingAccount = findUserByEmail(invite.email);
      if (existingAccount) return joinWithExistingAccount(req, reply, invite, existingAccount);

      const body = acceptInviteSchema.parse(req.body);

      // The link proves possession; the address proves it reached the right person.
      if (!emailsMatch(body.email, invite.email)) {
        return reply
          .status(403)
          .send({ error: 'That email address does not match this invite' });
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

      const session = await createSession(userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        activeOrgId: invite.orgId,
      });
      reply.setCookie('smt_session', session.id, { httpOnly: true, sameSite: 'lax', path: '/' });

      return reply.status(201).send({
        user: { id: userId, email: invite.email, displayName: body.displayName },
        orgId: invite.orgId,
        role: invite.role,
      });
    },
  );
}

/**
 * Accept an invite as an account that already exists. Either the browser is
 * already signed in as exactly that account, or the request carries its email
 * and password. The only effect is a new membership.
 */
async function joinWithExistingAccount(
  req: FastifyRequest,
  reply: FastifyReply,
  invite: typeof invites.$inferSelect,
  account: typeof users.$inferSelect,
) {
  const db = getDb();
  const body = joinInviteSchema.parse(req.body ?? {});

  const cookie = req.cookies['smt_session'];
  const session = cookie ? await validateSession(cookie) : null;

  if (session) {
    if (session.userId !== account.id) {
      return reply.status(403).send({
        error: 'You are signed in as a different account. Sign out, then open this link again.',
      });
    }
  } else {
    if (!body.email || !body.password) {
      return reply
        .status(401)
        .send({ error: 'Sign in with the invited account to accept this invite' });
    }
    if (!emailsMatch(body.email, invite.email)) {
      return reply.status(403).send({ error: 'That email address does not match this invite' });
    }
    // A password check like /auth/login, so under the same per-account pause:
    // otherwise an admin of any org could invite an existing account and guess
    // its password here without ever being paused
    const key = accountKey(account.email);
    const lock = lockoutStatus(key);
    if (lock) return sendLocked(reply, lock);
    const attempt = recordFailedLogin(key);
    if (!account.passwordHash || !(await verifyPassword(body.password, account.passwordHash))) {
      reportFailedPassword(req, account, attempt, { via: 'invite' });
      if (attempt.locked) return sendLocked(reply, attempt.locked);
      return reply.status(401).send({
        // Only reachable with the invited address, so this reveals nothing new
        error: 'Invalid credentials. This address already has an account — sign in with its password to accept.',
      });
    }
    clearLoginFailures(key);
    // The password alone is not a sign-in for an account with passkeys
    if (passkeyCount(account.id) > 0) {
      return reply.status(401).send({
        error: 'This account uses a passkey. Sign in first, then open this link again.',
      });
    }
  }

  const alreadyMember = db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, account.id), eq(memberships.orgId, invite.orgId)))
    .get();
  if (alreadyMember) {
    return reply.status(409).send({ error: 'You are already a member of this organization' });
  }

  db.transaction(() => {
    db.insert(memberships).values({ userId: account.id, orgId: invite.orgId, role: invite.role }).run();
    // An admin-issued reset is only allowed for someone in a single org. Joining
    // a second one voids any that is still open.
    db.delete(passwordResets)
      .where(and(eq(passwordResets.userId, account.id), isNull(passwordResets.usedAt)))
      .run();
    db.update(invites)
      .set({ acceptedAt: new Date().toISOString() })
      .where(eq(invites.id, invite.id))
      .run();
  });

  // Land in the org just joined
  let newDevice: SignInDevice | undefined;
  if (session) {
    setActiveOrg(session.id, invite.orgId);
  } else {
    const created = await createSession(account.id, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      activeOrgId: invite.orgId,
    });
    reply.setCookie('smt_session', created.id, { httpOnly: true, sameSite: 'lax', path: '/' });
    newDevice = recordSignInDevice(account.id, req.ip, req.headers['user-agent'], created.id);
  }

  const user = { id: account.id, email: account.email, displayName: account.displayName };
  // Unauthenticated route: say who acted for the audit row
  req.user = user;
  req.orgId = invite.orgId;
  await audit(req, 'member.join', 'member', account.id, account.email, { role: invite.role });
  // Signing in with the password here is a sign-in like any other
  if (newDevice?.isNew) {
    await audit(req, 'user.login_new_device', 'user', account.id, account.email, {
      method: 'password',
      device: newDevice.label,
      network: newDevice.ipPrefix,
    });
    notifyNewDeviceSignIn(account, newDevice, req.ip);
  }

  return reply.status(201).send({ user, orgId: invite.orgId, role: invite.role });
}
