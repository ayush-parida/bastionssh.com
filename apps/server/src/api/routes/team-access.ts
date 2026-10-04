import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  ACCESS_LEVELS,
  BUILT_IN_ROLE_DEFAULTS,
  BUILT_IN_ROLES,
  MODULE_KEYS,
  MODULE_LEVELS,
  RESOURCE_TYPES,
  type AccessExplanation,
  type AccessLevel,
  type AccessResources,
  type BuiltInRole,
  type CustomRole,
  type CustomRoleDetail,
  type GrantInput,
  type MemberScope,
  type ModuleKey,
  type ModuleLevel,
  type ModulePermissions,
  type MyAccessLevels,
  type ResourceAccessHolder,
  type ResourceAccessList,
  type ResourceType,
  type RoleGrant,
  type RoleMemberDetail,
} from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { accessRequests, memberships, resourceGrants, roleMembers, roles, users } from '../../db/schema.js';
import { audit } from '../../audit/index.js';
import { MAX_GRANT_MINUTES, minutesFromNow } from '../../auth/access-grants.js';
import { activeAt } from '../../auth/access/resolve.js';
import {
  canAssignRole,
  canGrant,
  isOwner,
  isReservedRoleName,
  requireModule,
  rolePermissions,
} from '../../auth/access/modules.js';
import { baseActions } from '../../auth/command-access.js';
import {
  allModules,
  clampModuleLevel,
  draftGrants,
  effectiveAccessList,
  explain,
  grantsOfRoles,
  listResources,
  moduleRank,
  parseModulePermissions,
  principalGrants,
  replaceGrants,
  resourceExists,
  RESOURCE_LABELS,
  TYPE_MODULES,
  type GrantDraft,
} from '../../auth/access/index.js';
import {
  changeMemberRoles,
  legacyRoleOf,
  legacyScopeOf,
  liveSummary,
  managesEverything,
  memberRoleRows,
  outranks,
  revokeAfterMemberChange,
  snapshotMembers,
  type RoleAssignment,
} from '../../auth/access/members.js';

/**
 * Roles and per-resource access (unified roles spec §3–§5, custom roles spec
 * §6), next to the member routes in team.ts under /api/team:
 *
 * - Roles (Team & Access → Roles & access): every role — the built-ins
 *   (Owner and No access locked, Admin, Operator and Viewer editable with
 *   "Reset to default") and custom roles — with their module levels and
 *   grants; create, clone, edit, delete; add and remove members, optionally
 *   until a time.
 * - A member's personal grants, replacing the pre-roles server and cluster
 *   access lists (still served by team.ts as compatible aliases).
 * - The access checker and who-has-access, and the caller's own level on
 *   each resource of a type (anyone), so the UI can hide buttons.
 *
 * Reading needs Roles & access at `view`, changing it `manage`; and every
 * change passes the delegation guard (spec §4.2): whoever makes it must hold
 * what it gives — or takes away — themselves, module by module and grant by
 * grant. Every change that can take access away snapshots the affected
 * members first and closes what they lost afterwards — resources and modules
 * (revokeAfterMemberChange) — and every change is audited with what it was
 * before and after.
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

/** A role's module levels: known modules only; a level above a module's highest counts as its highest. */
const modulesSchema = z
  .record(z.string(), z.enum(MODULE_LEVELS as [ModuleLevel, ...ModuleLevel[]]))
  .refine((m) => Object.keys(m).every((key) => (MODULE_KEYS as readonly string[]).includes(key)), {
    message: 'Unknown module',
  })
  .transform((m) => {
    const out: ModulePermissions = {};
    for (const [key, level] of Object.entries(m) as [ModuleKey, ModuleLevel][]) {
      if (level !== 'none') out[key] = clampModuleLevel(key, level);
    }
    return out;
  });

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #rrggbb');
const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).nullable().optional(),
  color: colorSchema.nullable().optional(),
  grants: z.array(grantSchema).max(500).optional(),
  modules: modulesSchema.optional(),
});
const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    color: colorSchema.nullable().optional(),
    modules: modulesSchema.optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined || b.color !== undefined || b.modules !== undefined, {
    message: 'Nothing to change',
  });
const cloneRoleSchema = z.object({ name: z.string().trim().min(1).max(60).optional() });

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

function systemOf(row: RoleRow): BuiltInRole | null {
  return row.system !== null && (BUILT_IN_ROLES as readonly string[]).includes(row.system) ? (row.system as BuiltInRole) : null;
}

/** Owner and No access cannot be changed (spec §2.2). */
function isLocked(row: RoleRow): boolean {
  const system = systemOf(row);
  return system !== null && !BUILT_IN_ROLE_DEFAULTS[system].editable;
}

function findRole(orgId: string, id: string): RoleRow | undefined {
  return getDb()
    .select()
    .from(roles)
    .where(and(eq(roles.id, id), eq(roles.orgId, orgId)))
    .get();
}

/**
 * What the role gives on each module: Owner everything; a custom role from
 * before module permissions (null) the resource modules of its grants at
 * `view`, as resolve.ts counts it.
 */
function modulesOf(orgId: string, row: RoleRow): ModulePermissions {
  if (systemOf(row) === 'owner') return allModules();
  if (row.modulePermissions === null) return rolePermissions(orgId, row.id)?.modules ?? {};
  return parseModulePermissions(row.modulePermissions);
}

function presentRole(orgId: string, row: RoleRow, extra: Partial<CustomRole> = {}): CustomRole {
  const system = systemOf(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    system,
    modules: modulesOf(orgId, row),
    editable: !isLocked(row),
    deletable: system === null,
    ...extra,
  };
}

/** Built-in roles first, in their order (Owner … No access), then the rest by name. */
function roleOrder(a: RoleRow, b: RoleRow): number {
  const rank = (r: RoleRow) => {
    const system = systemOf(r);
    return system ? BUILT_IN_ROLES.indexOf(system) : BUILT_IN_ROLES.length;
  };
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
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

/** The grants as an audit row records them: what, how, at which level, until when. */
function grantSummary(grants: Pick<RoleGrant, 'resourceType' | 'selector' | 'resourceId' | 'tag' | 'namespaces' | 'level' | 'expiresAt'>[]) {
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

// ── The delegation guard over role and grant edits (spec §4.2) ───────────────

type GrantShape = Pick<GrantDraft, 'resourceType' | 'selector' | 'resourceId' | 'tag' | 'namespaces' | 'level' | 'expiresAt'>;

function grantKey(g: GrantShape): string {
  return JSON.stringify([g.resourceType, g.selector, g.resourceId ?? null, g.tag ?? null, g.namespaces ?? null, g.level, g.expiresAt ?? null]);
}

/** Grants in one list and not the other: what a replacement gives, and what it takes away. */
function grantChanges(before: GrantShape[], after: GrantShape[]): GrantShape[] {
  const was = new Set(before.map(grantKey));
  const now = new Set(after.map(grantKey));
  return [...after.filter((g) => !was.has(grantKey(g))), ...before.filter((g) => !now.has(grantKey(g)))];
}

/** Modules whose level changes, each at the higher of the two: giving or taking it away needs that. */
function moduleChanges(before: ModulePermissions, after: ModulePermissions): ModulePermissions {
  const changed: ModulePermissions = {};
  for (const key of MODULE_KEYS) {
    const a = before[key] ?? 'none';
    const b = after[key] ?? 'none';
    if (a !== b) changed[key] = moduleRank(a) >= moduleRank(b) ? a : b;
  }
  return changed;
}

/**
 * What the actor lacks to make a change that gives or takes away `modules`
 * (for good) and `grants` (each until its own expiry). Empty when allowed.
 */
function delegationMissing(req: FastifyRequest, modules: ModulePermissions, grants: GrantShape[]): string[] {
  const missing = new Set<string>(canGrant(req, { modules }).missing);
  const byExpiry = new Map<string | null, GrantShape[]>();
  for (const g of grants) byExpiry.set(g.expiresAt ?? null, [...(byExpiry.get(g.expiresAt ?? null) ?? []), g]);
  for (const [expiresAt, list] of byExpiry) {
    for (const m of canGrant(req, { grants: list }, { expiresAt }).missing) missing.add(m);
  }
  return [...missing];
}

function sendRefused(reply: FastifyReply, verb: string, missing: string[]) {
  return reply.status(403).send({ error: `You cannot ${verb}: you do not hold ${missing.join('; ')}`, missing });
}

/** How the delegation guard let a change through, for its audit row. */
function delegationNote(req: FastifyRequest): string {
  return isOwner(req) ? 'owner' : 'within the actor’s own access';
}

/**
 * Module levels for a new role whose request named none: the resource
 * modules of its grants at `view` (Containers with Servers) — what a role
 * from before module permissions did, written out.
 */
function modulesFromGrants(grants: GrantShape[]): ModulePermissions {
  const modules: ModulePermissions = {};
  for (const g of grants) {
    modules[TYPE_MODULES[g.resourceType]] = 'view';
    if (g.resourceType === 'server') modules.containers = 'view';
  }
  return modules;
}

/** A free role name: none taken in the org, none reserved for a built-in. */
function nameProblem(orgId: string, name: string, exceptId?: string): string | undefined {
  if (isReservedRoleName(name)) return `${name} is a built-in role name`;
  const taken = getDb()
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.name, name), exceptId ? ne(roles.id, exceptId) : undefined))
    .get();
  return taken ? `A role named ${name} already exists` : undefined;
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
      status: memberships.status,
      email: users.email,
      displayName: users.displayName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .get();
}

/** The base role and scope a member's roles amount to (the compatible fields of the checker). */
function legacyOf(orgId: string, userId: string): { role: string; scope: MemberScope } {
  const lasting = (memberRoleRows(orgId, [userId]).get(userId) ?? []).filter((r) => r.expiresAt === null);
  return { role: legacyRoleOf(orgId, lasting), scope: legacyScopeOf(lasting) };
}

/** The resource's name, or undefined when it is not in the org. */
function resourceName(orgId: string, type: ResourceType, id: string): string | undefined {
  if (!resourceExists(orgId, type, id)) return undefined;
  return listResources(orgId, type).find((r) => r.id === id)?.name ?? id;
}

export async function teamAccessRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ── Roles ───────────────────────────────────────────────────────────────────

  app.get('/roles', { preHandler: requireModule('team_roles', 'view') }, async (req): Promise<CustomRole[]> => {
    const db = getDb();
    const rows = db.select().from(roles).where(eq(roles.orgId, req.orgId)).all().sort(roleOrder);
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
    return rows.map((r) => presentRole(req.orgId, r, { memberCount: counts.get(r.id) ?? 0, grants: grants.get(r.id) ?? [] }));
  });

  /**
   * A custom role with module levels and grants. Its creator must hold all of
   * it (spec §4.2): nobody makes a role that gives more than they have.
   */
  app.post('/roles', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const body = createRoleSchema.parse(req.body);
    const db = getDb();
    const problem = nameProblem(req.orgId, body.name);
    if (problem) return reply.status(409).send({ error: problem });
    const grantDrafts = drafts(req, reply, body.grants ?? []);
    if (!grantDrafts) return reply;
    const modules = body.modules ?? modulesFromGrants(grantDrafts);
    const missing = delegationMissing(req, modules, grantDrafts);
    if (missing.length) return sendRefused(reply, 'create this role', missing);

    const id = nanoid();
    const now = new Date().toISOString();
    db.insert(roles)
      .values({
        id,
        orgId: req.orgId,
        name: body.name,
        description: body.description || null,
        color: body.color ?? null,
        modulePermissions: JSON.stringify(modules),
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // A new role has no members, so its grants take nothing from anyone
    if (grantDrafts.length) replaceGrants(req.orgId, 'role', id, grantDrafts, req.user.id);
    const grants = principalGrants(req.orgId, 'role', id);
    await audit(req, 'role.create', 'role', id, body.name, {
      before: null,
      after: { name: body.name, description: body.description || null, color: body.color ?? null, modules, grants: grantSummary(grants) },
      delegation: delegationNote(req),
    });
    return reply
      .status(201)
      .send({ ...presentRole(req.orgId, findRole(req.orgId, id)!), grants, members: [], memberCount: 0 } satisfies CustomRoleDetail);
  });

  app.get('/roles/:id', { preHandler: requireModule('team_roles', 'view') }, async (req, reply): Promise<CustomRoleDetail> => {
    const { id } = req.params as { id: string };
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    const members = membersOf(req.orgId, id);
    return { ...presentRole(req.orgId, row), grants: principalGrants(req.orgId, 'role', id), members, memberCount: members.length };
  });

  /**
   * Rename, describe, recolour, or change a role's module levels. Owner and
   * No access are locked; the other built-ins keep their names. A module
   * level raised or lowered must be one the actor holds (spec §4.2); members
   * who lose a module have what it kept open closed.
   */
  app.patch('/roles/:id', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateRoleSchema.parse(req.body);
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (isLocked(row)) return reply.status(400).send({ error: `The ${row.name} role cannot be changed` });
    if (body.name !== undefined && body.name !== row.name) {
      if (systemOf(row)) return reply.status(400).send({ error: 'Built-in roles keep their names' });
      const problem = nameProblem(req.orgId, body.name, id);
      if (problem) return reply.status(409).send({ error: problem });
    }
    const modulesBefore = modulesOf(req.orgId, row);
    if (body.modules) {
      const missing = delegationMissing(req, moduleChanges(modulesBefore, body.modules), []);
      if (missing.length) return sendRefused(reply, 'change this role', missing);
    }
    const before = { name: row.name, description: row.description, color: row.color, modules: modulesBefore };
    const after = {
      name: body.name ?? row.name,
      description: body.description !== undefined ? body.description || null : row.description,
      color: body.color !== undefined ? body.color : row.color,
      modules: body.modules ?? modulesBefore,
    };
    const holders = memberIdsOf(req.orgId, id);
    const snapshot = body.modules ? snapshotMembers(req.orgId, holders) : undefined;
    getDb()
      .update(roles)
      .set({
        name: after.name,
        description: after.description,
        color: after.color,
        ...(body.modules && { modulePermissions: JSON.stringify(body.modules) }),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(roles.id, id), eq(roles.orgId, req.orgId)))
      .run();
    const live = snapshot ? liveSummary(revokeAfterMemberChange(req.orgId, holders, snapshot)) : undefined;
    await audit(req, 'role.update', 'role', id, after.name, {
      before,
      after,
      ...(body.modules && { members: holders.length, delegation: delegationNote(req) }),
      ...(live && { live }),
    });
    return presentRole(req.orgId, findRole(req.orgId, id)!);
  });

  /**
   * Put a built-in role (Admin, Operator, Viewer) back to its defaults: its
   * module levels and its "All …" grants (spec §2.2). Owner and No access
   * never change; custom roles have no defaults.
   */
  app.post('/roles/:id/reset', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    const system = systemOf(row);
    if (!system) return reply.status(400).send({ error: 'Only built-in roles have defaults' });
    if (isLocked(row)) return reply.status(400).send({ error: `The ${row.name} role cannot be changed` });
    const defaults = BUILT_IN_ROLE_DEFAULTS[system];
    const grantDrafts: GrantDraft[] = defaults.grantLevel
      ? RESOURCE_TYPES.map((resourceType) => ({
          resourceType,
          selector: 'all' as const,
          resourceId: null,
          tag: null,
          namespaces: null,
          level: defaults.grantLevel!,
          expiresAt: null,
          reason: null,
        }))
      : [];
    const modulesBefore = modulesOf(req.orgId, row);
    const grantsBefore = principalGrants(req.orgId, 'role', id);
    const missing = delegationMissing(req, moduleChanges(modulesBefore, defaults.modules), grantChanges(grantsBefore, grantDrafts));
    if (missing.length) return sendRefused(reply, 'reset this role', missing);

    const holders = memberIdsOf(req.orgId, id);
    const snapshot = snapshotMembers(req.orgId, holders);
    const db = getDb();
    db.transaction(() => {
      db.update(roles)
        .set({
          name: defaults.name,
          description: defaults.description,
          modulePermissions: JSON.stringify(defaults.modules),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(roles.id, id), eq(roles.orgId, req.orgId)))
        .run();
      replaceGrants(req.orgId, 'role', id, grantDrafts, req.user.id);
    });
    const live = liveSummary(revokeAfterMemberChange(req.orgId, holders, snapshot));
    const grants = principalGrants(req.orgId, 'role', id);
    await audit(req, 'role.reset', 'role', id, defaults.name, {
      before: { name: row.name, description: row.description, modules: modulesBefore, grants: grantSummary(grantsBefore) },
      after: { name: defaults.name, description: defaults.description, modules: defaults.modules, grants: grantSummary(grants) },
      members: holders.length,
      delegation: delegationNote(req),
      ...(live && { live }),
    });
    const members = membersOf(req.orgId, id);
    return { ...presentRole(req.orgId, findRole(req.orgId, id)!), grants, members, memberCount: members.length } satisfies CustomRoleDetail;
  });

  /**
   * A new custom role with the same module levels and grants as another (any
   * role; Owner's "everything" becomes every module and every resource at
   * `manage`, without the owner-only actions). No members are copied.
   */
  app.post('/roles/:id/clone', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = cloneRoleSchema.parse(req.body ?? {});
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    const name = body.name ?? `${row.name} (copy)`.slice(0, 60);
    const problem = nameProblem(req.orgId, name);
    if (problem) return reply.status(409).send({ error: problem });
    const modules = modulesOf(req.orgId, row);
    const grantDrafts: GrantDraft[] =
      systemOf(row) === 'owner'
        ? RESOURCE_TYPES.map((resourceType) => ({
            resourceType,
            selector: 'all' as const,
            resourceId: null,
            tag: null,
            namespaces: null,
            level: 'manage' as const,
            expiresAt: null,
            reason: null,
          }))
        : principalGrants(req.orgId, 'role', id).map((g) => ({
            resourceType: g.resourceType,
            selector: g.selector,
            resourceId: g.resourceId,
            tag: g.tag,
            namespaces: g.namespaces,
            level: g.level,
            expiresAt: g.expiresAt,
            reason: g.reason,
          }));
    const missing = delegationMissing(req, modules, grantDrafts);
    if (missing.length) return sendRefused(reply, 'clone this role', missing);

    const newId = nanoid();
    const now = new Date().toISOString();
    getDb()
      .insert(roles)
      .values({
        id: newId,
        orgId: req.orgId,
        name,
        description: row.description,
        color: row.color,
        modulePermissions: JSON.stringify(modules),
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (grantDrafts.length) replaceGrants(req.orgId, 'role', newId, grantDrafts, req.user.id);
    const grants = principalGrants(req.orgId, 'role', newId);
    await audit(req, 'role.create', 'role', newId, name, {
      before: null,
      after: { name, description: row.description, color: row.color, modules, grants: grantSummary(grants) },
      clonedFrom: { roleId: row.id, name: row.name },
      delegation: delegationNote(req),
    });
    return reply
      .status(201)
      .send({ ...presentRole(req.orgId, findRole(req.orgId, newId)!), grants, members: [], memberCount: 0 } satisfies CustomRoleDetail);
  });

  /**
   * Delete a custom role (built-ins cannot be). Its members lose what it gave,
   * which the actor must hold themselves (taking away needs the same as giving).
   */
  app.delete('/roles/:id', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (systemOf(row)) return reply.status(400).send({ error: 'Built-in roles cannot be deleted' });
    const delegation = canAssignRole(req, id);
    if (!delegation.ok) return sendRefused(reply, 'delete this role', delegation.missing);
    const db = getDb();
    const holders = memberIdsOf(req.orgId, id);
    const grants = principalGrants(req.orgId, 'role', id);
    const members = membersOf(req.orgId, id);
    const modules = modulesOf(req.orgId, row);
    const before = snapshotMembers(req.orgId, holders);
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
    const live = liveSummary(revokeAfterMemberChange(req.orgId, holders, before));
    await audit(req, 'role.delete', 'role', id, row.name, {
      before: {
        name: row.name,
        description: row.description,
        color: row.color,
        modules,
        grants: grantSummary(grants),
        members: members.map((m) => ({ userId: m.userId, email: m.email, expiresAt: m.expiresAt })),
      },
      after: null,
      delegation: delegationNote(req),
      ...(requestsCancelled > 0 && { accessRequestsCancelled: requestsCancelled }),
      ...(live && { live }),
    });
    return reply.status(204).send();
  });

  /**
   * Replace a role's resources wholesale; members who lose something have it
   * closed now. Each grant added or removed must be one the actor holds, for
   * as long (spec §4.2). Owner (everything) and No access (nothing) are locked.
   */
  app.put('/roles/:id/grants', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = grantsSchema.parse(req.body);
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (isLocked(row)) return reply.status(400).send({ error: `The ${row.name} role cannot be changed` });
    const grantDrafts = drafts(req, reply, body.grants);
    if (!grantDrafts) return reply;

    const previous = principalGrants(req.orgId, 'role', id);
    const missing = delegationMissing(req, {}, grantChanges(previous, grantDrafts));
    if (missing.length) return sendRefused(reply, 'change this role', missing);
    const holders = memberIdsOf(req.orgId, id);
    const before = snapshotMembers(req.orgId, holders);
    replaceGrants(req.orgId, 'role', id, grantDrafts, req.user.id);
    getDb().update(roles).set({ updatedAt: new Date().toISOString() }).where(eq(roles.id, id)).run();
    const live = liveSummary(revokeAfterMemberChange(req.orgId, holders, before));
    const grants = principalGrants(req.orgId, 'role', id);
    await audit(req, 'role.grants_change', 'role', id, row.name, {
      before: grantSummary(previous),
      after: grantSummary(grants),
      members: holders.length,
      delegation: delegationNote(req),
      ...(live && { live }),
    });
    return { grants };
  });

  /**
   * Add a member to a role, or change how long they hold it. The actor must
   * be able to give the role for that long (spec §4.2); Owner only by owners.
   */
  app.post('/roles/:id/members', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = roleMemberSchema.parse(req.body);
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    // Nobody hands themselves a role, even one they could give others
    if (body.userId === req.user.id) return reply.status(400).send({ error: 'You cannot change your own access' });
    const member = memberRow(req.orgId, body.userId);
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });
    const expiresAt = expiryFrom(body);
    if (expiresAt === 'invalid') return reply.status(400).send({ error: 'Membership can end between now and a year from now' });

    const current = memberRoleRows(req.orgId, [body.userId]).get(body.userId) ?? [];
    const existing = current.find((r) => r.roleId === id);
    const next: RoleAssignment[] = [
      ...current.filter((r) => r.roleId !== id).map((r) => ({ roleId: r.roleId, expiresAt: r.expiresAt })),
      { roleId: id, expiresAt },
    ];
    // A role given beside No access makes No access mean nothing
    const meaningful = row.system === 'none' ? next : next.filter((n) => current.find((r) => r.roleId === n.roleId)?.system !== 'none');
    const changed = changeMemberRoles(req, body.userId, meaningful, `give the ${row.name} role`);
    if ('refused' in changed) {
      const { status, error, missing } = changed.refused;
      return reply.status(status).send({ error, ...(missing && { missing }) });
    }
    if (!existing || existing.expiresAt !== expiresAt) {
      await audit(req, 'role.member_add', 'role', id, row.name, {
        userId: body.userId,
        email: member.email,
        before: existing ? { expiresAt: existing.expiresAt } : null,
        after: { expiresAt },
        delegation: delegationNote(req),
        ...(changed.live && { live: changed.live }),
      });
    }
    return reply.status(existing ? 200 : 201).send({ members: membersOf(req.orgId, id) });
  });

  async function removeRoleMember(req: FastifyRequest, reply: FastifyReply, id: string, userId: string) {
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (userId === req.user.id) return reply.status(400).send({ error: 'You cannot change your own access' });
    const current = memberRoleRows(req.orgId, [userId]).get(userId) ?? [];
    const existing = current.find((r) => r.roleId === id);
    if (!existing) return reply.status(404).send({ error: 'Not a member of this role' });
    const next = current.filter((r) => r.roleId !== id).map((r) => ({ roleId: r.roleId, expiresAt: r.expiresAt }));
    // Terminals, file sessions and streams on what only this role gave close now
    const changed = changeMemberRoles(req, userId, next, `take the ${row.name} role from`);
    if ('refused' in changed) {
      const { status, error, missing } = changed.refused;
      return reply.status(status).send({ error, ...(missing && { missing }) });
    }
    await audit(req, 'role.member_remove', 'role', id, row.name, {
      userId,
      email: getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email,
      before: { expiresAt: existing.expiresAt },
      after: null,
      delegation: delegationNote(req),
      ...(changed.live && { live: changed.live }),
    });
    return { members: membersOf(req.orgId, id) };
  }

  app.delete('/roles/:id/members/:userId', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    return removeRoleMember(req, reply, id, userId);
  });

  /** The same, with the member in the body (spec §6: `DELETE /roles/:id/members`). */
  app.delete('/roles/:id/members', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body ?? {});
    return removeRoleMember(req, reply, id, userId);
  });

  // ── A member's personal grants ──────────────────────────────────────────────

  /**
   * Replace a member's personal grants wholesale (any type, level, selector,
   * expiry). Only for a member whose access is within the actor's, and each
   * grant added or removed must be one the actor holds, for as long.
   */
  app.put('/members/:userId/grants', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = grantsSchema.parse(req.body);
    if (userId === req.user.id) return reply.status(400).send({ error: 'You cannot change your own access' });
    const member = memberRow(req.orgId, userId);
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });
    if (!outranks(req.orgId, req.user.id, userId, 'atOrBelow')) {
      return reply.status(403).send({ error: 'You cannot change access for a member who holds access you do not' });
    }
    if (managesEverything({ orgId: req.orgId, userId })) {
      return reply.status(400).send({ error: 'Owners and admins always have manage access to everything' });
    }
    const grantDrafts = drafts(req, reply, body.grants);
    if (!grantDrafts) return reply;

    const previous = principalGrants(req.orgId, 'user', userId);
    const missing = delegationMissing(req, {}, grantChanges(previous, grantDrafts));
    if (missing.length) return sendRefused(reply, 'change these grants', missing);
    const before = snapshotMembers(req.orgId, [userId]);
    replaceGrants(req.orgId, 'user', userId, grantDrafts, req.user.id);
    const live = liveSummary(revokeAfterMemberChange(req.orgId, [userId], before));
    const grants = principalGrants(req.orgId, 'user', userId);
    await audit(req, 'member.grants_change', 'member', userId, member.email, {
      before: grantSummary(previous),
      after: grantSummary(grants),
      delegation: delegationNote(req),
      ...(live && { live }),
    });
    return { grants };
  });

  // ── Access checker, who has access, resources ───────────────────────────────

  /** Every resource of every type, for the role editor's and checker's pickers. */
  app.get('/access/resources', { preHandler: requireModule('team_roles', 'view') }, async (req): Promise<AccessResources> => {
    return Object.fromEntries(RESOURCE_TYPES.map((type) => [type, listResources(req.orgId, type)])) as AccessResources;
  });

  /** "Why does alice have access to web-1?" — the level and every reason. */
  app.get('/access/explain', { preHandler: requireModule('team_roles', 'view') }, async (req, reply): Promise<AccessExplanation> => {
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
        ...legacyOf(req.orgId, query.userId),
      },
      resource: { name },
    };
  });

  /** Who can reach one resource, at which level, and through what. */
  app.get('/access/resource', { preHandler: requireModule('team_roles', 'view') }, async (req, reply): Promise<ResourceAccessList> => {
    const query = resourceQuerySchema.parse(req.query);
    const name = resourceName(req.orgId, query.type, query.id);
    if (name === undefined) return reply.status(404).send({ error: `${RESOURCE_LABELS[query.type]} not found` });
    const members = getDb()
      .select({
        userId: memberships.userId,
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
        ...legacyOf(req.orgId, m.userId),
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
      // Reaches every resource of the type at `manage`: owners, and admins at their defaults
      orgAdmin: managesEverything(req),
      levels: Object.fromEntries(entries.flatMap((e) => (e.level ? [[e.resourceId, e.level]] : []))),
      ...(type === 'cluster' && { namespaces }),
      ...(base.length > 0 && { baseActions: base }),
    };
  });
}
