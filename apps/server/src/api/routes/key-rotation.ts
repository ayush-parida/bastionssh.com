import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { BulkRotateKeysResponse } from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { accessibleServerFilter, requireServer, serverDenial } from '../../auth/server-access.js';
import { requireStepUpIfPasskeys } from '../../auth/passkey.js';
import { getDb } from '../../db/index.js';
import { keyRotations, servers } from '../../db/schema.js';
import { audit, auditActorOf } from '../../audit/index.js';
import { createRotations, rotationView, runRotation, runRotations } from '../../ssh/key-rotation.js';

const rotateSchema = z.object({
  type: z.enum(['rsa', 'ed25519', 'ecdsa']).optional(),
});

const bulkRotateSchema = rotateSchema.extend({
  serverIds: z.array(z.string().min(1)).min(1).max(200),
});

const historyQuery = z.object({
  serverId: z.string().optional(),
  keyId: z.string().optional(),
  batchId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * SSH key rotation (see ssh/key-rotation.ts). Rotating changes who can log in
 * to a server, so it needs `manage` on every server rotated (admins, or a
 * custom role that manages them — custom roles spec §5) and a passkey step-up
 * whenever the caller has a passkey; the history is readable by anyone who
 * can see the server.
 */
export async function keyRotationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** GET /api/keys/rotations?serverId=&keyId=&batchId=&limit= — newest first */
  app.get('/keys/rotations', async (req) => {
    const query = historyQuery.parse(req.query);
    return getDb()
      .select()
      .from(keyRotations)
      .where(
        and(
          eq(keyRotations.orgId, req.orgId),
          accessibleServerFilter(req, keyRotations.serverId),
          query.serverId ? eq(keyRotations.serverId, query.serverId) : undefined,
          query.batchId ? eq(keyRotations.batchId, query.batchId) : undefined,
          query.keyId
            ? or(eq(keyRotations.oldKeyId, query.keyId), eq(keyRotations.newKeyId, query.keyId))
            : undefined,
        ),
      )
      .orderBy(desc(keyRotations.createdAt))
      .limit(query.limit)
      .all()
      .map(rotationView);
  });

  /** POST /api/servers/:id/rotate-key {type?} — runs to the end and returns the record */
  app.post('/servers/:id/rotate-key', { preHandler: requireServer('rotate_keys') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = rotateSchema.parse(req.body ?? {});
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return reply;
    const server = getDb()
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!server) return reply.status(404).send({ error: 'Not found' });

    const [rotation] = createRotations(req.orgId, [server], req.user.id, null);
    return runRotation(rotation!.id, auditActorOf(req), { type: body.type });
  });

  /**
   * POST /api/keys/rotate {serverIds, type?} — queue one rotation per server
   * and run them one after another in the background. Answers 202 at once;
   * poll GET /api/keys/rotations?batchId= for progress.
   */
  app.post('/keys/rotate', async (req, reply) => {
    const body = bulkRotateSchema.parse(req.body);
    const serverIds = [...new Set(body.serverIds)];
    // Any server out of reach is a 404 before one below `manage` is a 403
    const denials = serverIds.map((id) => serverDenial(req, id, 'rotate_keys')).filter((d) => d !== null);
    const denied = denials.find((d) => d.status === 404) ?? denials[0];
    if (denied) return reply.status(denied.status).send({ error: denied.error });
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return reply;
    const rows = getDb()
      .select()
      .from(servers)
      .where(and(eq(servers.orgId, req.orgId), inArray(servers.id, serverIds)))
      .all();
    // Keep the order the servers were selected in
    const ordered = serverIds.map((id) => rows.find((r) => r.id === id)!);

    const batchId = nanoid();
    const rotations = createRotations(req.orgId, ordered, req.user.id, batchId);
    await audit(req, 'ssh_key.rotate_bulk', 'key_rotation', batchId, undefined, {
      serverIds,
      type: body.type ?? null,
    });

    void runRotations(
      rotations.map((r) => r.id),
      auditActorOf(req),
      { type: body.type },
    );
    const response: BulkRotateKeysResponse = { batchId, rotations: rotations.map(rotationView) };
    return reply.status(202).send(response);
  });
}
