import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, count, eq, isNull, notLike, or, type SQL } from 'drizzle-orm';
import {
  BUILT_IN_ROLE_DEFAULTS,
  MODULES,
  MODULES_ONLY_DEFAULTS,
  RESOURCE_TYPES,
  type AccessLevel,
  type MeAccess,
  type ModuleAccess,
  type ModuleKey,
  type ModuleLevel,
  type PermissionSet,
  type ResourceType,
} from '@smt/shared';
import { getDb } from '../../db/index.js';
import { cronJobs, roleMembers, roles, savedCommands, servers } from '../../db/schema.js';
import { contributionsFor } from './authorize.js';
import { accessibleFilter, accessibleIds, reachesAny, RESOURCE_TABLES } from './filter.js';
import { clampModuleLevel, meetsLevel, meetsModuleLevel, moduleDefinition, parseModulePermissions, TYPE_MODULES } from './levels.js';
import { activeAt, resolveAccess, type AccessSubject, type Contribution, type ResolvedAccess } from './resolve.js';
import { principalGrants } from './grants.js';

/**
 * Module permissions (unified roles spec §3, §4): what a member may use of
 * each feature, the visibility rule that hides a module they have nothing
 * in, owner-only actions, and the delegation guard that keeps anyone from
 * granting more than they hold. Resource checks stay in authorize.ts; a
 * route usually needs both — the module, then the item.
 */

/** The subject's level on a module (the union of their roles), capped at `view` for read-only tokens. */
export function moduleLevel(who: AccessSubject, module: ModuleKey): ModuleLevel {
  const access = resolveAccess(who);
  return access.active ? access.modules[module] : 'none';
}

/** True when the subject holds `module` at `level` or above. */
export function hasModule(who: AccessSubject, module: ModuleKey, level: Exclude<ModuleLevel, 'none'> = 'view'): boolean {
  // A level the module does not use counts as its highest, as for roles
  return meetsModuleLevel(moduleLevel(who, module), clampModuleLevel(module, level));
}

/**
 * preHandler gate: `{ preHandler: requireModule('audit', 'view') }`. Must run
 * after `requireAuth`. A module the caller has off (or is hidden for them —
 * nothing in it, spec §3.1) answers 404 as if it were not there; one they
 * have at a lower level answers 403.
 */
export function requireModule(module: ModuleKey, level: Exclude<ModuleLevel, 'none'> = 'view') {
  return async function moduleGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
    const held = moduleLevel(req, module);
    if (held === 'none' || !moduleVisible(resolveAccess(req), module)) return reply.status(404).send({ error: 'Not found' });
    if (!hasModule(req, module, level)) {
      return reply.status(403).send({
        error: `This needs ${clampModuleLevel(module, level)} access to ${moduleDefinition(module).label} (you have ${held})`,
      });
    }
  };
}

/** True when the subject holds the Owner role (spec §4.3). Read-only tokens never act as owners. */
export function isOwner(who: AccessSubject): boolean {
  const access = resolveAccess(who);
  return access.active && access.owner && !access.readOnly;
}

/**
 * True when `userId` holds the Owner role in `orgId` now, for checks made
 * before there is a request (sign-in, SSO enforcement, last-owner counts).
 */
export function isOrgOwner(orgId: string, userId: string): boolean {
  return !!getDb()
    .select({ roleId: roleMembers.roleId })
    .from(roleMembers)
    .innerJoin(roles, eq(roles.id, roleMembers.roleId))
    .where(
      and(
        eq(roleMembers.orgId, orgId),
        eq(roleMembers.userId, userId),
        eq(roles.orgId, orgId),
        eq(roles.system, 'owner'),
        activeAt(roleMembers.expiresAt, new Date().toISOString()),
      ),
    )
    .get();
}

/**
 * preHandler gate for owner-only actions (spec §4.3): transferring or
 * assigning Owner, removing an Owner, deleting the org, database backups,
 * instance-wide settings, the Owner role itself.
 */
export function requireOwner() {
  return async function ownerGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
    if (!isOwner(req)) return reply.status(403).send({ error: 'Only an owner can do this' });
  };
}

/** The resource types whose items make a resource module worth showing. */
const MODULE_TYPES: Partial<Record<ModuleKey, ResourceType>> = Object.fromEntries(
  MODULES.filter((m) => m.resourceType).map((m) => [m.key, m.resourceType!]),
);

/**
 * True when the subject sees at least one item of `type` — one cheap EXISTS.
 * Saved commands and cron jobs also follow their servers (auth/command-access.ts).
 */
function seesAnyItem(access: ResolvedAccess, type: ResourceType): boolean {
  const who = { orgId: access.orgId, userId: access.userId };
  if (type === 'saved_command') {
    const server = accessibleFilter(who, 'server', savedCommands.serverId);
    return !!getDb()
      .select({ id: savedCommands.id })
      .from(savedCommands)
      .where(
        and(
          eq(savedCommands.orgId, access.orgId),
          accessibleFilter(who, 'saved_command', savedCommands.id),
          server ? or(isNull(savedCommands.serverId), server) : undefined,
        ),
      )
      .limit(1)
      .get();
  }
  if (type === 'cron_job') {
    return !!getDb()
      .select({ id: cronJobs.id })
      .from(cronJobs)
      .where(
        and(
          eq(cronJobs.orgId, access.orgId),
          accessibleFilter(who, 'cron_job', cronJobs.id),
          accessibleFilter(who, 'server', cronJobs.serverId),
        ),
      )
      .limit(1)
      .get();
  }
  return reachesAny(who, type, 'view');
}

/**
 * The visibility rule (spec §3.1): a module is shown when some role has it
 * on, and — for a resource module — the member sees at least one item in it
 * or may create items there (`manage`). Memoized with the request's access.
 */
function moduleVisible(access: ResolvedAccess, module: ModuleKey): boolean {
  if (!access.active || access.modules[module] === 'none') return false;
  const type = MODULE_TYPES[module];
  if (!type || access.modules[module] === 'manage') return true;
  const key = `visible:${module}`;
  const cached = access.memo.get(key) as boolean | undefined;
  if (cached !== undefined) return cached;
  const visible = seesAnyItem(access, type);
  access.memo.set(key, visible);
  return visible;
}

/** The modules to show the subject, with their level there (`GET /api/me/modules`). */
export function visibleModules(who: AccessSubject): ModuleAccess[] {
  const access = resolveAccess(who);
  return MODULES.filter((m) => moduleVisible(access, m.key)).map((m) => ({
    module: m.key,
    level: access.modules[m.key] as ModuleAccess['level'],
  }));
}

/** What the subject holds and may do, for the web (`GET /api/me/access`). */
export function accessSummary(who: AccessSubject): MeAccess {
  const access = resolveAccess(who);
  const visible = visibleModules(who).map((m) => m.module);
  const resources = Object.fromEntries(
    RESOURCE_TYPES.map((type) => {
      const ids = accessibleIds(who, type);
      return [type, ids.all ? { all: true, count: countOf(access.orgId, type) } : { all: false, count: ids.ids.length }];
    }),
  ) as MeAccess['resources'];
  return {
    owner: isOwner(who),
    noAccess: visible.length === 0,
    readOnly: access.readOnly,
    roles: access.roles.map((r) => ({ id: r.id, name: r.name, system: r.system, color: r.color, expiresAt: r.expiresAt })),
    modules: { ...access.modules },
    visible,
    resources,
  };
}

/** How many resources of `type` the org has (for a member who reaches all of them). */
function countOf(orgId: string, type: ResourceType): number {
  const { table, orgId: orgColumn } = RESOURCE_TABLES[type];
  return getDb().select({ n: count() }).from(table).where(eq(orgColumn, orgId)).get()?.n ?? 0;
}

// ── Delegation guard (spec §4.2) ──────────────────────────────────────────────

/** A grant the actor wants to give, as `canGrant` weighs it. */
type WantedGrant = NonNullable<PermissionSet['grants']>[number];

/** The delegation guard's answer: allowed, or what the actor lacks (for the 403 and the audit row). */
export interface DelegationResult {
  ok: boolean;
  /** What the actor does not hold, in plain words. */
  missing: string[];
}

/** True when contributions at `level` cover every namespace of `wanted` (null = all of them). */
function coversNamespaces(list: Contribution[], level: AccessLevel, wanted: string[] | null | undefined): boolean {
  const enough = list.filter((c) => meetsLevel(c.level, level));
  if (enough.some((c) => c.namespaces === null)) return true;
  // An empty list covers nothing, so it is never "within" anything either
  if (wanted == null || wanted.length === 0) return false;
  return wanted.every((ns) => enough.some((c) => c.namespaces!.includes(ns)));
}

/** A server's tags in the org (none when it is not there, or unreadable). */
function tagsOf(orgId: string, serverId: string): string[] {
  const row = getDb()
    .select({ tags: servers.tags })
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.orgId, orgId)))
    .get();
  try {
    const tags: unknown = JSON.parse(row?.tags ?? '[]');
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Does the actor hold `grant` themselves? A specific item is covered by
 * anything reaching it (the item, a tag it carries now, or "all"); a tag
 * only by that tag or "all"; "all" only by "all" — specific id ⊆ tag ⊆ all.
 * Clusters: every namespace asked for must be covered (null = all of them).
 */
function holdsGrant(access: ResolvedAccess, grant: WantedGrant): boolean {
  const typeAccess = access.types[grant.resourceType];
  let found: Contribution[];
  if (grant.selector === 'all') found = typeAccess.every;
  else if (grant.selector === 'tag') found = [...typeAccess.every, ...(grant.tag ? typeAccess.byTag.get(grant.tag) ?? [] : [])];
  else if (grant.resourceId) {
    const tags = grant.resourceType === 'server' ? tagsOf(access.orgId, grant.resourceId) : [];
    found = contributionsFor(access, grant.resourceType, grant.resourceId, tags);
  } else found = [];
  // A read-only token holds nothing above `view`
  const held = access.readOnly ? found.map((c) => ({ ...c, level: 'view' as const })) : found;
  return coversNamespaces(held, grant.level, grant.namespaces);
}

function describeGrant(grant: WantedGrant): string {
  const target = grant.selector === 'all' ? `all ${grant.resourceType}s` : grant.selector === 'tag' ? `${grant.resourceType}s tagged ${grant.tag}` : `${grant.resourceType} ${grant.resourceId}`;
  const ns = grant.namespaces?.length ? ` (namespaces ${grant.namespaces.join(', ')})` : '';
  return `${target}${ns}: ${grant.level}`;
}

/**
 * The delegation guard core (spec §4.2): may the actor give `wanted` — when
 * assigning or editing a role, granting, approving a request, inviting with
 * roles? Only what they hold themselves, at the same or a higher level, per
 * module and per resource selector. Owners may give anything (the Owner role
 * itself is owner-only: `canAssignRole`). Says what is missing when refused.
 */
export function canGrant(actor: AccessSubject, wanted: PermissionSet): DelegationResult {
  const access = resolveAccess(actor);
  if (!access.active) return { ok: false, missing: ['an active membership'] };
  if (access.owner && !access.readOnly) return { ok: true, missing: [] };
  const missing: string[] = [];
  for (const [key, level] of Object.entries(wanted.modules ?? {}) as [ModuleKey, ModuleLevel][]) {
    if (level === 'none') continue;
    const asked = clampModuleLevel(key, level);
    if (!meetsModuleLevel(access.modules[key], asked)) missing.push(`${moduleDefinition(key).label}: ${asked}`);
  }
  for (const grant of wanted.grants ?? []) {
    if (!holdsGrant(access, grant)) missing.push(describeGrant(grant));
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Everything holding role `roleId` gives: its module levels and its grants in
 * force. A custom role from before module permissions (null) gives the
 * resource modules of its grants at `view`, as resolve.ts counts it.
 */
export function rolePermissions(orgId: string, roleId: string): PermissionSet | undefined {
  const row = getDb()
    .select({ modulePermissions: roles.modulePermissions })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.orgId, orgId)))
    .get();
  if (!row) return undefined;
  const grants = principalGrants(orgId, 'role', roleId);
  const modules = parseModulePermissions(row.modulePermissions);
  if (row.modulePermissions === null) {
    for (const g of grants) {
      modules[TYPE_MODULES[g.resourceType]] = 'view';
      if (g.resourceType === 'server') modules.containers = 'view';
    }
  }
  return {
    modules,
    grants: grants.map((g) => ({
      resourceType: g.resourceType,
      selector: g.selector,
      resourceId: g.resourceId,
      tag: g.tag,
      namespaces: g.namespaces,
      level: g.level,
    })),
  };
}

/**
 * May the actor give `roleId` to someone (or take it away, which needs the
 * same)? The Owner role only by owners (spec §4.3); any other role only when
 * the actor holds everything it gives (`canGrant`).
 */
export function canAssignRole(actor: AccessSubject, roleId: string): DelegationResult {
  const access = resolveAccess(actor);
  const role = getDb()
    .select({ system: roles.system, name: roles.name })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.orgId, access.orgId)))
    .get();
  if (!role) return { ok: false, missing: ['the role'] };
  if (role.system === 'owner') return isOwner(actor) ? { ok: true, missing: [] } : { ok: false, missing: ['the Owner role'] };
  return canGrant(actor, rolePermissions(access.orgId, roleId)!);
}

// ── Built-in and generated roles in the pre-0025 role routes ─────────────────

/**
 * Names the built-in roles and the generated "<Base> (modules only)" roles
 * use; no custom role may take one (migration 0025 renamed any that had).
 */
export const RESERVED_ROLE_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(BUILT_IN_ROLE_DEFAULTS).map((d) => d.name),
  ...Object.values(MODULES_ONLY_DEFAULTS).map((d) => d.name),
]);

/**
 * WHERE fragment for custom roles only: not built-in, not generated by
 * migration 0025 for role-scoped members. The custom-role routes, held-role
 * lists and access requests keep to these until they handle every role:
 * built-ins (and those generated roles) are given through a member's base
 * role and scope, which the 0025 triggers turn into them — so the Owner role
 * is never assigned, requested or edited from there.
 */
export function customRoleFilter(): SQL {
  return and(isNull(roles.system), notLike(roles.id, 'modules-only:%'))!;
}
