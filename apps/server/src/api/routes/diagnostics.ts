import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { rank, requireAuth, requireRole } from '../../auth/middleware.js';
import { canAccessServer } from '../../auth/server-access.js';
import { canAccessCluster } from '../../auth/cluster-access.js';
import { requireResource } from '../../auth/access/index.js';
import { audit } from '../../audit/index.js';
import { getDb } from '../../db/index.js';
import { ftpConnections, kubeClusters, servers, storageConnections } from '../../db/schema.js';
import { boolQuery } from '../query.js';
import { diagnoseFtp, diagnoseServer, diagnoseStorage, getEgressIp } from '../../diagnostics/index.js';
import { diagnoseCluster } from '../../kube/diagnose.js';

const bodySchema = z.object({ auth: z.boolean().default(false) });
const egressQuery = z.object({ refresh: boolQuery });

/**
 * Each run opens several outbound connections (and, with `auth`, a login), so
 * it is limited per user rather than per IP — the key runs after requireAuth.
 */
const DIAGNOSE_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
      hook: 'preHandler' as const,
      keyGenerator: (req: FastifyRequest) => `diagnostics:${req.user?.id ?? req.ip}`,
    },
  },
};

/** Routes gated per connection by their own preHandler rather than by base role. */
const PER_CONNECTION = new Set(['/api/diagnostics/ftp/:id', '/api/diagnostics/storage/:id']);

/**
 * Step-by-step connectivity checks for saved endpoints: DNS, TCP, the protocol
 * banner (and TLS), the host key, and — only when asked — a login with the
 * stored credentials. Operator and up, like opening a connection; per-server
 * access applies to servers. FTP and storage connections are checked per
 * connection instead (`operate` on it, which a custom role may give a viewer).
 */
export async function diagnosticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const operatorOnly = requireRole('operator');
  app.addHook('preHandler', async (req, reply) => {
    if (PER_CONNECTION.has(req.routeOptions.url ?? '')) return;
    return operatorOnly(req, reply);
  });

  const optionsFor = (req: FastifyRequest) => {
    const { auth } = bodySchema.parse(req.body ?? {});
    // A presented key that differs from the pinned one is admin-only evidence
    return { auth, revealHostKey: rank(req.role) >= rank('admin'), actorUserId: req.user.id };
  };

  /** POST /api/diagnostics/servers/:id {auth?} */
  app.post('/servers/:id', DIAGNOSE_RATE_LIMIT, async (req, reply) => {
    const { id } = req.params as { id: string };
    const opts = optionsFor(req);
    // Not granted reads as not found, so a restricted member cannot probe ids
    if (!canAccessServer(req, id)) return reply.status(404).send({ error: 'Not found' });
    const server = getDb()
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!server) return reply.status(404).send({ error: 'Not found' });

    const result = await diagnoseServer(server, req.orgId, opts);
    await audit(req, 'server.diagnose', 'server', server.id, server.name, {
      auth: opts.auth,
      ok: result.ok,
      failedStep: result.failedStep,
    });
    return result;
  });

  /** POST /api/diagnostics/ftp/:id {auth?} */
  app.post('/ftp/:id', { ...DIAGNOSE_RATE_LIMIT, preHandler: requireResource('ftp_connection', 'test') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const opts = optionsFor(req);
    const connection = getDb()
      .select()
      .from(ftpConnections)
      .where(and(eq(ftpConnections.id, id), eq(ftpConnections.orgId, req.orgId)))
      .get();
    if (!connection) return reply.status(404).send({ error: 'FTP connection not found' });

    const result = await diagnoseFtp(connection, opts);
    await audit(req, 'ftp_connection.diagnose', 'ftp_connection', connection.id, connection.name, {
      auth: opts.auth,
      ok: result.ok,
      failedStep: result.failedStep,
    });
    return result;
  });

  /** POST /api/diagnostics/storage/:id {auth?} */
  app.post(
    '/storage/:id',
    { ...DIAGNOSE_RATE_LIMIT, preHandler: requireResource('storage_connection', 'diagnose') },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const opts = optionsFor(req);
    const connection = getDb()
      .select()
      .from(storageConnections)
      .where(and(eq(storageConnections.id, id), eq(storageConnections.orgId, req.orgId)))
      .get();
    if (!connection) return reply.status(404).send({ error: 'Storage connection not found' });

    const result = await diagnoseStorage(connection, req.orgId, opts);
    await audit(req, 'storage_connection.diagnose', 'storage_connection', connection.id, connection.name, {
      auth: opts.auth,
      ok: result.ok,
      failedStep: result.failedStep,
    });
    return result;
  });

  /** POST /api/diagnostics/clusters/:id {auth?} — a Kubernetes cluster; `auth` adds the Kubernetes API step */
  app.post('/clusters/:id', DIAGNOSE_RATE_LIMIT, async (req, reply) => {
    const { id } = req.params as { id: string };
    const opts = optionsFor(req);
    // Not granted reads as not found, as for servers
    if (!canAccessCluster(req, id)) return reply.status(404).send({ error: 'Not found' });
    const cluster = getDb()
      .select()
      .from(kubeClusters)
      .where(and(eq(kubeClusters.id, id), eq(kubeClusters.orgId, req.orgId)))
      .get();
    if (!cluster) return reply.status(404).send({ error: 'Not found' });

    const result = await diagnoseCluster(cluster, req, opts);
    await audit(req, 'kube_cluster.diagnose', 'kube_cluster', cluster.id, cluster.name, {
      auth: opts.auth,
      ok: result.ok,
      failedStep: result.failedStep,
    });
    return result;
  });

  /** GET /api/diagnostics/egress-ip[?refresh=true] — the source address firewalls must allow */
  app.get(
    '/egress-ip',
    { config: { rateLimit: { ...DIAGNOSE_RATE_LIMIT.config.rateLimit, max: 30 } } },
    async (req) => {
      const { refresh } = egressQuery.parse(req.query);
      return getEgressIp({ refresh });
    },
  );
}
