import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { SSHBroker } from '../../ssh/broker.js';
import { getDb } from '../../db/index.js';
import { servers, sshKeys } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { vault } from '../../vault/index.js';

const createSessionSchema = z.object({
  serverId: z.string(),
  keyId: z.string().optional(),
  cols: z.number().int().default(220),
  rows: z.number().int().default(50),
});

export async function sshSessionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  // Every route here opens or drives an interactive shell — viewers are excluded wholesale
  app.addHook('preHandler', requireRole('operator'));

  /** POST /api/sessions → create a session and return its WS URL */
  app.post('/', async (req, reply) => {
    const body = createSessionSchema.parse(req.body);
    const db = getDb();

    const server = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, body.serverId), eq(servers.orgId, req.orgId)))
      .get();
    if (!server) return reply.status(404).send({ error: 'Server not found' });

    const keyId = body.keyId ?? server.defaultKeyId;
    const hasPassword = !!server.encryptedPassword;

    if (!keyId && !hasPassword) {
      return reply
        .status(400)
        .send({ error: 'No authentication method configured for this server' });
    }

    let key: typeof sshKeys.$inferSelect | undefined;
    if (keyId) {
      const found = db
        .select()
        .from(sshKeys)
        .where(and(eq(sshKeys.id, keyId), eq(sshKeys.orgId, req.orgId)))
        .get();
      if (!found) return reply.status(404).send({ error: 'SSH key not found' });
      key = found;
    }

    let password: string | undefined;
    if (!key && server.encryptedPassword) {
      password = await vault.decrypt(server.encryptedPassword, server.id);
    }

    const sessionId = await SSHBroker.createSession({
      server,
      key,
      password,
      userId: req.user.id,
      ...body,
    });
    await audit(req, 'server.connect', 'server', server.id, server.name);

    return reply.status(201).send({
      sessionId,
      wsUrl: `${config.baseUrl.replace(/^http/, 'ws')}/api/ssh-sessions/${sessionId}/ws`,
    });
  });

  /** WebSocket /api/sessions/:id/ws → interactive terminal */
  app.get('/:id/ws', { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string };
    await SSHBroker.attach(id, socket, req);
  });

  /** DELETE /api/sessions/:id → close the session */
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await SSHBroker.close(id);
    return reply.status(204).send();
  });
}
