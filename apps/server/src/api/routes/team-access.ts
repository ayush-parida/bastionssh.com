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
  type CustomRole,
  type CustomRoleDetail,
  type DefaultRole,
  type GrantInput,
  type MemberScope,
  type ModuleKey,
  type ModuleLevel,
  type ModulePermissions,
  type MyAccessLevels,
  type PermissionSet,
  type ResourceAccessHolder,
  type ResourceAccessList,
  type ResourceType,
  type RoleGrant,
  type RoleMemberDetail,
} from '@smt/shared';
import { rank, requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { accessRequests, memberships, organizations, resourceGrants, roleMembers, roles, users } from '../../db/schema.js';
import { audit } from '../../audit/index.js';
import { MAX_GRANT_MINUTES, minutesFromNow } from '../../auth/access-grants.js';
import type { LiveAccessRevoked } from '../../auth/revoke.js';
import { activeAt } from '../../auth/access/resolve.js';
import {
  canAssignRole,
  canGrant,
  hasModule,
  isOrgOwner,
  isReservedRoleName,
  requireModule,
  rolePermissions,
  type DelegationResult,
} from '../../auth/access/modules.js';
import { clampModuleLevel, maxModuleLevel, parseModulePermissions } from '../../auth/access/levels.js';
import { defaultRoleId, isBuiltInRole, otherActiveOwners } from '../../auth/access/assign.js';
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
 * Roles and per-resource access (custom roles spec §6, unified roles spec
 * §2–§5), next to the member routes in team.ts under /api/team:
 *
 * - Roles (Team & Access → Roles): every role of the org, built-ins first;
 *   create, read, rename/recolour, change module levels, delete; replace a
 *   role's grant list; reset a built-in to its defaults; clone; add and
 *   remove members, optionally until a time. Owner and No access are locked;
 *   built-ins cannot be renamed or deleted.
 * - A member's personal grants, replacing the pre-roles server and cluster
 *   access lists (still served by team.ts as compatible aliases).
 * - The org's default role for new members (invites, SSO).
 * - The access checker and who-has-access, and the caller's own level on
 *   each resource of a type (anyone), so the UI can hide buttons.
 *
 * Reading roles needs Roles & access at `view` (or Members at `operate`, to
 * pick roles for an invite); changing them `manage`. Every write passes the
 * delegation guard (spec §4.2): the actor must hold, at least as long, all a
 * role gives — before and after the change — so nobody grants, takes or
 * edits more than they have. Every change that can take access away
 * snapshots the affected members first and closes what they lost afterwards
 * (revokeAfterChange), and every change is audited with what it was before
 * and after.
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
/** {module: level}; unknown modules are refused, a module left out is `none`. */
const modulePermissionsSchema = z.record(
  z.enum(MODULE_KEYS as [ModuleKey, ...ModuleKey[]]),
  z.enum(MODULE_LEVELS as [ModuleLevel, ...ModuleLevel[]]),
);
const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).nullable().optional(),
  color: colorSchema.nullable().optional(),
  grants: z.array(grantSchema).max(500).optional(),
  modulePermissions: modulePermissionsSchema.optional(),
});
const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    color: colorSchema.nullable().optional(),
    modulePermissions: modulePermissionsSchema.optional(),
  })
  .refine(
    (b) => b.name !== undefined || b.description !== undefined || b.color !== undefined || b.modulePermissions !== undefined,
    { message: 'Nothing to change' },
  );
const cloneRoleSchema = z.object({ name: z.string().trim().min(1).max(60).optional() });
const defaultRoleSchema = z.object({ roleId: z.string().min(1) });

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
    .where(and(eq(roles.id, id), eq(roles.orgId, orgId)))
    .get();
}

/** Owner (everything) and No access (nothing) are what they are by definition. */
function isLocked(row: RoleRow): boolean {
  return row.system === 'owner' || row.system === 'none';
}

/** One of the "<Base> (modules only)" roles migration 0025 made for role-scoped members. */
function isGenerated(row: RoleRow): boolean {
  return row.id.startsWith('modules-only:');
}

/**
 * Module levels as stored: clamped to what each module uses, `none` left out,
 * so two equal sets compare equal.
 */
function normalizeModules(input: Partial<Record<ModuleKey, ModuleLevel>>): ModulePermissions {
  const out: ModulePermissions = {};
  for (const key of MODULE_KEYS) {
    const level = input[key];
    if (level && level !== 'none') out[key] = clampModuleLevel(key, level);
  }
  return out;
}

function sameModules(a: ModulePermissions, b: ModulePermissions): boolean {
  const x = normalizeModules(a);
  const y = normalizeModules(b);
  return MODULE_KEYS.every((key) => x[key] === y[key]);
}

/** A built-in's defaults as a grant list: "All …" at its level on every type. */
function defaultGrantInputs(system: 'admin' | 'operator' | 'viewer'): GrantInput[] {
  const level = BUILT_IN_ROLE_DEFAULTS[system].grantLevel!;
  return RESOURCE_TYPES.map((resourceType) => ({ resourceType, selector: 'all' as const, level }));
}

/** True when a built-in holds exactly its defaults, so "Reset to default" would change nothing. */
function atDefaults(row: RoleRow, grants: RoleGrant[]): boolean {
  if (row.system !== 'admin' && row.system !== 'operator' && row.system !== 'viewer') return true;
  if (!sameModules(parseModulePermissions(row.modulePermissions), BUILT_IN_ROLE_DEFAULTS[row.system].modules)) return false;
  const level = BUILT_IN_ROLE_DEFAULTS[row.system].grantLevel;
  return (
    grants.length === RESOURCE_TYPES.length &&
    RESOURCE_TYPES.every((type) =>
      grants.some((g) => g.resourceType === type && g.selector === 'all' && g.level === level && !g.namespaces && !g.expiresAt),
    )
  );
}

/**
 * What the role gives, as the editor shows it: stored levels, or for a
 * pre-0025 custom role (null) the resource modules its grants turn on.
 */
function modulesOf(orgId: string, row: RoleRow): ModulePermissions {
  if (row.system === 'owner') return BUILT_IN_ROLE_DEFAULTS.owner.modules;
  return normalizeModules(rolePermissions(orgId, row.id)?.modules ?? {});
}

function presentRole(req: FastifyRequest, row: RoleRow, extra: Partial<CustomRole> = {}): CustomRole {
  const grants = extra.grants ?? principalGrants(req.orgId, 'role', row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    system: isBuiltInRole(row.system) ? row.system : null,
    modulePermissions: modulesOf(req.orgId, row),
    editable: !isLocked(row),
    generated: isGenerated(row),
    customized: !atDefaults(row, grants),
    assignable: canAssignRole(req, row.id).ok,
    ...extra,
  };
}

/** Built-ins first, in their order (Owner … No access), then the rest by name. */
function roleOrder(a: RoleRow, b: RoleRow): number {
  const rankOf = (r: RoleRow) => (isBuiltInRole(r.system) ? BUILT_IN_ROLES.indexOf(r.system) : BUILT_IN_ROLES.length);
  return rankOf(a) - rankOf(b) || a.name.localeCompare(b.name);
}

/**
 * Everything in either permission set: what an edit must find the actor
 * holding, since it may take away the one and give the other.
 */
function bothSets(before: PermissionSet, after: PermissionSet): PermissionSet {
  const modules: ModulePermissions = { ...before.modules };
  for (const [key, level] of Object.entries(after.modules ?? {}) as [ModuleKey, ModuleLevel][]) {
    modules[key] = maxModuleLevel(modules[key] ?? 'none', level);
  }
  return { modules, grants: [...(before.grants ?? []), ...(after.grants ?? [])] };
}

/** The grants of a list, as the delegation guard weighs them. */
function wantedGrants(grants: { resourceType: ResourceType; selector: RoleGrant['selector']; resourceId: string | null; tag: string | null; namespaces: string[] | null; level: AccessLevel }[]): PermissionSet['grants'] {
  return grants.map((g) => ({
    resourceType: g.resourceType,
    selector: g.selector,
    resourceId: g.resourceId,
    tag: g.tag,
    namespaces: g.namespaces,
    level: g.level,
  }));
}

/** Sends the delegation guard's refusal (403, saying what is missing); true when it refused. */
function refused(reply: FastifyReply, result: DelegationResult, what: string): boolean {
  if (result.ok) return false;
  reply.status(403).send({ error: `You cannot ${what}: you do not hold ${result.missing.join('; ')}` });
  return true;
}

/** A name for a copy of `name` that no role in the org has and no built-in uses. */
function copyName(orgId: string, name: string): string {
  const taken = new Set(
    getDb()
      .select({ name: roles.name })
      .from(roles)
      .where(eq(roles.orgId, orgId))
      .all()
      .map((r) => r.name.toLowerCase()),
  );
  for (let n = 1; ; n++) {
    const candidate = `${name.slice(0, 50)} copy${n === 1 ? '' : ` ${n}`}`;
    if (!taken.has(candidate.toLowerCase()) && !isReservedRoleName(candidate)) return candidate;
  }
}

/**
 * Roles & access at `view`, or Members at `operate` (whoever invites picks
 * roles from the list). Neither: 404, as for a module that is off.
 */
async function requireRoleList(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
  if (hasModule(req, 'team_roles', 'view') || hasModule(req, 'team_members', 'operate')) return;
  return reply.status(404).send({ error: 'Not found' });
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

  app.get('/roles', { preHandler: requireRoleList }, async (req): Promise<CustomRole[]> => {
    const db = getDb();
    const rows = db.select().from(roles).where(eq(roles.orgId, req.orgId)).all().sort(roleOrder);
    // Members who only invite see names and what they may give, not what roles contain
    if (!hasModule(req, 'team_roles', 'view')) {
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        color: r.color,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        system: isBuiltInRole(r.system) ? r.system : null,
        editable: false,
        generated: isGenerated(r),
        assignable: canAssignRole(req, r.id).ok,
      }));
    }
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
    return rows.map((r) => presentRole(req, r, { memberCount: counts.get(r.id) ?? 0, grants: grants.get(r.id) ?? [] }));
  });

  app.post('/roles', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const body = createRoleSchema.parse(req.body);
    const db = getDb();
    if (isReservedRoleName(body.name)) return reply.status(409).send({ error: `${body.name} is a built-in role name` });
    const taken = db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, req.orgId), eq(roles.name, body.name)))
      .get();
    if (taken) return reply.status(409).send({ error: `A role named ${body.name} already exists` });
    const grantDrafts = drafts(req, reply, body.grants ?? []);
    if (!grantDrafts) return reply;
    // Left out (callers from before module permissions): null, which turns on
    // the resource modules of its grants at view, as roles did then
    const modules = body.modulePermissions ? normalizeModules(body.modulePermissions) : null;
    const delegation = canGrant(req, { modules: modules ?? {}, grants: wantedGrants(grantDrafts) });
    if (refused(reply, delegation, 'create this role')) return reply;
    return createRole(req, reply, {
      name: body.name,
      description: body.description || null,
      color: body.color ?? null,
      modules,
      grantDrafts,
      delegation,
    });
  });

  /** Create a role (after the checks), with its grants; audited. */
  async function createRole(
    req: FastifyRequest,
    reply: FastifyReply,
    role: {
      name: string;
      description: string | null;
      color: string | null;
      modules: ModulePermissions | null;
      grantDrafts: Exclude<ReturnType<typeof drafts>, undefined>;
      delegation: DelegationResult;
      clonedFrom?: { id: string; name: string };
    },
  ) {
    const id = nanoid();
    const now = new Date().toISOString();
    getDb()
      .insert(roles)
      .values({
        id,
        orgId: req.orgId,
        name: role.name,
        description: role.description,
        color: role.color,
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now,
        modulePermissions: role.modules ? JSON.stringify(role.modules) : null,
      })
      .run();
    // A new role has no members, so its grants take nothing from anyone
    if (role.grantDrafts.length) replaceGrants(req.orgId, 'role', id, role.grantDrafts, req.user.id);
    const grants = principalGrants(req.orgId, 'role', id);
    await audit(req, 'role.create', 'role', id, role.name, {
      after: {
        name: role.name,
        description: role.description,
        color: role.color,
        modules: role.modules,
        grants: grantSummary(grants),
      },
      ...(role.clonedFrom && { clonedFrom: role.clonedFrom }),
      delegation: role.delegation,
    });
    return reply
      .status(201)
      .send({ ...presentRole(req, findRole(req.orgId, id)!, { grants }), grants, members: [], memberCount: 0 } satisfies CustomRoleDetail);
  }

  app.get('/roles/:id', { preHandler: requireModule('team_roles', 'view') }, async (req, reply): Promise<CustomRoleDetail> => {
    const { id } = req.params as { id: string };
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    const members = membersOf(req.orgId, id);
    const grants = principalGrants(req.orgId, 'role', id);
    return { ...presentRole(req, row, { grants }), grants, members, memberCount: members.length };
  });

  app.patch('/roles/:id', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateRoleSchema.parse(req.body);
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (isLocked(row)) return reply.status(403).send({ error: `The ${row.name} role is locked` });
    const db = getDb();
    if (body.name !== undefined && body.name !== row.name) {
      if (row.system) return reply.status(400).send({ error: 'Built-in roles keep their names' });
      if (isReservedRoleName(body.name)) return reply.status(409).send({ error: `${body.name} is a built-in role name` });
      const taken = db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, req.orgId), eq(roles.name, body.name), ne(roles.id, id)))
        .get();
      if (taken) return reply.status(409).send({ error: `A role named ${body.name} already exists` });
    }
    const modulesBefore = modulesOf(req.orgId, row);
    const modulesAfter = body.modulePermissions ? normalizeModules(body.modulePermissions) : undefined;
    const modulesChanged = modulesAfter !== undefined && (row.modulePermissions === null || !sameModules(modulesBefore, modulesAfter));
    // Changing what the role gives takes from its members what it drops and
    // gives them what it adds: the actor must hold both
    let delegation: DelegationResult | undefined;
    if (modulesChanged) {
      delegation = canGrant(req, bothSets({ modules: modulesBefore }, { modules: modulesAfter }));
      if (refused(reply, delegation, `change what the ${row.name} role gives`)) return reply;
    }

    const before = { name: row.name, description: row.description, color: row.color };
    const after = {
      name: body.name ?? row.name,
      description: body.description !== undefined ? body.description || null : row.description,
      color: body.color !== undefined ? body.color : row.color,
    };
    const holders = modulesChanged ? memberIdsOf(req.orgId, id) : [];
    const access = modulesChanged ? snapshotAccess(req.orgId, holders) : undefined;
    db.update(roles)
      .set({
        ...after,
        ...(modulesChanged && { modulePermissions: JSON.stringify(modulesAfter) }),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(roles.id, id), eq(roles.orgId, req.orgId)))
      .run();
    if (before.name !== after.name || before.description !== after.description || before.color !== after.color) {
      await audit(req, 'role.update', 'role', id, after.name, { before, after });
    }
    if (modulesChanged) {
      // A resource module turned off parks the role's grants: what members reached through it closes now
      const live = liveSummary(revokeAfterChange(req.orgId, holders, access));
      await audit(req, 'role.modules_change', 'role', id, after.name, {
        before: row.modulePermissions === null ? null : modulesBefore,
        after: modulesAfter,
        members: holders.length,
        delegation,
        ...(live && { live }),
      });
    }
    return presentRole(req, findRole(req.orgId, id)!);
  });

  /** Built-in Admin, Operator or Viewer back to their defaults: modules and "All …" grants. */
  app.post('/roles/:id/reset', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (row.system !== 'admin' && row.system !== 'operator' && row.system !== 'viewer') {
      return reply.status(400).send({ error: 'Only the built-in Admin, Operator and Viewer roles have defaults to reset to' });
    }
    const defaults = BUILT_IN_ROLE_DEFAULTS[row.system];
    const grantDrafts = drafts(req, reply, defaultGrantInputs(row.system));
    if (!grantDrafts) return reply;
    const previous = principalGrants(req.orgId, 'role', id);
    const modulesBefore = modulesOf(req.orgId, row);
    const delegation = canGrant(
      req,
      bothSets({ modules: modulesBefore, grants: wantedGrants(previous) }, { modules: defaults.modules, grants: wantedGrants(grantDrafts) }),
    );
    if (refused(reply, delegation, `reset the ${row.name} role`)) return reply;

    const holders = memberIdsOf(req.orgId, id);
    const before = snapshotAccess(req.orgId, holders);
    getDb()
      .update(roles)
      .set({ modulePermissions: JSON.stringify(normalizeModules(defaults.modules)), description: defaults.description, updatedAt: new Date().toISOString() })
      .where(and(eq(roles.id, id), eq(roles.orgId, req.orgId)))
      .run();
    replaceGrants(req.orgId, 'role', id, grantDrafts, req.user.id);
    const live = liveSummary(revokeAfterChange(req.orgId, holders, before));
    const grants = principalGrants(req.orgId, 'role', id);
    await audit(req, 'role.reset', 'role', id, row.name, {
      before: { description: row.description, modules: modulesBefore, grants: grantSummary(previous) },
      after: { description: defaults.description, modules: normalizeModules(defaults.modules), grants: grantSummary(grants) },
      members: holders.length,
      delegation,
      ...(live && { live }),
    });
    return presentRole(req, findRole(req.orgId, id)!, { grants });
  });

  /** A new custom role with the same modules and resources (and no members). */
  app.post('/roles/:id/clone', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = cloneRoleSchema.parse(req.body ?? {});
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    // Owner reaches everything without grants; a copy would be Admin, so clone that
    if (row.system === 'owner') return reply.status(400).send({ error: 'The Owner role cannot be cloned — clone Admin instead' });
    const name = body.name ?? copyName(req.orgId, row.name);
    if (isReservedRoleName(name)) return reply.status(409).send({ error: `${name} is a built-in role name` });
    const taken = getDb()
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, req.orgId), eq(roles.name, name)))
      .get();
    if (taken) return reply.status(409).send({ error: `A role named ${name} already exists` });
    const grantDrafts = drafts(req, reply, principalGrants(req.orgId, 'role', id));
    if (!grantDrafts) return reply;
    const modules = modulesOf(req.orgId, row);
    const delegation = canGrant(req, { modules, grants: wantedGrants(grantDrafts) });
    if (refused(reply, delegation, `clone the ${row.name} role`)) return reply;
    return createRole(req, reply, {
      name,
      description: row.description,
      color: row.color,
      modules,
      grantDrafts,
      delegation,
      clonedFrom: { id: row.id, name: row.name },
    });
  });

  app.delete('/roles/:id', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (row.system) return reply.status(400).send({ error: 'Built-in roles cannot be deleted' });
    // Deleting takes from its members everything it gives
    const delegation = canGrant(req, rolePermissions(req.orgId, id)!);
    if (refused(reply, delegation, `delete the ${row.name} role`)) return reply;
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
        modules: row.modulePermissions === null ? null : parseModulePermissions(row.modulePermissions),
        grants: grantSummary(grants),
        members: members.map((m) => ({ userId: m.userId, email: m.email, expiresAt: m.expiresAt })),
      },
      ...(requestsCancelled > 0 && { accessRequestsCancelled: requestsCancelled }),
      delegation,
      ...(live && { live }),
    });
    return reply.status(204).send();
  });

  /** Replace a role's resources wholesale; members who lose something have it closed now. */
  app.put('/roles/:id/grants', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = grantsSchema.parse(req.body);
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (isLocked(row)) return reply.status(403).send({ error: `The ${row.name} role is locked` });
    const grantDrafts = drafts(req, reply, body.grants);
    if (!grantDrafts) return reply;
    const previous = principalGrants(req.orgId, 'role', id);
    const delegation = canGrant(req, { grants: [...wantedGrants(previous)!, ...wantedGrants(grantDrafts)!] });
    if (refused(reply, delegation, `change the resources of the ${row.name} role`)) return reply;

    const holders = memberIdsOf(req.orgId, id);
    const before = snapshotAccess(req.orgId, holders);
    replaceGrants(req.orgId, 'role', id, grantDrafts, req.user.id);
    getDb().update(roles).set({ updatedAt: new Date().toISOString() }).where(eq(roles.id, id)).run();
    const live = liveSummary(revokeAfterChange(req.orgId, holders, before));
    const grants = principalGrants(req.orgId, 'role', id);
    await audit(req, 'role.grants_change', 'role', id, row.name, {
      before: grantSummary(previous),
      after: grantSummary(grants),
      members: holders.length,
      delegation,
      ...(live && { live }),
    });
    return { grants };
  });

  /** Add a member to a role, or change how long they hold it. */
  app.post('/roles/:id/members', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
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
    // Changing how long someone holds it gives (or takes) it for that long
    const delegation = canAssignRole(req, id, { expiresAt });
    if (refused(reply, delegation, `give the ${row.name} role`)) return reply;
    // Shortening an Owner's hold on the role could leave the org without one
    if (existing && row.system === 'owner' && expiresAt && otherActiveOwners(req.orgId, body.userId) === 0) {
      return reply.status(400).send({ error: 'The organization must keep at least one owner' });
    }
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
      delegation,
      ...(live && { live }),
    });
    return reply.status(existing ? 200 : 201).send({ members: membersOf(req.orgId, id) });
  });

  async function removeRoleMember(req: FastifyRequest, reply: FastifyReply, id: string, userId: string) {
    const row = findRole(req.orgId, id);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (userId === req.user.id) return reply.status(400).send({ error: 'You cannot change your own access' });
    const db = getDb();
    const where = and(eq(roleMembers.roleId, id), eq(roleMembers.userId, userId), eq(roleMembers.orgId, req.orgId));
    const existing = db.select().from(roleMembers).where(where).get();
    if (!existing) return reply.status(404).send({ error: 'Not a member of this role' });
    // Taking a role away needs what giving it needs
    const delegation = canAssignRole(req, id);
    if (refused(reply, delegation, `take the ${row.name} role away`)) return reply;
    if (row.system === 'owner' && otherActiveOwners(req.orgId, userId) === 0) {
      return reply.status(400).send({ error: 'The organization must keep at least one owner' });
    }
    const before = snapshotAccess(req.orgId, [userId]);
    db.delete(roleMembers).where(where).run();
    // Terminals, file sessions and streams on what only this role gave close now
    const live = liveSummary(revokeAfterChange(req.orgId, [userId], before));
    await audit(req, 'role.member_remove', 'role', id, row.name, {
      userId,
      email: db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email,
      before: { expiresAt: existing.expiresAt },
      after: null,
      delegation,
      ...(live && { live }),
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

  /** Replace a member's personal grants wholesale (any type, level, selector, expiry). */
  app.put('/members/:userId/grants', { preHandler: requireModule('team_roles', 'manage') }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = grantsSchema.parse(req.body);
    if (userId === req.user.id) return reply.status(400).send({ error: 'You cannot change your own access' });
    const member = memberRow(req.orgId, userId);
    if (!member) return reply.status(404).send({ error: 'Not a member of this organization' });
    if (isOrgOwner(req.orgId, userId)) {
      return reply.status(400).send({ error: 'Owners always have manage access to everything' });
    }
    const grantDrafts = drafts(req, reply, body.grants);
    if (!grantDrafts) return reply;
    // Replacing the list takes the old grants away and gives the new ones: the actor must hold both
    const previous = principalGrants(req.orgId, 'user', userId);
    const delegation = canGrant(req, { grants: [...wantedGrants(previous)!, ...wantedGrants(grantDrafts)!] });
    if (refused(reply, delegation, `change ${member.email}'s personal grants`)) return reply;

    const before = snapshotAccess(req.orgId, [userId]);
    replaceGrants(req.orgId, 'user', userId, grantDrafts, req.user.id);
    const live = liveSummary(revokeAfterChange(req.orgId, [userId], before));
    const grants = principalGrants(req.orgId, 'user', userId);
    await audit(req, 'member.grants_change', 'member', userId, member.email, {
      before: grantSummary(previous),
      after: grantSummary(grants),
      delegation,
      ...(live && { live }),
    });
    return { grants };
  });

  // ── The org's default role ──────────────────────────────────────────────────

  /** The role new members get when none is picked: for the invite and SSO forms. */
  app.get('/default-role', { preHandler: requireRoleList }, async (req): Promise<DefaultRole> => {
    const roleId = defaultRoleId(req.orgId);
    return { roleId, name: findRole(req.orgId, roleId)?.name ?? '' };
  });

  /** Organization settings: any role but Owner that the actor could give themselves. */
  app.put('/default-role', { preHandler: requireModule('settings', 'manage') }, async (req, reply) => {
    const { roleId } = defaultRoleSchema.parse(req.body);
    const row = findRole(req.orgId, roleId);
    if (!row) return reply.status(404).send({ error: 'Role not found' });
    if (row.system === 'owner') return reply.status(400).send({ error: 'Owner cannot be the default role' });
    // Every invite and SSO account without a pick gets it: as giving it to each of them
    const delegation = canAssignRole(req, roleId);
    if (refused(reply, delegation, `make ${row.name} the default role`)) return reply;
    const previous = defaultRoleId(req.orgId);
    if (previous !== roleId) {
      getDb()
        .update(organizations)
        .set({ defaultRoleId: roleId, updatedAt: new Date().toISOString() })
        .where(eq(organizations.id, req.orgId))
        .run();
      await audit(req, 'org.default_role_change', 'organization', req.orgId, undefined, {
        before: { roleId: previous, name: findRole(req.orgId, previous)?.name ?? null },
        after: { roleId, name: row.name },
        delegation,
      });
    }
    return { roleId, name: row.name } satisfies DefaultRole;
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
        role: member.role,
        scope: scopeOf(member.role, member.scope),
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
