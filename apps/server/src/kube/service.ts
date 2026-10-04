import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { KubeConnectVia, KubePermissions, KubeSettings } from '@smt/shared';
import { canAccessCluster, clusterNamespaces } from '../auth/cluster-access.js';
import { resolveAccess } from '../auth/access/resolve.js';
import { getDb } from '../db/index.js';
import { kubeClusters } from '../db/schema.js';
import { vault } from '../vault/index.js';
import type { CacheSource } from './cache.js';
import { KubeClient, type KubeIdentity } from './client.js';
import { KubeError, isRouteError } from './errors.js';
import { apiEndpoint, type KubeCredential } from './kubeconfig.js';
import { kubePermissionsFor } from './permissions.js';
import { kubeSettings } from './settings.js';
import { openApiSocket, type ApiRoute } from './transport.js';

/**
 * The one way a Kubernetes route reaches a cluster. {@link withKubeClient}:
 *
 * 1. answers 404 for a cluster the caller cannot access, or that is not in
 *    their org (cluster-access.ts) — never 403, so ids do not leak;
 * 2. decrypts the credential (it never leaves this module's callers' scope);
 * 3. hands the route a {@link KubeClient} over the cluster's route
 *    (transport.ts), with impersonation headers when the cluster has it on,
 *    plus the caller's permissions, org settings and namespace rules;
 * 4. closes the client when the callback settles.
 *
 * Later phases (graph, actions, logs, exec, AI tools, fleet) build on this,
 * so access checks and the namespace allowlist cannot be skipped.
 */

export type ClusterRow = typeof kubeClusters.$inferSelect;

type Caller = Pick<FastifyRequest, 'orgId' | 'user'> & Partial<Pick<FastifyRequest, 'apiTokenReadOnly'>>;

export interface KubeContext {
  cluster: ClusterRow;
  client: KubeClient;
  /** For the watch cache (cache.ts): shared per cluster, or per user when impersonating. */
  source: CacheSource;
  /** On the cluster as a whole, where a namespace-narrowed grant gives `view` at most. */
  permissions: KubePermissions;
  /** In one namespace, at the caller's level there; null (cluster-scoped objects) = `permissions`. */
  permissionsIn: (namespace: string | null | undefined) => KubePermissions;
  settings: KubeSettings;
  /**
   * The namespaces the caller may see: the cluster's allowlist, narrowed to
   * those their grants cover when the grants name namespaces (custom roles
   * spec §2.4); null = every namespace.
   */
  allowlist: string[] | null;
  /** True when the caller may see objects in `namespace` (cluster-scoped objects: null). */
  namespaceAllowed: (namespace: string | null | undefined) => boolean;
}

export function parseAllowlist(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * The namespaces of `cluster` the caller may see: its allowlist, intersected
 * with the namespaces their grants narrow it to. Null = every namespace.
 */
export function callerNamespaces(
  req: Pick<FastifyRequest, 'orgId' | 'user'>,
  cluster: Pick<ClusterRow, 'id' | 'namespacesAllowlist'>,
): string[] | null {
  const allowlist = parseAllowlist(cluster.namespacesAllowlist);
  const granted = clusterNamespaces(req, cluster.id);
  if (!granted) return allowlist;
  return allowlist ? allowlist.filter((ns) => granted.includes(ns)) : granted;
}

/** The cluster row, if the caller may use it; throws 404 otherwise. */
export function kubeCluster(req: Pick<FastifyRequest, 'orgId' | 'user'>, clusterId: string): ClusterRow {
  if (!canAccessCluster(req, clusterId)) throw new KubeError('Cluster not found', 404);
  const row = getDb()
    .select()
    .from(kubeClusters)
    .where(and(eq(kubeClusters.id, clusterId), eq(kubeClusters.orgId, req.orgId)))
    .get();
  if (!row) throw new KubeError('Cluster not found', 404);
  return row;
}

/** Decrypt a cluster's stored credential. */
export async function clusterCredential(row: Pick<ClusterRow, 'id' | 'authType' | 'encryptedCredential'>): Promise<KubeCredential> {
  const plain = await vault.decrypt(row.encryptedCredential, row.id);
  if (row.authType === 'token') return { type: 'token', token: plain };
  const parsed = JSON.parse(plain) as { cert: string; key: string };
  return { type: 'cert', cert: parsed.cert, key: parsed.key };
}

/** Serialize a credential for `vault.encrypt` (the inverse of {@link clusterCredential}). */
export function credentialPlaintext(credential: KubeCredential): string {
  return credential.type === 'token' ? credential.token : JSON.stringify({ cert: credential.cert, key: credential.key });
}

/**
 * The group a person is impersonated as: what their roles amount to as a base
 * role (owner, admin, operator or viewer — auth/access/levels.ts
 * `legacyRoleFor`), so RBAC bindings made for `bastion:<role>` before unified
 * roles keep matching; a read-only API token as a viewer, as before. A name
 * for the cluster's RBAC, not an access decision here.
 */
function impersonatedRole(req: Caller): string {
  const access = resolveAccess(req);
  return access.readOnly ? 'viewer' : access.role;
}

/** What the API server sees when impersonation is on: the person and their role. */
export function identityOf(req: Caller): KubeIdentity {
  return { user: `bastion:${req.user.email}`, groups: [`bastion:${impersonatedRole(req)}`] };
}

export interface ClientParams {
  orgId: string;
  apiUrl: string;
  caData: string | null;
  credential: KubeCredential;
  connectVia: KubeConnectVia;
  viaServerId: string | null;
  viaAgentId: string | null;
  impersonate?: KubeIdentity | null;
  actorUserId?: string;
}

/** A client for a cluster's connection details (saved or still being added). */
export function clientFor(params: ClientParams): KubeClient {
  const route: ApiRoute = {
    orgId: params.orgId,
    apiUrl: params.apiUrl,
    caData: params.caData,
    credential: params.credential,
    connectVia: params.connectVia,
    viaServerId: params.viaServerId,
    viaAgentId: params.viaAgentId,
    actorUserId: params.actorUserId,
  };
  const url = new URL(params.apiUrl);
  return new KubeClient(() => openApiSocket(route), {
    host: url.host,
    basePath: apiEndpoint(params.apiUrl).basePath,
    token: params.credential.type === 'token' ? params.credential.token : null,
    impersonate: params.impersonate ?? null,
  });
}

/** A client for a saved cluster, as `req`'s caller. */
export async function clusterClient(row: ClusterRow, req: Caller): Promise<KubeClient> {
  return clientFor({
    orgId: row.orgId,
    apiUrl: row.apiUrl,
    caData: row.caData,
    credential: await clusterCredential(row),
    connectVia: row.connectVia as KubeConnectVia,
    viaServerId: row.viaServerId,
    viaAgentId: row.viaAgentId,
    impersonate: row.impersonate ? identityOf(req) : null,
    actorUserId: req.user.id,
  });
}

/**
 * The cache source for a cluster as `req`'s caller: one shared cache per
 * cluster, or — with impersonation on — one per user and role, since the
 * API server answers each of them differently.
 */
export async function cacheSourceFor(row: ClusterRow, req: Caller): Promise<CacheSource> {
  const credential = await clusterCredential(row);
  const impersonate = row.impersonate ? identityOf(req) : null;
  // Cache entries carry the cluster's updatedAt, so an edit never serves old data from another route
  const version = row.updatedAt;
  return {
    key: impersonate ? `${row.id}@${version}:${req.user.id}:${impersonate.groups.join(',')}` : `${row.id}@${version}`,
    orgId: row.orgId,
    clusterId: row.id,
    identityUserId: impersonate ? req.user.id : null,
    client: () =>
      clientFor({
        orgId: row.orgId,
        apiUrl: row.apiUrl,
        caData: row.caData,
        credential,
        connectVia: row.connectVia as KubeConnectVia,
        viaServerId: row.viaServerId,
        viaAgentId: row.viaAgentId,
        impersonate,
        actorUserId: req.user.id,
      }),
  };
}

/** What a member narrowed to some namespaces is told when a routed cluster cannot be reached. */
export const UNREACHABLE_ROUTED = 'The cluster could not be reached';

/** A {@link KubeError} standing in for a route error a caller may not see; `original` is for admin records only. */
export class RedactedKubeError extends KubeError {
  constructor(
    readonly original: unknown,
    statusCode: number,
  ) {
    super(UNREACHABLE_ROUTED, statusCode);
  }
}

/**
 * `err` as `req`'s caller may see it. A member whose access to the cluster is
 * narrowed to some namespaces learns nothing of how it is reached (custom
 * roles spec §5), so a failure on the server or agent route — whose message
 * names that server or agent — becomes a plain "could not be reached", with
 * the same status. Everyone else gets the error as it is.
 */
export function routeSafeError(req: Pick<FastifyRequest, 'orgId' | 'user'>, cluster: Pick<ClusterRow, 'id' | 'connectVia'>, err: unknown): unknown {
  if (cluster.connectVia === 'direct' || !isRouteError(err) || !clusterNamespaces(req, cluster.id)) return err;
  const status = (err as { statusCode?: unknown }).statusCode;
  return new RedactedKubeError(err, typeof status === 'number' && status >= 400 ? status : 502);
}

/** The error a route failed with before {@link routeSafeError} redacted it, for the cluster's own records. */
export function unredacted(err: unknown): unknown {
  return err instanceof RedactedKubeError ? err.original : err;
}

/**
 * Run `fn` with a client for `clusterId` (see the module comment). The
 * client is closed when `fn` settles. Failures come out as the caller may
 * see them ({@link routeSafeError}).
 */
export async function withKubeClient<T>(req: Caller, clusterId: string, fn: (ctx: KubeContext) => Promise<T>): Promise<T> {
  const cluster = kubeCluster(req, clusterId);
  const allowlist = callerNamespaces(req, cluster);
  const allowed = allowlist ? new Set(allowlist) : null;
  try {
    const client = await clusterClient(cluster, req);
    try {
      return await fn({
        cluster,
        client,
        source: await cacheSourceFor(cluster, req),
        permissions: kubePermissionsFor(req, cluster.id),
        permissionsIn: (namespace) => kubePermissionsFor(req, cluster.id, namespace ?? undefined),
        settings: kubeSettings(req.orgId),
        allowlist,
        namespaceAllowed: (namespace) => !allowed || !namespace || allowed.has(namespace),
      });
    } finally {
      client.close();
    }
  } catch (err) {
    throw routeSafeError(req, cluster, err);
  }
}
