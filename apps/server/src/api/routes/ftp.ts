import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PassThrough, type Readable } from 'node:stream';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  FTP_PROTOCOLS,
  ftpProtocolOption,
  type FtpConnection,
  type FtpProtocol,
} from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { boolQuery } from '../query.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { getDb } from '../../db/index.js';
import { ftpConnections } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import {
  FtpError,
  assertSafeHost,
  baseName,
  decryptPassword,
  evictConnection,
  loadConnection,
  normalizeRemotePath,
  ops,
  parentOf,
  toTarget,
  withClient,
} from '../../ftp/index.js';

const protocolSchema = z.enum(FTP_PROTOCOLS);
const portSchema = z.number().int().min(1).max(65535);
const rootPathSchema = z.string().max(1024).nullable();
const pathSchema = z.string().min(1).max(4096);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(253),
  port: portSchema.optional(),
  protocol: protocolSchema.default('ftps'),
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
  verifyTls: z.boolean().default(true),
  rootPath: rootPathSchema.optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  host: z.string().min(1).max(253).optional(),
  port: portSchema.optional(),
  protocol: protocolSchema.optional(),
  username: z.string().min(1).max(256).optional(),
  password: z.string().min(1).max(1024).optional(),
  verifyTls: z.boolean().optional(),
  rootPath: rootPathSchema.optional(),
});

const pathQuery = z.object({ path: pathSchema });
const deleteQuery = z.object({ path: pathSchema, recursive: boolQuery });
const mkdirSchema = z.object({ path: pathSchema });
const renameSchema = z.object({ from: pathSchema, to: pathSchema });

/** Everything but the password. */
const publicColumns = {
  id: ftpConnections.id,
  orgId: ftpConnections.orgId,
  name: ftpConnections.name,
  host: ftpConnections.host,
  port: ftpConnections.port,
  protocol: ftpConnections.protocol,
  username: ftpConnections.username,
  verifyTls: ftpConnections.verifyTls,
  rootPath: ftpConnections.rootPath,
  lastStatus: ftpConnections.lastStatus,
  lastError: ftpConnections.lastError,
  lastTestedAt: ftpConnections.lastTestedAt,
  createdBy: ftpConnections.createdBy,
  createdAt: ftpConnections.createdAt,
  updatedAt: ftpConnections.updatedAt,
};

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof FtpError) {
    return reply.status(err.statusCode).send({ error: err.message });
  }
  throw err;
}

/** `null` keeps "start at the login directory"; anything else must be absolute. */
function resolveRootPath(rootPath: string | null | undefined): string | null {
  if (rootPath == null || rootPath.trim() === '') return null;
  return normalizeRemotePath(rootPath.trim());
}

function publicConnection(orgId: string, id: string): FtpConnection | undefined {
  return getDb()
    .select(publicColumns)
    .from(ftpConnections)
    .where(and(eq(ftpConnections.id, id), eq(ftpConnections.orgId, orgId)))
    .get() as FtpConnection | undefined;
}

export async function ftpRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Uploads arrive as a raw body so large files never buffer in memory.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  // ── Connections ──────────────────────────────────────────────────────────

  app.get('/connections', async (req) => {
    return getDb()
      .select(publicColumns)
      .from(ftpConnections)
      .where(eq(ftpConnections.orgId, req.orgId))
      .orderBy(desc(ftpConnections.createdAt))
      .all();
  });

  app.get('/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connection = publicConnection(req.orgId, id);
    if (!connection) return reply.status(404).send({ error: 'Not found' });
    return connection;
  });

  app.post('/connections', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    try {
      const host = assertSafeHost(body.host);
      const rootPath = resolveRootPath(body.rootPath);
      const port = body.port ?? ftpProtocolOption(body.protocol).defaultPort;
      const id = nanoid();
      getDb()
        .insert(ftpConnections)
        .values({
          id,
          orgId: req.orgId,
          name: body.name,
          host,
          port,
          protocol: body.protocol,
          username: body.username,
          encryptedPassword: await vault.encrypt(body.password, id),
          verifyTls: body.verifyTls,
          rootPath,
          createdBy: req.user.id,
        })
        .run();

      await audit(req, 'ftp_connection.create', 'ftp_connection', id, body.name, {
        host,
        port,
        protocol: body.protocol,
      });
      return reply.status(201).send(publicConnection(req.orgId, id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/connections/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);
    const db = getDb();

    const existing = db
      .select()
      .from(ftpConnections)
      .where(and(eq(ftpConnections.id, id), eq(ftpConnections.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    try {
      const host = body.host !== undefined ? assertSafeHost(body.host) : existing.host;
      const protocol = (body.protocol ?? existing.protocol) as FtpProtocol;
      const rootPath =
        body.rootPath !== undefined ? resolveRootPath(body.rootPath) : existing.rootPath;
      const targetChanged =
        host !== existing.host ||
        (body.port !== undefined && body.port !== existing.port) ||
        protocol !== existing.protocol ||
        (body.username !== undefined && body.username !== existing.username) ||
        (body.verifyTls !== undefined && body.verifyTls !== existing.verifyTls) ||
        body.password !== undefined;

      db.update(ftpConnections)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          host,
          ...(body.port !== undefined && { port: body.port }),
          protocol,
          ...(body.username !== undefined && { username: body.username }),
          ...(body.password !== undefined && {
            encryptedPassword: await vault.encrypt(body.password, id),
          }),
          ...(body.verifyTls !== undefined && { verifyTls: body.verifyTls }),
          rootPath,
          // A new target or credential invalidates whatever the last test reported;
          // a rename does not.
          ...(targetChanged && { lastStatus: null, lastError: null, lastTestedAt: null }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(ftpConnections.id, id))
        .run();

      evictConnection(id);
      await audit(req, 'ftp_connection.update', 'ftp_connection', id, existing.name);
      return publicConnection(req.orgId, id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/connections/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const existing = db
      .select()
      .from(ftpConnections)
      .where(and(eq(ftpConnections.id, id), eq(ftpConnections.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    db.delete(ftpConnections).where(eq(ftpConnections.id, id)).run();
    evictConnection(id);
    await audit(req, 'ftp_connection.delete', 'ftp_connection', id, existing.name);
    return reply.status(204).send();
  });

  app.post('/connections/:id/test', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const connection = loadConnection(req.orgId, id);
      const result = await ops.testConnection(
        toTarget(connection),
        await decryptPassword(connection),
      );
      getDb()
        .update(ftpConnections)
        .set({
          lastStatus: result.ok ? 'ok' : 'failed',
          lastError: result.ok ? null : (result.error ?? 'Unknown error'),
          lastTestedAt: new Date().toISOString(),
        })
        .where(eq(ftpConnections.id, id))
        .run();
      await audit(req, 'ftp_connection.test', 'ftp_connection', id, connection.name, {
        ok: result.ok,
      });
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── Files ────────────────────────────────────────────────────────────────

  /** GET …/list?path=/var/www — `.` opens the connection's root or login directory */
  app.get('/connections/:id/list', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = pathQuery.parse(req.query);
    try {
      const listing = await withClient(req.orgId, id, req.user.id, async (client, connection) => {
        const path =
          query.path === '.'
            ? await ops.home(client, connection.rootPath)
            : normalizeRemotePath(query.path);
        const entries = await ops.list(client, path);
        await audit(req, 'ftp.list', 'ftp_connection', id, connection.name, { path });
        return { path, parent: parentOf(path), entries };
      });
      return listing;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** GET …/download?path=/var/www/index.html — stream the file down */
  app.get('/connections/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = pathQuery.parse(req.query);
    const path = normalizeRemotePath(query.path);
    try {
      await withClient(req.orgId, id, req.user.id, async (client, connection) => {
        // Listing the parent first turns a missing file into a clean 404 instead
        // of an error after the response headers have already gone out.
        const entry = await ops.stat(client, path);
        if (entry.type === 'directory') throw new FtpError('Cannot download a directory', 400);
        await audit(req, 'ftp.download', 'ftp_connection', id, connection.name, {
          path,
          size: entry.size,
        });

        const body = new PassThrough();
        void reply
          .header('Content-Type', 'application/octet-stream')
          .header(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(baseName(path))}`,
          );
        if (entry.size > 0) void reply.header('Content-Length', String(entry.size));
        void reply.send(body);
        try {
          await ops.download(client, path, body);
        } catch (err) {
          // Headers are gone; the only honest signal left is a broken stream.
          body.destroy(err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      });
      return reply;
    } catch (err) {
      if (reply.sent) return reply;
      return sendError(reply, err);
    }
  });

  /** PUT …/file?path=/var/www/index.html — stream a raw body up */
  app.put('/connections/:id/file', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = pathQuery.parse(req.query);
    try {
      const path = normalizeRemotePath(query.path);
      if (path === '/') return reply.status(400).send({ error: 'Path must name a file' });

      // Browsers always declare a File body's length, so an oversized upload can
      // be refused cleanly before a byte is read. The counter below still guards
      // chunked bodies with no declared length.
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > config.ftpMaxUploadBytes) {
        return reply
          .status(413)
          .send({ error: `Upload exceeds the ${config.ftpMaxUploadBytes} byte limit` });
      }
      const source = req.body as Readable | undefined;
      if (!source || typeof source.on !== 'function') {
        return reply
          .status(400)
          .send({ error: 'Upload body must be sent as application/octet-stream' });
      }

      let bytes = 0;
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > config.ftpMaxUploadBytes) {
          source.destroy(
            new FtpError(`Upload exceeds the ${config.ftpMaxUploadBytes} byte limit`, 413),
          );
        }
      });

      await withClient(req.orgId, id, req.user.id, async (client, connection) => {
        await ops.upload(client, source, path);
        await audit(req, 'ftp.upload', 'ftp_connection', id, connection.name, {
          path,
          size: bytes,
        });
      });
      return reply.status(201).send({ path, size: bytes });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** POST …/mkdir { path } */
  app.post(
    '/connections/:id/mkdir',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = mkdirSchema.parse(req.body);
      try {
        const path = normalizeRemotePath(body.path);
        if (path === '/') return reply.status(400).send({ error: 'Folder name is required' });
        await withClient(req.orgId, id, req.user.id, async (client, connection) => {
          await ops.mkdir(client, path);
          await audit(req, 'ftp.mkdir', 'ftp_connection', id, connection.name, { path });
        });
        return reply.status(201).send({ path });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** POST …/rename { from, to } */
  app.post(
    '/connections/:id/rename',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = renameSchema.parse(req.body);
      try {
        const from = normalizeRemotePath(body.from);
        const to = normalizeRemotePath(body.to);
        if (from === '/' || to === '/') {
          return reply.status(400).send({ error: 'Cannot rename the root directory' });
        }
        if (from !== to) {
          await withClient(req.orgId, id, req.user.id, async (client, connection) => {
            await ops.rename(client, from, to);
            await audit(req, 'ftp.rename', 'ftp_connection', id, connection.name, { from, to });
          });
        }
        return { from, to };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** DELETE …/file?path=/var/www/old&recursive= — a file, an empty directory, or a whole tree */
  app.delete(
    '/connections/:id/file',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = deleteQuery.parse(req.query);
      try {
        const path = normalizeRemotePath(query.path);
        if (path === '/') return reply.status(400).send({ error: 'Refusing to delete the root' });
        await withClient(req.orgId, id, req.user.id, async (client, connection) => {
          const entry = await ops.stat(client, path);
          if (entry.type === 'directory') {
            if (query.recursive) await ops.removeDirRecursive(client, path);
            else await ops.removeEmptyDir(client, path);
          } else {
            await ops.removeFile(client, path);
          }
          await audit(req, 'ftp.delete', 'ftp_connection', id, connection.name, {
            path,
            type: entry.type,
            recursive: query.recursive,
          });
        });
        return reply.status(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
