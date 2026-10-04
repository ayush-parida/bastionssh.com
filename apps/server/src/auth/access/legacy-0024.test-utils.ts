import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { preHandlerHookHandler } from 'fastify';
import { RESOURCE_TYPES, type AccessReason, type ModuleKey, type ModuleLevel, type Role } from '@smt/shared';
import { getDb } from '../../db/index.js';
import { memberships, resourceGrants, roleMembers, roles } from '../../db/schema.js';
import { baseLevel, isAccessLevel, isResourceType } from './levels.js';
import { emptyTypes, type Contribution, type ResolvedAccess } from './resolve.js';
import { requireModule, requireOwner } from './modules.js';

/**
 * The access resolver as it was at migration 0024 (custom roles: base role +
 * scope + custom roles + personal grants), verbatim but for the memo. Tests
 * only: the migration equivalence test and the real-backup dry run read a
 * database with it before migration 0025 and compare with the live engine.
 */

export const ROLE_NAMES: readonly Role[] = ['viewer', 'operator', 'admin', 'owner'];

function activeAt(column: Parameters<typeof isNull>[0], now: string) {
  return or(isNull(column), gt(column, now))!;
}

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

function push<K>(map: Map<K, Contribution[]>, key: K, contribution: Contribution) {
  const list = map.get(key);
  if (list) list.push(contribution);
  else map.set(key, [contribution]);
}

export interface Legacy extends ResolvedAccess {
  scope: 'all' | 'roles';
}

export function legacyLoad(orgId: string, userId: string, readOnly: boolean, now = new Date().toISOString()): Legacy {
  const db = getDb();
  const access: Legacy = {
    orgId,
    userId,
    active: false,
    owner: false,
    role: 'viewer',
    scope: 'roles',
    orgAdmin: false,
    readOnly,
    roles: [],
    modules: {} as ResolvedAccess['modules'],
    roleModules: [],
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
  access.scope = membership.scope === 'roles' && !access.orgAdmin ? 'roles' : 'all';

  if (access.scope === 'all') {
    const level = baseLevel(role);
    for (const type of RESOURCE_TYPES) {
      access.types[type].every.push({ level, reason: { kind: 'base', name: role, level }, namespaces: null });
    }
  }
  if (access.orgAdmin) return access;

  const held = db
    .select({ roleId: roleMembers.roleId, name: roles.name, expiresAt: roleMembers.expiresAt })
    .from(roleMembers)
    .innerJoin(roles, eq(roles.id, roleMembers.roleId))
    .where(and(eq(roleMembers.orgId, orgId), eq(roleMembers.userId, userId), eq(roles.orgId, orgId), activeAt(roleMembers.expiresAt, now)))
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
          held.length ? and(eq(resourceGrants.principalType, 'role'), inArray(resourceGrants.principalId, [...heldById.keys()])) : undefined,
        ),
        activeAt(resourceGrants.expiresAt, now),
      ),
    )
    .all();

  for (const grant of grants) {
    if (!isResourceType(grant.resourceType) || !isAccessLevel(grant.level)) continue;
    const type = grant.resourceType;
    const namespaces = type === 'cluster' ? parseNamespaces(grant.namespaces) : null;
    if (namespaces === undefined) continue;

    let reason: AccessReason;
    if (grant.principalType === 'role') {
      const viaRole = heldById.get(grant.principalId);
      if (!viaRole) continue;
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
    if (grant.selector === 'all') access.types[type].every.push(contribution);
    else if (grant.selector === 'id' && grant.resourceId) push(access.types[type].byId, grant.resourceId, contribution);
    else if (grant.selector === 'tag' && type === 'server' && grant.tag) {
      reason.tag = grant.tag;
      push(access.types[type].byTag, grant.tag, contribution);
    }
  }
  return access;
}

/**
 * Every gate that replaced a `requireRole(minimum)` in the route sweep, with
 * that minimum: the module level (and owner check) each former admin, owner
 * or operator route now asks for. Allowed through the new gate exactly when
 * the old one let the member's base role through.
 */
export const FORMER_GATES: { name: string; minimum: Role; gate: preHandlerHookHandler[] }[] = [
  ...(
    [
      ['audit', 'view'],
      ['audit', 'operate'],
      ['audit', 'manage'],
      ['agents', 'view'],
      ['agents', 'manage'],
      ['ai', 'manage'],
      ['ssh_keys', 'manage'],
      ['monitoring', 'manage'],
      ['servers', 'manage'],
      ['containers', 'manage'],
      ['kubernetes', 'manage'],
      ['ftp', 'manage'],
      ['storage', 'manage'],
      ['cloud', 'manage'],
      ['team_members', 'operate'],
      ['team_roles', 'view'],
      ['team_roles', 'manage'],
    ] as [ModuleKey, Exclude<ModuleLevel, 'none'>][]
  ).map(([module, level]) => ({ name: `${module}-${level}`, minimum: 'admin' as Role, gate: [requireModule(module, level)] })),
  ...(
    [
      ['audit', 'manage'],
      ['recordings', 'manage'],
      ['settings', 'manage'],
      ['team_sign_in', 'manage'],
    ] as [ModuleKey, Exclude<ModuleLevel, 'none'>][]
  ).map(([module, level]) => ({ name: `owner-${module}-${level}`, minimum: 'owner' as Role, gate: [requireModule(module, level), requireOwner()] })),
  { name: 'diagnostics-operate', minimum: 'operator', gate: [requireModule('diagnostics', 'operate')] },
];
