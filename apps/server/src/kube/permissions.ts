import type { FastifyReply, FastifyRequest } from 'fastify';
import { kubePermissions, type KubeCapability, type KubePermissions, type Role } from '@smt/shared';
import { levelFor } from '../auth/access/authorize.js';
import { roleForLevel } from '../auth/access/levels.js';
import type { AccessSubject } from '../auth/access/resolve.js';
import { kubeSettings } from './settings.js';

/**
 * Kubernetes role gates (spec §7; the matrix lives in @smt/shared
 * `kubePermissions`, so the UI hides exactly what the server refuses). On a
 * given cluster the matrix is read at the caller's level there (custom roles
 * spec §5): `operate` as an operator, org toggles included, `manage` as an
 * admin. `req.role` is already capped for read-only API tokens, and so are
 * levels. Cluster access is checked separately and first — a cluster the
 * caller cannot access is a 404 whatever their role. The cluster's own
 * credential bounds the rest: RBAC on the cluster may still say no.
 */

type Caller = Pick<FastifyRequest, 'orgId' | 'role'> & Partial<Pick<FastifyRequest, 'user' | 'apiTokenReadOnly'>>;

/** The caller's level on `clusterId` as a role when they can reach it, else their base role. */
function roleOn(req: Caller, clusterId?: string): Role {
  // The request itself, so the answer is shared with the route's own access check
  if (clusterId && req.user) {
    const found = levelFor(req as AccessSubject, 'cluster', clusterId);
    if (found) return roleForLevel(found.level);
  }
  return req.role as Role;
}

export function kubePermissionsFor(req: Caller, clusterId?: string): KubePermissions {
  return kubePermissions(roleOn(req, clusterId), kubeSettings(req.orgId));
}

export function kubeCan(req: Caller, capability: KubeCapability, clusterId?: string): boolean {
  return kubePermissionsFor(req, clusterId)[capability];
}

const REFUSED: Record<KubeCapability, string> = {
  view: 'You cannot view this cluster',
  logs: 'Pod logs need the operator role or higher',
  yaml: 'The YAML view needs the operator role or higher',
  scale: 'Scaling and restarting workloads is turned off for operators, or needs the operator role',
  deletePod: 'Deleting pods is turned off for operators, or needs the operator role',
  rollback: 'Rolling back needs the admin role',
  cordon: 'Cordoning nodes needs the admin role',
  exec: 'Opening a shell in a pod is not allowed for your role',
  configure: 'Managing clusters needs the admin role',
};

/**
 * preHandler gate: `{ preHandler: requireKube('logs') }`. Must run after
 * `requireAuth`. The cluster is the `:id` route parameter, when there is one.
 * Sends 403 with the reason when the capability is missing.
 */
export function requireKube(capability: KubeCapability) {
  return async function kubeGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.role) return reply.status(401).send({ error: 'Unauthorized' });
    const clusterId = (req.params as { id?: string } | undefined)?.id;
    if (!kubeCan(req, capability, clusterId)) return reply.status(403).send({ error: REFUSED[capability] });
  };
}
