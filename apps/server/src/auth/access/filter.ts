import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { AccessLevel, ResourceType } from '@smt/shared';
import { getDb } from '../../db/index.js';
import {
  cloudAccounts,
  cronJobs,
  ftpConnections,
  kubeClusters,
  savedCommands,
  servers,
  storageConnections,
} from '../../db/schema.js';
import { meetsLevel } from './levels.js';
import { resolveAccess, topLevel, type AccessSubject, type Contribution, type ResolvedAccess } from './resolve.js';

/**
 * Which resources of a type someone may see (spec §4 filter.ts): as a SQL
 * WHERE fragment for lists, which stays in SQL wherever the table has the
 * resource id, or as an id list for rows already loaded. Server tag
 * selectors are matched against `servers.tags` (a JSON array) when the
 * query runs, so a newly tagged server is covered at once.
 */

/** The table holding each resource type; every one has `id` and `org_id`. */
export const RESOURCE_TABLES: Record<ResourceType, { table: SQLiteTable; id: SQLiteColumn; orgId: SQLiteColumn }> = {
  server: { table: servers, id: servers.id, orgId: servers.orgId },
  cluster: { table: kubeClusters, id: kubeClusters.id, orgId: kubeClusters.orgId },
  ftp_connection: { table: ftpConnections, id: ftpConnections.id, orgId: ftpConnections.orgId },
  storage_connection: { table: storageConnections, id: storageConnections.id, orgId: storageConnections.orgId },
  cloud_account: { table: cloudAccounts, id: cloudAccounts.id, orgId: cloudAccounts.orgId },
  saved_command: { table: savedCommands, id: savedCommands.id, orgId: savedCommands.orgId },
  cron_job: { table: cronJobs, id: cronJobs.id, orgId: cronJobs.orgId },
};

/** Every resource of a type, or only these. */
export type AccessibleIds = { all: true } | { all: false; ids: string[] };

/** Contributions that count at `minLevel` (after the read-only cap). */
function reaching(access: ResolvedAccess, list: Contribution[], minLevel: AccessLevel): Contribution[] {
  return list.filter((c) => meetsLevel(topLevel(access, [c]), minLevel));
}

/** Servers in `orgId` carrying any of `tags` (malformed tag lists match nothing). */
export function serversTaggedSql(orgId: string, tags: string[]): SQL {
  return sql`select ${servers.id} from ${servers} where ${servers.orgId} = ${orgId} and exists (select 1 from json_each(case when json_valid(${servers.tags}) then ${servers.tags} else '[]' end) where json_each.value in (${sql.join(
    tags.map((tag) => sql`${tag}`),
    sql`, `,
  )}))`;
}

/** What `accessibleIds` and `accessibleFilter` work from: all, or ids plus tags. */
function reach(access: ResolvedAccess, type: ResourceType, minLevel: AccessLevel): { all: true } | { all: false; ids: string[]; tags: string[] } {
  if (!access.active) return { all: false, ids: [], tags: [] };
  const typeAccess = access.types[type];
  if (reaching(access, typeAccess.every, minLevel).length) return { all: true };
  const ids = [...typeAccess.byId].filter(([, list]) => reaching(access, list, minLevel).length).map(([id]) => id);
  const tags = [...typeAccess.byTag].filter(([, list]) => reaching(access, list, minLevel).length).map(([tag]) => tag);
  return { all: false, ids, tags };
}

/**
 * The resources of `type` the subject reaches at `minLevel` (default: may see
 * them). Tag selectors are resolved to the servers carrying the tag now.
 */
export function accessibleIds(who: AccessSubject, type: ResourceType, minLevel: AccessLevel = 'view'): AccessibleIds {
  const access = resolveAccess(who);
  const key = `ids:${type}:${minLevel}`;
  const cached = access.memo.get(key) as AccessibleIds | undefined;
  if (cached) return cached;

  const r = reach(access, type, minLevel);
  let result: AccessibleIds;
  if (r.all) {
    result = { all: true };
  } else {
    const ids = new Set(r.ids);
    if (r.tags.length) {
      const tagged = getDb().all<{ id: string }>(sql`${serversTaggedSql(access.orgId, r.tags)}`);
      for (const row of tagged) ids.add(row.id);
    }
    result = { all: false, ids: [...ids] };
  }
  access.memo.set(key, result);
  return result;
}

/**
 * A WHERE fragment limiting `column` (any column holding ids of `type` —
 * servers.id, cronJobs.serverId…) to what the subject may see. Undefined when
 * nothing needs filtering, which drizzle's `and()` simply skips:
 *
 *   .where(and(eq(servers.orgId, req.orgId), accessibleFilter(req, 'server', servers.id)))
 */
export function accessibleFilter(
  who: AccessSubject,
  type: ResourceType,
  column: SQLiteColumn,
  minLevel: AccessLevel = 'view',
): SQL | undefined {
  const access = resolveAccess(who);
  const r = reach(access, type, minLevel);
  if (r.all) return undefined;
  const parts: SQL[] = [];
  if (r.ids.length) parts.push(inArray(column, r.ids));
  if (r.tags.length) parts.push(sql`${column} in (${serversTaggedSql(access.orgId, r.tags)})`);
  // inArray with an empty list compiles to a constant false
  if (!parts.length) return inArray(column, []);
  return parts.length === 1 ? parts[0] : or(...parts);
}

/** In-memory counterpart of `accessibleFilter` for rows already loaded. */
export function filterAccessible<T>(
  who: AccessSubject,
  type: ResourceType,
  rows: T[],
  idOf: (row: T) => string,
  minLevel: AccessLevel = 'view',
): T[] {
  const ids = accessibleIds(who, type, minLevel);
  if (ids.all) return rows;
  const allowed = new Set(ids.ids);
  return rows.filter((row) => allowed.has(idOf(row)));
}

/** True when `id` is a resource of `type` in `orgId`. */
export function resourceExists(orgId: string, type: ResourceType, id: string): boolean {
  const { table, id: idColumn, orgId: orgColumn } = RESOURCE_TABLES[type];
  return !!getDb()
    .select({ id: idColumn })
    .from(table)
    .where(and(eq(idColumn, id), eq(orgColumn, orgId)))
    .get();
}
