import type { FastifyRequest } from 'fastify';
import { and, eq, gt, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  BUILT_IN_ROLES,
  RESOURCE_TYPES,
  type AccessLevel,
  type AccessReason,
  type BuiltInRole,
  type ModuleKey,
  type ModuleLevel,
  type ResourceType,
  type Role,
} from '@smt/shared';
import { getDb } from '../../db/index.js';
import { memberships, resourceGrants, roleMembers, roles } from '../../db/schema.js';
import {
  allModules,
  isAccessLevel,
  isResourceType,
  legacyRoleFor,
  levelRank,
  maxModuleLevel,
  meetsModuleLevel,
  noModules,
  parseModulePermissions,
  TYPE_MODULES,
} from './levels.js';

/**
 * Everything one member may use, loaded once: their membership (status), the
 * roles they hold right now, and every grant in force for them or those
 * roles — three small queries. The rest of the engine (authorize, filter,
 * explain, revoke, modules) answers from this.
 *
 * Unified roles (spec §2, §4.1): a member's access is the union of the roles
 * they hold — built-in (Owner, Admin, Operator, Viewer, No access) or custom
 * — and their personal grants. Module levels are the highest any role gives.
 * A role's grants count only while that role has the grants' resource module
 * on; with it at `none` they are parked (§10.4). Personal grants count while
 * any held role has the module on. The Owner role is locked and reaches
 * everything. Levels never exceed `manage`. Expired role memberships and
 * grants stop counting at once; the expiry sweep (auth/access-grants.ts)
 * deletes them later. memberships.role and scope are not read (migration
 * 0025 turned them into roles).
 *
 * Results are memoized per request (a real request object, for a second at
 * most, so a long-lived WebSocket request does not keep a stale answer).
 * Nothing is cached across requests, so a change applies on the next one.
 */

/** Who is asking. A FastifyRequest after `requireAuth` works as-is. */
export type AccessSubject =
  | (Pick<FastifyRequest, 'orgId' | 'user'> & Partial<Pick<FastifyRequest, 'apiTokenReadOnly'>>)
  | { orgId: string; userId: string; role?: string };

export interface Subject {
  orgId: string;
  userId: string;
  /** A read-only API token: every level is capped at `view` (spec §2.7). */
  readOnly: boolean;
}

export function subjectOf(who: AccessSubject): Subject {
  if ('userId' in who) return { orgId: who.orgId, userId: who.userId, readOnly: false };
  return { orgId: who.orgId, userId: who.user.id, readOnly: who.apiTokenReadOnly === true };
}

/** One way a member reaches resources: the level, why, and (clusters) which namespaces. */
export interface Contribution {
  level: AccessLevel;
  reason: AccessReason;
  /** Clusters only; null = every namespace. */
  namespaces: string[] | null;
}

/** What reaches the resources of one type: every one of them, some by id, servers by tag. */
export interface TypeAccess {
  every: Contribution[];
  byId: Map<string, Contribution[]>;
  byTag: Map<string, Contribution[]>;
}

/** A role the member holds right now. */
export interface HeldRoleInfo {
  id: string;
  name: string;
  /** The built-in role it is, if any. */
  system: BuiltInRole | null;
  color: string | null;
  /** When the membership ends; null = permanent. */
  expiresAt: string | null;
}

export interface ResolvedAccess {
  orgId: string;
  userId: string;
  /** False when there is no active membership: no access to anything. */
  active: boolean;
  /** Holds the Owner role: everything, and the owner-only actions (spec §4.3). */
  owner: boolean;
  /**
   * @deprecated The base role these module levels amount to (`legacyRoleFor`),
   * for gates not yet moved to module checks. Not capped for read-only tokens.
   */
  role: Role;
  /** @deprecated Owner or admin as `role` counts them. */
  orgAdmin: boolean;
  readOnly: boolean;
  roles: HeldRoleInfo[];
  /** The union of the roles' module levels, capped at `view` for read-only tokens. */
  modules: Record<ModuleKey, ModuleLevel>;
  /**
   * Each held role's module levels and when the membership ends (null =
   * permanent), not capped: what the delegation guard weighs, so a role held
   * for a while never lets anyone give it, or what it holds, for longer.
   */
  roleModules: { expiresAt: string | null; modules: Partial<Record<ModuleKey, ModuleLevel>> }[];
  types: Record<ResourceType, TypeAccess>;
  /** Per-type id lists worked out from `types` (filter.ts), kept with the rest of the request's answer. */
  memo: Map<string, unknown>;
}

const MEMO_TTL_MS = 1_000;
const memo = new WeakMap<object, { at: number; access: ResolvedAccess }>();

/** Only real requests are memoized; a plain `{ orgId, userId }` is looked up afresh every time. */
function isRequest(who: AccessSubject): who is FastifyRequest {
  return 'user' in who && typeof (who as { raw?: unknown }).raw === 'object';
}

/** WHERE fragment for an expiry column still in force at `now` (ISO strings compare as text). */
export function activeAt(column: SQLiteColumn, now: string): SQL {
  return or(isNull(column), gt(column, now))!;
}

export function emptyTypes(): Record<ResourceType, TypeAccess> {
  return Object.fromEntries(
    RESOURCE_TYPES.map((type) => [type, { every: [], byId: new Map(), byTag: new Map() }]),
  ) as unknown as Record<ResourceType, TypeAccess>;
}

function push<K>(map: Map<K, Contribution[]>, key: K, contribution: Contribution) {
  const list = map.get(key);
  if (list) list.push(contribution);
  else map.set(key, [contribution]);
}

/** Parse a grant's namespaces. Undefined when unreadable: such a grant counts for nothing. */
function parseNamespaces(raw: string | null): string[] | null | undefined {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((ns) => typeof ns === 'string')) return value as string[];
  } catch {
    /* fall through */
  }
  return undefined;
}

function isBuiltIn(value: string | null): value is BuiltInRole {
  return value !== null && (BUILT_IN_ROLES as readonly string[]).includes(value);
}

/** Module levels capped at `view`, for read-only tokens. */
function capped(modules: Record<ModuleKey, ModuleLevel>): Record<ModuleKey, ModuleLevel> {
  return Object.fromEntries(
    Object.entries(modules).map(([key, level]) => [key, level === 'none' ? 'none' : 'view']),
  ) as Record<ModuleKey, ModuleLevel>;
}

function load(subject: Subject, now: string): ResolvedAccess {
  const { orgId, userId, readOnly } = subject;
  const db = getDb();
  const access: ResolvedAccess = {
    orgId,
    userId,
    active: false,
    owner: false,
    role: 'viewer',
    orgAdmin: false,
    readOnly,
    roles: [],
    modules: noModules(),
    roleModules: [],
    types: emptyTypes(),
    memo: new Map(),
  };

  const membership = db
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .get();
  if (!membership || membership.status !== 'active') return access;
  access.active = true;

  const held = db
    .select({
      roleId: roleMembers.roleId,
      name: roles.name,
      system: roles.system,
      color: roles.color,
      modulePermissions: roles.modulePermissions,
      expiresAt: roleMembers.expiresAt,
    })
    .from(roleMembers)
    .innerJoin(roles, eq(roles.id, roleMembers.roleId))
    .where(
      and(
        eq(roleMembers.orgId, orgId),
        eq(roleMembers.userId, userId),
        eq(roles.orgId, orgId),
        activeAt(roleMembers.expiresAt, now),
      ),
    )
    .all();
  access.roles = held.map((r) => ({
    id: r.roleId,
    name: r.name,
    system: isBuiltIn(r.system) ? r.system : null,
    color: r.color,
    expiresAt: r.expiresAt,
  }));

  // The Owner role is locked: every module, every resource, whatever else is held
  const ownerRole = held.find((r) => r.system === 'owner');
  if (ownerRole) {
    access.owner = true;
    access.role = 'owner';
    access.orgAdmin = true;
    access.modules = readOnly ? capped(allModules()) : allModules();
    access.roleModules = [{ expiresAt: ownerRole.expiresAt, modules: allModules() }];
    for (const type of RESOURCE_TYPES) {
      const reason: AccessReason = { kind: 'base', name: 'owner', level: 'manage' };
      if (ownerRole.expiresAt) reason.expiresAt = ownerRole.expiresAt;
      access.types[type].every.push({ level: 'manage', reason, namespaces: null });
    }
    return access;
  }

  const heldById = new Map(held.map((r) => [r.roleId, { ...r, modules: parseModulePermissions(r.modulePermissions) }]));
  const grants = db
    .select({
      id: resourceGrants.id,
      principalType: resourceGrants.principalType,
      principalId: resourceGrants.principalId,
      resourceType: resourceGrants.resourceType,
      selector: resourceGrants.selector,
      resourceId: resourceGrants.resourceId,
      tag: resourceGrants.tag,
      namespaces: resourceGrants.namespaces,
      level: resourceGrants.level,
      expiresAt: resourceGrants.expiresAt,
    })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.orgId, orgId),
        or(
          and(eq(resourceGrants.principalType, 'user'), eq(resourceGrants.principalId, userId)),
          held.length
            ? and(eq(resourceGrants.principalType, 'role'), inArray(resourceGrants.principalId, [...heldById.keys()]))
            : undefined,
        ),
        activeAt(resourceGrants.expiresAt, now),
      ),
    )
    .all();

  // A custom role from before module permissions existed (null) turns on, at
  // `view`, the resource modules of the types it has grants for: what it did then
  for (const grant of grants) {
    if (grant.principalType !== 'role' || !isResourceType(grant.resourceType)) continue;
    const role = heldById.get(grant.principalId);
    if (!role || role.modulePermissions !== null) continue;
    const module = TYPE_MODULES[grant.resourceType];
    role.modules[module] = maxModuleLevel(role.modules[module] ?? 'none', 'view');
    if (module === 'servers') role.modules.containers = maxModuleLevel(role.modules.containers ?? 'none', 'view');
  }

  const modules = noModules();
  for (const role of heldById.values()) {
    for (const [key, level] of Object.entries(role.modules) as [ModuleKey, ModuleLevel][]) {
      modules[key] = maxModuleLevel(modules[key], level);
    }
  }
  access.roleModules = [...heldById.values()].map((r) => ({ expiresAt: r.expiresAt, modules: r.modules }));
  access.role = legacyRoleFor(modules);
  access.orgAdmin = access.role === 'admin';
  access.modules = readOnly ? capped(modules) : modules;

  for (const grant of grants) {
    // Anything malformed counts for nothing rather than for too much
    if (!isResourceType(grant.resourceType) || !isAccessLevel(grant.level)) continue;
    const type = grant.resourceType;
    const namespaces = type === 'cluster' ? parseNamespaces(grant.namespaces) : null;
    if (namespaces === undefined) continue;

    let reason: AccessReason;
    if (grant.principalType === 'role') {
      const viaRole = heldById.get(grant.principalId);
      // Parked: the role has this resource module off
      if (!viaRole || !meetsModuleLevel(viaRole.modules[TYPE_MODULES[type]], 'view')) continue;
      // The earlier of the membership's and the grant's expiry is when this ends
      const ends = [viaRole.expiresAt, grant.expiresAt].filter((e): e is string => e !== null).sort()[0] ?? null;
      if (isBuiltIn(viaRole.system) && grant.selector === 'all') {
        // A built-in role's "All …" grant is what the base role gave before, and reads as it did
        const base: AccessReason = { kind: 'base', name: viaRole.system, level: grant.level };
        if (ends) base.expiresAt = ends;
        access.types[type].every.push({ level: grant.level, reason: base, namespaces });
        continue;
      }
      reason = { kind: 'role', name: viaRole.name, roleId: viaRole.roleId, level: grant.level, expiresAt: ends };
    } else if (grant.principalType === 'user') {
      if (!meetsModuleLevel(modules[TYPE_MODULES[type]], 'view')) continue;
      reason = { kind: 'grant', name: 'personal', grantId: grant.id, level: grant.level, expiresAt: grant.expiresAt };
    } else {
      continue;
    }
    reason.selector = grant.selector as AccessReason['selector'];
    if (type === 'cluster') reason.namespaces = namespaces;

    const contribution: Contribution = { level: grant.level, reason, namespaces };
    if (grant.selector === 'all') {
      access.types[type].every.push(contribution);
    } else if (grant.selector === 'id' && grant.resourceId) {
      push(access.types[type].byId, grant.resourceId, contribution);
    } else if (grant.selector === 'tag' && type === 'server' && grant.tag) {
      reason.tag = grant.tag;
      push(access.types[type].byTag, grant.tag, contribution);
    }
  }
  return access;
}

/** The subject's access, memoized for the request (see the module comment). */
export function resolveAccess(who: AccessSubject, now: string = new Date().toISOString()): ResolvedAccess {
  if (!isRequest(who)) return load(subjectOf(who), now);
  const hit = memo.get(who);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.access;
  const access = load(subjectOf(who), now);
  memo.set(who, { at: Date.now(), access });
  return access;
}

/** Drop a request's memoized access — after it changed the caller's own access. */
export function forgetAccess(req: object): void {
  memo.delete(req);
}

/**
 * What a contribution gives on a resource as a whole. A cluster grant narrowed
 * to some namespaces gives its level in those namespaces only (ask with a
 * namespace); on the cluster as a whole — cordoning nodes, its settings, the
 * Kubernetes matrix read for the cluster — it makes the cluster visible and no
 * more, so a namespace-narrowed `manage` never becomes `manage` everywhere.
 */
export function wholeResource(c: Contribution): Contribution {
  return c.namespaces !== null && c.level !== 'view' ? { ...c, level: 'view' } : c;
}

/** The highest level among `contributions`, capped at `view` for read-only tokens. Null when there are none. */
export function topLevel(access: ResolvedAccess, contributions: Contribution[]): AccessLevel | null {
  let best: AccessLevel | null = null;
  for (const c of contributions) {
    if (best === null || levelRank(c.level) > levelRank(best)) best = c.level;
  }
  return best && access.readOnly ? 'view' : best;
}
