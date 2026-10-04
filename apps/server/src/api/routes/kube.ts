import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type {
  KubeAuthType,
  KubeCluster,
  KubeClusterStatus,
  KubeClusterStatusView,
  KubeConnectVia,
  KubeSettings,
  KubeTestResult,
  KubeconfigSummary,
} from '@smt/shared';
import { rank, requireAuth, requireRole } from '../../auth/middleware.js';
import { authorize } from '../../auth/access/authorize.js';
import { filterAccessibleClusters } from '../../auth/cluster-access.js';
import { audit } from '../../audit/index.js';
import { getDb } from '../../db/index.js';
import { agents, kubeClusters, servers } from '../../db/schema.js';
import { CredentialError } from '../../ssh/credentials.js';
import { HostKeyMismatchError } from '../../ssh/host-keys.js';
import { JumpHostError } from '../../ssh/jump.js';
import { FtpError } from '../../ftp/errors.js';
import { assertSafeHost } from '../../ftp/paths.js';
import { KubeError } from '../../kube/errors.js';
import {
  MAX_KUBECONFIG_BYTES,
  apiEndpoint,
  checkApiUrl,
  checkCertificates,
  checkPrivateKey,
  checkToken,
  connectionFromKubeconfig,
  credentialHint,
  summarizeKubeconfig,
  type KubeCredential,
} from '../../kube/kubeconfig.js';
import { kubePermissionsFor, requireKube } from '../../kube/permissions.js';
import { kubeSettings, updateKubeSettings } from '../../kube/settings.js';
import { closeDisallowedPodShells } from '../../kube/exec.js';
import { namespaceName } from '../../kube/validation.js';
import {
  clientFor,
  clusterCredential,
  credentialPlaintext,
  identityOf,
  kubeCluster,
  parseAllowlist,
  type ClusterRow,
} from '../../kube/service.js';
import { testConnection } from '../../kube/connection-test.js';
import { resetCluster } from '../../kube/index.js';
import type { ApiRoute } from '../../kube/transport.js';
import { vault } from '../../vault/index.js';

/**
 * Kubernetes clusters (spec 2026-10-03 §4.2): the org settings, kubeconfig
 * inspection, cluster CRUD and "Test connection". Every route is behind
 * `requireAuth`; managing clusters needs `configure` (admins and owners),
 * and a cluster the caller cannot access is a 404 whatever their role
 * (kube/service.ts). The views over a cluster — map, namespaces, workloads,
 * details, the change feed — are in kube-views.ts, and later phases add
 * their own route files under the same prefix, reusing {@link sendKubeError}
 * and {@link clusterParams}.
 */

export const clusterParams = z.object({ id: z.string().min(1).max(64) });

const settingsSchema = z
  .object({
    operatorsCanExec: z.boolean().optional(),
    operatorsCanDeletePods: z.boolean().optional(),
    operatorsCanScale: z.boolean().optional(),
    showConfigMapValues: z.boolean().optional(),
    clusterAlerts: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

const PEM_MAX = 256 * 1024;

const clusterInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    kubeconfig: z.string().max(MAX_KUBECONFIG_BYTES).optional(),
    context: z.string().max(253).optional(),
    apiUrl: z.string().max(2048).optional(),
    caData: z.string().max(PEM_MAX).optional(),
    token: z.string().max(16 * 1024).optional(),
    clientCert: z.string().max(PEM_MAX).optional(),
    clientKey: z.string().max(PEM_MAX).optional(),
    connectVia: z.enum(['direct', 'server', 'agent']).optional(),
    viaServerId: z.string().max(64).nullable().optional(),
    viaAgentId: z.string().max(64).nullable().optional(),
    impersonate: z.boolean().optional(),
    defaultNamespace: z.string().max(63).optional(),
    namespacesAllowlist: z.array(z.string().max(63)).max(500).nullable().optional(),
  })
  .strict();

type ClusterInput = z.infer<typeof clusterInputSchema>;

const kubeconfigSchema = z.object({ kubeconfig: z.string().min(1).max(MAX_KUBECONFIG_BYTES) });

/**
 * Answer a Kubernetes, credential, jump host or host key failure with its
 * own status and a body safe to show. Anything else is rethrown for the
 * app's error handler.
 */
export function sendKubeError(reply: FastifyReply, err: unknown) {
  if (err instanceof KubeError) return reply.status(err.statusCode).send(err.toJSON());
  if (err instanceof CredentialError) return reply.status(err.statusCode).send({ error: err.message });
  if (err instanceof JumpHostError) return reply.status(err.statusCode).send({ error: err.message });
  // The presented key is admin evidence on the server's own page; here the reason is enough
  if (err instanceof HostKeyMismatchError) {
    return reply.status(409).send({ error: 'The SSH host key of the server this cluster is reached through has changed; an admin must review it.' });
  }
  throw err;
}

/** The connection a cluster input describes: from a kubeconfig context, or field by field. */
interface ResolvedInput {
  name: string | undefined;
  apiUrl: string | undefined;
  /** undefined = unchanged; null = system trust store. */
  caData: string | null | undefined;
  /** undefined = unchanged. */
  credential: KubeCredential | undefined;
  namespace: string | undefined;
}

function resolveConnection(body: ClusterInput): ResolvedInput {
  if (body.kubeconfig) {
    if (body.apiUrl || body.token || body.clientCert || body.clientKey || body.caData !== undefined) {
      throw new KubeError('Give a kubeconfig or the connection fields, not both', 400);
    }
    const conn = connectionFromKubeconfig(body.kubeconfig, body.context);
    return {
      name: body.name ?? body.context,
      apiUrl: conn.apiUrl,
      caData: conn.caData,
      credential: conn.credential,
      namespace: conn.namespace ?? undefined,
    };
  }
  let credential: KubeCredential | undefined;
  if (body.token !== undefined && (body.clientCert || body.clientKey)) {
    throw new KubeError('Give a token or a client certificate, not both', 400);
  }
  if (body.token !== undefined) credential = { type: 'token', token: checkToken(body.token) };
  else if (body.clientCert || body.clientKey) {
    if (!body.clientCert || !body.clientKey) throw new KubeError('A client certificate needs its key, and the other way round', 400);
    credential = {
      type: 'cert',
      cert: checkCertificates(body.clientCert, 'The client certificate'),
      key: checkPrivateKey(body.clientKey),
    };
  }
  return {
    name: body.name,
    apiUrl: body.apiUrl === undefined ? undefined : checkApiUrl(body.apiUrl),
    caData: body.caData === undefined ? undefined : body.caData.trim() ? checkCertificates(body.caData, 'The cluster CA') : null,
    credential,
    namespace: undefined,
  };
}

/** The route fields, checked against the org: a server or agent of this org, a host that may be dialled. */
function checkRoute(
  orgId: string,
  connectVia: KubeConnectVia,
  viaServerId: string | null,
  viaAgentId: string | null,
  apiUrl: string,
): { viaServerId: string | null; viaAgentId: string | null; viaName: string | null } {
  if (connectVia === 'server') {
    if (!viaServerId) throw new KubeError('Pick the server to reach the cluster through', 400);
    const server = getDb()
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .where(and(eq(servers.id, viaServerId), eq(servers.orgId, orgId)))
      .get();
    if (!server) throw new KubeError('Unknown server', 400);
    return { viaServerId, viaAgentId: null, viaName: server.name };
  }
  if (connectVia === 'agent') {
    if (!viaAgentId) throw new KubeError('Pick the agent to reach the cluster through', 400);
    const agent = getDb()
      .select({ id: agents.id, name: agents.name, revokedAt: agents.revokedAt })
      .from(agents)
      .where(and(eq(agents.id, viaAgentId), eq(agents.orgId, orgId)))
      .get();
    if (!agent || agent.revokedAt) throw new KubeError('Unknown agent', 400);
    return { viaServerId: null, viaAgentId, viaName: agent.name };
  }
  // Direct: the same host rules as servers (metadata addresses are refused again at connect time)
  try {
    assertSafeHost(apiEndpoint(apiUrl).host);
  } catch (err) {
    if (err instanceof FtpError) throw new KubeError(`API server host: ${err.message}`, 400);
    throw err;
  }
  return { viaServerId: null, viaAgentId: null, viaName: null };
}

function checkNamespaces(defaultNamespace: string, allowlist: string[] | null): void {
  namespaceName(defaultNamespace);
  if (!allowlist) return;
  allowlist.forEach(namespaceName);
  if (!allowlist.length) throw new KubeError('The namespace allowlist is empty; clear it to allow every namespace', 400);
  if (!allowlist.includes(defaultNamespace)) throw new KubeError('The default namespace must be in the allowlist', 400);
}

function namesFor(orgId: string, row: ClusterRow): { server: string | null; agent: string | null } {
  const db = getDb();
  const server = row.viaServerId
    ? db.select({ name: servers.name }).from(servers).where(and(eq(servers.id, row.viaServerId), eq(servers.orgId, orgId))).get()
    : undefined;
  const agent = row.viaAgentId
    ? db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, row.viaAgentId), eq(agents.orgId, orgId))).get()
    : undefined;
  return { server: server?.name ?? null, agent: agent?.name ?? null };
}

export function toCluster(row: ClusterRow, names: { server: string | null; agent: string | null }): KubeCluster {
  return {
    id: row.id,
    name: row.name,
    apiUrl: row.apiUrl,
    connectVia: row.connectVia as KubeConnectVia,
    viaServerId: row.viaServerId,
    viaServerName: names.server,
    viaAgentId: row.viaAgentId,
    viaAgentName: names.agent,
    hasCa: !!row.caData,
    authType: row.authType as KubeAuthType,
    credentialHint: row.credentialHint,
    impersonate: row.impersonate,
    defaultNamespace: row.defaultNamespace,
    namespacesAllowlist: parseAllowlist(row.namespacesAllowlist),
    lastStatus: (row.lastStatus as KubeClusterStatus | null) ?? 'unknown',
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt,
    serverVersion: row.serverVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Record how a cluster answered (its health dot). Never touches `updatedAt`, which keys the caches. */
export function recordClusterStatus(clusterId: string, ok: boolean, error: string | null, serverVersion?: string | null): void {
  getDb()
    .update(kubeClusters)
    .set({
      lastStatus: ok ? 'ok' : 'error',
      lastError: ok ? null : (error ?? 'Unreachable').slice(0, 500),
      lastCheckedAt: new Date().toISOString(),
      ...(serverVersion && { serverVersion }),
    })
    .where(eq(kubeClusters.id, clusterId))
    .run();
}

/** The full connection a create, edit or test describes, merged over the saved cluster when there is one. */
async function connectionFor(req: FastifyRequest, body: ClusterInput, existing: ClusterRow | null) {
  const resolved = resolveConnection(body);
  const apiUrl = resolved.apiUrl ?? existing?.apiUrl;
  if (!apiUrl) throw new KubeError('The API server URL is required (or upload a kubeconfig)', 400);
  const credential = resolved.credential ?? (existing ? await clusterCredential(existing) : undefined);
  if (!credential) throw new KubeError('A token or a client certificate is required (or upload a kubeconfig)', 400);
  const caData = resolved.caData !== undefined ? resolved.caData : (existing?.caData ?? null);
  // The saved credential only ever goes to the API server it was saved for: pointing the cluster
  // at another address (or trusting another CA) would hand it to whoever answers there
  if (existing && !resolved.credential && (apiUrl !== existing.apiUrl || caData !== existing.caData)) {
    throw new KubeError('Enter the token or client certificate again when changing the API server address or its CA', 400);
  }
  const connectVia = (body.connectVia ?? existing?.connectVia ?? 'direct') as KubeConnectVia;
  const via = checkRoute(
    req.orgId,
    connectVia,
    body.viaServerId !== undefined ? body.viaServerId : (existing?.viaServerId ?? null),
    body.viaAgentId !== undefined ? body.viaAgentId : (existing?.viaAgentId ?? null),
    apiUrl,
  );
  const defaultNamespace = body.defaultNamespace ?? resolved.namespace ?? existing?.defaultNamespace ?? 'default';
  const allowlist =
    body.namespacesAllowlist !== undefined
      ? body.namespacesAllowlist && [...new Set(body.namespacesAllowlist)]
      : parseAllowlist(existing?.namespacesAllowlist ?? null);
  checkNamespaces(defaultNamespace, allowlist);
  return {
    name: resolved.name ?? existing?.name,
    apiUrl,
    caData,
    credential,
    credentialChanged: resolved.credential !== undefined,
    connectVia,
    ...via,
    impersonate: body.impersonate ?? existing?.impersonate ?? false,
    defaultNamespace,
    allowlist,
  };
}

/**
 * A cluster's `manage` level may come from a custom role rather than the
 * admin base role (custom roles spec §5). Such a member may edit the cluster,
 * but not borrow what only admins hold to do it: pointing the cluster at a
 * route through a server — a new server, or a new address behind the same
 * one — needs `operate` on that server (it tunnels through the server's
 * SSH), and through an agent it stays admin-only, as agents are.
 */
function checkRouteChange(
  req: FastifyRequest,
  existing: ClusterRow,
  conn: Awaited<ReturnType<typeof connectionFor>>,
): void {
  if (rank(req.role) >= rank('admin')) return;
  const moved = conn.apiUrl !== existing.apiUrl;
  if (conn.viaServerId && (moved || conn.viaServerId !== existing.viaServerId)) {
    const result = authorize(req, 'server', conn.viaServerId, 'terminal');
    if (result.status === 404) throw new KubeError('Server not found', 404);
    if (!result.ok) throw new KubeError('Routing a cluster through a server needs operate access to that server', 403);
  }
  if (conn.viaAgentId && (moved || conn.viaAgentId !== existing.viaAgentId)) {
    throw new KubeError('Only admins can route a cluster through an agent', 403);
  }
}

function routeOf(req: FastifyRequest, conn: Awaited<ReturnType<typeof connectionFor>>): ApiRoute {
  return {
    orgId: req.orgId,
    apiUrl: conn.apiUrl,
    caData: conn.caData,
    credential: conn.credential,
    connectVia: conn.connectVia,
    viaServerId: conn.viaServerId,
    viaAgentId: conn.viaAgentId,
    actorUserId: req.user.id,
  };
}

async function runTest(req: FastifyRequest, conn: Awaited<ReturnType<typeof connectionFor>>): Promise<KubeTestResult> {
  const route = routeOf(req, conn);
  const client = clientFor({ ...route, impersonate: conn.impersonate ? identityOf(req) : null });
  try {
    return await testConnection({ route, client, viaName: conn.viaName, namespace: conn.defaultNamespace });
  } finally {
    client.close();
  }
}

const TEST_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 20,
      timeWindow: '1 minute',
      hook: 'preHandler' as const,
      keyGenerator: (req: FastifyRequest) => `kube-test:${req.user?.id ?? req.ip}`,
    },
  },
};

export async function kubeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ── Org settings ──────────────────────────────────────────────

  /** The org's Kubernetes permissions. Every member may read them — the UI hides what they cannot do. */
  app.get('/settings', async (req): Promise<KubeSettings> => kubeSettings(req.orgId));

  /** Owners and admins: what operators may do, and whether ConfigMap values are shown. */
  app.patch('/settings', { preHandler: requireRole('admin') }, async (req): Promise<KubeSettings> => {
    const body = settingsSchema.parse(req.body);
    const before = kubeSettings(req.orgId);
    const after = updateKubeSettings(req.orgId, body);
    // Pod shells opened under the old rule end with it
    if (before.operatorsCanExec && !after.operatorsCanExec) closeDisallowedPodShells(req.orgId);
    await audit(req, 'org.kube_settings', 'organization', req.orgId, undefined, { before, after });
    return after;
  });

  // ── Kubeconfig ────────────────────────────────────────────────

  /** POST /kubeconfig/contexts — what an uploaded kubeconfig holds, each context with why it cannot be used. Nothing is kept. */
  app.post('/kubeconfig/contexts', { preHandler: requireKube('configure') }, async (req, reply): Promise<KubeconfigSummary | void> => {
    const { kubeconfig } = kubeconfigSchema.parse(req.body);
    try {
      return summarizeKubeconfig(kubeconfig);
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  // ── Clusters ──────────────────────────────────────────────────

  /** GET /clusters — the clusters the caller may use, with their last known health. */
  app.get('/clusters', async (req): Promise<KubeCluster[]> => {
    const rows = getDb().select().from(kubeClusters).where(eq(kubeClusters.orgId, req.orgId)).all();
    return filterAccessibleClusters(req, rows, (r) => r.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => toCluster(row, namesFor(req.orgId, row)));
  });

  /** GET /clusters/:id — the cluster and what the caller may do on it. */
  app.get('/clusters/:id', async (req, reply): Promise<KubeClusterStatusView | void> => {
    const { id } = clusterParams.parse(req.params);
    try {
      const row = kubeCluster(req, id);
      return { cluster: toCluster(row, namesFor(req.orgId, row)), permissions: kubePermissionsFor(req, row.id) };
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** POST /clusters — add a cluster from a kubeconfig context or from fields. */
  app.post('/clusters', { preHandler: requireKube('configure') }, async (req, reply) => {
    const body = clusterInputSchema.parse(req.body);
    try {
      const conn = await connectionFor(req, body, null);
      if (!conn.name) throw new KubeError('Give the cluster a name', 400);
      const id = nanoid();
      const now = new Date().toISOString();
      getDb()
        .insert(kubeClusters)
        .values({
          id,
          orgId: req.orgId,
          name: conn.name.slice(0, 100),
          apiUrl: conn.apiUrl,
          connectVia: conn.connectVia,
          viaServerId: conn.viaServerId,
          viaAgentId: conn.viaAgentId,
          caData: conn.caData,
          authType: conn.credential.type,
          encryptedCredential: await vault.encrypt(credentialPlaintext(conn.credential), id),
          credentialHint: credentialHint(conn.credential),
          impersonate: conn.impersonate,
          defaultNamespace: conn.defaultNamespace,
          namespacesAllowlist: conn.allowlist ? JSON.stringify(conn.allowlist) : null,
          createdBy: req.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const row = kubeCluster(req, id);
      await audit(req, 'kube_cluster.create', 'kube_cluster', id, row.name, {
        apiUrl: row.apiUrl,
        connectVia: row.connectVia,
        authType: row.authType,
        impersonate: row.impersonate,
        fromKubeconfig: !!body.kubeconfig,
      });
      return reply.status(201).send(toCluster(row, namesFor(req.orgId, row)));
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** PATCH /clusters/:id — change anything; credentials left out stay as they are. */
  app.patch('/clusters/:id', { preHandler: requireKube('configure') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const body = clusterInputSchema.parse(req.body);
    try {
      const existing = kubeCluster(req, id);
      const conn = await connectionFor(req, body, existing);
      checkRouteChange(req, existing, conn);
      const changes = {
        name: (conn.name ?? existing.name).slice(0, 100),
        apiUrl: conn.apiUrl,
        connectVia: conn.connectVia,
        viaServerId: conn.viaServerId,
        viaAgentId: conn.viaAgentId,
        caData: conn.caData,
        impersonate: conn.impersonate,
        defaultNamespace: conn.defaultNamespace,
        namespacesAllowlist: conn.allowlist ? JSON.stringify(conn.allowlist) : null,
      };
      const changed: string[] = (Object.keys(changes) as (keyof typeof changes)[]).filter((k) => changes[k] !== existing[k]);
      if (conn.credentialChanged) changed.push('credential');
      getDb()
        .update(kubeClusters)
        .set({
          ...changes,
          ...(conn.credentialChanged && {
            authType: conn.credential.type,
            encryptedCredential: await vault.encrypt(credentialPlaintext(conn.credential), id),
            credentialHint: credentialHint(conn.credential),
          }),
          // A new route or credential: the old health no longer says anything
          ...(changed.some((k) => ['apiUrl', 'connectVia', 'viaServerId', 'viaAgentId', 'caData', 'credential'].includes(k)) && {
            lastStatus: null,
            lastError: null,
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(kubeClusters.id, id), eq(kubeClusters.orgId, req.orgId)))
        .run();
      // Watches and live views reconnect with the new settings
      resetCluster(id, 'The cluster settings changed');
      const row = kubeCluster(req, id);
      await audit(req, 'kube_cluster.update', 'kube_cluster', id, row.name, { changed });
      if (existing.impersonate !== row.impersonate) {
        await audit(req, 'kube_cluster.impersonation', 'kube_cluster', id, row.name, { impersonate: row.impersonate });
      }
      return toCluster(row, namesFor(req.orgId, row));
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** DELETE /clusters/:id — the cluster, its grants (cascade), its watches and streams. */
  app.delete('/clusters/:id', { preHandler: requireKube('configure') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    try {
      const row = kubeCluster(req, id);
      getDb()
        .delete(kubeClusters)
        .where(and(eq(kubeClusters.id, id), eq(kubeClusters.orgId, req.orgId)))
        .run();
      resetCluster(id, 'The cluster was removed');
      await audit(req, 'kube_cluster.delete', 'kube_cluster', id, row.name, { apiUrl: row.apiUrl });
      return reply.status(204).send();
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** POST /clusters/test — test a connection before saving it. Nothing is stored. */
  app.post('/clusters/test', { preHandler: requireKube('configure'), ...TEST_RATE_LIMIT }, async (req, reply) => {
    const body = clusterInputSchema.parse(req.body ?? {});
    try {
      const conn = await connectionFor(req, body, null);
      const result = await runTest(req, conn);
      await audit(req, 'kube_cluster.test', 'kube_cluster', undefined, conn.name ?? conn.apiUrl, {
        apiUrl: conn.apiUrl,
        connectVia: conn.connectVia,
        ok: result.ok,
        saved: false,
      });
      return result;
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /**
   * POST /clusters/:id/test — test a saved cluster and record its health.
   * With changes in the body (the edit dialog), tests them over the saved
   * credential instead, without saving or recording anything.
   */
  app.post('/clusters/:id/test', { preHandler: requireKube('configure'), ...TEST_RATE_LIMIT }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const body = clusterInputSchema.parse(req.body ?? {});
    try {
      const existing = kubeCluster(req, id);
      const edits = Object.keys(body).length > 0;
      const conn = await connectionFor(req, body, existing);
      const result = await runTest(req, conn);
      if (!edits) {
        const failed = result.steps.find((s) => s.status === 'fail');
        recordClusterStatus(id, result.ok, failed ? `${failed.label}: ${failed.detail}` : null, result.serverVersion);
      }
      await audit(req, 'kube_cluster.test', 'kube_cluster', id, existing.name, { ok: result.ok, saved: !edits });
      return result;
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });
}
