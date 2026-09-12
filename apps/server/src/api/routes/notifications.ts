import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { NotificationCapabilities, NotificationChannelType } from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { notificationChannels } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { audit } from '../../audit/index.js';
import {
  ChannelInputError,
  emailAvailable,
  getAdapter,
  sendTestNotification,
} from '../../notifications/index.js';

const urlSchema = z.string().url().max(2000);
const recipientsSchema = z.array(z.string().email().max(254)).min(1).max(20);

const baseCreate = z.object({
  name: z.string().min(1).max(100),
  minSeverity: z.enum(['warning', 'critical']).default('warning'),
  notifyOnResolve: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

/** Webhook-style channels take a URL; email takes recipients. Neither accepts the other. */
const createSchema = z.discriminatedUnion('type', [
  baseCreate.extend({
    type: z.enum(['webhook', 'slack', 'discord']),
    url: urlSchema,
    recipients: z.undefined(),
  }),
  baseCreate.extend({ type: z.literal('email'), recipients: recipientsSchema, url: z.undefined() }),
]);

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: urlSchema.optional(),
  recipients: recipientsSchema.optional(),
  minSeverity: z.enum(['warning', 'critical']).optional(),
  notifyOnResolve: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** Validate per-type input and produce what to vault; throws ChannelInputError (→ 400). */
function resolveTarget(
  type: NotificationChannelType,
  url: string | undefined,
  recipients: string[] | undefined,
): { target: string; hint: string } {
  if (type !== 'email' && recipients !== undefined) {
    throw new ChannelInputError('Recipients only apply to email channels');
  }
  return getAdapter(type).prepare({ url, recipients });
}

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

  app.get('/capabilities', async (): Promise<NotificationCapabilities> => ({
    email: emailAvailable(),
  }));

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
    let resolved: { target: string; hint: string };
    try {
      resolved = resolveTarget(body.type, body.url, body.recipients);
    } catch (err) {
      if (err instanceof ChannelInputError) {
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
        encryptedUrl: await vault.encrypt(resolved.target, id),
        targetHint: resolved.hint,
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

    // A new URL or recipient list replaces the stored target
    let resolved: { target: string; hint: string } | null = null;
    if (body.url !== undefined || body.recipients !== undefined) {
      try {
        resolved = resolveTarget(
          existing.type as NotificationChannelType,
          body.url,
          body.recipients,
        );
      } catch (err) {
        if (err instanceof ChannelInputError) {
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
        // A new target invalidates whatever the last delivery reported
        ...(resolved && {
          encryptedUrl: await vault.encrypt(resolved.target, id),
          targetHint: resolved.hint,
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
