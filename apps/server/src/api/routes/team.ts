import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, count, countDistinct, desc, eq, inArray, isNull, max, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  RESOURCE_TYPES,
  type BuiltInRole,
  type DefaultRoleSetting,
  type MemberRoles,
  type MemberScope,
  type MemberServerAccess,
  type OrgMember,
  type OrgSecuritySettings,
  type PasswordResetLink,
  type PermissionSet,
  type RoleGrant,
} from '@smt/shared';
import { requireAuth, ROLES, type Role } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import {
  invites,
  kubeClusters,
  memberClusterAccess,
  memberServerAccess,
  memberships,
  organizations,
  passkeys,
  passwordResets,
  resourceGrants,
  roles,
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
import { emailsMatch, generateInviteToken, inviteExpiry, inviteState, maskEmail } from '../../auth/invite.js';
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
import { cancelPendingAccessRequests, MAX_GRANT_MINUTES, minutesFromNow } from '../../auth/access-grants.js';
import { activeAt } from '../../auth/access/resolve.js';
import { canAssignRole, canGrant, hasModule, isOrgOwner, isOwner, requireModule, requireOwner } from '../../auth/access/modules.js';
import {
  baseLevel,
  effectiveAccessList,
  principalGrants,
  revokeAfterChange,
  snapshotAccess,
} from '../../auth/access/index.js';
import {
  baseRoleOf,
  builtInRoleId,
  changeMemberRoles,
  defaultRoleId,
  isBaseRoleRole,
  legacyRoleOf,
  legacyScopeOf,
  memberRoleRows,
  outranks,
  presentHeldRoles,
  roleDelegationMissing,
  roleIdForBaseRole,
  setMemberRoles,
  wouldOrphanOrg,
  type RankRule,
  type RoleAssignment,
} from '../../auth/access/members.js';

const roleSchema = z.enum(ROLES);

const createInviteSchema = z.object({
  // trim() before email() — a pasted address often carries whitespace
  email: z.string().trim().email().max(254),
  /** A base role, as before unified roles: its built-in role. */
  role: roleSchema.optional(),
  /** The roles to give (wins over `role`); neither = the org's default role. */
  roleIds: z.array(z.string().min(1).max(200)).max(50).optional(),
});

const memberRolesSchema = z.object({
  roles: z
    .array(
      z.object({
        roleId: z.string().min(1).max(200),
        expiresAt: z.string().max(40).nullable().optional(),
        expiresInMinutes: z.number().int().min(1).max(MAX_GRANT_MINUTES).nullable().optional(),
      }),
    )
    .max(100),
});

const defaultRoleSchema = z.object({ roleId: z.string().min(1).max(200) });

/** A role, a scope (custom roles spec §6), or both. */
const changeRoleSchema = z
  .object({ role: roleSchema.optional(), scope: z.enum(['all', 'roles']).optional() })
  .refine((b) => b.role !== undefined || b.scope !== undefined, { message: 'Nothing to change' });

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

const settingsSchema = z
  .object({ requirePasskey: z.boolean().optional(), backupCodeRecoveryOnly: z.boolean().optional() })
  .refine((b) => b.requirePasskey !== undefined || b.backupCodeRecoveryOnly !== undefined, {
    message: 'Nothing to change',
  });

const serverAccessSchema = z.object({
  serverAccess: z.enum(['all', 'restricted']),
  serverIds: z.array(z.string().min(1)).max(1000).default([]),
  // Per server: minutes from now for a time-bound grant, null for permanent.
  // A server left out keeps the expiry it already has; a new one is permanent.
  expiresInMinutes: z
    .record(z.string(), z.number().int().min(1).max(MAX_GRANT_MINUTES).nullable())
    .default({}),
  // Kubernetes clusters, the same way; left out, cluster grants stay as they are
  clusterIds: z.array(z.string().min(1)).max(1000).optional(),
  clusterExpiresInMinutes: z
    .record(z.string(), z.number().int().min(1).max(MAX_GRANT_MINUTES).nullable())
    .default({}),
});

function inviteLink(token: string): string {
  return `${config.baseUrl.replace(/\/$/, '')}/invite/${token}`;
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
 * Shared guard for acting on another member: not yourself, only someone in
 * this org, and only someone whose permissions are within the actor's per
 * `rule` (auth/access/members.ts `outranks`, which replaces the base-role
 * order). Sends the error and returns undefined when the action is not
 * allowed. A read-only API token never gets here: it cannot write.
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
  if (!outranks(req.orgId, req.user.id, userId, rule)) {
    reply.status(403).send({
      error: isOrgOwner(req.orgId, userId)
        ? `You cannot ${verb} an owner`
        : rule === 'atOrBelow'
          ? `You cannot ${verb} a member who holds access you do not`
          : `You cannot ${verb} a member who holds as much access as you`,
    });
    return undefined;
  }
  return member;
}

/**
 * A member's roles now, and the base role their built-in role stands for and
 * the scope (the compatible fields, and what the compatible endpoints map
 * from: never raised by a custom role).
 */
function rolesOf(orgId: string, userId: string) {
  const rows = memberRoleRows(orgId, [userId]).get(userId) ?? [];
  const lasting = rows.filter((r) => r.expiresAt === null);
  return { rows, role: baseRoleOf(lasting), scope: legacyScopeOf(lasting) };
}

/** Role names for an audit row: what the member holds, and until when. */
function roleSummary(rows: { roleId: string; name: string; expiresAt: string | null }[]) {
  return rows.map((r) => ({ roleId: r.roleId, name: r.name, ...(r.expiresAt && { expiresAt: r.expiresAt }) }));
}

function sendDelegationRefused(reply: FastifyReply, verb: string, missing: string[]) {
  return reply.status(403).send({ error: `You cannot ${verb}: you do not hold ${missing.join('; ')}`, missing });
}

/**
 * Replace a member's roles (`changeMemberRoles` in auth/access/members.ts:
 * the delegation guard, the rank rule, the last-owner rule, closing what
 * they lose); sends the refusal and returns undefined when refused.
 */
function changeRoles(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  next: RoleAssignment[],
  verb: string,
  extra?: () => void,
) {
  const result = changeMemberRoles(req, userId, next, verb, extra);
  if ('refused' in result) {
    const { status, error, missing } = result.refused;
    reply.status(status).send({ error, ...(missing && { missing }) });
    return undefined;
  }
  return result;
}

/**
 * What the actor lacks to replace a member's personal server (and cluster)
 * grants by id with `lists`, as the compatible access endpoint does: each id
 * added at `level` (until its picked expiry, else for good), each one whose
 * expiry is picked anew, and each one dropped (at its level, until it would
 * have ended). Empty when allowed.
 */
function accessListDelegationMissing(
  req: FastifyRequest,
  userId: string,
  level: ReturnType<typeof baseLevel>,
  lists: { type: 'server' | 'cluster'; ids: string[]; minutes: Record<string, number | null> }[],
): string[] {
  const personal = principalGrants(req.orgId, 'user', userId);
  const changes: { grant: NonNullable<PermissionSet['grants']>[number]; expiresAt: string | null }[] = [];
  for (const { type, ids, minutes } of lists) {
    const prior = new Map(personal.filter((g) => g.resourceType === type && g.selector === 'id').map((g) => [g.resourceId!, g]));
    for (const id of ids) {
      const was = prior.get(id);
      if (was && minutes[id] === undefined) continue;
      const expiresAt = minutes[id] == null ? null : minutesFromNow(minutes[id]!);
      changes.push({ grant: { resourceType: type, selector: 'id', resourceId: id, namespaces: null, level: was?.level ?? level }, expiresAt });
    }
    for (const [id, was] of prior) {
      if (ids.includes(id)) continue;
      changes.push({
        grant: { resourceType: type, selector: 'id', resourceId: id, namespaces: was.namespaces, level: was.level },
        expiresAt: was.expiresAt,
      });
    }
  }
  const missing = new Set<string>();
  for (const { grant, expiresAt } of changes) {
    for (const m of canGrant(req, { grants: [grant] }, { expiresAt }).missing) missing.add(m);
  }
  return [...missing];
}

/** When a membership given in a request ends: null for good, 'invalid' when out of range. */
function expiryFrom(body: { expiresAt?: string | null; expiresInMinutes?: number | null }): string | null | 'invalid' {
  if (body.expiresAt) {
    const at = new Date(body.expiresAt).getTime();
    if (Number.isNaN(at) || at <= Date.now() || at > Date.now() + MAX_GRANT_MINUTES * 60_000 + 60_000) return 'invalid';
    return new Date(at).toISOString();
  }
  return body.expiresInMinutes != null ? minutesFromNow(body.expiresInMinutes) : null;
}

/** Roles of the org by id (any kind), for checking what a request names. */
function orgRoles(orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; name: string; system: string | null; modulePermissions: string | null }>();
  return new Map(
    getDb()
      .select({ id: roles.id, name: roles.name, system: roles.system, modulePermissions: roles.modulePermissions })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), inArray(roles.id, ids)))
      .all()
      .map((r) => [r.id, r]),
  );
}

/**
 * What an invite gives: `invites.role` holds a base role name (as before
 * unified roles, and still for invites made with one) or a JSON list of role
 * ids. Base roles stand for their built-in role.
 */
function inviteRoleIds(orgId: string, stored: string): string[] {
  if (stored.startsWith('[')) {
    try {
      const ids: unknown = JSON.parse(stored);
      if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
    } catch {
      /* fall through */
    }
    return [];
  }
  const id = roleIdForBaseRole(orgId, (ROLES as readonly string[]).includes(stored) ? (stored as Role) : 'viewer');
  return id ? [id] : [];
}

/** The invite's roles as the API shows them, and the base role they amount to. */
function presentInviteRoles(orgId: string, stored: string) {
  const found = [...orgRoles(orgId, inviteRoleIds(orgId, stored)).values()];
  const role: Role = (ROLES as readonly string[]).includes(stored)
    ? (stored as Role)
    : legacyRoleOf(orgId, found.map((r) => ({ roleId: r.id, system: r.system, modulePermissions: r.modulePermissions })));
  return { role, roles: found.map((r) => ({ id: r.id, name: r.name, system: (r.system as BuiltInRole | null) ?? null })) };
}

/**
 * Give a member who just joined the invite's roles (deleted ones are skipped;
 * none left: No access — never the default role, which the inviter was not
 * checked for). Inside the accepting transaction; the membership row's base
 * role already made migration 0025's trigger give a built-in, which this
 * replaces.
 */
function assignInviteRoles(orgId: string, userId: string, stored: string, invitedBy: string) {
  const roleIds = [...orgRoles(orgId, inviteRoleIds(orgId, stored)).keys()];
  setMemberRoles(orgId, userId, roleIds.map((roleId) => ({ roleId, expiresAt: null })), invitedBy);
}

function orgSettings(orgId: string): OrgSecuritySettings {
  const db = getDb();
  const org = db
    .select({
      requirePasskey: organizations.requirePasskey,
      backupCodeRecoveryOnly: organizations.backupCodeRecoveryOnly,
    })
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
  return {
    requirePasskey: org?.requirePasskey ?? false,
    backupCodeRecoveryOnly: org?.backupCodeRecoveryOnly ?? true,
    membersWithoutPasskey: withoutPasskey?.n ?? 0,
  };
}

/** End live access in `orgId` for active members (bar `exceptUserId`) with no passkey-verified session. */
function revokeUnverifiedLiveAccess(orgId: string, exceptUserId: string) {
  return revokeMembersLiveAccess(
    orgId,
    exceptUserId,
    sql`not exists (select 1 from ${sessions} where ${sessions.userId} = ${memberships.userId} and ${sessions.passkeyVerified} = 1)`,
  );
}

/**
 * End live access in `orgId` for active members (bar `exceptUserId`) signed in
 * with a backup code and with no session that has fully verified.
 */
function revokeRecoveryLiveAccess(orgId: string, exceptUserId: string) {
  return revokeMembersLiveAccess(
    orgId,
    exceptUserId,
    and(
      sql`exists (select 1 from ${sessions} where ${sessions.userId} = ${memberships.userId} and ${sessions.recoveryOnly} = 1)`,
      sql`not exists (select 1 from ${sessions} where ${sessions.userId} = ${memberships.userId} and ${sessions.passkeyVerified} = 1 and ${sessions.recoveryOnly} = 0)`,
    )!,
  );
}

function revokeMembersLiveAccess(orgId: string, exceptUserId: string, condition: SQL) {
  const db = getDb();
  const members = db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.status, 'active'),
        ne(memberships.userId, exceptUserId),
        condition,
      ),
    )
    .all();
  const total = { members: 0, terminals: 0, sftp: 0, docker: 0, kube: 0, agents: 0 };
  for (const { userId } of members) {
    const r = revokeLiveAccess(userId, { orgId });
    if (r.terminals + r.sftp + r.docker + r.kube + r.agents === 0) continue;
    total.members++;
    total.terminals += r.terminals;
    total.sftp += r.sftp;
    total.docker += r.docker;
    total.kube += r.kube;
    total.agents += r.agents;
  }
  return total;
}

function userEmail(userId: string) {
  return getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email;
}

/**
 * A member's personal grants by id on one type (servers or clusters), as the
 * pre-roles access endpoints report them: one entry per resource, the
 * longest-lasting when there are several.
 */
function personalIdGrants(grants: RoleGrant[], type: 'server' | 'cluster') {
  const best = new Map<string, RoleGrant>();
  for (const g of grants) {
    if (g.resourceType !== type || g.selector !== 'id' || !g.resourceId) continue;
    const prior = best.get(g.resourceId);
    if (!prior || (prior.expiresAt !== null && (g.expiresAt === null || g.expiresAt > prior.expiresAt))) {
      best.set(g.resourceId, g);
    }
  }
  return [...best.values()].map((g) => ({
    id: g.resourceId!,
    expiresAt: g.expiresAt,
    grantedBy: g.grantedBy,
    reason: g.reason,
  }));
}

/**
 * The types the pre-roles restriction never narrowed: restricting a member
 * through the old access endpoint keeps them open at the base level, as
 * migration 0023 did for members restricted before custom roles.
 */
const LEGACY_ALL_TYPES = ['ftp_connection', 'storage_connection', 'cloud_account', 'saved_command', 'cron_job'] as const;

/** The id migration 0023 gives a legacy "all" grant, so it follows base-role changes (its trigger). */
function legacyAllId(type: (typeof LEGACY_ALL_TYPES)[number], orgId: string, userId: string): string {
  return `legacy-all:${type}:${orgId}:${userId}`;
}

/** A member's legacy "all" grants, for the audit row: type and level. */
function legacyAllGrants(orgId: string, userId: string) {
  return getDb()
    .select({ resourceType: resourceGrants.resourceType, level: resourceGrants.level })
    .from(resourceGrants)
    .where(
      inArray(
        resourceGrants.id,
        LEGACY_ALL_TYPES.map((type) => legacyAllId(type, orgId, userId)),
      ),
    )
    .orderBy(resourceGrants.resourceType)
    .all();
}

/**
 * Switch a member between every resource at their base role (`all`) and only
 * what their roles and personal grants cover (`roles`), as before unified
 * roles: their built-in role becomes the generated "<Base> (modules only)"
 * role or back (migration 0025). Narrowing closes what they lose at once.
 * Sends the error and returns the reply when refused.
 */
async function changeScope(req: FastifyRequest, reply: FastifyReply, userId: string, scope: MemberScope) {
  const member = targetMember(req, reply, userId, 'change access for', 'atOrBelow');
  if (!member) return reply;
  const { rows, role, scope: from } = rolesOf(req.orgId, userId);
  if (scope === 'roles' && (role === 'owner' || role === 'admin')) {
    return reply.status(400).send({ error: 'Owners and admins always have access to everything' });
  }
  if (from !== scope) {
    const base = roleIdForBaseRole(req.orgId, role, scope);
    const next = [
      ...rows.filter((r) => !isBaseRoleRole(r)).map((r) => ({ roleId: r.roleId, expiresAt: r.expiresAt })),
      ...(base ? [{ roleId: base, expiresAt: null }] : []),
    ];
    // Lifting the restriction ends the legacy "all" grants that kept the
    // types it never narrowed open (migration 0023, the old access alias):
    // the base role covers them now, and narrowing again here starts from
    // the member's roles and personal grants alone, default-deny.
    const legacyAllBefore = scope === 'all' ? legacyAllGrants(req.orgId, userId) : [];
    const db = getDb();
    const changed = changeRoles(req, reply, userId, next, 'change access for', () => {
      if (!legacyAllBefore.length) return;
      db.delete(resourceGrants)
        .where(
          and(
            eq(resourceGrants.orgId, req.orgId),
            inArray(
              resourceGrants.id,
              LEGACY_ALL_TYPES.map((type) => legacyAllId(type, req.orgId, userId)),
            ),
          ),
        )
        .run();
    });
    if (!changed) return reply;
    await audit(req, 'member.scope_change', 'member', userId, userEmail(userId), {
      from,
      to: scope,
      before: { scope: from, roles: roleSummary(changed.before), ...(legacyAllBefore.length && { legacyAll: legacyAllBefore }) },
      after: {
        scope,
        roles: roleSummary(changed.after),
        ...(legacyAllBefore.length && { legacyAll: legacyAllGrants(req.orgId, userId) }),
      },
      ...(changed.live && { live: changed.live }),
    });
  }
  return { userId, scope };
}

/** Authenticated team management: who is in the org, and who has been asked. */
export async function teamRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/members', { preHandler: requireModule('team_members', 'view') }, async (req): Promise<OrgMember[]> => {
    const db = getDb();
    const rows = db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
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
    // Servers granted to the member by id (personal grants, the old per-member list included)
    const grants = new Map(
      userIds.length
        ? db
            .select({ userId: resourceGrants.principalId, n: countDistinct(resourceGrants.resourceId) })
            .from(resourceGrants)
            .where(
              and(
                eq(resourceGrants.orgId, req.orgId),
                eq(resourceGrants.principalType, 'user'),
                inArray(resourceGrants.principalId, userIds),
                eq(resourceGrants.resourceType, 'server'),
                eq(resourceGrants.selector, 'id'),
                activeAt(resourceGrants.expiresAt, new Date().toISOString()),
              ),
            )
            .groupBy(resourceGrants.principalId)
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
    // Who has enrolled is the concern of whoever manages members (recovery, the policy warning), not everyone's
    const seesPasskeys = hasModule(req, 'team_members', 'operate');
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

    // The roles each member holds; the base role and scope fields are what they amount to
    const held = memberRoleRows(req.orgId, userIds);
    const seesRoles = hasModule(req, 'team_roles', 'view');

    return rows.map((r) => {
      const memberRoles = held.get(r.userId) ?? [];
      const lasting = memberRoles.filter((m) => m.expiresAt === null);
      return {
        ...r,
        role: legacyRoleOf(req.orgId, lasting),
        status: r.status === 'suspended' ? 'suspended' : 'active',
        serverAccess: r.serverAccess === 'restricted' ? 'restricted' : 'all',
        scope: legacyScopeOf(lasting),
        serverCount: grants.get(r.userId) ?? 0,
        lastActiveAt: lastSeen.get(r.userId) ?? null,
        ...(seesPasskeys && { passkeyCount: passkeyCounts.get(r.userId) ?? 0 }),
        ...(seesRoles && { roles: presentHeldRoles(memberRoles) }),
      };
    });
  });

  /** Org-wide security policy. Every member may read it; the count is what whoever sets it weighs before enabling. */
  app.get('/settings', async (req): Promise<OrgSecuritySettings> => {
    const settings = orgSettings(req.orgId);
    return hasModule(req, 'team_sign_in', 'manage')
      ? settings
      : { requirePasskey: settings.requirePasskey, backupCodeRecoveryOnly: settings.backupCodeRecoveryOnly };
  });

  /**
   * Sign-in & SSO at `manage`, and owners only, as before unified roles (the
   * built-in Admin holds that module). Turning the requirement on needs the
   * owner's own session to have used a passkey — proof they can still get in
   * once it applies.
   */
  app.patch('/settings', { preHandler: [requireModule('team_sign_in', 'manage'), requireOwner()] }, async (req, reply) => {
    const { requirePasskey, backupCodeRecoveryOnly } = settingsSchema.parse(req.body);
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

    if (requirePasskey !== undefined && requirePasskey !== before.requirePasskey) {
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
        before: { requirePasskey: before.requirePasskey },
        after: { requirePasskey },
        ...(live && { live }),
      });
    }

    if (backupCodeRecoveryOnly !== undefined && backupCodeRecoveryOnly !== before.backupCodeRecoveryOnly) {
      getDb()
        .update(organizations)
        .set({ backupCodeRecoveryOnly, updatedAt: new Date().toISOString() })
        .where(eq(organizations.id, req.orgId))
        .run();
      // Terminals and the like opened by a backup-code session before the
      // switch would keep going; end them unless the member has verified since
      const live = backupCodeRecoveryOnly ? revokeRecoveryLiveAccess(req.orgId, req.user.id) : undefined;
      await audit(req, 'org.backup_code_policy', 'organization', req.orgId, undefined, {
        backupCodeRecoveryOnly,
        before: { backupCodeRecoveryOnly: before.backupCodeRecoveryOnly },
        after: { backupCodeRecoveryOnly },
        ...(live && { live }),
      });
    }
    return orgSettings(req.orgId);
  });

  /**
   * The base role, the scope, or both, as before unified roles (a compatible
   * alias for one release): the member's built-in role (or generated
   * "<Base> (modules only)" role) becomes the one they stand for; their
   * other roles stay. Under the same checks as `PUT …/roles`.
   */
  app.patch('/members/:userId', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { role, scope } = changeRoleSchema.parse(req.body);
    if (role === undefined) return changeScope(req, reply, userId, scope!);

    if (userId === req.user.id) {
      return reply.status(400).send({ error: 'You cannot change your own role' });
    }
    const member = targetMember(req, reply, userId, 'change the role of', 'atOrBelow');
    if (!member) return reply;
    const current = rolesOf(req.orgId, userId);
    const everything = role === 'owner' || role === 'admin';
    if (scope === 'roles' && everything) {
      return reply.status(400).send({ error: 'Owners and admins always have access to everything' });
    }
    // Owners and admins see everything whatever the scope was
    const nextScope = everything ? 'all' : (scope ?? current.scope);
    const base = roleIdForBaseRole(req.orgId, role, nextScope);
    if (!base) return reply.status(409).send({ error: `The ${role} role is missing from this organization` });
    const next = [
      ...current.rows.filter((r) => !isBaseRoleRole(r)).map((r) => ({ roleId: r.roleId, expiresAt: r.expiresAt })),
      { roleId: base, expiresAt: null },
    ];
    // Same rule as suspension: a demotion takes something away, so peers
    // cannot do it to each other and nobody can do it to someone above them
    const changed = changeRoles(req, reply, userId, next, `grant the ${role} role`);
    if (!changed) return reply;

    await audit(req, 'member.role_change', 'member', userId, userEmail(userId), {
      from: current.role,
      to: role,
      before: { role: current.role, scope: current.scope, roles: roleSummary(changed.before) },
      after: { role, scope: nextScope, roles: roleSummary(changed.after) },
      delegation: isOwner(req) ? 'owner' : 'within the actor’s own access',
      ...(changed.live && { live: changed.live }),
    });
    return { userId, role, ...(scope !== undefined && { scope }) };
  });

  /** The roles a member holds now (unified roles spec §5). */
  app.get('/members/:userId/roles', { preHandler: requireModule('team_roles', 'view') }, async (req, reply): Promise<MemberRoles> => {
    const { userId } = req.params as { userId: string };
    const member = getDb()
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
      .get();
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });
    return { userId, roles: presentHeldRoles(memberRoleRows(req.orgId, [userId]).get(userId) ?? []) };
  });

  /**
   * Replace the roles a member holds (unified roles spec §5: the role chips).
   * Every role given or taken away must be one the actor could give, for as
   * long (spec §4.2); taking any away needs the actor to hold more than the
   * member; Owner only by owners, and the org keeps an owner. An empty list
   * leaves the member with No access. What they lose closes now.
   */
  app.put('/members/:userId/roles', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = memberRolesSchema.parse(req.body);
    if (userId === req.user.id) return reply.status(400).send({ error: 'You cannot change your own roles' });
    const member = getDb()
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
      .get();
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });

    const found = orgRoles(
      req.orgId,
      body.roles.map((r) => r.roleId),
    );
    const next: RoleAssignment[] = [];
    for (const entry of body.roles) {
      if (!found.has(entry.roleId)) return reply.status(400).send({ error: 'Unknown role' });
      const expiresAt = expiryFrom(entry);
      if (expiresAt === 'invalid') return reply.status(400).send({ error: 'A role can end between now and a year from now' });
      if (next.some((n) => n.roleId === entry.roleId)) return reply.status(400).send({ error: 'A role is listed twice' });
      next.push({ roleId: entry.roleId, expiresAt });
    }
    // No access is the absence of everything: beside another role it means nothing
    const meaningful = next.filter((n) => found.get(n.roleId)?.system !== 'none');
    const wanted = meaningful.length ? meaningful : next;

    const changed = changeRoles(req, reply, userId, wanted, 'change the roles of');
    if (!changed) return reply;
    const before = roleSummary(changed.before);
    const after = roleSummary(changed.after);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await audit(req, 'member.roles_change', 'member', userId, userEmail(userId), {
        before,
        after,
        delegation: isOwner(req) ? 'owner' : 'within the actor’s own access',
        ...(changed.live && { live: changed.live }),
      });
    }
    return { userId, roles: presentHeldRoles(changed.after) } satisfies MemberRoles;
  });

  /** The role new members get when none is picked (invites, SSO). */
  app.get('/default-role', { preHandler: requireModule('team_members', 'view') }, async (req, reply): Promise<DefaultRoleSetting> => {
    const roleId = defaultRoleId(req.orgId);
    const role = roleId ? orgRoles(req.orgId, [roleId]).get(roleId) : undefined;
    if (!role) return reply.status(404).send({ error: 'No default role' });
    return { roleId: role.id, name: role.name, system: (role.system as BuiltInRole | null) ?? null };
  });

  /**
   * Organization settings at `manage` (spec §3.2). The default role is handed
   * out by every invite that names none, so it passes the delegation guard
   * like an invite would; never Owner.
   */
  app.put('/default-role', { preHandler: requireModule('settings', 'manage') }, async (req, reply): Promise<DefaultRoleSetting> => {
    const { roleId } = defaultRoleSchema.parse(req.body);
    const role = orgRoles(req.orgId, [roleId]).get(roleId);
    if (!role) return reply.status(400).send({ error: 'Unknown role' });
    if (role.system === 'owner') return reply.status(400).send({ error: 'Owner cannot be the default role' });
    const delegation = canAssignRole(req, roleId);
    if (!delegation.ok) return sendDelegationRefused(reply, 'make this the default role', delegation.missing);
    const previousId = defaultRoleId(req.orgId);
    if (previousId !== roleId) {
      getDb()
        .update(organizations)
        .set({ defaultRoleId: roleId, updatedAt: new Date().toISOString() })
        .where(eq(organizations.id, req.orgId))
        .run();
      const previous = previousId ? orgRoles(req.orgId, [previousId]).get(previousId) : undefined;
      await audit(req, 'org.default_role', 'organization', req.orgId, undefined, {
        before: previous ? { roleId: previous.id, name: previous.name } : null,
        after: { roleId: role.id, name: role.name },
      });
    }
    return { roleId: role.id, name: role.name, system: (role.system as BuiltInRole | null) ?? null };
  });

  app.delete('/members/:userId', { preHandler: requireModule('team_members', 'operate') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const db = getDb();

    const member = targetMember(req, reply, userId, 'remove', 'below');
    if (!member) return reply;
    if (wouldOrphanOrg(req.orgId, userId, false)) {
      return reply.status(400).send({ error: 'The organization must keep at least one owner' });
    }

    const target = db.select().from(users).where(eq(users.id, userId)).get();
    const rolesBefore = roleSummary(rolesOf(req.orgId, userId).rows);
    let requestsCancelled = 0;
    db.transaction(() => {
      requestsCancelled = cancelPendingAccessRequests(req.orgId, userId, req.user.id, 'removed');
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

    await audit(req, 'member.remove', 'member', userId, target?.email, {
      before: { roles: rolesBefore },
      after: null,
      live,
      ...(requestsCancelled > 0 && { accessRequestsCancelled: requestsCancelled }),
    });
    return reply.status(204).send();
  });

  /** Block a member from this org without removing them. Ends all their sessions. */
  app.post('/members/:userId/suspend', { preHandler: requireModule('team_members', 'operate') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const member = targetMember(req, reply, userId, 'suspend', 'below');
    if (!member) return reply;

    if (member.status !== 'suspended') {
      if (wouldOrphanOrg(req.orgId, userId, false)) {
        return reply
          .status(400)
          .send({ error: 'The organization must keep at least one active owner' });
      }
      let requestsCancelled = 0;
      getDb().transaction((tx) => {
        tx.update(memberships)
          .set({ status: 'suspended', suspendedAt: new Date().toISOString(), suspendedBy: req.user.id })
          .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
          .run();
        requestsCancelled = cancelPendingAccessRequests(req.orgId, userId, req.user.id, 'suspended');
      });
      // Sessions are per user, not per org — a live cookie would keep working
      // until expiry if left, so every one goes.
      const revoked = invalidateUserSessions(userId);
      // Ending the browser sessions does not end what they already opened here
      const live = revokeLiveAccess(userId, { orgId: req.orgId });
      await audit(req, 'member.suspend', 'member', userId, userEmail(userId), {
        sessionsRevoked: revoked,
        live,
        ...(requestsCancelled > 0 && { accessRequestsCancelled: requestsCancelled }),
      });
    }
    return { userId, status: 'suspended' as const };
  });

  app.post('/members/:userId/reactivate', { preHandler: requireModule('team_members', 'operate') }, async (req, reply) => {
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

  app.get('/members/:userId/access', { preHandler: requireModule('team_roles', 'view') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const db = getDb();
    const member = db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
      .get();
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });

    // Expired grants are gone as far as anyone is concerned, even before the sweep deletes them
    const personalGrants = principalGrants(req.orgId, 'user', userId);
    const grants = personalIdGrants(personalGrants, 'server').map(({ id, ...g }) => ({ serverId: id, ...g }));
    const clusterGrants = personalIdGrants(personalGrants, 'cluster').map(({ id, ...g }) => ({ clusterId: id, ...g }));
    const held = rolesOf(req.orgId, userId);
    const scope: MemberScope = held.scope;
    const who = { orgId: req.orgId, userId };
    return {
      // The pre-roles shape, kept as a compatible alias for one release
      serverAccess: scope === 'roles' ? 'restricted' : 'all',
      serverIds: grants.map((g) => g.serverId),
      grants,
      clusterIds: clusterGrants.map((g) => g.clusterId),
      clusterGrants,
      role: held.role,
      scope,
      roles: presentHeldRoles(held.rows),
      personalGrants,
      effective: Object.fromEntries(
        RESOURCE_TYPES.map((type) => [type, effectiveAccessList(who, type)]),
      ) as MemberServerAccess['effective'],
    } satisfies MemberServerAccess;
  });

  /** Replace a member's server access wholesale: the mode and the full list of granted servers. */
  app.put('/members/:userId/access', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = serverAccessSchema.parse(req.body);
    const member = targetMember(req, reply, userId, 'change server access for', 'atOrBelow');
    if (!member) return reply;

    const held = rolesOf(req.orgId, userId);
    if (body.serverAccess === 'restricted' && (held.role === 'owner' || held.role === 'admin')) {
      return reply
        .status(400)
        .send({ error: 'Owners and admins always have access to every server' });
    }
    // Moving in or out of the restriction swaps the member's built-in role for
    // the generated "(modules only)" one or back (migration 0025's trigger):
    // giving or taking either away passes the delegation guard
    if ((body.serverAccess === 'restricted') !== (held.scope === 'roles')) {
      const from = roleIdForBaseRole(req.orgId, held.role, held.scope);
      const to = roleIdForBaseRole(req.orgId, held.role, body.serverAccess === 'restricted' ? 'roles' : 'all');
      const missing = roleDelegationMissing(
        req,
        to ? [{ roleId: to, expiresAt: null }] : [],
        from ? [{ roleId: from, expiresAt: null }] : [],
      );
      if (missing.length) return sendDelegationRefused(reply, 'change server access for this member', missing);
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
    const clusterIds = body.clusterIds ? [...new Set(body.clusterIds)] : null;
    if (clusterIds?.length) {
      const known = db
        .select({ id: kubeClusters.id })
        .from(kubeClusters)
        .where(and(eq(kubeClusters.orgId, req.orgId), inArray(kubeClusters.id, clusterIds)))
        .all();
      if (known.length !== clusterIds.length) {
        return reply.status(400).send({ error: 'Unknown cluster in clusterIds' });
      }
    }

    // The delegation guard over the list (spec §4.2): every server or cluster
    // given — at the member's base level, as the mirrored grant will be — or
    // taken away, or given for a new length of time, must be one the actor
    // holds, for as long. Admins at their defaults hold them all.
    const listMissing = accessListDelegationMissing(req, userId, baseLevel(held.role), [
      { type: 'server', ids: serverIds, minutes: body.expiresInMinutes },
      ...(clusterIds ? [{ type: 'cluster' as const, ids: clusterIds, minutes: body.clusterExpiresInMinutes }] : []),
    ]);
    if (listMissing.length) return sendDelegationRefused(reply, 'change server access for this member', listMissing);

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

    // Cluster grants follow the same rules, when the caller sent them
    const memberClusterGrants = and(eq(memberClusterAccess.userId, userId), eq(memberClusterAccess.orgId, req.orgId));
    const existingClusters = new Map(
      db.select().from(memberClusterAccess).where(memberClusterGrants).all().map((g) => [g.clusterId, g]),
    );
    const clusterRows = (clusterIds ?? []).map((clusterId) => {
      const minutes = body.clusterExpiresInMinutes[clusterId];
      const prior = existingClusters.get(clusterId);
      if (minutes === undefined && prior) {
        return { clusterId, expiresAt: prior.expiresAt, grantedBy: prior.grantedBy, reason: prior.reason, createdAt: prior.createdAt };
      }
      return {
        clusterId,
        expiresAt: minutes == null ? null : minutesFromNow(minutes, now),
        grantedBy: req.user.id,
        reason: null,
        createdAt: new Date(now).toISOString(),
      };
    });

    // Personal grants by id written by the newer grants endpoint (any level)
    // or by approved access requests stay as they are for servers and clusters still listed, with a new
    // expiry if one was picked, and go for those left out. Grants by tag or
    // "all" are not this endpoint's to change.
    const personalById = (type: 'server' | 'cluster') =>
      and(
        eq(resourceGrants.orgId, req.orgId),
        eq(resourceGrants.principalType, 'user'),
        eq(resourceGrants.principalId, userId),
        eq(resourceGrants.resourceType, type),
        eq(resourceGrants.selector, 'id'),
        // The pre-roles tables' mirrors, rewritten through those tables below
        sql`substr(${resourceGrants.id}, 1, 14) <> 'legacy-server:'`,
        sql`substr(${resourceGrants.id}, 1, 15) <> 'legacy-cluster:'`,
      );
    const newerServerIds = new Set(
      db.select({ id: resourceGrants.resourceId }).from(resourceGrants).where(personalById('server')).all().map((g) => g.id!),
    );
    const newerClusterIds = new Set(
      db.select({ id: resourceGrants.resourceId }).from(resourceGrants).where(personalById('cluster')).all().map((g) => g.id!),
    );
    const legacyRows = rows.filter((r) => existing.has(r.serverId) || !newerServerIds.has(r.serverId));
    const legacyClusterRows = clusterRows.filter((r) => existingClusters.has(r.clusterId) || !newerClusterIds.has(r.clusterId));

    // For the audit row: the personal server (and cluster) grants as they were
    const personalBefore = principalGrants(req.orgId, 'user', userId);
    const accessGrantsBefore = {
      servers: personalIdGrants(personalBefore, 'server').map((g) => ({ serverId: g.id, expiresAt: g.expiresAt })),
      ...(clusterIds && {
        clusters: personalIdGrants(personalBefore, 'cluster').map((g) => ({ clusterId: g.id, expiresAt: g.expiresAt })),
      }),
    };
    // Moving in or out of the restriction: the types it never narrowed stay
    // open through legacy "all" grants at the base level, as migration 0023
    // gave members restricted before custom roles, and go when it is lifted.
    const wasRestricted = held.scope === 'roles';
    const restricting = body.serverAccess === 'restricted' && !wasRestricted;
    const lifting = body.serverAccess === 'all' && wasRestricted;
    const legacyAllBefore = legacyAllGrants(req.orgId, userId);
    const legacyAllIds = LEGACY_ALL_TYPES.map((type) => legacyAllId(type, req.orgId, userId));
    const accessBefore = snapshotAccess(req.orgId, [userId]);
    db.transaction(() => {
      db.update(memberships)
        .set({ serverAccess: body.serverAccess })
        .where(and(eq(memberships.userId, userId), eq(memberships.orgId, req.orgId)))
        .run();
      if (restricting || lifting) {
        db.delete(resourceGrants)
          .where(and(eq(resourceGrants.orgId, req.orgId), inArray(resourceGrants.id, legacyAllIds)))
          .run();
      }
      if (restricting) {
        const createdAt = new Date(now).toISOString();
        for (const type of LEGACY_ALL_TYPES) {
          db.insert(resourceGrants)
            .values({
              id: legacyAllId(type, req.orgId, userId),
              orgId: req.orgId,
              principalType: 'user',
              principalId: userId,
              resourceType: type,
              selector: 'all',
              resourceId: null,
              level: baseLevel(held.role),
              expiresAt: null,
              grantedBy: req.user.id,
              reason: 'Kept from before custom roles',
              createdAt,
            })
            .run();
        }
      }
      db.delete(memberServerAccess).where(memberGrants).run();
      for (const row of legacyRows) {
        db.insert(memberServerAccess).values({ orgId: req.orgId, userId, ...row }).run();
      }
      db.delete(resourceGrants)
        .where(and(personalById('server'), serverIds.length ? notInArray(resourceGrants.resourceId, serverIds) : undefined))
        .run();
      for (const [serverId, minutes] of Object.entries(body.expiresInMinutes)) {
        if (!newerServerIds.has(serverId) || !serverIds.includes(serverId)) continue;
        db.update(resourceGrants)
          .set({ expiresAt: minutes == null ? null : minutesFromNow(minutes, now) })
          .where(and(personalById('server'), eq(resourceGrants.resourceId, serverId)))
          .run();
      }
      if (clusterIds) {
        db.delete(memberClusterAccess).where(memberClusterGrants).run();
        for (const row of legacyClusterRows) {
          db.insert(memberClusterAccess).values({ orgId: req.orgId, userId, ...row }).run();
        }
        db.delete(resourceGrants)
          .where(and(personalById('cluster'), clusterIds.length ? notInArray(resourceGrants.resourceId, clusterIds) : undefined))
          .run();
        for (const [clusterId, minutes] of Object.entries(body.clusterExpiresInMinutes)) {
          if (!newerClusterIds.has(clusterId) || !clusterIds.includes(clusterId)) continue;
          db.update(resourceGrants)
            .set({ expiresAt: minutes == null ? null : minutesFromNow(minutes, now) })
            .where(and(personalById('cluster'), eq(resourceGrants.resourceId, clusterId)))
            .run();
        }
      }
    });

    const personal = principalGrants(req.orgId, 'user', userId);
    const grants = personalIdGrants(personal, 'server').map(({ id, ...g }) => ({ serverId: id, ...g }));
    const grantedIds = grants.map((g) => g.serverId);
    const clusterGrants = personalIdGrants(personal, 'cluster').map(({ id, ...g }) => ({ clusterId: id, ...g }));
    const grantedClusterIds = clusterGrants.map((g) => g.clusterId);
    // Narrowed: anything already open on what the member no longer reaches
    // (through this list, their roles or other grants) closes now
    const live = revokeAfterChange(req.orgId, [userId], accessBefore).get(userId);
    const legacyAllAfter = legacyAllGrants(req.orgId, userId);

    await audit(req, 'member.access_change', 'member', userId, userEmail(userId), {
      from: member.serverAccess,
      to: body.serverAccess,
      before: {
        serverAccess: member.serverAccess,
        ...accessGrantsBefore,
        ...((restricting || lifting) && { legacyAll: legacyAllBefore }),
      },
      after: {
        serverAccess: body.serverAccess,
        servers: grants.map((g) => ({ serverId: g.serverId, expiresAt: g.expiresAt })),
        ...(clusterIds && { clusters: clusterGrants.map((g) => ({ clusterId: g.clusterId, expiresAt: g.expiresAt })) }),
        ...((restricting || lifting) && { legacyAll: legacyAllAfter }),
      },
      servers: grantedIds.length,
      timeBound: grants.filter((g) => g.expiresAt !== null).length,
      ...(clusterIds && { clusters: grantedClusterIds.length }),
      ...(live && { live }),
    });
    return {
      serverAccess: body.serverAccess,
      serverIds: grantedIds,
      grants,
      clusterIds: grantedClusterIds,
      clusterGrants,
    } satisfies MemberServerAccess;
  });

  /** Issue a one-time link that lets the member set a new password. Shown once. */
  app.post('/members/:userId/password-reset', { preHandler: requireModule('team_members', 'operate') }, async (req, reply) => {
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
  app.delete('/members/:userId/passkeys', { preHandler: requireModule('team_members', 'operate') }, async (req, reply) => {
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
  app.delete('/members/:userId/sessions', { preHandler: requireModule('team_members', 'operate') }, async (req, reply) => {
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

  app.get('/invites', { preHandler: requireModule('team_members', 'operate') }, async (req) => {
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
      ...presentInviteRoles(req.orgId, invite.role),
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      state: inviteState(invite),
    }));
  });

  /**
   * Invite someone with roles (unified roles spec §5): `roleIds`, or a base
   * role as before (its built-in role), or neither for the org's default
   * role. Only roles the inviter could give themselves (spec §4.2) — Owner
   * only by owners.
   */
  app.post('/invites', { preHandler: requireModule('team_members', 'operate') }, async (req, reply) => {
    const body = createInviteSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const db = getDb();

    let roleIds: string[];
    if (body.roleIds) {
      roleIds = [...new Set(body.roleIds)];
      if (orgRoles(req.orgId, roleIds).size !== roleIds.length) return reply.status(400).send({ error: 'Unknown role' });
      // An empty list is No access, as for a member's roles — never the
      // default role, which the inviter may not be able to give
      if (!roleIds.length) {
        const none = builtInRoleId(req.orgId, 'none');
        if (!none) return reply.status(409).send({ error: 'The No access role is missing from this organization' });
        roleIds = [none];
      }
    } else {
      const id = body.role ? roleIdForBaseRole(req.orgId, body.role) : defaultRoleId(req.orgId);
      if (!id) return reply.status(409).send({ error: 'That role is missing from this organization' });
      roleIds = [id];
    }
    const missing = roleDelegationMissing(
      req,
      roleIds.map((roleId) => ({ roleId, expiresAt: null })),
      [],
    );
    if (missing.length) {
      return sendDelegationRefused(reply, body.role ? `invite someone as ${body.role}` : 'invite someone with these roles', missing);
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
    // A base role is kept as its name, so the invite reads as it always did
    const stored = body.roleIds ? JSON.stringify(roleIds) : (body.role ?? JSON.stringify(roleIds));
    db.insert(invites)
      .values({
        id,
        orgId: req.orgId,
        email,
        role: stored,
        token,
        invitedBy: req.user.id,
        expiresAt: inviteExpiry(),
      })
      .run();

    const presented = presentInviteRoles(req.orgId, stored);
    await audit(req, 'user.invite', 'invite', id, email, {
      role: presented.role,
      roles: presented.roles.map((r) => ({ roleId: r.id, name: r.name })),
      delegation: isOwner(req) ? 'owner' : 'within the actor’s own access',
    });
    // The only time the link is ever returned.
    return reply.status(201).send({
      id,
      email,
      ...presented,
      expiresAt: inviteExpiry(),
      state: 'valid' as const,
      link: inviteLink(token),
      existingAccount: !!existingUser,
    });
  });

  app.delete('/invites/:id', { preHandler: requireModule('team_members', 'operate') }, async (req, reply) => {
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
      ...presentInviteRoles(invite.orgId, invite.role),
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

      const { role } = presentInviteRoles(invite.orgId, invite.role);
      db.transaction(() => {
        db.insert(users)
          .values({ id: userId, email: invite.email, displayName: body.displayName, passwordHash })
          .run();
        db.insert(memberships)
          .values({ userId, orgId: invite.orgId, role })
          .run();
        assignInviteRoles(invite.orgId, userId, invite.role, invite.invitedBy);
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
        role,
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

  const { role, roles: joinedRoles } = presentInviteRoles(invite.orgId, invite.role);
  db.transaction(() => {
    db.insert(memberships).values({ userId: account.id, orgId: invite.orgId, role }).run();
    assignInviteRoles(invite.orgId, account.id, invite.role, invite.invitedBy);
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
  await audit(req, 'member.join', 'member', account.id, account.email, {
    role,
    roles: joinedRoles.map((r) => ({ roleId: r.id, name: r.name })),
  });
  // Signing in with the password here is a sign-in like any other
  if (newDevice?.isNew) {
    await audit(req, 'user.login_new_device', 'user', account.id, account.email, {
      method: 'password',
      device: newDevice.label,
      network: newDevice.ipPrefix,
    });
    notifyNewDeviceSignIn(account, newDevice, req.ip);
  }

  return reply.status(201).send({ user, orgId: invite.orgId, role });
}
