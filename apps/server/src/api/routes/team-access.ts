import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  ACCESS_LEVELS,
  RESOURCE_TYPES,
  type AccessExplanation,
  type AccessLevel,
  type AccessResources,
  type CustomRole,
  type CustomRoleDetail,
  type GrantInput,
  type MemberScope,
  type MyAccessLevels,
  type ResourceAccessHolder,
  type ResourceAccessList,
  type ResourceType,
  type RoleGrant,
  type RoleMemberDetail,
} from '@smt/shared';
import { rank, requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { accessRequests, memberships, resourceGrants, roleMembers, roles, users } from '../../db/schema.js';
import { audit } from '../../audit/index.js';
import { MAX_GRANT_MINUTES, minutesFromNow } from '../../auth/access-grants.js';
import type { LiveAccessRevoked } from '../../auth/revoke.js';
import { activeAt } from '../../auth/access/resolve.js';
import { customRoleFilter, RESERVED_ROLE_NAMES } from '../../auth/access/modules.js';
import { baseActions } from '../../auth/command-access.js';
import {
  draftGrants,
  effectiveAccessList,
  explain,
  grantsOfRoles,
  listResources,
  principalGrants,
  replaceGrants,
  resourceExists,
  revokeAfterChange,
  snapshotAccess,
  RESOURCE_LABELS,
} from '../../auth/access/index.js';

/**
 * Custom roles and per-resource access (custom roles spec §6), next to the
 * member routes in team.ts under /api/team:
 *
 * - Roles (admins): list, create, read, rename/recolour, delete; replace a
 *   role's grant list; add and remove members, optionally until a time.
 * - A member's personal grants (admins), replacing the pre-roles server and
 *   cluster access lists (still served by team.ts as compatible aliases).
 * - The access checker and who-has-access (admins), and the caller's own
 *   level on each resource of a type (anyone), so the UI can hide buttons.
 *
 * Every change that can take access away snapshots the affected members
 * first and closes what they lost afterwards (revokeAfterChange), and every
 * change is audited with what it was before and after. Roles never touch
 * org-admin features: they only add resource levels.
 */

const typeSchema = z.enum(RESOURCE_TYPES as [ResourceType, ...ResourceType[]]);
const levelSchema = z.enum(ACCESS_LEVELS as [AccessLevel, ...AccessLevel[]]);
/** A Kubernetes namespace name (RFC 1123 label). */
const namespaceSchema = z.string().max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Invalid namespace');

const grantSchema = z.object({
  resourceType: typeSchema,
  selector: z.enum(['id', 'all', 'tag']),
  resourceId: z.string().min(1).max(100).nullable().optional(),
  tag: z.string().trim().min(1).max(64).nullable().optional(),
  namespaces: z.array(namespaceSchema).max(100).nullable().optional(),
  level: levelSchema,
  expiresAt: z.string().max(40).nullable().optional(),
  expiresInMinutes: z.number().int().min(1).max(MAX_GRANT_MINUTES).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});
const grantsSchema = z.object({ grants: z.array(grantSchema).max(500) });

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #rrggbb');
const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).nullable().optional(),
  color: colorSchema.nullable().optional(),
  grants: z.array(grantSchema).max(500).optional(),
});
const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    color: colorSchema.nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined || b.color !== undefined, {
    message: 'Nothing to change',
  });

const roleMemberSchema = z.object({
  userId: z.string().min(1),
  /** When membership ends; null/absent = permanent. Wins over `expiresInMinutes`. */
  expiresAt: z.string().max(40).nullable().optional(),
  expiresInMinutes: z.number().int().min(1).max(MAX_GRANT_MINUTES).nullable().optional(),
});

const explainSchema = z.object({
  userId: z.string().min(1),
  type: typeSchema,
  id: z.string().min(1),
  namespace: namespaceSchema.optional(),
});
const resourceQuerySchema = z.object({ type: typeSchema, id: z.string().min(1) });
const mineSchema = z.object({ type: typeSchema });

type RoleRow = typeof roles.$inferSelect;

function findRole(orgId: string, id: string): RoleRow | undefined {
  return getDb()
    .select()
    .from(roles)
    .where(and(eq(roles.id, id), eq(roles.orgId, orgId), customRoleFilter()))
    .get();
}

function presentRole(row: RoleRow, extra: Partial<CustomRole> = {}): CustomRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...extra,
  };
}

/** A role's members still in force, with who they are. */
function membersOf(orgId: string, roleId: string): RoleMemberDetail[] {
  return getDb()
    .select({
      roleId: roleMembers.roleId,
      userId: roleMembers.userId,
      expiresAt: roleMembers.expiresAt,
      addedBy: roleMembers.addedBy,
      addedAt: roleMembers.addedAt,
      email: users.email,
      displayName: users.displayName,
      role: memberships.role,
    })
    .from(roleMembers)
    .innerJoin(users, eq(users.id, roleMembers.userId))
    .innerJoin(memberships, and(eq(memberships.userId, roleMembers.userId), eq(memberships.orgId, roleMembers.orgId)))
    .where(
      and(
        eq(roleMembers.orgId, orgId),
        eq(roleMembers.roleId, roleId),
        activeAt(roleMembers.expiresAt, new Date().toISOString()),
      ),
    )
    .orderBy(users.email)
    .all();
}

/** Every user holding a role, expired or not — whoever a change to it might touch. */
function memberIdsOf(orgId: string, roleId: string): string[] {
  return getDb()
    .select({ userId: roleMembers.userId })
    .from(roleMembers)
    .where(and(eq(roleMembers.orgId, orgId), eq(roleMembers.roleId, roleId)))
    .all()
    .map((m) => m.userId);
}

/** What closed, per member, for the audit row; undefined when nothing did. */
function liveSummary(closed: Map<string, LiveAccessRevoked>): Record<string, LiveAccessRevoked> | undefined {
  return closed.size ? Object.fromEntries(closed) : undefined;
}

/** The grants as an audit row records them: what, how, at which level, until when. */
function grantSummary(grants: RoleGrant[]) {
  return grants.map((g) => ({
    type: g.resourceType,
    selector: g.selector,
    ...(g.resourceId && { resourceId: g.resourceId }),
    ...(g.tag && { tag: g.tag }),
    ...(g.namespaces && { namespaces: g.namespaces }),
    level: g.level,
    ...(g.expiresAt && { expiresAt: g.expiresAt }),
  }));
}

/** Validate and settle a grant list; sends a 400 and returns undefined when it does not hold up. */
function drafts(req: FastifyRequest, reply: FastifyReply, grants: GrantInput[]) {
  const result = draftGrants(req.orgId, grants);
  if ('error' in result) {
    reply.status(400).send({ error: result.error });
    return undefined;
  }
  return result.drafts;
}

function expiryFrom(body: { expiresAt?: string | null; expiresInMinutes?: number | null }): string | null | 'invalid' {
  if (body.expiresAt) {
    const at = new Date(body.expiresAt).getTime();
    if (Number.isNaN(at) || at <= Date.now() || at > Date.now() + MAX_GRANT_MINUTES * 60_000 + 60_000) return 'invalid';
    return new Date(at).toISOString();
  }
  return body.expiresInMinutes != null ? minutesFromNow(body.expiresInMinutes) : null;
}

function memberRow(orgId: string, userId: string) {
  return getDb()
    .select({
      role: memberships.role,
      scope: memberships.scope,
      status: memberships.status,
      email: users.email,
      displayName: users.displayName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .get();
}

function scopeOf(role: string, scope: string): MemberScope {
  return scope === 'roles' && rank(role) < rank('admin') ? 'roles' : 'all';
}

/** The resource's name, or undefined when it is not in the org. */
function resourceName(orgId: string, type: ResourceType, id: string): string | undefined {
  if (!resourceExists(orgId, type, id)) return undefined;
  return listResources(orgId, type).find((r) => r.id === id)?.name ?? id;
}

export async function teamAccessRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ── Roles ───────────────────────────────────────────────────────────────────

  app.get('/roles', { preHandler: requireRole('admin') }, async (req): Promise<CustomRole[]> => {
    const db = getDb();
    const rows = db.select().from(roles).where(and(eq(roles.orgId, req.orgId), customRoleFilter())).orderBy(roles.name).all();
    const ids = rows.map((r) => r.id);
    const counts = new Map(
      ids.length
        ? db
            .select({ roleId: roleMembers.roleId, n: count() })
            .from(roleMembers)
            .where(
              and(
                eq(roleMembers.orgId, req.orgId),
                inArray(roleMembers.roleId, ids),
                activeAt(roleMembers.expiresAt, new Date().toISOString()),
              ),
            )
            .groupBy(roleMembers.roleId)
            .all()
            .map((c) => [c.roleId, c.n])
        : [],
    );
    const grants = grantsOfRoles(req.orgId, ids);
    return rows.map((r) => presentRole(r, { memberCount: counts.get(r.id) ?? 0, grants: grants.get(r.id) ?? [] }));
  });

  app.post('/roles', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = createRoleSchema.parse(req.body);
    const db = getDb();
    if (RESERVED_ROLE_NAMES.has(body.name)) return reply.status(409).send({ error: `${body.name} is a built-in role name` });
    const taken = db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, req.orgId), eq(roles.name, body.name)))
      .get();
    if (taken) return reply.status(409).send({ error: `A role named ${body.name} already exists` });
    const grantDrafts = drafts(req, reply, body.grants ?? []);
    if (!grantDrafts) return reply;

    const id = nanoid();
    const now = new Date().toISOString();
    db.insert(roles)
      .values({
        id,
        orgId: req.orgId,
        name: body.name,
        description: body.description || null,
        color: body.color ?? null,
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // A new role has no members, so its grants take nothing from anyone
    if (grantDrafts.length) replaceGrants(req.orgId, 'role', id, grantDrafts, req.user.id);
    const grants = principalGrants(req.orgId, 'role', id);
    await audit(req, 'role.create', 'role', id, body.name, {
      after: { name: body.name, description: body.description || null, color: body.color ?? null, grants: grantSummary(grants) },
    });
    return reply.status(201).send({ ...presentRole(findRole(req.orgId, id)!), grants, members: [], memberCount: 0 } satisfies CustomRoleDetail);
  });

  app.get('/roles/:id', { preHandler: requireRole('admin') }, async (req, reply): Promise<CustomRoleDetail> => {
    const { id } = req.params as { id: string };
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    const members = membersOf(req.orgId, id);
    return { ...presentRole(row), grants: principalGrants(req.orgId, 'role', id), members, memberCount: members.length };
  });

  app.patch('/roles/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateRoleSchema.parse(req.body);
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    const db = getDb();
    if (body.name !== undefined && body.name !== row.name) {
      if (RESERVED_ROLE_NAMES.has(body.name)) return reply.status(409).send({ error: `${body.name} is a built-in role name` });
      const taken = db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, req.orgId), eq(roles.name, body.name), ne(roles.id, id)))
        .get();
      if (taken) return reply.status(409).send({ error: `A role named ${body.name} already exists` });
    }
    const before = { name: row.name, description: row.description, color: row.color };
    const after = {
      name: body.name ?? row.name,
      description: body.description !== undefined ? body.description || null : row.description,
      color: body.color !== undefined ? body.color : row.color,
    };
    db.update(roles)
      .set({ ...after, updatedAt: new Date().toISOString() })
      .where(and(eq(roles.id, id), eq(roles.orgId, req.orgId)))
      .run();
    await audit(req, 'role.update', 'role', id, after.name, { before, after });
    return presentRole(findRole(req.orgId, id)!);
  });

  app.delete('/roles/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    const db = getDb();
    const holders = memberIdsOf(req.orgId, id);
    const grants = principalGrants(req.orgId, 'role', id);
    const members = membersOf(req.orgId, id);
    const before = snapshotAccess(req.orgId, holders);
    let requestsCancelled = 0;
    db.transaction((tx) => {
      // Requests for the role keep their history; pending ones can no longer be granted
      requestsCancelled = tx
        .update(accessRequests)
        .set({
          status: 'cancelled',
          decidedBy: req.user.id,
          decidedAt: new Date().toISOString(),
          decisionNote: `Cancelled automatically: the role ${row.name} was deleted`,
        })
        .where(and(eq(accessRequests.orgId, req.orgId), eq(accessRequests.roleId, id), eq(accessRequests.status, 'pending')))
        .run().changes;
      tx.update(accessRequests).set({ roleId: null }).where(eq(accessRequests.roleId, id)).run();
      tx.delete(resourceGrants)
        .where(and(eq(resourceGrants.orgId, req.orgId), eq(resourceGrants.principalType, 'role'), eq(resourceGrants.principalId, id)))
        .run();
      tx.delete(roleMembers).where(eq(roleMembers.roleId, id)).run();
      tx.delete(roles).where(and(eq(roles.id, id), eq(roles.orgId, req.orgId))).run();
    });
    const live = liveSummary(revokeAfterChange(req.orgId, holders, before));
    await audit(req, 'role.delete', 'role', id, row.name, {
      before: {
        name: row.name,
        description: row.description,
        color: row.color,
        grants: grantSummary(grants),
        members: members.map((m) => ({ userId: m.userId, email: m.email, expiresAt: m.expiresAt })),
      },
      ...(requestsCancelled > 0 && { accessRequestsCancelled: requestsCancelled }),
      ...(live && { live }),
    });
    return reply.status(204).send();
  });

  /** Replace a role's resources wholesale; members who lose something have it closed now. */
  app.put('/roles/:id/grants', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = grantsSchema.parse(req.body);
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    const grantDrafts = drafts(req, reply, body.grants);
    if (!grantDrafts) return reply;

    const holders = memberIdsOf(req.orgId, id);
    const previous = principalGrants(req.orgId, 'role', id);
    const before = snapshotAccess(req.orgId, holders);
    replaceGrants(req.orgId, 'role', id, grantDrafts, req.user.id);
    getDb().update(roles).set({ updatedAt: new Date().toISOString() }).where(eq(roles.id, id)).run();
    const live = liveSummary(revokeAfterChange(req.orgId, holders, before));
    const grants = principalGrants(req.orgId, 'role', id);
    await audit(req, 'role.grants_change', 'role', id, row.name, {
      before: grantSummary(previous),
      after: grantSummary(grants),
      members: holders.length,
      ...(live && { live }),
    });
    return { grants };
  });

  /** Add a member to a role, or change how long they hold it. */
  app.post('/roles/:id/members', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = roleMemberSchema.parse(req.body);
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    // As with personal grants: an admin's own roles would only outlive a demotion
    if (body.userId === req.user.id) return reply.status(400).send({ error: 'You cannot change your own access' });
    const member = memberRow(req.orgId, body.userId);
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });
    const expiresAt = expiryFrom(body);
    if (expiresAt === 'invalid') return reply.status(400).send({ error: 'Membership can end between now and a year from now' });

    const db = getDb();
    const where = and(eq(roleMembers.roleId, id), eq(roleMembers.userId, body.userId));
    const existing = db.select().from(roleMembers).where(where).get();
    const before = snapshotAccess(req.orgId, [body.userId]);
    if (existing) {
      db.update(roleMembers).set({ expiresAt, addedBy: req.user.id }).where(where).run();
    } else {
      db.insert(roleMembers)
        .values({ roleId: id, userId: body.userId, orgId: req.orgId, expiresAt, addedBy: req.user.id, addedAt: new Date().toISOString() })
        .run();
    }
    // A membership past its expiry counted for nothing, so only a shortened one can take something away
    const live = liveSummary(revokeAfterChange(req.orgId, [body.userId], before));
    await audit(req, 'role.member_add', 'role', id, row.name, {
      userId: body.userId,
      email: member.email,
      before: existing ? { expiresAt: existing.expiresAt } : null,
      after: { expiresAt },
      ...(live && { live }),
    });
    return reply.status(existing ? 200 : 201).send({ members: membersOf(req.orgId, id) });
  });

  async function removeRoleMember(req: FastifyRequest, reply: FastifyReply, id: string, userId: string) {
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    const db = getDb();
    const where = and(eq(roleMembers.roleId, id), eq(roleMembers.userId, userId), eq(roleMembers.orgId, req.orgId));
    const existing = db.select().from(roleMembers).where(where).get();
    if (!existing) return reply.status(404).send({ error: 'Not a member of this role' });
    const before = snapshotAccess(req.orgId, [userId]);
    db.delete(roleMembers).where(where).run();
    // Terminals, file sessions and streams on what only this role gave close now
    const live = liveSummary(revokeAfterChange(req.orgId, [userId], before));
    await audit(req, 'role.member_remove', 'role', id, row.name, {
      userId,
      email: db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email,
      before: { expiresAt: existing.expiresAt },
      after: null,
      ...(live && { live }),
    });
    return { members: membersOf(req.orgId, id) };
  }

  app.delete('/roles/:id/members/:userId', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    return removeRoleMember(req, reply, id, userId);
  });

  /** The same, with the member in the body (spec §6: `DELETE /roles/:id/members`). */
  app.delete('/roles/:id/members', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body ?? {});
    return removeRoleMember(req, reply, id, userId);
  });

  // ── A member's personal grants ──────────────────────────────────────────────

  /** Replace a member's personal grants wholesale (any type, level, selector, expiry). */
  app.put('/members/:userId/grants', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = grantsSchema.parse(req.body);
    if (userId === req.user.id) return reply.status(400).send({ error: 'You cannot change your own access' });
    const member = memberRow(req.orgId, userId);
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });
    if (rank(member.role) > rank(req.role)) {
      return reply.status(403).send({ error: `You cannot change access for a member with the ${member.role} role` });
    }
    if (rank(member.role) >= rank('admin')) {
      return reply.status(400).send({ error: 'Owners and admins always have manage access to everything' });
    }
    const grantDrafts = drafts(req, reply, body.grants);
    if (!grantDrafts) return reply;

    const previous = principalGrants(req.orgId, 'user', userId);
    const before = snapshotAccess(req.orgId, [userId]);
    replaceGrants(req.orgId, 'user', userId, grantDrafts, req.user.id);
    const live = liveSummary(revokeAfterChange(req.orgId, [userId], before));
    const grants = principalGrants(req.orgId, 'user', userId);
    await audit(req, 'member.grants_change', 'member', userId, member.email, {
      before: grantSummary(previous),
      after: grantSummary(grants),
      ...(live && { live }),
    });
    return { grants };
  });

  // ── Access checker, who has access, resources ───────────────────────────────

  /** Every resource of every type, for the role editor's and checker's pickers. */
  app.get('/access/resources', { preHandler: requireRole('admin') }, async (req): Promise<AccessResources> => {
    return Object.fromEntries(RESOURCE_TYPES.map((type) => [type, listResources(req.orgId, type)])) as AccessResources;
  });

  /** "Why does alice have access to web-1?" — the level and every reason. */
  app.get('/access/explain', { preHandler: requireRole('admin') }, async (req, reply): Promise<AccessExplanation> => {
    const query = explainSchema.parse(req.query);
    const member = memberRow(req.orgId, query.userId);
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });
    const name = resourceName(req.orgId, query.type, query.id);
    if (name === undefined) return reply.status(404).send({ error: `${RESOURCE_LABELS[query.type]} not found` });
    // A suspended member reaches nothing, whatever their roles say
    const result = explain({ orgId: req.orgId, userId: query.userId }, query.type, query.id, { namespace: query.namespace });
    return {
      ...result,
      user: {
        id: query.userId,
        email: member.email,
        displayName: member.displayName,
        role: member.role,
        scope: scopeOf(member.role, member.scope),
      },
      resource: { name },
    };
  });

  /** Who can reach one resource, at which level, and through what. */
  app.get('/access/resource', { preHandler: requireRole('admin') }, async (req, reply): Promise<ResourceAccessList> => {
    const query = resourceQuerySchema.parse(req.query);
    const name = resourceName(req.orgId, query.type, query.id);
    if (name === undefined) return reply.status(404).send({ error: `${RESOURCE_LABELS[query.type]} not found` });
    const members = getDb()
      .select({
        userId: memberships.userId,
        role: memberships.role,
        scope: memberships.scope,
        email: users.email,
        displayName: users.displayName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, req.orgId), eq(memberships.status, 'active')))
      .all();
    const holders: ResourceAccessHolder[] = [];
    for (const m of members) {
      const result = explain({ orgId: req.orgId, userId: m.userId }, query.type, query.id);
      if (!result.level) continue;
      holders.push({
        userId: m.userId,
        email: m.email,
        displayName: m.displayName,
        role: m.role,
        scope: scopeOf(m.role, m.scope),
        level: result.level,
        via: result.via,
        ...(query.type === 'cluster' && { namespaces: result.namespaces ?? null }),
      });
    }
    // Most access first, then by name
    const order = (l: AccessLevel) => ACCESS_LEVELS.indexOf(l);
    holders.sort((a, b) => order(b.level) - order(a.level) || a.email.localeCompare(b.email));
    return { resourceType: query.type, resourceId: query.id, name, holders };
  });

  /** The caller's own level on each resource of a type they can see. */
  app.get('/access/mine', async (req): Promise<MyAccessLevels> => {
    const { type } = mineSchema.parse(req.query);
    const entries = effectiveAccessList(req, type);
    const namespaces = Object.fromEntries(
      entries.flatMap((e) => (Array.isArray(e.namespaces) ? [[e.resourceId, e.namespaces]] : [])),
    );
    const base = baseActions(req, type);
    return {
      resourceType: type,
      orgAdmin: rank(req.role) >= rank('admin'),
      levels: Object.fromEntries(entries.flatMap((e) => (e.level ? [[e.resourceId, e.level]] : []))),
      ...(type === 'cluster' && { namespaces }),
      ...(base.length > 0 && { baseActions: base }),
    };
  });
}
