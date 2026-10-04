import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  BUILT_IN_ROLES,
  MODULE_LEVELS,
  MODULES,
  type BuiltInRole,
  type MemberModuleAccess,
  type ModuleAccessReason,
  type ModuleKey,
  type ModuleLevel,
  type ModulePermissions,
  type Role,
} from '@smt/shared';
import { getDb } from '../../db/index.js';
import { memberships, organizations, roleMembers, roles } from '../../db/schema.js';
import { legacyRoleFor, maxModuleLevel, noModules } from './levels.js';
import { rolePermissions, visibleModules } from './modules.js';
import { activeAt } from './resolve.js';

/**
 * Giving members roles (unified roles spec §2, §5): the org's default role,
 * putting a new member in the roles an invite or SSO picked, the module
 * levels a member holds and through which roles, and the base role a
 * member's roles amount to for the member routes that still compare ranks.
 * The delegation guard (may the actor give this?) is in modules.ts.
 */

/** The id migration 0025 gives an org's built-in role. */
export function builtInRoleId(orgId: string, system: BuiltInRole): string {
  return `builtin:${orgId}:${system}`;
}

export function isBuiltInRole(value: string | null | undefined): value is BuiltInRole {
  return !!value && (BUILT_IN_ROLES as readonly string[]).includes(value);
}

/** A role of the org, or undefined when it is not one. */
export function orgRole(orgId: string, roleId: string) {
  return getDb()
    .select({ id: roles.id, name: roles.name, system: roles.system })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.orgId, orgId)))
    .get();
}

/**
 * The role new members get when nobody picked one (invites, SSO): the org's
 * setting, or Viewer — as before unified roles — when it is unset or gone.
 */
export function defaultRoleId(orgId: string): string {
  const row = getDb()
    .select({ roleId: organizations.defaultRoleId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .get();
  const id = row?.roleId;
  // Never Owner, whatever the column says
  const role = id ? orgRole(orgId, id) : undefined;
  return role && role.system !== 'owner' ? role.id : builtInRoleId(orgId, 'viewer');
}

/**
 * Make `roleIds` the roles a member who just joined holds, permanently,
 * replacing whatever the memberships trigger gave them for the base role
 * their membership row was written with. Roles not in the org are skipped,
 * so an invite whose roles were all deleted since joins with none — No access,
 * never more. Runs inside the caller's transaction.
 */
export function setJoinedMemberRoles(orgId: string, userId: string, roleIds: string[], addedBy: string | null): string[] {
  const db = getDb();
  const ids = roleIds.length
    ? db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), inArray(roles.id, [...new Set(roleIds)])))
        .all()
        .map((r) => r.id)
    : [];
  db.delete(roleMembers).where(and(eq(roleMembers.orgId, orgId), eq(roleMembers.userId, userId))).run();
  const addedAt = new Date().toISOString();
  for (const roleId of ids) {
    db.insert(roleMembers).values({ roleId, userId, orgId, expiresAt: null, addedBy, addedAt }).run();
  }
  return ids;
}

/**
 * What `roleIds` amount to as a base role, for the membership row old
 * callers read (and the 0025 trigger turns into a built-in role, which
 * `setJoinedMemberRoles` then replaces): owner with the Owner role among
 * them, a single built-in Admin or Operator is itself, anything else
 * `viewer`.
 */
export function legacyRoleOf(orgId: string, roleIds: string[]): Role {
  const systems = roleIds.map((id) => orgRole(orgId, id)?.system ?? null);
  if (systems.includes('owner')) return 'owner';
  const only = systems.length === 1 ? systems[0] : null;
  return only === 'admin' || only === 'operator' ? only : 'viewer';
}

/** The roles a member holds now (expired memberships left out), with their system kind. */
function heldRoleRows(orgId: string, userId: string) {
  return getDb()
    .select({ id: roles.id, name: roles.name, system: roles.system, expiresAt: roleMembers.expiresAt })
    .from(roleMembers)
    .innerJoin(roles, eq(roles.id, roleMembers.roleId))
    .where(
      and(
        eq(roleMembers.orgId, orgId),
        eq(roleMembers.userId, userId),
        eq(roles.orgId, orgId),
        activeAt(roleMembers.expiresAt, new Date().toISOString()),
      ),
    )
    .all();
}

/**
 * The base role a member's roles amount to — owner when they hold the Owner
 * role, else what `legacyRoleFor` makes of their module levels — whatever
 * their membership's status. The member routes that compare ranks (suspend,
 * remove, reset a password…) weigh the target by this, so a member given
 * Owner through role chips is an owner there too.
 */
export function memberBaseRole(orgId: string, userId: string, cache = new Map<string, ModulePermissions>()): Role {
  const held = heldRoleRows(orgId, userId);
  if (held.some((r) => r.system === 'owner')) return 'owner';
  const modules = noModules();
  for (const role of held) {
    // Pass one `cache` when weighing many members: their roles repeat
    let given = cache.get(role.id);
    if (!given) cache.set(role.id, (given = rolePermissions(orgId, role.id)?.modules ?? {}));
    for (const [key, level] of Object.entries(given) as [ModuleKey, ModuleLevel][]) {
      modules[key] = maxModuleLevel(modules[key], level);
    }
  }
  return legacyRoleFor(modules);
}

/** Active members holding the Owner role now, other than `exceptUserId`. */
export function otherActiveOwners(orgId: string, exceptUserId: string): number {
  return getDb()
    .select({ userId: roleMembers.userId })
    .from(roleMembers)
    .innerJoin(memberships, and(eq(memberships.userId, roleMembers.userId), eq(memberships.orgId, roleMembers.orgId)))
    .where(
      and(
        eq(roleMembers.orgId, orgId),
        eq(roleMembers.roleId, builtInRoleId(orgId, 'owner')),
        ne(roleMembers.userId, exceptUserId),
        eq(memberships.status, 'active'),
        activeAt(roleMembers.expiresAt, new Date().toISOString()),
      ),
    )
    .all().length;
}

/**
 * Every module with the member's level there, whether it is shown to them,
 * and which of their roles give it (spec §5: "Team & Access: invite members
 * — via Team leads"), for the member detail.
 */
export function memberModules(orgId: string, userId: string): MemberModuleAccess[] {
  const held = heldRoleRows(orgId, userId);
  const visible = new Set(visibleModules({ orgId, userId }).map((m) => m.module));
  const reasons = new Map<ModuleKey, ModuleAccessReason[]>();
  for (const role of held) {
    const modules = rolePermissions(orgId, role.id)?.modules ?? {};
    for (const m of MODULES) {
      // The Owner role reaches every module at its highest level, whatever it stores
      const level = role.system === 'owner' ? m.levels[m.levels.length - 1]! : modules[m.key];
      if (!level || level === 'none') continue;
      const list = reasons.get(m.key) ?? [];
      list.push({
        roleId: role.id,
        name: role.name,
        system: isBuiltInRole(role.system) ? role.system : null,
        level,
        expiresAt: role.expiresAt,
      });
      reasons.set(m.key, list);
    }
  }
  const order = (l: ModuleLevel) => MODULE_LEVELS.indexOf(l);
  return MODULES.map((m) => {
    const via = (reasons.get(m.key) ?? []).sort((a, b) => order(b.level) - order(a.level) || a.name.localeCompare(b.name));
    return { module: m.key, level: via[0]?.level ?? 'none', visible: visible.has(m.key), via };
  });
}
