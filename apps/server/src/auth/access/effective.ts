import { asc, eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { EffectiveAccessEntry, ResourceSummary, ResourceType } from '@smt/shared';
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
import { contributionsFor, foldContributions } from './authorize.js';
import { RESOURCE_TABLES } from './filter.js';
import { resolveAccess, wholeResource, type AccessSubject } from './resolve.js';

/**
 * Every resource of a type with the subject's level on each (custom roles
 * spec §7: the member detail's "Effective access", and the levels the UI
 * reads to hide what a member may not do). One pass over the type's rows
 * with the subject's access resolved once, rather than a lookup per row.
 */

/** Name and a short detail per type, as pickers and lists show them. */
const COLUMNS: Record<ResourceType, { name: SQLiteColumn; detail: SQLiteColumn | SQL | null }> = {
  server: { name: servers.name, detail: servers.host },
  cluster: { name: kubeClusters.name, detail: kubeClusters.apiUrl },
  ftp_connection: { name: ftpConnections.name, detail: ftpConnections.host },
  storage_connection: { name: storageConnections.name, detail: storageConnections.provider },
  cloud_account: { name: cloudAccounts.name, detail: cloudAccounts.provider },
  saved_command: { name: savedCommands.name, detail: null },
  cron_job: { name: cronJobs.name, detail: cronJobs.schedule },
};

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const tags: unknown = JSON.parse(raw);
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Every resource of `type` in `orgId`, by name. Servers carry their tags. */
export function listResources(orgId: string, type: ResourceType): ResourceSummary[] {
  const { table, id, orgId: orgColumn } = RESOURCE_TABLES[type];
  const { name, detail } = COLUMNS[type];
  const rows = getDb()
    .select({
      id,
      name,
      ...(detail && { detail }),
      ...(type === 'server' && { tags: servers.tags }),
    })
    .from(table)
    .where(eq(orgColumn, orgId))
    .orderBy(asc(name))
    .all() as { id: string; name: string; detail?: string | null; tags?: string }[];
  return rows.map((r) => ({
    type,
    id: r.id,
    name: r.name,
    ...(r.detail !== undefined && { detail: r.detail }),
    ...(type === 'server' && { tags: parseTags(r.tags) }),
  }));
}

/**
 * The subject's level, reasons and (clusters) namespaces on every resource of
 * `type` they reach, on the resource as a whole (a namespace-narrowed cluster
 * grant counts as `view` there, as in `levelFor`). Resources they cannot
 * reach are left out.
 */
export function effectiveAccessList(who: AccessSubject, type: ResourceType): EffectiveAccessEntry[] {
  const access = resolveAccess(who);
  if (!access.active) return [];
  const entries: EffectiveAccessEntry[] = [];
  for (const resource of listResources(access.orgId, type)) {
    const found = contributionsFor(access, type, resource.id, resource.tags ?? []).map(wholeResource);
    const folded = foldContributions(access, found);
    if (!folded) continue;
    entries.push({
      resourceType: type,
      resourceId: resource.id,
      name: resource.name,
      level: folded.level,
      via: folded.via,
      ...(type === 'cluster' && { namespaces: folded.namespaces }),
    });
  }
  return entries;
}
