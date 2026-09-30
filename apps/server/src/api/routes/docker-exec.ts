import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DockerExecSession } from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { audit, auditActorOf, auditAs } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { startTerminalRecording } from '../../recordings/index.js';
import { SSHBroker } from '../../ssh/broker.js';
import { DockerClient } from '../../docker/client.js';
import { DockerError } from '../../docker/errors.js';
import { EXEC_USER_PATTERN, openContainerShell, pickShell, type ContainerShell } from '../../docker/exec.js';
import { requireDocker } from '../../docker/permissions.js';
import { dockerServer, ensureEndpoint, leaseSsh } from '../../docker/service.js';
import { openDaemonStream } from '../../docker/transport.js';
import { apiPath, containerRef } from '../../docker/validation.js';
import { sendDockerError, serverParams } from './docker.js';

/**
 * A shell inside a container (D3). `POST …/containers/:cid/exec` opens it and
 * hands it to the terminal broker as a session of its own; the browser then
 * attaches over the same WebSocket as an SSH terminal
 * (`/api/ssh-sessions/:id/ws`) and closes it with `DELETE
 * /api/ssh-sessions/:id`. Recording, detached reaping, output buffering and
 * revocation are the broker's (ssh/broker.ts); the exec itself is
 * docker/exec.ts.
 *
 * Needs the `exec` capability (operators only while `operatorsCanExec`), and
 * per-server access — 404 otherwise. Opening and ending are audited.
 */

const containerParams = serverParams.extend({ cid: z.string() });

const execSchema = z
  .object({
    cmd: z
      .array(z.string().min(1).max(4096).refine((a) => !a.includes('\0'), 'cannot contain NUL bytes'))
      .min(1)
      .max(64)
      .optional(),
    user: z.string().regex(EXEC_USER_PATTERN, 'must be user, user:group, uid or uid:gid').optional(),
    tty: z.boolean().default(true),
    cols: z.number().int().min(10).max(1000).default(220),
    rows: z.number().int().min(5).max(500).default(50),
  })
  .strict();

export async function dockerExecRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** POST /servers/:id/containers/:cid/exec `{ cmd?, user?, tty?, cols, rows }` → a terminal session. */
  app.post('/servers/:id/containers/:cid/exec', { preHandler: requireDocker('exec') }, async (req, reply) => {
    const { id, cid } = containerParams.parse(req.params);
    const body = execSchema.parse(req.body ?? {});
    try {
      const ref = containerRef(cid);
      const server = dockerServer(req, id);
      // Held for as long as the shell is open: the pooled connection carries it
      const lease = await leaseSsh(req, server);
      let docker: DockerClient | undefined;
      let shell: ContainerShell | undefined;
      let handedOver = false;
      try {
        const { endpoint, apiVersion } = await ensureEndpoint(lease.client, server);
        const client = new DockerClient(() => openDaemonStream(lease.client, endpoint), apiVersion);
        docker = client;
        const info = await client.json<Record<string, unknown>>({ path: apiPath('containers', ref, 'json') });
        const container = { id: String(info.Id ?? ref), name: String(info.Name ?? ref).replace(/^\//, '') };
        // A paused container reports Running too; Status says which
        const state = (info.State ?? {}) as { Running?: unknown; Paused?: unknown; Status?: unknown };
        if (state.Paused === true || state.Status === 'paused') throw new DockerError(`${container.name} is paused`, 409);
        if (state.Running !== true && state.Status !== 'running') throw new DockerError(`${container.name} is not running`, 409);

        const cmd = body.cmd ?? (await pickShell(client, container.id, body.user));
        shell = await openContainerShell(client, container.id, {
          cmd,
          user: body.user,
          tty: body.tty,
          cols: body.cols,
          rows: body.rows,
        });

        const recording = startTerminalRecording({
          orgId: req.orgId,
          serverId: server.id,
          serverName: server.name,
          userId: req.user.id,
          cols: body.cols,
          rows: body.rows,
          container,
        });
        const actor = auditActorOf(req);
        const started = Date.now();
        const opened = shell;
        let sessionId = '';
        // Ends when the shell exits, the user disconnects, or access is revoked
        const end = () => {
          void opened
            .close()
            .then((exitCode) =>
              auditAs(actor, 'docker.exec_end', 'server', server.id, server.name, {
                container,
                sessionId,
                exitCode,
                durationMs: Date.now() - started,
              }),
            )
            .finally(() => {
              client.close();
              lease.release();
            });
        };
        sessionId = SSHBroker.adoptSession(
          {
            server: { id: server.id, host: server.host, port: server.port, username: server.username },
            userId: req.user.id,
            orgId: req.orgId,
            cols: body.cols,
            rows: body.rows,
            recording,
            container,
          },
          shell.channel,
          end,
        );
        handedOver = true;

        await audit(req, 'docker.exec_start', 'server', server.id, server.name, {
          container,
          cmd,
          ...(body.user && { user: body.user }),
          tty: body.tty,
          sessionId,
          ...(recording && { recordingId: recording.id }),
        });
        const result: DockerExecSession = {
          sessionId,
          wsUrl: `${config.baseUrl.replace(/^http/, 'ws')}/api/ssh-sessions/${sessionId}/ws`,
          container,
          cmd,
          recording: recording ? { id: recording.id, inputRecorded: recording.inputRecorded } : null,
        };
        return reply.status(201).send(result);
      } finally {
        if (!handedOver) {
          shell?.channel.destroy();
          docker?.close();
          lease.release();
        }
      }
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });
}
