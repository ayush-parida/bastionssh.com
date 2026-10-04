import type { FastifyReply, FastifyRequest } from 'fastify';
import { dockerPermissions, type DockerCapability, type DockerPermissions, type Role } from '@smt/shared';
import { levelFor } from '../auth/access/authorize.js';
import { roleForLevel } from '../auth/access/levels.js';
import type { AccessSubject } from '../auth/access/resolve.js';
import { dockerSettings } from './settings.js';

/**
 * Docker role gates (the matrix lives in @smt/shared `dockerPermissions`, so
 * the UI hides exactly what the server refuses). On a given server the
 * matrix is read at the caller's level there (custom roles spec §5):
 * `operate` as an operator, org toggles included, `manage` as an admin — so
 * a custom role can raise a member on its servers, and a role-scoped member
 * gets no more than their grants say. `req.role` is already capped for
 * read-only API tokens, and so are levels, so a token never gets more than a
 * viewer here. Per-server access is checked separately and first — a server
 * the caller cannot access is a 404 whatever their role.
 */

type Caller = Pick<FastifyRequest, 'orgId' | 'role'> & Partial<Pick<FastifyRequest, 'user' | 'apiTokenReadOnly'>>;

/**
 * The role whose matrix applies: the caller's level on `serverId` when they
 * can reach it, else their base role (the route then answers 404 for a
 * server they cannot reach, as before).
 */
function roleOn(req: Caller, serverId?: string): Role {
  // The request itself, so the answer is shared with the route's own access check
  if (serverId && req.user) {
    const found = levelFor(req as AccessSubject, 'server', serverId);
    if (found) return roleForLevel(found.level);
  }
  return req.role as Role;
}

export function permissionsFor(req: Caller, serverId?: string): DockerPermissions {
  return dockerPermissions(roleOn(req, serverId), dockerSettings(req.orgId));
}

export function dockerCan(req: Caller, capability: DockerCapability, serverId?: string): boolean {
  return permissionsFor(req, serverId)[capability];
}

const REFUSED: Record<DockerCapability, string> = {
  view: 'You cannot view Docker on this server',
  inspect: 'Container logs, stats and details need the operator role or higher',
  control: 'Starting and stopping containers needs the operator role or higher',
  exec: 'Opening a shell in a container is not allowed for your role',
  remove: 'Removing containers and images is not allowed for your role',
  pull: 'Pulling images needs the operator role or higher',
  prune: 'Pruning is turned off, or needs the admin role',
  revealEnv: 'Revealing environment variables needs the admin role',
  configure: 'Docker settings need the admin role',
};

/**
 * preHandler gate: `{ preHandler: requireDocker('inspect') }`. Must run after
 * `requireAuth`. The server is the `:id` route parameter, when there is one.
 * Sends 403 with the reason when the capability is missing.
 */
export function requireDocker(capability: DockerCapability) {
  return async function dockerGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.role) return reply.status(401).send({ error: 'Unauthorized' });
    const serverId = (req.params as { id?: string } | undefined)?.id;
    if (!dockerCan(req, capability, serverId)) return reply.status(403).send({ error: REFUSED[capability] });
  };
}
