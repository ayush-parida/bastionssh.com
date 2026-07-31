import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import posix from 'node:path/posix';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { CredentialError, resolveServerAuth } from '../../ssh/credentials.js';
import * as sftp from '../../ssh/sftp.js';
import type { SftpLease } from '../../ssh/sftp.js';
import type { SftpListResponse, SftpReadResponse } from '@smt/shared';

/** Upper bound on files openable in the inline editor. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

const pathQuerySchema = z.object({
  path: z.string().default('.'),
  keyId: z.string().optional(),
});

const mkdirSchema = z.object({ path: z.string().min(1), keyId: z.string().optional() });
const renameSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  keyId: z.string().optional(),
});
const deleteSchema = z.object({
  path: z.string().min(1),
  recursive: z.coerce.boolean().default(false),
  keyId: z.string().optional(),
});

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof sftp.SftpError || err instanceof CredentialError) {
    return reply.status(err.statusCode).send({ error: err.message });
  }
  throw err;
}

export async function sftpRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Uploads arrive as a raw body so large files never buffer in memory.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  /** Open a pooled SFTP channel for the caller against the given server. */
  async function lease(orgId: string, serverId: string, userId: string, keyId?: string) {
    const { server, auth } = await resolveServerAuth(orgId, serverId, keyId);
    const held = await sftp.acquire(
      sftp.poolKey(orgId, serverId, userId),
      { host: server.host, port: server.port, username: server.username },
      auth,
    );
    return { server, held };
  }

  /** GET /api/sftp/:serverId/list?path=/var/www — directory listing */
  app.get('/:serverId/list', async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const query = pathQuerySchema.parse(req.query);

    let held: SftpLease | undefined;
    try {
      const opened = await lease(req.orgId, serverId, req.user.id, query.keyId);
      held = opened.held;

      // "." resolves to the login user's home directory
      const resolved =
        query.path === '.'
          ? await sftp.realpath(held.sftp, '.')
          : sftp.normalizeRemotePath(query.path);

      const entries = await sftp.list(held.sftp, resolved);
      await audit(req, 'sftp.list', 'server', serverId, opened.server.name, { path: resolved });

      return {
        path: resolved,
        parent: sftp.parentOf(resolved),
        entries,
      } satisfies SftpListResponse;
    } catch (err) {
      return sendError(reply, err);
    } finally {
      held?.release();
    }
  });

  /** GET /api/sftp/:serverId/download?path=/etc/hosts — stream a file back */
  app.get('/:serverId/download', async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const query = pathQuerySchema.parse(req.query);

    let held: SftpLease | undefined;
    try {
      const opened = await lease(req.orgId, serverId, req.user.id, query.keyId);
      held = opened.held;

      const target = sftp.normalizeRemotePath(query.path);
      const attrs = await sftp.stat(held.sftp, target);
      if (attrs.isDirectory()) {
        held.release();
        return reply.status(400).send({ error: 'Cannot download a directory' });
      }

      await audit(req, 'sftp.download', 'server', serverId, opened.server.name, {
        path: target,
        size: attrs.size,
      });

      const stream = sftp.createReadStream(held.sftp, target);
      // The lease outlives this handler — hold it until the stream finishes
      const release = held.release;
      held = undefined;
      stream.once('close', release);
      stream.once('error', release);

      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', String(attrs.size ?? 0))
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(target))}`,
        )
        .send(stream);
    } catch (err) {
      held?.release();
      return sendError(reply, err);
    }
  });

  /** GET /api/sftp/:serverId/read?path=/etc/nginx.conf — text contents for the inline editor */
  app.get('/:serverId/read', async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const query = pathQuerySchema.parse(req.query);

    let held: SftpLease | undefined;
    try {
      const opened = await lease(req.orgId, serverId, req.user.id, query.keyId);
      held = opened.held;

      const target = sftp.normalizeRemotePath(query.path);
      const attrs = await sftp.stat(held.sftp, target);
      if (attrs.isDirectory()) {
        return reply.status(400).send({ error: 'Cannot open a directory' });
      }
      if ((attrs.size ?? 0) > MAX_EDIT_BYTES) {
        return reply
          .status(413)
          .send({ error: `File is larger than ${MAX_EDIT_BYTES} bytes — download it instead` });
      }

      const buffer = await sftp.readFile(held.sftp, target, MAX_EDIT_BYTES);
      // A null byte in the leading chunk is the usual heuristic for "not text"
      if (buffer.subarray(0, 8000).includes(0)) {
        return reply.status(415).send({ error: 'File appears to be binary' });
      }

      await audit(req, 'sftp.download', 'server', serverId, opened.server.name, {
        path: target,
        mode: 'read',
      });

      return {
        path: target,
        content: buffer.toString('utf8'),
        size: attrs.size ?? buffer.length,
        truncated: (attrs.size ?? 0) > buffer.length,
      } satisfies SftpReadResponse;
    } catch (err) {
      return sendError(reply, err);
    } finally {
      held?.release();
    }
  });

  /** PUT /api/sftp/:serverId/file?path=/tmp/x.txt — upload a raw body */
  app.put('/:serverId/file', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const query = pathQuerySchema.parse(req.query);
    if (query.path === '.') return reply.status(400).send({ error: 'Path is required' });

    let held: SftpLease | undefined;
    try {
      const opened = await lease(req.orgId, serverId, req.user.id, query.keyId);
      held = opened.held;

      const target = sftp.normalizeRemotePath(query.path);
      const source = req.body as Readable;

      let bytes = 0;
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > config.sftpMaxUploadBytes) {
          source.destroy(
            new sftp.SftpError(
              `Upload exceeds the ${config.sftpMaxUploadBytes} byte limit`,
              413,
            ),
          );
        }
      });

      await pipeline(source, sftp.createWriteStream(held.sftp, target));
      await audit(req, 'sftp.upload', 'server', serverId, opened.server.name, {
        path: target,
        size: bytes,
      });

      return reply.status(201).send({ path: target, size: bytes });
    } catch (err) {
      return sendError(reply, err);
    } finally {
      held?.release();
    }
  });

  /** POST /api/sftp/:serverId/mkdir */
  app.post('/:serverId/mkdir', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const body = mkdirSchema.parse(req.body);

    let held: SftpLease | undefined;
    try {
      const opened = await lease(req.orgId, serverId, req.user.id, body.keyId);
      held = opened.held;

      const target = sftp.normalizeRemotePath(body.path);
      await sftp.mkdir(held.sftp, target);
      await audit(req, 'sftp.mkdir', 'server', serverId, opened.server.name, { path: target });

      return reply.status(201).send({ path: target });
    } catch (err) {
      return sendError(reply, err);
    } finally {
      held?.release();
    }
  });

  /** POST /api/sftp/:serverId/rename — also used for moves */
  app.post('/:serverId/rename', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const body = renameSchema.parse(req.body);

    let held: SftpLease | undefined;
    try {
      const opened = await lease(req.orgId, serverId, req.user.id, body.keyId);
      held = opened.held;

      const from = sftp.normalizeRemotePath(body.from);
      const to = sftp.normalizeRemotePath(body.to);
      await sftp.rename(held.sftp, from, to);
      await audit(req, 'sftp.rename', 'server', serverId, opened.server.name, { from, to });

      return reply.send({ from, to });
    } catch (err) {
      return sendError(reply, err);
    } finally {
      held?.release();
    }
  });

  /** DELETE /api/sftp/:serverId/file?path=…&recursive=true */
  app.delete('/:serverId/file', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const query = deleteSchema.parse(req.query);

    let held: SftpLease | undefined;
    try {
      const opened = await lease(req.orgId, serverId, req.user.id, query.keyId);
      held = opened.held;

      const target = sftp.normalizeRemotePath(query.path);
      if (target === '/') return reply.status(400).send({ error: 'Refusing to delete /' });

      const attrs = await sftp.stat(held.sftp, target);
      if (attrs.isDirectory()) {
        if (query.recursive) await sftp.removeRecursive(held.sftp, target);
        else await sftp.rmdir(held.sftp, target);
      } else {
        await sftp.unlink(held.sftp, target);
      }

      await audit(req, 'sftp.delete', 'server', serverId, opened.server.name, {
        path: target,
        recursive: query.recursive,
      });
      return reply.status(204).send();
    } catch (err) {
      return sendError(reply, err);
    } finally {
      held?.release();
    }
  });
}
