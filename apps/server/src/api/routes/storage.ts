import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { StorageConnection, StorageProvider } from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { boolQuery } from '../query.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { getDb } from '../../db/index.js';
import { storageConnections } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import {
  StorageError,
  assertBucketParam,
  assertSafeEndpoint,
  baseName,
  evictConnection,
  normalizeKey,
  normalizePrefix,
  ops,
  resolveConnection,
  validateBucketName,
} from '../../storage/index.js';

const providerSchema = z.enum(['s3', 'minio', 'other']);
const endpointSchema = z.string().min(1).max(2000);
const keySchema = z.string().min(1).max(1024);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  provider: providerSchema.default('s3'),
  endpoint: endpointSchema.nullable().optional(),
  region: z.string().min(1).max(64).default('us-east-1'),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(1024),
  forcePathStyle: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  provider: providerSchema.optional(),
  endpoint: endpointSchema.nullable().optional(),
  region: z.string().min(1).max(64).optional(),
  accessKeyId: z.string().min(1).max(256).optional(),
  secretAccessKey: z.string().min(1).max(1024).optional(),
  forcePathStyle: z.boolean().optional(),
});

const createBucketSchema = z.object({ name: z.string().min(1).max(255) });
const deleteBucketQuery = z.object({ force: boolQuery });
const listQuery = z.object({
  prefix: z.string().max(1024).default(''),
  token: z.string().max(4096).optional(),
});
const keyQuery = z.object({ key: keySchema });
const uploadQuery = z.object({ key: keySchema, contentType: z.string().max(255).optional() });
const deleteObjectQuery = z.object({ key: keySchema, recursive: boolQuery });
const folderSchema = z.object({ prefix: keySchema });
const renameSchema = z.object({ from: keySchema, to: keySchema });

/** Everything but the secret. */
const publicColumns = {
  id: storageConnections.id,
  orgId: storageConnections.orgId,
  name: storageConnections.name,
  provider: storageConnections.provider,
  endpoint: storageConnections.endpoint,
  region: storageConnections.region,
  accessKeyId: storageConnections.accessKeyId,
  forcePathStyle: storageConnections.forcePathStyle,
  lastStatus: storageConnections.lastStatus,
  lastError: storageConnections.lastError,
  lastTestedAt: storageConnections.lastTestedAt,
  createdBy: storageConnections.createdBy,
  createdAt: storageConnections.createdAt,
  updatedAt: storageConnections.updatedAt,
};

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof StorageError) {
    return reply.status(err.statusCode).send({ error: err.message });
  }
  throw err;
}

/** A non-AWS provider has nowhere to go without an endpoint. */
function resolveEndpoint(
  provider: StorageProvider,
  endpoint: string | null | undefined,
): string | null {
  if (endpoint) return assertSafeEndpoint(endpoint);
  if (provider !== 's3') {
    throw new StorageError(
      'An endpoint is required for MinIO and other S3-compatible providers',
      400,
    );
  }
  return null;
}

function publicConnection(orgId: string, id: string): StorageConnection | undefined {
  return getDb()
    .select(publicColumns)
    .from(storageConnections)
    .where(and(eq(storageConnections.id, id), eq(storageConnections.orgId, orgId)))
    .get() as StorageConnection | undefined;
}

export async function storageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Uploads arrive as a raw body so large objects never buffer in memory.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  // ── Connections ──────────────────────────────────────────────────────────

  app.get('/connections', async (req) => {
    return getDb()
      .select(publicColumns)
      .from(storageConnections)
      .where(eq(storageConnections.orgId, req.orgId))
      .orderBy(desc(storageConnections.createdAt))
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
      const endpoint = resolveEndpoint(body.provider, body.endpoint);
      const id = nanoid();
      getDb()
        .insert(storageConnections)
        .values({
          id,
          orgId: req.orgId,
          name: body.name,
          provider: body.provider,
          endpoint,
          region: body.region,
          accessKeyId: body.accessKeyId,
          encryptedSecretAccessKey: await vault.encrypt(body.secretAccessKey, id),
          // AWS prefers virtual-host style; everyone else usually needs path style
          forcePathStyle: body.forcePathStyle ?? body.provider !== 's3',
          createdBy: req.user.id,
        })
        .run();

      await audit(req, 'storage_connection.create', 'storage_connection', id, body.name, {
        provider: body.provider,
        endpoint,
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
      .from(storageConnections)
      .where(and(eq(storageConnections.id, id), eq(storageConnections.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    try {
      const provider = (body.provider ?? existing.provider) as StorageProvider;
      const endpoint = resolveEndpoint(
        provider,
        body.endpoint !== undefined ? body.endpoint : existing.endpoint,
      );
      const targetChanged =
        endpoint !== existing.endpoint ||
        (body.region !== undefined && body.region !== existing.region) ||
        (body.accessKeyId !== undefined && body.accessKeyId !== existing.accessKeyId) ||
        (body.forcePathStyle !== undefined && body.forcePathStyle !== existing.forcePathStyle) ||
        body.secretAccessKey !== undefined;

      db.update(storageConnections)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          provider,
          endpoint,
          ...(body.region !== undefined && { region: body.region }),
          ...(body.accessKeyId !== undefined && { accessKeyId: body.accessKeyId }),
          ...(body.forcePathStyle !== undefined && { forcePathStyle: body.forcePathStyle }),
          ...(body.secretAccessKey !== undefined && {
            encryptedSecretAccessKey: await vault.encrypt(body.secretAccessKey, id),
          }),
          // A new target or credential invalidates whatever the last test reported;
          // a rename does not.
          ...(targetChanged && { lastStatus: null, lastError: null, lastTestedAt: null }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(storageConnections.id, id))
        .run();

      evictConnection(id);
      await audit(req, 'storage_connection.update', 'storage_connection', id, existing.name);
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
      .from(storageConnections)
      .where(and(eq(storageConnections.id, id), eq(storageConnections.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    db.delete(storageConnections).where(eq(storageConnections.id, id)).run();
    evictConnection(id);
    await audit(req, 'storage_connection.delete', 'storage_connection', id, existing.name);
    return reply.status(204).send();
  });

  app.post('/connections/:id/test', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { connection, client } = await resolveConnection(req.orgId, id);
      const result = await ops.testConnection(client);
      getDb()
        .update(storageConnections)
        .set({
          lastStatus: result.ok ? 'ok' : 'failed',
          lastError: result.ok ? null : (result.error ?? 'Unknown error'),
          lastTestedAt: new Date().toISOString(),
        })
        .where(eq(storageConnections.id, id))
        .run();
      await audit(req, 'storage_connection.test', 'storage_connection', id, connection.name, {
        ok: result.ok,
      });
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── Buckets ──────────────────────────────────────────────────────────────

  app.get('/connections/:id/buckets', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { client } = await resolveConnection(req.orgId, id);
      return await ops.listBuckets(client);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/connections/:id/buckets', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createBucketSchema.parse(req.body);
    try {
      const { connection, client } = await resolveConnection(req.orgId, id);
      const bucket = validateBucketName(body.name);
      await ops.createBucket(client, bucket, connection.region);
      await audit(req, 'storage.bucket_create', 'storage_connection', id, connection.name, {
        bucket,
      });
      return reply.status(201).send({ name: bucket, createdAt: new Date().toISOString() });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete(
    '/connections/:id/buckets/:bucket',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const query = deleteBucketQuery.parse(req.query);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);
        const deletedObjects = query.force ? await ops.deletePrefix(client, bucket, '') : 0;
        await ops.deleteBucket(client, bucket);
        await audit(req, 'storage.bucket_delete', 'storage_connection', id, connection.name, {
          bucket,
          force: query.force,
          deletedObjects,
        });
        return { bucket, deletedObjects };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── Objects ──────────────────────────────────────────────────────────────

  /** GET …/objects?prefix=photos/&token= — one page of folders and objects */
  app.get('/connections/:id/buckets/:bucket/objects', async (req, reply) => {
    const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
    const query = listQuery.parse(req.query);
    try {
      const { connection, client } = await resolveConnection(req.orgId, id);
      const bucket = assertBucketParam(rawBucket);
      const prefix = normalizePrefix(query.prefix);
      const listing = await ops.listObjects(client, bucket, prefix, query.token);
      await audit(req, 'storage.list', 'storage_connection', id, connection.name, {
        bucket,
        prefix,
      });
      return listing;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** GET …/object?key=photos/cat.jpg — stream the object down */
  app.get('/connections/:id/buckets/:bucket/object', async (req, reply) => {
    const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
    const query = keyQuery.parse(req.query);
    try {
      const { connection, client } = await resolveConnection(req.orgId, id);
      const bucket = assertBucketParam(rawBucket);
      const key = normalizeKey(query.key);
      const object = await ops.getObject(client, bucket, key);
      await audit(req, 'storage.download', 'storage_connection', id, connection.name, {
        bucket,
        key,
        size: object.contentLength,
      });

      void reply
        .header('Content-Type', object.contentType ?? 'application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(baseName(key))}`,
        );
      if (object.contentLength != null) {
        void reply.header('Content-Length', String(object.contentLength));
      }
      if (object.contentEncoding) {
        void reply.header('Content-Encoding', object.contentEncoding);
      }
      return reply.send(object.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** PUT …/object?key=photos/cat.jpg&contentType=image/jpeg — stream a raw body up */
  app.put(
    '/connections/:id/buckets/:bucket/object',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const query = uploadQuery.parse(req.query);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);
        const key = normalizeKey(query.key);

        // Browsers always declare a File body's length, so an oversized upload can
        // be refused cleanly before a byte is read. The counter below still guards
        // chunked bodies with no declared length.
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > config.storageMaxUploadBytes) {
          return reply
            .status(413)
            .send({ error: `Upload exceeds the ${config.storageMaxUploadBytes} byte limit` });
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
          if (bytes > config.storageMaxUploadBytes) {
            source.destroy(
              new StorageError(
                `Upload exceeds the ${config.storageMaxUploadBytes} byte limit`,
                413,
              ),
            );
          }
        });

        await ops.putObject(client, bucket, key, source, query.contentType);
        await audit(req, 'storage.upload', 'storage_connection', id, connection.name, {
          bucket,
          key,
          size: bytes,
        });
        return reply.status(201).send({ bucket, key, size: bytes });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** POST …/folder { prefix } — create a folder marker */
  app.post(
    '/connections/:id/buckets/:bucket/folder',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const body = folderSchema.parse(req.body);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);
        const prefix = normalizePrefix(body.prefix);
        if (prefix === '') return reply.status(400).send({ error: 'Folder name is required' });
        await ops.createFolder(client, bucket, prefix);
        await audit(req, 'storage.mkdir', 'storage_connection', id, connection.name, {
          bucket,
          prefix,
        });
        return reply.status(201).send({ bucket, prefix });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** POST …/rename { from, to } — copy + delete a single object */
  app.post(
    '/connections/:id/buckets/:bucket/rename',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const body = renameSchema.parse(req.body);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);
        const from = normalizeKey(body.from);
        const to = normalizeKey(body.to);
        await ops.renameObject(client, bucket, from, to);
        await audit(req, 'storage.rename', 'storage_connection', id, connection.name, {
          bucket,
          from,
          to,
        });
        return { bucket, from, to };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** DELETE …/object?key=photos/cat.jpg — or ?key=photos/&recursive=true for a prefix */
  app.delete(
    '/connections/:id/buckets/:bucket/object',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const query = deleteObjectQuery.parse(req.query);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);

        if (query.recursive) {
          const prefix = normalizePrefix(query.key);
          if (prefix === '') {
            return reply.status(400).send({
              error:
                'Refusing to empty the whole bucket here — delete the bucket with force instead',
            });
          }
          const deleted = await ops.deletePrefix(client, bucket, prefix);
          await audit(req, 'storage.delete', 'storage_connection', id, connection.name, {
            bucket,
            prefix,
            recursive: true,
            deleted,
          });
          return { bucket, prefix, deleted };
        }

        const key = normalizeKey(query.key);
        await ops.deleteObject(client, bucket, key);
        await audit(req, 'storage.delete', 'storage_connection', id, connection.name, {
          bucket,
          key,
        });
        return reply.status(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
