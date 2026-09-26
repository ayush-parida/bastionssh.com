import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  FTP_PROTOCOLS,
  ftpProtocolOption,
  type FtpConnection,
  type FtpProtocol,
  type FtpTestResult,
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
  backendFor,
  baseName,
  decryptPassword,
  evictConnection,
  loadConnection,
  normalizeRemotePath,
  parentOf,
  withSession,
  type FtpConnectionRow,
} from '../../ftp/index.js';
import {
  clearedFtpHostKeyColumns,
  forgetFtpHostKey,
  ftpHostKeyStatus,
  ftpHostKeyView,
  pinFtpHostKey,
} from '../../ftp/host-keys.js';
import { HostKeyMismatchError } from '../../ssh/host-keys.js';
import { fingerprintSchema } from './server-host-keys.js';

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
const fingerprintBody = z.object({ fingerprint: fingerprintSchema });

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
  hostKeyFingerprint: ftpConnections.hostKeyFingerprint,
  hostKeyMismatchFingerprint: ftpConnections.hostKeyMismatchFingerprint,
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

type PublicRow = { [K in keyof typeof publicColumns]: FtpConnectionRow[K] };

/** The mismatch fingerprint is admin-only evidence; everyone else gets the status. */
function toPublic({ hostKeyMismatchFingerprint, ...row }: PublicRow): FtpConnection {
  return {
    ...(row as Omit<FtpConnection, 'hostKeyStatus'>),
    hostKeyStatus: ftpHostKeyStatus({
      hostKeyFingerprint: row.hostKeyFingerprint,
      hostKeyMismatchFingerprint,
    }),
  };
}

function publicConnection(orgId: string, id: string): FtpConnection | undefined {
  const row = getDb()
    .select(publicColumns)
    .from(ftpConnections)
    .where(and(eq(ftpConnections.id, id), eq(ftpConnections.orgId, orgId)))
    .get();
  return row ? toPublic(row) : undefined;
}

/** An SFTP connection in the caller's org; host keys mean nothing for FTP/FTPS. */
function loadSftpConnection(orgId: string, id: string): FtpConnectionRow {
  const connection = loadConnection(orgId, id);
  if (connection.protocol !== 'sftp') {
    throw new FtpError('Only SFTP connections have an SSH host key', 400);
  }
  return connection;
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
      .all()
      .map(toPublic);
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
      const endpointChanged =
        host !== existing.host ||
        (body.port !== undefined && body.port !== existing.port) ||
        protocol !== existing.protocol;
      const targetChanged =
        endpointChanged ||
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
          // A pinned host key belongs to the endpoint it was seen on
          ...(endpointChanged && clearedFtpHostKeyColumns()),
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
      const record = async (result: FtpTestResult) => {
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
      };
      let result: FtpTestResult;
      try {
        result = await backendFor(connection.protocol).testConnection(
          connection,
          await decryptPassword(connection),
        );
      } catch (err) {
        // A changed SFTP host key answers 409 like any other request, but the
        // failed test is still recorded on the card.
        if (err instanceof HostKeyMismatchError) await record({ ok: false, error: err.message });
        throw err;
      }
      await record(result);
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── Host key (SFTP) ──────────────────────────────────────────────────────
  // Same model as a server's host key: trusted on first use, refused on change
  // until an admin pins, accepts or forgets. Admin-only — whoever picks the
  // trusted key picks who receives the password.

  /** GET …/host-key */
  app.get(
    '/connections/:id/host-key',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return ftpHostKeyView(loadSftpConnection(req.orgId, id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** PUT …/host-key {fingerprint} — pin a known-good fingerprint */
  app.put(
    '/connections/:id/host-key',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { fingerprint } = fingerprintBody.parse(req.body);
      try {
        const connection = loadSftpConnection(req.orgId, id);
        // Keep the key type when this is the key already pinned
        const type = fingerprint === connection.hostKeyFingerprint ? connection.hostKeyType : null;
        pinFtpHostKey(id, fingerprint, type);
        evictConnection(id);
        await audit(req, 'ftp_connection.host_key_pinned', 'ftp_connection', id, connection.name, {
          fingerprint,
          previous: connection.hostKeyFingerprint,
        });
        return ftpHostKeyView(loadConnection(req.orgId, id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /**
   * POST …/host-key/accept {fingerprint} — trust the key recorded in the
   * mismatch. The caller must echo that exact fingerprint.
   */
  app.post(
    '/connections/:id/host-key/accept',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { fingerprint } = fingerprintBody.parse(req.body);
      try {
        const connection = loadSftpConnection(req.orgId, id);
        if (!connection.hostKeyMismatchFingerprint) {
          return reply.status(409).send({ error: 'There is no host key mismatch to accept' });
        }
        if (fingerprint !== connection.hostKeyMismatchFingerprint) {
          return reply.status(409).send({
            error: 'Fingerprint does not match the key the host presented',
            code: 'HOST_KEY_FINGERPRINT_DIFFERS',
          });
        }
        // The type is filled in from the real key on the next connection
        pinFtpHostKey(id, fingerprint, null);
        evictConnection(id);
        await audit(req, 'ftp_connection.host_key_accepted', 'ftp_connection', id, connection.name, {
          fingerprint,
          previous: connection.hostKeyFingerprint,
        });
        return ftpHostKeyView(loadConnection(req.orgId, id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** DELETE …/host-key — forget it; the next connection trusts on first use */
  app.delete(
    '/connections/:id/host-key',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const connection = loadSftpConnection(req.orgId, id);
        forgetFtpHostKey(id);
        evictConnection(id);
        await audit(req, 'ftp_connection.host_key_forgotten', 'ftp_connection', id, connection.name, {
          previous: connection.hostKeyFingerprint,
          mismatch: connection.hostKeyMismatchFingerprint,
        });
        return reply.status(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── Files ────────────────────────────────────────────────────────────────

  /** GET …/list?path=/var/www — `.` opens the connection's root or login directory */
  app.get('/connections/:id/list', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = pathQuery.parse(req.query);
    try {
      const listing = await withSession(req.orgId, id, req.user.id, async (session, connection) => {
        const path =
          query.path === '.'
            ? await session.home(connection.rootPath)
            : normalizeRemotePath(query.path);
        const entries = await session.list(path);
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
      await withSession(req.orgId, id, req.user.id, async (session, connection) => {
        // Listing the parent first turns a missing file into a clean 404 instead
        // of an error after the response headers have already gone out.
        const entry = await session.stat(path);
        if (entry.type === 'directory') throw new FtpError('Cannot download a directory', 400);
        const size = entry.type === 'symlink' ? await session.linkTargetSize(path) : entry.size;
        await audit(req, 'ftp.download', 'ftp_connection', id, connection.name, { path, size });

        const body = new PassThrough();
        void reply
          .header('Content-Type', 'application/octet-stream')
          .header(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(baseName(path))}`,
          );
        if (size > 0) void reply.header('Content-Length', String(size));
        void reply.send(body);
        try {
          await session.download(path, body);
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

      // Count through a Transform rather than a 'data' listener: a listener would
      // set the body flowing before basic-ftp pipes it (after login, EPSV and
      // STOR), and every chunk emitted in between would be lost. Backpressure
      // keeps the body paused until the data socket is ready.
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > config.ftpMaxUploadBytes) {
            callback(
              new FtpError(`Upload exceeds the ${config.ftpMaxUploadBytes} byte limit`, 413),
            );
          } else {
            callback(null, chunk);
          }
        },
      });
      // Errors surface through `counter`, which session.upload consumes. Plain pipe
      // (not pipeline) so an over-cap body is left for Node to drain and the
      // client still gets its 413 rather than a reset socket.
      source.on('error', (err) => counter.destroy(err));
      // `counter` has no listener of its own until basic-ftp pipes it, which
      // may be never (a failed login) or only after several round trips. A
      // client abort in that window would otherwise be an unhandled 'error'
      // that takes the process down. session.upload still sees the error: a
      // destroyed stream fails the pipeline it is handed to.
      counter.on('error', () => {});
      source.pipe(counter);

      await withSession(req.orgId, id, req.user.id, async (session, connection) => {
        await session.upload(counter, path);
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
        await withSession(req.orgId, id, req.user.id, async (session, connection) => {
          await session.mkdir(path);
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
          await withSession(req.orgId, id, req.user.id, async (session, connection) => {
            await session.rename(from, to);
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
        await withSession(req.orgId, id, req.user.id, async (session, connection) => {
          // stat describes a symlink itself, so a link is unlinked, never followed
          const entry = await session.stat(path);
          if (entry.type === 'directory') {
            if (query.recursive) await session.removeDirRecursive(path);
            else await session.removeEmptyDir(path);
          } else {
            await session.removeFile(path);
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
