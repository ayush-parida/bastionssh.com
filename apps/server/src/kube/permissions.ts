import type { FastifyReply, FastifyRequest } from 'fastify';
import { kubePermissions, type KubeCapability, type KubePermissions, type Role } from '@smt/shared';
import { kubeSettings } from './settings.js';

/**
 * Kubernetes role gates (spec §7; the matrix lives in @smt/shared
 * `kubePermissions`, so the UI hides exactly what the server refuses).
 * `req.role` is already capped for read-only API tokens. Cluster access is
 * checked separately and first — a cluster the caller cannot access is a 404
 * whatever their role. The cluster's own credential bounds the rest: RBAC on
 * the cluster may still say no.
 */

export function kubePermissionsFor(req: Pick<FastifyRequest, 'orgId' | 'role'>): KubePermissions {
  return kubePermissions(req.role as Role, kubeSettings(req.orgId));
}

export function kubeCan(req: Pick<FastifyRequest, 'orgId' | 'role'>, capability: KubeCapability): boolean {
  return kubePermissionsFor(req)[capability];
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
 * `requireAuth`. Sends 403 with the reason when the capability is missing.
 */
export function requireKube(capability: KubeCapability) {
  return async function kubeGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.role) return reply.status(401).send({ error: 'Unauthorized' });
    if (!kubeCan(req, capability)) return reply.status(403).send({ error: REFUSED[capability] });
  };
}
