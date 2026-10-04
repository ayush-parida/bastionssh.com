import type { FastifyRequest } from 'fastify';
import { and, eq, gt, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  RESOURCE_TYPES,
  type AccessLevel,
  type AccessReason,
  type MemberScope,
  type ResourceType,
  type Role,
} from '@smt/shared';
import { getDb } from '../../db/index.js';
import { memberships, resourceGrants, roleMembers, roles } from '../../db/schema.js';
import { baseLevel, isAccessLevel, isResourceType, levelRank } from './levels.js';

/**
 * Everything one member may use, loaded once: their membership (base role,
 * scope, status), the custom roles they hold right now, and every grant in
 * force for them or those roles — three small queries. The rest of the
 * engine (authorize, filter, explain, revoke) answers from this.
 *
 * Owners and admins get `manage` on every resource, whatever their scope.
 * Anyone else gets their base role's level on every resource when their
 * scope is `all`, and nothing by default when it is `roles` (spec §8.1).
 * Roles and personal grants add levels on top, never above `manage`.
 * Expired role memberships and grants stop counting at once; the expiry
 * sweep (auth/access-grants.ts) deletes them later.
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
  /** A read-only API token: every level is capped at `view` (spec §2.9). */
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

export interface ResolvedAccess {
  orgId: string;
  userId: string;
  /** False when there is no active membership: no access to anything. */
  active: boolean;
  role: Role;
  scope: MemberScope;
  /** Owner or admin: `manage` everywhere. */
  orgAdmin: boolean;
  readOnly: boolean;
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

const ROLE_NAMES: readonly Role[] = ['viewer', 'operator', 'admin', 'owner'];

function emptyTypes(): Record<ResourceType, TypeAccess> {
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

function load(subject: Subject, now: string): ResolvedAccess {
  const { orgId, userId, readOnly } = subject;
  const db = getDb();
  const access: ResolvedAccess = {
    orgId,
    userId,
    active: false,
    role: 'viewer',
    scope: 'roles',
    orgAdmin: false,
    readOnly,
    types: emptyTypes(),
    memo: new Map(),
  };

  const membership = db
    .select({ role: memberships.role, status: memberships.status, scope: memberships.scope })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .get();
  if (!membership || membership.status !== 'active') return access;

  const role = (ROLE_NAMES as readonly string[]).includes(membership.role) ? (membership.role as Role) : 'viewer';
  access.active = true;
  access.role = role;
  access.orgAdmin = role === 'owner' || role === 'admin';
  // Anything but an explicit `roles` is the default, as before roles existed
  access.scope = membership.scope === 'roles' && !access.orgAdmin ? 'roles' : 'all';

  if (access.scope === 'all') {
    const level = baseLevel(role);
    for (const type of RESOURCE_TYPES) {
      access.types[type].every.push({ level, reason: { kind: 'base', name: role, level }, namespaces: null });
    }
  }
  // Nothing a role or grant gives can exceed what admins already have
  if (access.orgAdmin) return access;

  const held = db
    .select({ roleId: roleMembers.roleId, name: roles.name, expiresAt: roleMembers.expiresAt })
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
  const heldById = new Map(held.map((r) => [r.roleId, r]));

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

  for (const grant of grants) {
    // Anything malformed counts for nothing rather than for too much
    if (!isResourceType(grant.resourceType) || !isAccessLevel(grant.level)) continue;
    const type = grant.resourceType;
    const namespaces = type === 'cluster' ? parseNamespaces(grant.namespaces) : null;
    if (namespaces === undefined) continue;

    let reason: AccessReason;
    if (grant.principalType === 'role') {
      const viaRole = heldById.get(grant.principalId);
      if (!viaRole) continue;
      // The earlier of the membership's and the grant's expiry is when this ends
      const ends = [viaRole.expiresAt, grant.expiresAt].filter((e): e is string => e !== null).sort()[0] ?? null;
      reason = { kind: 'role', name: viaRole.name, roleId: viaRole.roleId, level: grant.level, expiresAt: ends };
    } else if (grant.principalType === 'user') {
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

/** The highest level among `contributions`, capped at `view` for read-only tokens. Null when there are none. */
export function topLevel(access: ResolvedAccess, contributions: Contribution[]): AccessLevel | null {
  let best: AccessLevel | null = null;
  for (const c of contributions) {
    if (best === null || levelRank(c.level) > levelRank(best)) best = c.level;
  }
  return best && access.readOnly ? 'view' : best;
}
