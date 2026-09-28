import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { HOST_KEY_FINGERPRINT_PATTERN } from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { canAccessServer } from '../../auth/server-access.js';
import { getDb } from '../../db/index.js';
import { servers } from '../../db/schema.js';
import { audit } from '../../audit/index.js';
import { evictServer } from '../../ssh/sftp.js';
import { forgetHostKey, hostKeyView, pinHostKey } from '../../ssh/host-keys.js';
import { scanServerHostKey, serversBehind } from '../../ssh/jump.js';

export const fingerprintSchema = z
  .string()
  .trim()
  .regex(HOST_KEY_FINGERPRINT_PATTERN, 'must look like SHA256: followed by 43 base64 characters');

const fingerprintBody = z.object({ fingerprint: fingerprintSchema });

/**
 * Host key management for a server: inspect, scan, pin, accept a changed key
 * or forget it. Admin-only — whoever decides which key is trusted decides who
 * the app will hand credentials to.
 */
export async function hostKeyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireRole('admin'));

  /** The server row if it is in the caller's org and they may use it. */
  function findServer(req: FastifyRequest) {
    const { id } = req.params as { id: string };
    if (!canAccessServer(req, id)) return undefined;
    return getDb()
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
  }

  /** GET /api/servers/:id/host-key */
  app.get('/:id/host-key', async (req, reply) => {
    const server = findServer(req);
    if (!server) return reply.status(404).send({ error: 'Not found' });
    return hostKeyView(server);
  });

  /**
   * Pooled SFTP connections to this server, and to every server that jumps
   * through it, were verified against the old key.
   */
  function evict(orgId: string, serverId: string) {
    for (const id of [serverId, ...serversBehind(orgId, serverId)]) evictServer(orgId, id);
  }

  /**
   * POST /api/servers/:id/host-key/scan — read the key the host presents now;
   * stores nothing. A server behind jump hosts is scanned through them.
   */
  app.post('/:id/host-key/scan', async (req, reply) => {
    const server = findServer(req);
    if (!server) return reply.status(404).send({ error: 'Not found' });
    // Through the server's jump hosts or agent, when it has one — the same route a connection takes
    return scanServerHostKey(
      { id: server.id, host: server.host, port: server.port, username: server.username },
      { actorUserId: req.user.id },
    );
  });

  /** PUT /api/servers/:id/host-key {fingerprint} — pin a known-good fingerprint */
  app.put('/:id/host-key', async (req, reply) => {
    const { fingerprint } = fingerprintBody.parse(req.body);
    const server = findServer(req);
    if (!server) return reply.status(404).send({ error: 'Not found' });

    // Keep the key type when we have seen this key before
    const type =
      fingerprint === server.hostKeyFingerprint
        ? server.hostKeyType
        : fingerprint === server.hostKeyMismatchFingerprint
          ? server.hostKeyMismatchType
          : null;
    pinHostKey(server, fingerprint, type, req.user.id);
    evict(req.orgId, server.id);
    await audit(req, 'server.host_key_pinned', 'server', server.id, server.name, {
      fingerprint,
      previous: server.hostKeyFingerprint,
    });

    const row = getDb().select().from(servers).where(eq(servers.id, server.id)).get()!;
    return hostKeyView(row);
  });

  /**
   * POST /api/servers/:id/host-key/accept {fingerprint} — trust the key the host
   * presented in the recorded mismatch. The caller must echo that exact
   * fingerprint, so nobody accepts a changed key without having seen it.
   */
  app.post('/:id/host-key/accept', async (req, reply) => {
    const { fingerprint } = fingerprintBody.parse(req.body);
    const server = findServer(req);
    if (!server) return reply.status(404).send({ error: 'Not found' });

    if (!server.hostKeyMismatchFingerprint) {
      return reply.status(409).send({ error: 'There is no host key mismatch to accept' });
    }
    if (fingerprint !== server.hostKeyMismatchFingerprint) {
      return reply.status(409).send({
        error: 'Fingerprint does not match the key the host presented',
        code: 'HOST_KEY_FINGERPRINT_DIFFERS',
      });
    }

    pinHostKey(server, fingerprint, server.hostKeyMismatchType, req.user.id);
    evict(req.orgId, server.id);
    await audit(req, 'server.host_key_accepted', 'server', server.id, server.name, {
      fingerprint,
      previous: server.hostKeyFingerprint,
    });

    const row = getDb().select().from(servers).where(eq(servers.id, server.id)).get()!;
    return hostKeyView(row);
  });

  /** DELETE /api/servers/:id/host-key — forget it; the next connection trusts on first use */
  app.delete('/:id/host-key', async (req, reply) => {
    const server = findServer(req);
    if (!server) return reply.status(404).send({ error: 'Not found' });

    forgetHostKey(server);
    evict(req.orgId, server.id);
    await audit(req, 'server.host_key_forgotten', 'server', server.id, server.name, {
      previous: server.hostKeyFingerprint,
      mismatch: server.hostKeyMismatchFingerprint,
    });
    return reply.status(204).send();
  });
}
