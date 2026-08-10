import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { notificationChannels } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { audit } from '../../audit/index.js';
import {
  assertSafeUrl,
  InvalidWebhookUrlError,
  maskUrl,
  sendTestNotification,
} from '../../notifications/index.js';

const createSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['webhook', 'slack']),
  url: z.string().url().max(2000),
  minSeverity: z.enum(['warning', 'critical']).default('warning'),
  notifyOnResolve: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().max(2000).optional(),
  minSeverity: z.enum(['warning', 'critical']).optional(),
  notifyOnResolve: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** The encrypted URL never leaves the server. */
const publicColumns = {
  id: notificationChannels.id,
  orgId: notificationChannels.orgId,
  name: notificationChannels.name,
  type: notificationChannels.type,
  targetHint: notificationChannels.targetHint,
  enabled: notificationChannels.enabled,
  minSeverity: notificationChannels.minSeverity,
  notifyOnResolve: notificationChannels.notifyOnResolve,
  lastStatus: notificationChannels.lastStatus,
  lastError: notificationChannels.lastError,
  lastSentAt: notificationChannels.lastSentAt,
  createdAt: notificationChannels.createdAt,
  updatedAt: notificationChannels.updatedAt,
};

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/channels', async (req) => {
    return getDb()
      .select(publicColumns)
      .from(notificationChannels)
      .where(eq(notificationChannels.orgId, req.orgId))
      .orderBy(desc(notificationChannels.createdAt))
      .all();
  });

  app.post('/channels', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    try {
      assertSafeUrl(body.url);
    } catch (err) {
      if (err instanceof InvalidWebhookUrlError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    const db = getDb();
    const id = nanoid();

    db.insert(notificationChannels)
      .values({
        id,
        orgId: req.orgId,
        name: body.name,
        type: body.type,
        encryptedUrl: await vault.encrypt(body.url, id),
        targetHint: maskUrl(body.url),
        enabled: body.enabled,
        minSeverity: body.minSeverity,
        notifyOnResolve: body.notifyOnResolve,
        createdBy: req.user.id,
      })
      .run();

    await audit(req, 'notification_channel.create', 'notification_channel', id, body.name);
    return reply
      .status(201)
      .send(db.select(publicColumns).from(notificationChannels).where(eq(notificationChannels.id, id)).get());
  });

  app.patch('/channels/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);
    const db = getDb();

    const existing = db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    if (body.url !== undefined) {
      try {
        assertSafeUrl(body.url);
      } catch (err) {
        if (err instanceof InvalidWebhookUrlError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    }

    db.update(notificationChannels)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.minSeverity !== undefined && { minSeverity: body.minSeverity }),
        ...(body.notifyOnResolve !== undefined && { notifyOnResolve: body.notifyOnResolve }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        // A new URL invalidates whatever the last delivery reported
        ...(body.url !== undefined && {
          encryptedUrl: await vault.encrypt(body.url, id),
          targetHint: maskUrl(body.url),
          lastStatus: null,
          lastError: null,
          lastSentAt: null,
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(notificationChannels.id, id))
      .run();

    await audit(req, 'notification_channel.update', 'notification_channel', id, existing.name);
    return db.select(publicColumns).from(notificationChannels).where(eq(notificationChannels.id, id)).get();
  });

  app.post('/channels/:id/test', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await sendTestNotification(req.orgId, id);
    if (!result.ok && result.error === 'Channel not found') {
      return reply.status(404).send({ error: 'Not found' });
    }
    await audit(req, 'notification_channel.test', 'notification_channel', id, undefined, {
      ok: result.ok,
    });
    return result;
  });

  app.delete('/channels/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const existing = db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    db.delete(notificationChannels).where(eq(notificationChannels.id, id)).run();
    await audit(req, 'notification_channel.delete', 'notification_channel', id, existing.name);
    return reply.status(204).send();
  });
}
