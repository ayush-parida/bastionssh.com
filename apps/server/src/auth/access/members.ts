import type { FastifyRequest } from 'fastify';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  BUILT_IN_ROLES,
  MODULE_LEVELS,
  MODULES,
  MODULES_ONLY_DEFAULTS,
  type AccessLevel,
  type BuiltInRole,
  type HeldRole,
  type MemberModuleAccess,
  type MemberScope,
  type ModuleAccessReason,
  type ModuleKey,
  type ModuleLevel,
  type PermissionSet,
  type Role,
} from '@smt/shared';
import { getDb } from '../../db/index.js';
import { memberships, organizations, roleMembers, roles, servers } from '../../db/schema.js';
import { abortAgentStreams } from '../../ai/streams.js';
import { abortDockerStreams } from '../../docker/sse.js';
import { closeDisallowedExecSessions } from '../../docker/exec.js';
import { abortKubeStreams } from '../../kube/sse.js';
import { closeDisallowedPodShells } from '../../kube/exec.js';
import type { LiveAccessRevoked } from '../revoke.js';
import { grantsOfRoles, principalGrants } from './grants.js';
import { canAssignRole, canGrant, visibleModules } from './modules.js';
import {
  allModules,
  baseLevel,
  legacyRoleFor,
  maxModuleLevel,
  meetsLevel,
  meetsModuleLevel,
  moduleRank,
  noModules,
  parseModulePermissions,
  TYPE_MODULES,
} from './levels.js';
import { activeAt, resolveAccess, type AccessSubject } from './resolve.js';
import { revokeAfterChange, snapshotAccess, type AccessSnapshot } from './revoke.js';

/**
 * Members and their roles in Team & Access (unified roles spec §4.2, §4.3,
 * §5): which roles a member holds, assigning them as a whole, who may act on
 * whom (a member whose permissions are within the actor's), the last-owner
 * rule, and closing what a change took away — resources and modules alike.
 * The delegation guard for what is *given* lives in modules.ts (`canGrant`,
 * `canAssignRole`); this file weighs members against each other.
 */

type WantedGrant = NonNullable<PermissionSet['grants']>[number];

/** A role a member holds, as the team routes need it. */
export interface MemberRoleRow {
  roleId: string;
  name: string;
  color: string | null;
  system: BuiltInRole | null;
  modulePermissions: string | null;
  expiresAt: string | null;
}

function isBuiltIn(value: string | null): value is BuiltInRole {
  return value !== null && (BUILT_IN_ROLES as readonly string[]).includes(value);
}

/** Roles each of `userIds` holds now (unexpired), whatever their membership's status, by user. */
export function memberRoleRows(orgId: string, userIds: string[]): Map<string, MemberRoleRow[]> {
  const byUser = new Map<string, MemberRoleRow[]>();
  if (!userIds.length) return byUser;
  const rows = getDb()
    .select({
      userId: roleMembers.userId,
      roleId: roleMembers.roleId,
      name: roles.name,
      color: roles.color,
      system: roles.system,
      modulePermissions: roles.modulePermissions,
      expiresAt: roleMembers.expiresAt,
    })
    .from(roleMembers)
    .innerJoin(roles, eq(roles.id, roleMembers.roleId))
    .where(
      and(
        eq(roleMembers.orgId, orgId),
        eq(roles.orgId, orgId),
        inArray(roleMembers.userId, userIds),
        activeAt(roleMembers.expiresAt, new Date().toISOString()),
      ),
    )
    .orderBy(roles.name)
    .all();
  // Built-in roles first, in their order, then the rest by name
  const order = (r: MemberRoleRow) => (r.system ? BUILT_IN_ROLES.indexOf(r.system) : BUILT_IN_ROLES.length);
  for (const { userId, system, ...row } of rows) {
    const role: MemberRoleRow = { ...row, system: isBuiltIn(system) ? system : null };
    byUser.set(userId, [...(byUser.get(userId) ?? []), role]);
  }
  for (const list of byUser.values()) list.sort((a, b) => order(a) - order(b));
  return byUser;
}

/** The roles as the API shows them. */
export function presentHeldRoles(rows: MemberRoleRow[]): HeldRole[] {
  return rows.map((r) => ({ roleId: r.roleId, name: r.name, color: r.color, expiresAt: r.expiresAt, system: r.system }));
}

/** The union of the roles' module levels; a role from before module permissions (null) as resolve.ts counts it. */
function unionModules(orgId: string, rows: { roleId: string; modulePermissions: string | null }[]): {
  modules: Record<ModuleKey, ModuleLevel>;
  byRole: Map<string, Partial<Record<ModuleKey, ModuleLevel>>>;
} {
  const legacy = rows.filter((r) => r.modulePermissions === null).map((r) => r.roleId);
  const legacyGrants = grantsOfRoles(orgId, legacy);
  const modules = noModules();
  const byRole = new Map<string, Partial<Record<ModuleKey, ModuleLevel>>>();
  for (const row of rows) {
    const own = parseModulePermissions(row.modulePermissions);
    for (const g of legacyGrants.get(row.roleId) ?? []) {
      own[TYPE_MODULES[g.resourceType]] = maxModuleLevel(own[TYPE_MODULES[g.resourceType]] ?? 'none', 'view');
      if (g.resourceType === 'server') own.containers = maxModuleLevel(own.containers ?? 'none', 'view');
    }
    byRole.set(row.roleId, own);
    for (const [key, level] of Object.entries(own) as [ModuleKey, ModuleLevel][]) modules[key] = maxModuleLevel(modules[key], level);
  }
  return { modules, byRole };
}

/**
 * The base role a set of roles amounts to, for the compatible `role` field and
 * memberships.role (which migration 0023's triggers still follow): owner when
 * it includes the Owner role, else `legacyRoleFor` of their module levels.
 */
export function legacyRoleOf(orgId: string, rows: { roleId: string; system: string | null; modulePermissions: string | null }[]): Role {
  if (rows.some((r) => r.system === 'owner')) return 'owner';
  return legacyRoleFor(unionModules(orgId, rows).modules);
}

/**
 * The base role the member's built-in (or generated "<Base> (modules only)")
 * role stands for — what memberships.role stores. Never derived from custom
 * roles: migration 0023's trigger sets the level of the member's mirrored
 * per-server and "all" grants from it, so a custom role counted here would
 * raise those grants past what the delegation guard weighed when it was
 * given. No built-in: viewer, the least.
 */
export function baseRoleOf(rows: { roleId: string; system: string | null }[]): Role {
  const order: Role[] = ['owner', 'admin', 'operator'];
  for (const role of order) {
    if (rows.some((r) => r.system === role || (role === 'operator' && r.roleId.startsWith('modules-only:') && r.roleId.endsWith(':operator')))) {
      return role;
    }
  }
  return 'viewer';
}

/**
 * The compatible scope: `all` when a built-in role giving every resource of
 * every type is held (Owner, Admin, Operator, Viewer), else `roles`.
 */
export function legacyScopeOf(rows: { system: string | null }[]): MemberScope {
  return rows.some((r) => r.system === 'owner' || r.system === 'admin' || r.system === 'operator' || r.system === 'viewer')
    ? 'all'
    : 'roles';
}

// ── Who may act on whom ───────────────────────────────────────────────────────

/** Everything a member holds now: Owner, module levels, and the grants that count (not parked). */
export interface HeldPermissions {
  owner: boolean;
  modules: Record<ModuleKey, ModuleLevel>;
  grants: (WantedGrant & { namespaces: string[] | null })[];
}

/**
 * What a member holds, whatever their membership's status (a suspended admin
 * is still an admin to whoever would reactivate them). Grants count as
 * resolve.ts counts them: a role's only while that role has the resource
 * module on, personal ones while any held role does.
 */
export function heldPermissions(orgId: string, userId: string, opts: { parked?: boolean } = {}): HeldPermissions {
  const rows = memberRoleRows(orgId, [userId]).get(userId) ?? [];
  if (rows.some((r) => r.system === 'owner')) return { owner: true, modules: allModules(), grants: [] };
  const { modules, byRole } = unionModules(orgId, rows);
  const grants: HeldPermissions['grants'] = [];
  const ofRoles = grantsOfRoles(
    orgId,
    rows.map((r) => r.roleId),
  );
  for (const [roleId, list] of ofRoles) {
    const own = byRole.get(roleId) ?? {};
    for (const g of list) if (meetsModuleLevel(own[TYPE_MODULES[g.resourceType]], 'view')) grants.push(g);
  }
  for (const g of principalGrants(orgId, 'user', userId)) {
    // `parked`: personal grants count even with their module off — they come
    // back the moment any role turns it on, which no longer needs the actor
    if (opts.parked || meetsModuleLevel(modules[TYPE_MODULES[g.resourceType]], 'view')) grants.push(g);
  }
  return { owner: false, modules, grants };
}

function serverTags(orgId: string, serverId: string): string[] {
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

/** True when `held` covers `wanted` on its own: same type, level, selector id ⊆ tag ⊆ all, namespaces. */
function grantCovers(orgId: string, held: HeldPermissions['grants'][number], wanted: HeldPermissions['grants'][number]): boolean {
  if (held.resourceType !== wanted.resourceType || !meetsLevel(held.level, wanted.level)) return false;
  if (held.namespaces !== null && (wanted.namespaces === null || !wanted.namespaces.every((ns) => held.namespaces!.includes(ns)))) {
    return false;
  }
  if (held.selector === 'all') return true;
  if (held.selector === 'tag') {
    if (wanted.selector === 'tag') return wanted.tag === held.tag;
    return wanted.selector === 'id' && wanted.resourceType === 'server' && !!wanted.resourceId && !!held.tag
      && serverTags(orgId, wanted.resourceId).includes(held.tag);
  }
  return wanted.selector === 'id' && wanted.resourceId === held.resourceId;
}

/** True when `holder` holds everything `wanted` does (Owner only within Owner). */
export function permissionsCover(orgId: string, holder: HeldPermissions, wanted: HeldPermissions): boolean {
  if (holder.owner) return true;
  if (wanted.owner) return false;
  for (const [key, level] of Object.entries(wanted.modules) as [ModuleKey, ModuleLevel][]) {
    if (moduleRank(level) > moduleRank(holder.modules[key])) return false;
  }
  return wanted.grants.every((w) => holder.grants.some((h) => grantCovers(orgId, h, w)));
}

/**
 * How far above the target the actor must be, now that rank is what each
 * holds (spec §4.2, §3.2 "for members whose roles ⊆ own"):
 *  - `atOrBelow`: everything the target holds, the actor holds too (a peer is fine).
 *  - `below`: that, and the actor holds something the target does not —
 *    except that owners may act on other owners — for actions that lock
 *    someone out but hand over nothing (suspend, reactivate, sign out,
 *    change roles, remove). Peers cannot do these to each other; the
 *    last-owner check still applies on top.
 *  - `strictlyBelow`: strictly within, no exceptions — for a password or
 *    passkey reset, which hands the actor the target's account. Nobody can
 *    reset an owner.
 * With the built-in roles at their defaults this is exactly the base-role
 * order it replaces (owner > admin > operator > viewer).
 */
export type RankRule = 'atOrBelow' | 'below' | 'strictlyBelow';

export function outranks(orgId: string, actorId: string, targetId: string, rule: RankRule): boolean {
  const actor = heldPermissions(orgId, actorId);
  // The target's parked personal grants count as theirs: whoever takes over or
  // locks out a member with "all servers: manage" parked must hold it too
  const target = heldPermissions(orgId, targetId, { parked: true });
  if (target.owner) return actor.owner && rule !== 'strictlyBelow';
  if (actor.owner) return true;
  if (!permissionsCover(orgId, actor, target)) return false;
  return rule === 'atOrBelow' || !permissionsCover(orgId, target, actor);
}

/** True when the subject reaches every resource of every type at `manage` — nothing left to ask for. */
export function managesEverything(who: AccessSubject): boolean {
  const access = resolveAccess(who);
  if (!access.active) return false;
  if (access.owner) return true;
  return Object.values(access.types).every((t) => t.every.some((c) => c.level === 'manage' && c.namespaces === null));
}

/** Active members who hold `module` at `level` or above (with every role counted, not a token's cap). */
export function membersWithModule(orgId: string, module: ModuleKey, level: Exclude<ModuleLevel, 'none'>): string[] {
  const userIds = getDb()
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, 'active')))
    .all()
    .map((m) => m.userId);
  return userIds.filter((userId) => meetsModuleLevel(resolveAccess({ orgId, userId }).modules[module], level));
}

// ── Owners ────────────────────────────────────────────────────────────────────

/**
 * Active members holding the Owner role for good. A suspended owner cannot
 * sign in, and a temporary one will not be there, so neither keeps the org
 * from being orphaned.
 */
export function permanentOwnerIds(orgId: string): string[] {
  return getDb()
    .select({ userId: roleMembers.userId })
    .from(roleMembers)
    .innerJoin(roles, eq(roles.id, roleMembers.roleId))
    .innerJoin(memberships, and(eq(memberships.userId, roleMembers.userId), eq(memberships.orgId, roleMembers.orgId)))
    .where(
      and(
        eq(roleMembers.orgId, orgId),
        eq(roles.orgId, orgId),
        eq(roles.system, 'owner'),
        isNull(roleMembers.expiresAt),
        eq(memberships.status, 'active'),
      ),
    )
    .all()
    .map((r) => r.userId);
}

/** The org must never lose its last owner — by losing the role, suspension or removal. */
export function wouldOrphanOrg(orgId: string, userId: string, keepsOwner: boolean): boolean {
  if (keepsOwner) return false;
  const owners = permanentOwnerIds(orgId);
  return owners.includes(userId) && owners.length <= 1;
}

// ── Which role ────────────────────────────────────────────────────────────────

/** A built-in role's id in the org. */
export function builtInRoleId(orgId: string, system: BuiltInRole): string | undefined {
  return getDb()
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.system, system)))
    .get()?.id;
}

/** The role new members get when none is picked: the org's setting, else Viewer. */
export function defaultRoleId(orgId: string): string | undefined {
  const org = getDb()
    .select({ roleId: organizations.defaultRoleId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .get();
  const set = org?.roleId
    ? getDb()
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.id, org.roleId), eq(roles.orgId, orgId)))
        .get()?.id
    : undefined;
  return set ?? builtInRoleId(orgId, 'viewer');
}

/**
 * The role a base role and scope from before unified roles stand for, as
 * migration 0025 assigned it: the built-in, or for role-scoped operators and
 * viewers the generated "<Base> (modules only)" role (made when missing).
 */
export function roleIdForBaseRole(orgId: string, role: Role, scope: MemberScope = 'all'): string | undefined {
  if (scope === 'roles' && (role === 'operator' || role === 'viewer')) {
    const id = `modules-only:${orgId}:${role}`;
    const defaults = MODULES_ONLY_DEFAULTS[role];
    const now = new Date().toISOString();
    getDb()
      .insert(roles)
      .values({
        id,
        orgId,
        name: defaults.name,
        description: defaults.description,
        color: null,
        createdBy: 'system',
        createdAt: now,
        updatedAt: now,
        system: null,
        modulePermissions: JSON.stringify(defaults.modules),
      })
      .onConflictDoNothing()
      .run();
    return id;
  }
  return builtInRoleId(orgId, role);
}

/** True for the roles a base role and scope stand for (built-ins and generated "(modules only)" roles). */
export function isBaseRoleRole(row: { roleId: string; system: string | null }): boolean {
  return row.system !== null || row.roleId.startsWith('modules-only:');
}

// ── Assigning ─────────────────────────────────────────────────────────────────

export interface RoleAssignment {
  roleId: string;
  /** Null = permanent. */
  expiresAt: string | null;
}

/**
 * Replace the roles a member holds with `assignments` (none: No access).
 * memberships.role / scope / server_access keep the base role and scope the
 * roles amount to, for old API callers and migration 0023's triggers (the
 * mirrored per-server grants follow the base role); migration 0025's sync
 * trigger fires on that write and is overruled by the list written after it.
 * Run inside the caller's transaction where there is one. Validating the
 * roles and the delegation guard are the caller's.
 */
export function setMemberRoles(orgId: string, userId: string, assignments: RoleAssignment[], addedBy: string | null): void {
  const db = getDb();
  let wanted = [...new Map(assignments.map((a) => [a.roleId, a])).values()];
  if (wanted.length === 0) {
    const none = builtInRoleId(orgId, 'none');
    wanted = none ? [{ roleId: none, expiresAt: null }] : [];
  }
  const info = wanted.length
    ? db
        .select({ roleId: roles.id, system: roles.system, modulePermissions: roles.modulePermissions })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), inArray(roles.id, wanted.map((a) => a.roleId))))
        .all()
    : [];
  // Only built-in roles held for good decide the base role the old columns show
  const lasting = info.filter((r) => wanted.find((a) => a.roleId === r.roleId)?.expiresAt === null);
  const role = baseRoleOf(lasting);
  const scope = legacyScopeOf(lasting);
  const existing = new Map(
    db
      .select()
      .from(roleMembers)
      .where(and(eq(roleMembers.orgId, orgId), eq(roleMembers.userId, userId)))
      .all()
      .map((m) => [m.roleId, m]),
  );
  const now = new Date().toISOString();
  db.update(memberships)
    .set({ role, scope, serverAccess: scope === 'roles' ? 'restricted' : 'all' })
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .run();
  db.delete(roleMembers).where(and(eq(roleMembers.orgId, orgId), eq(roleMembers.userId, userId))).run();
  for (const a of wanted) {
    const prior = existing.get(a.roleId);
    // An unchanged membership keeps who added it and when
    const same = prior && prior.expiresAt === a.expiresAt && (prior.expiresAt === null || prior.expiresAt > now);
    db.insert(roleMembers)
      .values({
        roleId: a.roleId,
        userId,
        orgId,
        expiresAt: a.expiresAt,
        addedBy: same ? prior.addedBy : addedBy,
        addedAt: same ? prior.addedAt : now,
      })
      .run();
  }
}

// ── Closing what a change took away ───────────────────────────────────────────

/** What members reach and which modules they use, before a change (`revokeAfterMemberChange`). */
export interface MemberSnapshot {
  access: Map<string, AccessSnapshot>;
  modules: Map<string, Record<ModuleKey, ModuleLevel>>;
}

export function snapshotMembers(orgId: string, userIds: Iterable<string>): MemberSnapshot {
  const ids = [...new Set(userIds)];
  return {
    access: snapshotAccess(orgId, ids),
    modules: new Map(ids.map((userId) => [userId, { ...resolveAccess({ orgId, userId }).modules }])),
  };
}

/**
 * After a change to roles or memberships (spec §7): close what each member
 * has open on resources they no longer reach (`revokeAfterChange`), and on
 * modules they lost or were lowered on — AI streams when the AI Assistant
 * goes, Docker streams and container shells with Containers or Servers,
 * Kubernetes streams and pod shells with Kubernetes (the pages reopen what
 * is still allowed). Returns what closed, per member.
 */
export function revokeAfterMemberChange(orgId: string, userIds: Iterable<string>, before: MemberSnapshot): Map<string, LiveAccessRevoked> {
  const ids = [...new Set(userIds)];
  const closed = revokeAfterChange(orgId, ids, before.access);
  for (const userId of ids) {
    const was = before.modules.get(userId);
    if (!was) continue;
    const now = resolveAccess({ orgId, userId }).modules;
    const lowered = (key: ModuleKey) => moduleRank(now[key]) < moduleRank(was[key]);
    const extra: LiveAccessRevoked = { terminals: 0, sftp: 0, docker: 0, kube: 0, agents: 0 };
    if (lowered('ai')) extra.agents += abortAgentStreams(userId, { orgId });
    if (lowered('containers') || lowered('servers')) {
      extra.docker += abortDockerStreams(userId, { orgId });
      extra.terminals += closeDisallowedExecSessions(orgId, userId);
    }
    if (lowered('kubernetes')) {
      extra.kube += abortKubeStreams(userId, { orgId });
      extra.terminals += closeDisallowedPodShells(orgId, userId);
    }
    if (extra.terminals + extra.docker + extra.kube + extra.agents === 0) continue;
    const prior = closed.get(userId) ?? { terminals: 0, sftp: 0, docker: 0, kube: 0, agents: 0 };
    closed.set(userId, {
      ...prior,
      terminals: prior.terminals + extra.terminals,
      docker: prior.docker + extra.docker,
      kube: prior.kube + extra.kube,
      agents: prior.agents + extra.agents,
    });
  }
  return closed;
}

// ── Changing a member's roles ─────────────────────────────────────────────────

/**
 * The delegation guard (spec §4.2) over a change of a member's roles: every
 * role given — or taken away, which needs the same — must be one the actor
 * could give, for as long. Owner only by owners. Returns what is missing.
 */
export function roleDelegationMissing(actor: AccessSubject, added: RoleAssignment[], removed: RoleAssignment[]): string[] {
  const missing = new Set<string>();
  for (const a of [...added, ...removed]) {
    for (const m of canAssignRole(actor, a.roleId, { expiresAt: a.expiresAt }).missing) missing.add(m);
  }
  return [...missing];
}

/**
 * The member's mirrored grants from before custom roles (`legacy-` ids: the
 * pre-roles per-server and per-cluster lists, the "all" grants of a
 * restricted member) sit at their base role's level and follow it (migration
 * 0023's trigger on memberships.role). A change of built-in role that moves
 * that level moves those grants too, so the actor must hold each of them at
 * the higher of the two levels — giving and taking away alike — for as long.
 * Returns what is missing; nothing when the level stays.
 */
function mirroredGrantsMissing(actor: AccessSubject, userId: string, current: MemberRoleRow[], next: RoleAssignment[]): string[] {
  const lasting = (rows: { roleId: string; system: string | null }[], ends: (id: string) => string | null | undefined) =>
    rows.filter((r) => ends(r.roleId) === null);
  const nextInfo = next.length
    ? getDb()
        .select({ roleId: roles.id, system: roles.system })
        .from(roles)
        .where(and(eq(roles.orgId, actor.orgId), inArray(roles.id, next.map((a) => a.roleId))))
        .all()
    : [];
  const from = baseLevel(baseRoleOf(lasting(current, (id) => current.find((r) => r.roleId === id)?.expiresAt)));
  const to = baseLevel(baseRoleOf(lasting(nextInfo, (id) => next.find((a) => a.roleId === id)?.expiresAt)));
  if (from === to) return [];
  const level = meetsLevel(from, to) ? from : to;
  const missing = new Set<string>();
  for (const g of principalGrants(actor.orgId, 'user', userId)) {
    if (!g.id.startsWith('legacy-')) continue;
    const wanted = { resourceType: g.resourceType, selector: g.selector, resourceId: g.resourceId, tag: g.tag, namespaces: g.namespaces, level };
    for (const m of canGrant(actor, { grants: [wanted] }, { expiresAt: g.expiresAt }).missing) missing.add(m);
  }
  return [...missing];
}

/** True when `modules` has the resource module of `type` on. */
function moduleOn(modules: Record<ModuleKey, ModuleLevel>, type: WantedGrant['resourceType']): boolean {
  return meetsModuleLevel(modules[TYPE_MODULES[type]], 'view');
}

/**
 * A personal grant counts only while one of the member's roles has its
 * resource module on (resolve.ts), so a change of roles — or of a role's
 * module levels — that turns that module on gives the grant back, and one
 * that turns it off parks it (spec §10.4). Like a role's own parked grants
 * (`PATCH /roles/:id`), the actor must hold each such grant, for as long, to
 * move it either way. `rolesAfter` says what each member's roles become
 * (each as `{ roleId, modulePermissions }`). Returns what is missing.
 */
export function personalGrantsMovedMissing(
  actor: AccessSubject,
  userIds: string[],
  rolesAfter: (userId: string, rows: MemberRoleRow[]) => { roleId: string; system: string | null; modulePermissions: string | null }[],
): string[] {
  const orgId = actor.orgId;
  const held = memberRoleRows(orgId, userIds);
  const missing = new Set<string>();
  for (const userId of userIds) {
    const personal = principalGrants(orgId, 'user', userId);
    if (!personal.length) continue;
    const rows = held.get(userId) ?? [];
    const after = rolesAfter(userId, rows);
    // An owner reaches everything whatever their grants; only owners give or take Owner
    if (rows.some((r) => r.system === 'owner') || after.some((r) => r.system === 'owner')) continue;
    const was = unionModules(orgId, rows).modules;
    const now = unionModules(orgId, after).modules;
    for (const g of personal) {
      if (moduleOn(was, g.resourceType) === moduleOn(now, g.resourceType)) continue;
      const wanted = { resourceType: g.resourceType, selector: g.selector, resourceId: g.resourceId, tag: g.tag, namespaces: g.namespaces, level: g.level };
      for (const m of canGrant(actor, { grants: [wanted] }, { expiresAt: g.expiresAt }).missing) missing.add(m);
    }
  }
  return [...missing];
}

/**
 * Personal grants that operate a server or cluster open the AI Assistant
 * (at `view`) for a member none of whose roles do (resolve.ts), once its
 * module is on for them. Giving one to such a member gives that module too — for as long as the longest of
 * them lasts — so the actor must hold it that long. Returns what is
 * missing; nothing when the member has the assistant already or no such
 * grant is given.
 */
export function assistantDelegationMissing(
  actor: AccessSubject,
  userId: string,
  grants: { resourceType: WantedGrant['resourceType']; level: AccessLevel; expiresAt?: string | null }[],
): string[] {
  const target = resolveAccess({ orgId: actor.orgId, userId });
  // A parked grant (its module off for the member) opens nothing until a role turns it on
  const operating = grants.filter(
    (g) => (g.resourceType === 'server' || g.resourceType === 'cluster') && meetsLevel(g.level, 'operate') && moduleOn(target.modules, g.resourceType),
  );
  if (!operating.length || target.modules.ai !== 'none') return [];
  const ends = operating.map((g) => g.expiresAt ?? null);
  const until = ends.includes(null) ? null : ends.sort().at(-1)!;
  return canGrant(actor, { modules: { ai: 'view' } }, { expiresAt: until }).missing;
}

export interface RoleChangeRefusal {
  status: 400 | 403;
  error: string;
  missing?: string[];
}

export interface RoleChange {
  before: MemberRoleRow[];
  after: MemberRoleRow[];
  live?: LiveAccessRevoked;
}

/**
 * Replace a member's roles with `next` after the checks every path shares:
 *  - the delegation guard over each role given or taken away;
 *  - taking away a built-in role (or a generated "(modules only)" one) —
 *    what a demotion was — needs the actor to hold more than the member
 *    (`outranks` `below`), as changing a base role did; custom roles are
 *    weighed by the delegation guard alone, as their members always were;
 *  - the org keeps an owner.
 * Then writes them (with `extra` in the same transaction), closes what the
 * member lost and returns the roles before and after.
 */
export function changeMemberRoles(
  actor: FastifyRequest,
  userId: string,
  next: RoleAssignment[],
  verb: string,
  extra: () => void = () => {},
): RoleChange | { refused: RoleChangeRefusal } {
  const orgId = actor.orgId;
  const current = memberRoleRows(orgId, [userId]).get(userId) ?? [];
  const key = (a: RoleAssignment) => `${a.roleId}\u0000${a.expiresAt ?? ''}`;
  const nextKeys = new Set(next.map(key));
  const currentKeys = new Set(current.map(key));
  const removedRows = current.filter((r) => !nextKeys.has(key(r)));
  const added = next.filter((a) => !currentKeys.has(key(a)));
  const removed = removedRows.map((r) => ({ roleId: r.roleId, expiresAt: r.expiresAt }));
  if (removedRows.some(isBaseRoleRole) && !outranks(orgId, actor.user.id, userId, 'below')) {
    return { refused: { status: 403, error: `You cannot ${verb} a member who holds as much access as you` } };
  }
  const nextInfo = next.length
    ? getDb()
        .select({ roleId: roles.id, system: roles.system, modulePermissions: roles.modulePermissions })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), inArray(roles.id, next.map((a) => a.roleId))))
        .all()
    : [];
  const missing = [
    ...new Set([
      ...roleDelegationMissing(actor, added, removed),
      ...mirroredGrantsMissing(actor, userId, current, next),
      ...personalGrantsMovedMissing(actor, [userId], () => nextInfo),
    ]),
  ];
  if (missing.length) {
    return { refused: { status: 403, error: `You cannot ${verb}: you do not hold ${missing.join('; ')}`, missing } };
  }
  const ownerId = builtInRoleId(orgId, 'owner');
  const keepsOwner = next.some((a) => a.roleId === ownerId && a.expiresAt === null);
  if (wouldOrphanOrg(orgId, userId, keepsOwner)) {
    return { refused: { status: 400, error: 'The organization must keep at least one owner' } };
  }
  const before = snapshotMembers(orgId, [userId]);
  getDb().transaction(() => {
    setMemberRoles(orgId, userId, next, actor.user.id);
    extra();
  });
  const live = revokeAfterMemberChange(orgId, [userId], before).get(userId);
  return { before: current, after: memberRoleRows(orgId, [userId]).get(userId) ?? [], ...(live && { live }) };
}

/** What closed, per member, for an audit row; undefined when nothing did. */
export function liveSummary(closed: Map<string, LiveAccessRevoked>): Record<string, LiveAccessRevoked> | undefined {
  return closed.size ? Object.fromEntries(closed) : undefined;
}

/**
 * Every module with the member's level there, whether it is shown to them,
 * and which of their roles give it (spec §5: "Team & Access: invite members
 * — via Team leads"), for the member detail.
 */
export function memberModules(orgId: string, userId: string): MemberModuleAccess[] {
  const held = memberRoleRows(orgId, [userId]).get(userId) ?? [];
  const { byRole } = unionModules(orgId, held);
  const visible = new Set(visibleModules({ orgId, userId }).map((m) => m.module));
  const reasons = new Map<ModuleKey, ModuleAccessReason[]>();
  for (const role of held) {
    const given = byRole.get(role.roleId) ?? {};
    for (const m of MODULES) {
      // The Owner role reaches every module at its highest level, whatever it stores
      const level = role.system === 'owner' ? m.levels[m.levels.length - 1]! : given[m.key];
      if (!level || level === 'none') continue;
      reasons.set(m.key, [
        ...(reasons.get(m.key) ?? []),
        { roleId: role.roleId, name: role.name, system: role.system, level, expiresAt: role.expiresAt },
      ]);
    }
  }
  const order = (l: ModuleLevel) => MODULE_LEVELS.indexOf(l);
  return MODULES.map((m) => {
    const via = (reasons.get(m.key) ?? []).sort((a, b) => order(b.level) - order(a.level) || a.name.localeCompare(b.name));
    return { module: m.key, level: via[0]?.level ?? 'none', visible: visible.has(m.key), via };
  });
}
