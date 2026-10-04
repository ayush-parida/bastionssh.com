import type { FastifyReply } from 'fastify';
import { and, isNull, or, type SQL } from 'drizzle-orm';
import { cronJobs, savedCommands } from '../db/schema.js';
import { authorize, type AuthorizeResult } from './access/authorize.js';
import { accessibleFilter, accessibleIds } from './access/filter.js';
import { resolveAccess, type AccessSubject } from './access/resolve.js';
import { rank, type Role } from './middleware.js';

/**
 * Saved commands and cron jobs (custom roles spec §2.7, §5). Both are
 * resources of their own — `view` to see one, `operate` to run it (and to
 * switch a job on or off), `manage` to edit or delete it — and both follow
 * the servers they touch: a command bound to a server is visible only with
 * that server, running one needs `operate` on every target server, and a cron
 * job is visible only with its server and runs, as its creator, only while
 * the creator can operate the job and the server.
 *
 * Members with scope `all` keep exactly what their base role gave before
 * roles existed (spec §2.1): operators could edit saved commands and edit or
 * delete cron jobs, which on a resource is `manage`. Those rights are kept for
 * them here and nowhere else; anything a custom role or grant gives follows §5.
 */

/**
 * Saved commands the subject may see: a `view` grant on the command, and
 * either no bound server or a bound server they can see. A command's text is
 * operational detail of the server it belongs to.
 */
export function savedCommandFilter(who: AccessSubject): SQL | undefined {
  const own = accessibleFilter(who, 'saved_command', savedCommands.id);
  const server = accessibleFilter(who, 'server', savedCommands.serverId);
  return and(own, server ? or(isNull(savedCommands.serverId), server) : undefined);
}

/** Cron jobs the subject may see: `view` on the job and on its server. */
export function cronJobFilter(who: AccessSubject): SQL | undefined {
  return and(
    accessibleFilter(who, 'cron_job', cronJobs.id),
    accessibleFilter(who, 'server', cronJobs.serverId),
  );
}

/**
 * True when a scope-`all` member's base role (at least `minimum`) allowed this
 * before custom roles. Read-only API tokens never get it; they read only.
 */
export function baseRoleAllows(who: AccessSubject, minimum: Role): boolean {
  const access = resolveAccess(who);
  return access.active && access.scope === 'all' && !access.readOnly && rank(access.role) >= rank(minimum);
}

/**
 * May the subject create a saved command or cron job? A new one is managed
 * by whoever made it, so they need `manage` on every resource of the type —
 * or, with scope `all`, the operator role, as before.
 */
export function mayCreate(who: AccessSubject, type: 'saved_command' | 'cron_job'): boolean {
  return baseRoleAllows(who, 'operator') || accessibleIds(who, type, 'manage').all;
}

/** "Not found" or "needs more access", for a decision that did not allow. */
export function denyAccess(reply: FastifyReply, result: AuthorizeResult, label: string): FastifyReply {
  if (result.status === 404) return reply.status(404).send({ error: `${label} not found` });
  return reply.status(403).send({
    error: `This needs ${result.required} access to the ${label.toLowerCase()} (you have ${result.level})`,
  });
}

/**
 * The operate check on servers a command or job will run on: undefined when
 * the subject can operate every one, otherwise the decision that refused
 * (404 before 403, so a hidden server is never confirmed by its 403).
 */
export function refuseServers(who: AccessSubject, serverIds: string[]): AuthorizeResult | undefined {
  const results = [...new Set(serverIds)].map((id) => authorize(who, 'server', id, 'run_command'));
  return results.find((r) => r.status === 404) ?? results.find((r) => !r.ok);
}
