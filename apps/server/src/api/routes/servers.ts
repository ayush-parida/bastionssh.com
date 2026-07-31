import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { servers } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { audit } from '../../audit/index.js';
import { vault } from '../../vault/index.js';
import { evictServer } from '../../ssh/sftp.js';

const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  authType: z.enum(['key', 'password']).default('key'),
  defaultKeyId: z.string().optional(),
  password: z.string().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

/** Strip encryptedPassword and return safe server object */
function sanitize(row: typeof servers.$inferSelect) {
  const { encryptedPassword, ...safe } = row;
  return { ...safe, authType: encryptedPassword ? 'password' : 'key' } as const;
}

export async function serverRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    return db.select().from(servers).where(eq(servers.orgId, req.orgId)).all().map(sanitize);
  });

  app.post('/', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = createServerSchema.parse(req.body);
    const db = getDb();
    const id = nanoid();

    let encryptedPassword: string | null = null;
    if (body.authType === 'password' && body.password) {
      encryptedPassword = await vault.encrypt(body.password, id);
    }

    db.insert(servers)
      .values({
        id,
        orgId: req.orgId,
        createdBy: req.user.id,
        name: body.name,
        host: body.host,
        port: body.port,
        username: body.username,
        defaultKeyId: body.authType === 'key' ? body.defaultKeyId : undefined,
        encryptedPassword: encryptedPassword ?? null,
        tags: JSON.stringify(body.tags),
        notes: body.notes,
      })
      .run();

    await audit(req, 'server.create', 'server', id, body.name);
    const row = db.select().from(servers).where(eq(servers.id, id)).get()!;
    return reply.status(201).send(sanitize(row));
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const server = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!server) return reply.status(404).send({ error: 'Not found' });
    return sanitize(server);
  });

  app.patch('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createServerSchema.partial().parse(req.body);
    const db = getDb();

    const existing = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    const updateData: Partial<typeof servers.$inferInsert> = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.host !== undefined && { host: body.host }),
      ...(body.port !== undefined && { port: body.port }),
      ...(body.username !== undefined && { username: body.username }),
      ...(body.tags !== undefined && { tags: JSON.stringify(body.tags) }),
      ...(body.notes !== undefined && { notes: body.notes }),
      updatedAt: new Date().toISOString(),
    };

    if (body.authType === 'password' && body.password) {
      updateData.encryptedPassword = await vault.encrypt(body.password, id);
      updateData.defaultKeyId = null; // clear key when switching to password
    } else if (body.authType === 'key') {
      updateData.defaultKeyId = body.defaultKeyId;
      updateData.encryptedPassword = null;
    }

    db.update(servers).set(updateData).where(eq(servers.id, id)).run();
    // Pooled SFTP channels hold the old host/credentials — force a reconnect
    evictServer(req.orgId, id);
    await audit(req, 'server.update', 'server', id, existing.name);
    const row = db.select().from(servers).where(eq(servers.id, id)).get()!;
    return sanitize(row);
  });

  app.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const existing = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), eq(servers.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    db.delete(servers).where(eq(servers.id, id)).run();
    evictServer(req.orgId, id);
    await audit(req, 'server.delete', 'server', id, existing.name);
    return reply.status(204).send();
  });
}
