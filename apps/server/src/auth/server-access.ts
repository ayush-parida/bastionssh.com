import type { FastifyRequest } from 'fastify';
import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { getDb } from '../db/index.js';
import { memberServerAccess, memberships, savedCommands, servers } from '../db/schema.js';
import { rank } from './middleware.js';

/**
 * Per-server access for `restricted` members. The single place that decides
 * whether someone may see or touch a server — every route that takes a server
 * id or lists servers goes through here, so the rule cannot drift per route.
 *
 * Owners and admins always see everything. Anyone else sees everything unless
 * their membership is `restricted`, in which case only the servers granted in
 * `member_server_access`. A server someone cannot access is reported as not
 * found, never as forbidden, so its existence does not leak.
 */

/** Who is asking. A FastifyRequest after `requireAuth` works as-is. */
export type AccessSubject =
  | Pick<FastifyRequest, 'orgId' | 'user'>
  | { orgId: string; userId: string; role?: string };

function subjectOf(who: AccessSubject): { orgId: string; userId: string } {
  return 'userId' in who ? { orgId: who.orgId, userId: who.userId } : { orgId: who.orgId, userId: who.user.id };
}

export type ServerScope = { all: true } | { all: false; serverIds: string[] };

/**
 * What the subject may see. Reads the membership rather than trusting a passed
 * role, so a read-only token (which narrows `req.role`) does not turn an admin
 * into a restricted member, and a stale role cannot widen access.
 */
export function serverScope(who: AccessSubject): ServerScope {
  const { orgId, userId } = subjectOf(who);
  const db = getDb();
  const membership = db
    .select({ role: memberships.role, status: memberships.status, serverAccess: memberships.serverAccess })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .get();

  if (!membership || membership.status !== 'active') return { all: false, serverIds: [] };
  if (rank(membership.role) >= rank('admin') || membership.serverAccess !== 'restricted') {
    return { all: true };
  }

  const serverIds = db
    .select({ serverId: memberServerAccess.serverId })
    .from(memberServerAccess)
    .where(and(eq(memberServerAccess.orgId, orgId), eq(memberServerAccess.userId, userId)))
    .all()
    .map((row) => row.serverId);
  return { all: false, serverIds };
}

/** True when the server exists in the subject's org and they may use it. */
export function canAccessServer(who: AccessSubject, serverId: string): boolean {
  const { orgId } = subjectOf(who);
  const exists = getDb()
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.orgId, orgId)))
    .get();
  if (!exists) return false;
  const scope = serverScope(who);
  return scope.all || scope.serverIds.includes(serverId);
}

/**
 * A WHERE fragment limiting `column` (any server-id column — servers.id,
 * cronJobs.serverId, serverAlerts.serverId…) to accessible servers. Undefined
 * when nothing needs filtering, which drizzle's `and()` simply skips:
 *
 *   .where(and(eq(servers.orgId, req.orgId), accessibleServerFilter(req, servers.id)))
 */
export function accessibleServerFilter(who: AccessSubject, column: SQLiteColumn): SQL | undefined {
  const scope = serverScope(who);
  if (scope.all) return undefined;
  // inArray with an empty list compiles to a constant false
  return inArray(column, scope.serverIds);
}

/**
 * Saved commands the subject may see: those not bound to a server, plus those
 * bound to a server they can access. A command's text is operational detail of
 * the server it belongs to, so a restricted member must not read it for others.
 */
export function accessibleSavedCommandFilter(who: AccessSubject): SQL | undefined {
  const filter = accessibleServerFilter(who, savedCommands.serverId);
  return filter ? or(isNull(savedCommands.serverId), filter) : undefined;
}

/** In-memory counterpart of `accessibleServerFilter` for rows already loaded. */
export function filterAccessible<T>(who: AccessSubject, rows: T[], serverIdOf: (row: T) => string): T[] {
  const scope = serverScope(who);
  if (scope.all) return rows;
  const allowed = new Set(scope.serverIds);
  return rows.filter((row) => allowed.has(serverIdOf(row)));
}
