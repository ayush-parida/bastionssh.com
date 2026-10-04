import { and, eq, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AccessLevel, GrantInput, GrantPrincipal, GrantSelector, ResourceType, RoleGrant } from '@smt/shared';
import { getDb } from '../../db/index.js';
import { memberClusterAccess, memberServerAccess, resourceGrants } from '../../db/schema.js';
import { RESOURCE_TABLES } from './filter.js';
import { isAccessLevel, meetsLevel } from './levels.js';
import { activeAt } from './resolve.js';

/**
 * Reading and replacing the grant lists of a custom role or of one member (a
 * personal grant), for the team routes (custom roles spec §6). The list is
 * always replaced as a whole, inside one transaction, so a role never has
 * half its old resources and half its new ones.
 */

/** Longest a grant may run from now; anything longer should be permanent. Matches MAX_GRANT_MINUTES. */
const MAX_GRANT_MS = 365 * 24 * 60 * 60_000;

/** A grant as validated, before it gets an id and a principal. */
export interface GrantDraft {
  resourceType: ResourceType;
  selector: GrantSelector;
  resourceId: string | null;
  tag: string | null;
  namespaces: string[] | null;
  level: AccessLevel;
  expiresAt: string | null;
  reason: string | null;
}

type GrantRow = typeof resourceGrants.$inferSelect;

function parseNamespaces(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((ns): ns is string => typeof ns === 'string') : [];
  } catch {
    return [];
  }
}

export function toRoleGrant(row: GrantRow): RoleGrant {
  return {
    id: row.id,
    resourceType: row.resourceType as ResourceType,
    selector: row.selector as GrantSelector,
    resourceId: row.resourceId,
    tag: row.tag,
    namespaces: parseNamespaces(row.namespaces),
    level: isAccessLevel(row.level) ? row.level : 'view',
    expiresAt: row.expiresAt,
    grantedBy: row.grantedBy,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

/** A role's (or a member's personal) grants still in force, oldest first. */
export function principalGrants(orgId: string, principalType: GrantPrincipal, principalId: string): RoleGrant[] {
  return getDb()
    .select()
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.orgId, orgId),
        eq(resourceGrants.principalType, principalType),
        eq(resourceGrants.principalId, principalId),
        activeAt(resourceGrants.expiresAt, new Date().toISOString()),
      ),
    )
    .orderBy(resourceGrants.createdAt)
    .all()
    .map(toRoleGrant);
}

/** Every grant of several roles, in force, by role id — one query for the role list. */
export function grantsOfRoles(orgId: string, roleIds: string[]): Map<string, RoleGrant[]> {
  const byRole = new Map<string, RoleGrant[]>();
  if (!roleIds.length) return byRole;
  const rows = getDb()
    .select()
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.orgId, orgId),
        eq(resourceGrants.principalType, 'role'),
        inArray(resourceGrants.principalId, roleIds),
        activeAt(resourceGrants.expiresAt, new Date().toISOString()),
      ),
    )
    .orderBy(resourceGrants.createdAt)
    .all();
  for (const row of rows) byRole.set(row.principalId, [...(byRole.get(row.principalId) ?? []), toRoleGrant(row)]);
  return byRole;
}

/** Ids of `type` among `ids` that are in `orgId`. */
function knownIds(orgId: string, type: ResourceType, ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const { table, id, orgId: orgColumn } = RESOURCE_TABLES[type];
  return new Set(
    getDb()
      .select({ id })
      .from(table)
      .where(and(eq(orgColumn, orgId), inArray(id, ids)))
      .all()
      .map((r) => r.id as string),
  );
}

/**
 * Check a grant list against the org and settle each entry's expiry. Entries
 * already past their `expiresAt` are dropped (they lapsed while the editor
 * was open and stay lapsed); exact duplicates collapse. Returns an error
 * message for anything that does not hold up, rather than granting less (or
 * more) than was asked.
 */
export function draftGrants(
  orgId: string,
  inputs: GrantInput[],
  now = Date.now(),
): { drafts: GrantDraft[] } | { error: string } {
  const byType = new Map<ResourceType, string[]>();
  for (const g of inputs) {
    if (g.selector === 'id' && g.resourceId) byType.set(g.resourceType, [...(byType.get(g.resourceType) ?? []), g.resourceId]);
  }
  const known = new Map([...byType].map(([type, ids]) => [type, knownIds(orgId, type, [...new Set(ids)])]));

  const drafts: GrantDraft[] = [];
  const seen = new Set<string>();
  for (const g of inputs) {
    if (g.selector === 'id') {
      if (!g.resourceId || !known.get(g.resourceType)?.has(g.resourceId)) return { error: 'Unknown resource in grants' };
    } else if (g.selector === 'tag') {
      if (g.resourceType !== 'server') return { error: 'Only servers can be granted by tag' };
      if (!g.tag?.trim()) return { error: 'A tag grant needs a tag' };
    }
    if (g.namespaces != null) {
      if (g.resourceType !== 'cluster') return { error: 'Only clusters can be narrowed to namespaces' };
      if (g.namespaces.length === 0) return { error: 'Pick at least one namespace, or none to cover every namespace' };
    }

    let expiresAt: string | null = null;
    if (g.expiresAt) {
      const at = new Date(g.expiresAt).getTime();
      if (Number.isNaN(at)) return { error: 'Invalid expiry in grants' };
      if (at <= now) continue;
      if (at > now + MAX_GRANT_MS + 60_000) return { error: 'A grant can be time-bound for a year at most' };
      expiresAt = new Date(at).toISOString();
    } else if (g.expiresInMinutes != null) {
      expiresAt = new Date(now + g.expiresInMinutes * 60_000).toISOString();
    }

    const draft: GrantDraft = {
      resourceType: g.resourceType,
      selector: g.selector,
      resourceId: g.selector === 'id' ? g.resourceId! : null,
      tag: g.selector === 'tag' ? g.tag!.trim() : null,
      namespaces: g.resourceType === 'cluster' && g.namespaces ? [...new Set(g.namespaces)].sort() : null,
      level: g.level,
      expiresAt,
      reason: g.reason?.trim() || null,
    };
    const key = JSON.stringify([draft.resourceType, draft.selector, draft.resourceId, draft.tag, draft.namespaces, draft.level, draft.expiresAt]);
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push(draft);
  }
  return { drafts };
}

/**
 * Replace every grant of a principal with `drafts`, atomically. For a member
 * this also clears the pre-roles per-member tables, whose rows migration
 * 0023 mirrors into resource_grants, so nothing the old endpoints wrote
 * survives a replacement.
 */
export function replaceGrants(
  orgId: string,
  principalType: GrantPrincipal,
  principalId: string,
  drafts: GrantDraft[],
  grantedBy: string,
): void {
  const db = getDb();
  const createdAt = new Date().toISOString();
  db.transaction((tx) => {
    if (principalType === 'user') {
      tx.delete(memberServerAccess)
        .where(and(eq(memberServerAccess.orgId, orgId), eq(memberServerAccess.userId, principalId)))
        .run();
      tx.delete(memberClusterAccess)
        .where(and(eq(memberClusterAccess.orgId, orgId), eq(memberClusterAccess.userId, principalId)))
        .run();
    }
    tx.delete(resourceGrants)
      .where(
        and(
          eq(resourceGrants.orgId, orgId),
          eq(resourceGrants.principalType, principalType),
          eq(resourceGrants.principalId, principalId),
        ),
      )
      .run();
    for (const d of drafts) {
      tx.insert(resourceGrants)
        .values({
          id: nanoid(),
          orgId,
          principalType,
          principalId,
          resourceType: d.resourceType,
          selector: d.selector,
          resourceId: d.resourceId,
          tag: d.tag,
          namespaces: d.namespaces ? JSON.stringify(d.namespaces) : null,
          level: d.level,
          expiresAt: d.expiresAt,
          grantedBy,
          reason: d.reason,
          createdAt,
        })
        .run();
    }
  });
}

/**
 * A personal grant on one resource until `expiresAt`, unless one already gives
 * at least `level` for at least as long (an approval never shortens access).
 * Returns true when a grant was added.
 */
export function addPersonalGrant(
  orgId: string,
  userId: string,
  type: ResourceType,
  resourceId: string,
  level: AccessLevel,
  grant: { expiresAt: string; grantedBy: string; reason: string | null },
): boolean {
  const db = getDb();
  const existing = db
    .select({ level: resourceGrants.level, expiresAt: resourceGrants.expiresAt })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.orgId, orgId),
        eq(resourceGrants.principalType, 'user'),
        eq(resourceGrants.principalId, userId),
        eq(resourceGrants.resourceType, type),
        eq(resourceGrants.selector, 'id'),
        eq(resourceGrants.resourceId, resourceId),
        activeAt(resourceGrants.expiresAt, new Date().toISOString()),
        sql`${resourceGrants.namespaces} is null`,
      ),
    )
    .all();
  const covered = existing.some(
    (g) => meetsLevel(isAccessLevel(g.level) ? g.level : null, level) && (g.expiresAt === null || g.expiresAt >= grant.expiresAt),
  );
  if (covered) return false;
  db.insert(resourceGrants)
    .values({
      id: nanoid(),
      orgId,
      principalType: 'user',
      principalId: userId,
      resourceType: type,
      selector: 'id',
      resourceId,
      level,
      ...grant,
      createdAt: new Date().toISOString(),
    })
    .run();
  return true;
}
