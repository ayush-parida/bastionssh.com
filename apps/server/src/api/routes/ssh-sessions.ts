import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { hasModule } from '../../auth/access/modules.js';
import { requireAnyModule } from '../../auth/access/any-module.js';
import { canOnServer, serverDenial } from '../../auth/server-access.js';
import { SSHBroker } from '../../ssh/broker.js';
import { getDb } from '../../db/index.js';
import { servers, sshKeys } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { vault } from '../../vault/index.js';
import { startTerminalRecording } from '../../recordings/index.js';
import { RETIRED_KEY_MESSAGE } from '../../ssh/credentials.js';
import { dockerCan } from '../../docker/permissions.js';
import { kubeCan } from '../../kube/permissions.js';

const createSessionSchema = z.object({
  serverId: z.string(),
  keyId: z.string().optional(),
  cols: z.number().int().default(220),
  rows: z.number().int().default(50),
});

export async function sshSessionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  // Shells on servers and in containers are the Servers module, in pods Kubernetes (unified
  // roles spec §3.1): one of them must be on, and each route checks its own
  app.addHook('preHandler', requireAnyModule(['servers', 'kubernetes']));
  // Every route here opens or drives an interactive shell, which needs `operate` on its
  // server (custom roles spec §5) — from the base role or a custom role — checked per route

  /** POST /api/sessions → create a session and return its WS URL */
  app.post('/', async (req, reply) => {
    const body = createSessionSchema.parse(req.body);
    const db = getDb();

    if (!hasModule(req, 'servers')) return reply.status(404).send({ error: 'Server not found' });
    const denied = serverDenial(req, body.serverId, 'terminal');
    if (denied) return reply.status(denied.status).send({ error: denied.error });
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
      if (found.retiredAt) return reply.status(409).send({ error: RETIRED_KEY_MESSAGE });
      key = found;
    }

    let password: string | undefined;
    if (!key && server.encryptedPassword) {
      password = await vault.decrypt(server.encryptedPassword, server.id);
    }

    const recording = startTerminalRecording({
      orgId: req.orgId,
      serverId: server.id,
      serverName: server.name,
      userId: req.user.id,
      cols: body.cols,
      rows: body.rows,
    });

    let sessionId: string;
    try {
      sessionId = await SSHBroker.createSession({
        server,
        key,
        password,
        userId: req.user.id,
        orgId: req.orgId,
        recording,
        ...body,
      });
    } catch (err) {
      await recording?.discard();
      throw err;
    }
    await audit(req, 'server.connect', 'server', server.id, server.name, recording ? { recordingId: recording.id } : undefined);

    return reply.status(201).send({
      sessionId,
      wsUrl: `${config.baseUrl.replace(/^http/, 'ws')}/api/ssh-sessions/${sessionId}/ws`,
      recording: recording ? { id: recording.id, inputRecorded: recording.inputRecorded } : null,
    });
  });

  /** WebSocket /api/sessions/:id/ws → interactive terminal */
  app.get('/:id/ws', { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string };
    // Access may have been withdrawn since the session was opened; re-attaching
    // (e.g. after a page reload) must not outlive the grant.
    const owned = SSHBroker.getSessionForUser(id, req.user.id, req.orgId);
    // A server shell needs `operate` on the server still; a shell in a container the
    // Docker exec permission at the caller's level there (role, org setting), and a
    // shell in a pod the Kubernetes one in the pod's namespace (none there: refused).
    // Each also needs its module on: Kubernetes for pods, Servers for the rest
    const refused = owned?.pod
      ? !hasModule(req, 'kubernetes') || !kubeCan(req, 'exec', owned.pod.clusterId, owned.pod.namespace)
      : !!owned &&
        (!hasModule(req, 'servers') ||
          (owned.container
            ? !canOnServer(req, owned.server.id, 'view') || !dockerCan(req, 'exec', owned.server.id)
            : !canOnServer(req, owned.server.id, 'terminal')));
    if (refused) {
      await SSHBroker.close(id, { userId: req.user.id, orgId: req.orgId });
      socket.close(4404, 'Session not found');
      return;
    }
    await SSHBroker.attach(id, socket, req);
  });

  /** DELETE /api/sessions/:id → close the session (only the caller's own; no level needed to end it) */
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await SSHBroker.close(id, { userId: req.user.id, orgId: req.orgId });
    return reply.status(204).send();
  });
}
