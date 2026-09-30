import type { FastifyReply, FastifyRequest } from 'fastify';
import { dockerPermissions, type DockerCapability, type DockerPermissions, type Role } from '@smt/shared';
import { dockerSettings } from './settings.js';

/**
 * Docker role gates (the matrix lives in @smt/shared `dockerPermissions`, so
 * the UI hides exactly what the server refuses). `req.role` is already capped
 * for read-only API tokens, so a token never gets more than a viewer here.
 * Per-server access is checked separately and first — a server the caller
 * cannot access is a 404 whatever their role.
 */

export function permissionsFor(req: Pick<FastifyRequest, 'orgId' | 'role'>): DockerPermissions {
  return dockerPermissions(req.role as Role, dockerSettings(req.orgId));
}

export function dockerCan(req: Pick<FastifyRequest, 'orgId' | 'role'>, capability: DockerCapability): boolean {
  return permissionsFor(req)[capability];
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
 * `requireAuth`. Sends 403 with the reason when the capability is missing.
 */
export function requireDocker(capability: DockerCapability) {
  return async function dockerGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.role) return reply.status(401).send({ error: 'Unauthorized' });
    if (!dockerCan(req, capability)) return reply.status(403).send({ error: REFUSED[capability] });
  };
}
