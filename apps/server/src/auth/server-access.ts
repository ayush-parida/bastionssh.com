import { gt, isNull, or, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { memberServerAccess } from '../db/schema.js';
import { authorize, levelFor, requireResource } from './access/authorize.js';
import type { ResourceAction } from './access/levels.js';
import {
  accessibleFilter,
  accessibleIds,
  filterAccessible as filterAccessibleRows,
} from './access/filter.js';
import type { AccessSubject } from './access/resolve.js';
import { savedCommandFilter } from './command-access.js';

export type { AccessSubject } from './access/resolve.js';

/**
 * Per-server access. The single place that decides whether someone may see
 * or touch a server — every route that takes a server id or lists servers
 * goes through here, so the rule cannot drift per route. Since custom roles
 * these are thin wrappers over the access engine (auth/access/), kept so
 * their many call sites need not change.
 *
 * Owners and admins always see everything. Anyone else sees everything when
 * their membership's scope is `all` (as before), and otherwise only the
 * servers their custom roles and personal grants cover — by id, "all
 * servers", or a tag. A server someone cannot access is reported as not
 * found, never as forbidden, so its existence does not leak.
 *
 * A grant may carry an expiry. Once past it the grant stops counting here at
 * once; the expiry sweep (auth/access-grants.ts) later deletes the row and
 * closes whatever is still open on the server.
 */

/**
 * WHERE fragment for rows of member_server_access still in force at `now`:
 * permanent, or expiring later. Expiries are ISO-8601 UTC strings, so they
 * compare as text.
 */
export function activeGrantFilter(now: string = new Date().toISOString()): SQL {
  return or(isNull(memberServerAccess.expiresAt), gt(memberServerAccess.expiresAt, now))!;
}

export type ServerScope = { all: true } | { all: false; serverIds: string[] };

/**
 * What the subject may see. Reads the membership rather than trusting a passed
 * role, so a read-only token (which narrows `req.role`) does not turn an admin
 * into a restricted member, and a stale role cannot widen access.
 */
export function serverScope(who: AccessSubject): ServerScope {
  const ids = accessibleIds(who, 'server');
  return ids.all ? { all: true } : { all: false, serverIds: ids.ids };
}

/** True when the server exists in the subject's org and they may use it. */
export function canAccessServer(who: AccessSubject, serverId: string): boolean {
  return levelFor(who, 'server', serverId) !== null;
}

/**
 * A WHERE fragment limiting `column` (any server-id column — servers.id,
 * cronJobs.serverId, serverAlerts.serverId…) to accessible servers. Undefined
 * when nothing needs filtering, which drizzle's `and()` simply skips:
 *
 *   .where(and(eq(servers.orgId, req.orgId), accessibleServerFilter(req, servers.id)))
 */
export function accessibleServerFilter(who: AccessSubject, column: SQLiteColumn): SQL | undefined {
  return accessibleFilter(who, 'server', column);
}

/**
 * Saved commands the subject may see: those they reach as saved commands,
 * and of those only the ones not bound to a server or bound to a server they
 * can access. A command's text is operational detail of the server it belongs
 * to, so a restricted member must not read it for others.
 */
export function accessibleSavedCommandFilter(who: AccessSubject): SQL | undefined {
  return savedCommandFilter(who);
}

/** In-memory counterpart of `accessibleServerFilter` for rows already loaded. */
export function filterAccessible<T>(who: AccessSubject, rows: T[], serverIdOf: (row: T) => string): T[] {
  return filterAccessibleRows(who, 'server', rows, serverIdOf);
}

/**
 * preHandler gate for a server route: `{ preHandler: requireServer('terminal') }`
 * — 404 when the caller cannot reach the server (`param`, default `id`), 403
 * when they see it but the action needs a higher level (spec §5).
 */
export function requireServer(action: ResourceAction<'server'>, param = 'id') {
  return requireResource('server', action, { param });
}

/** Why the subject may not do `action` on a server, for checks inside a handler; null when they may. */
export function serverDenial(
  who: AccessSubject,
  serverId: string,
  action: ResourceAction<'server'>,
): { status: 403 | 404; error: string } | null {
  const result = authorize(who, 'server', serverId, action);
  if (result.ok) return null;
  if (result.status === 404) return { status: 404, error: 'Server not found' };
  return { status: 403, error: `This needs ${result.required} access to the server (you have ${result.level})` };
}

/** True when the subject may do `action` on the server (it exists in their org and their level suffices). */
export function canOnServer(who: AccessSubject, serverId: string, action: ResourceAction<'server'>): boolean {
  return authorize(who, 'server', serverId, action).ok;
}
