import type { FastifyReply, FastifyRequest } from 'fastify';
import { KUBE_CLUSTER_SCOPE, kubePermissions, type KubeCapability, type KubePermissions, type Role } from '@smt/shared';
import { levelFor } from '../auth/access/authorize.js';
import { roleForLevel, roleForModuleLevel } from '../auth/access/levels.js';
import { moduleLevel } from '../auth/access/modules.js';
import type { AccessSubject } from '../auth/access/resolve.js';
import { kubeSettings } from './settings.js';

/**
 * Kubernetes role gates (spec §7; the matrix lives in @smt/shared
 * `kubePermissions`, so the UI hides exactly what the server refuses). On a
 * given cluster the matrix is read at the caller's level there (custom roles
 * spec §5): `operate` as an operator, org toggles included, `manage` as an
 * admin — and in a namespace, at their level in that namespace, so a role
 * narrowed to `shop` operates there and nowhere else. Levels are capped for
 * read-only API tokens. Cluster access is checked first — a cluster the
 * caller cannot access is a 404 whatever their role. The cluster's own
 * credential bounds the rest: RBAC on the cluster may still say no.
 */

type Caller = Pick<FastifyRequest, 'orgId' | 'user'> & Partial<Pick<FastifyRequest, 'apiTokenReadOnly'>>;

/**
 * The caller's level on `clusterId` as a role when they can reach it, else
 * (no cluster: adding one, the fleet) their level on the Kubernetes module —
 * `manage` there is what adds clusters (unified roles spec §3.1). With
 * `namespace`, only grants covering that namespace count; one none covers
 * reads as the least, a viewer.
 */
function roleOn(req: Caller, clusterId?: string, namespace?: string): Role {
  // The request itself, so the answer is shared with the route's own access check
  if (clusterId) {
    const found = levelFor(req as AccessSubject, 'cluster', clusterId, { namespace });
    if (found) return roleForLevel(found.level);
    if (namespace !== undefined) return 'viewer';
  }
  return roleForModuleLevel(moduleLevel(req as AccessSubject, 'kubernetes'));
}

export function kubePermissionsFor(req: Caller, clusterId?: string, namespace?: string): KubePermissions {
  return kubePermissions(roleOn(req, clusterId, namespace), kubeSettings(req.orgId));
}

export function kubeCan(req: Caller, capability: KubeCapability, clusterId?: string, namespace?: string): boolean {
  return kubePermissionsFor(req, clusterId, namespace)[capability];
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
  configure: 'Managing clusters needs manage access to Kubernetes',
};

/** Where a route names the namespace it acts in: the `:ns` route parameter, or `namespace` in the JSON body. */
export type NamespaceSource = 'param' | 'body';

/** The namespace a request acts in, if any; the cluster-scope placeholder (`_`) is none. */
function namespaceOf(req: FastifyRequest, from: NamespaceSource | undefined): string | undefined {
  if (!from) return undefined;
  const source = (from === 'param' ? req.params : req.body) as Record<string, unknown> | undefined;
  const value = source?.[from === 'param' ? 'ns' : 'namespace'];
  return typeof value === 'string' && value !== KUBE_CLUSTER_SCOPE ? value : undefined;
}

/**
 * preHandler gate: `{ preHandler: requireKube('logs', 'param') }`. Must run
 * after `requireAuth`. The cluster is the `:id` route parameter, when there
 * is one: one the caller cannot reach is a 404 (custom roles spec §6), and
 * so is a namespace none of their grants covers. With a namespace source the
 * matrix is read at the caller's level in that namespace; without, on the
 * cluster as a whole. Sends 403 with the reason when the capability is missing.
 */
export function requireKube(capability: KubeCapability, namespaceFrom?: NamespaceSource) {
  return async function kubeGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
    const clusterId = (req.params as { id?: string } | undefined)?.id;
    const namespace = namespaceOf(req, namespaceFrom);
    if (clusterId) {
      if (!levelFor(req, 'cluster', clusterId)) return reply.status(404).send({ error: 'Cluster not found' });
      if (namespace !== undefined && !levelFor(req, 'cluster', clusterId, { namespace })) {
        return reply.status(404).send({ error: 'Not found' });
      }
    }
    if (!kubeCan(req, capability, clusterId, namespace)) return reply.status(403).send({ error: REFUSED[capability] });
  };
}
