import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  CHANNEL_TYPE_IDS,
  channelMeta,
  type ChannelField,
  type NotificationCapabilities,
  type NotificationChannelType,
} from '@smt/shared';
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
  type ChannelInput,
} from '../../notifications/index.js';

const targetFields = {
  url: z.string().url().max(2000),
  recipients: z.array(z.string().email().max(254)).min(1).max(20),
  token: z.string().min(1).max(256),
  chatId: z.string().min(1).max(64),
  userKey: z.string().min(1).max(64),
  routingKey: z.string().min(1).max(256),
  region: z.enum(['us', 'eu']),
} satisfies Record<ChannelField, z.ZodTypeAny>;

const optionalTargetFields = Object.fromEntries(
  Object.entries(targetFields).map(([k, v]) => [k, v.optional()]),
) as { [K in ChannelField]: z.ZodOptional<(typeof targetFields)[K]> };

const createSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(CHANNEL_TYPE_IDS),
  minSeverity: z.enum(['warning', 'critical']).default('warning'),
  notifyOnResolve: z.boolean().default(true),
  enabled: z.boolean().default(true),
  ...optionalTargetFields,
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  minSeverity: z.enum(['warning', 'critical']).optional(),
  notifyOnResolve: z.boolean().optional(),
  enabled: z.boolean().optional(),
  ...optionalTargetFields,
});

const FIELD_NAMES = Object.keys(targetFields) as ChannelField[];

/** The target fields present in a body, or null when none were sent. */
function pickTarget(body: Partial<ChannelInput>): ChannelInput | null {
  const input: ChannelInput = {};
  let any = false;
  for (const field of FIELD_NAMES) {
    const value = body[field];
    if (value !== undefined) {
      (input as Record<string, unknown>)[field] = value;
      any = true;
    }
  }
  return any ? input : null;
}

/**
 * Validate per-type input and produce what to vault. Fields that do not belong
 * to the type are refused rather than ignored, so a typo never silently
 * creates a channel with the wrong target.
 */
function resolveTarget(type: NotificationChannelType, input: ChannelInput): { target: string; hint: string } {
  const allowed = channelMeta(type).fields;
  for (const field of FIELD_NAMES) {
    if (input[field] !== undefined && !allowed.includes(field)) {
      throw new ChannelInputError(`"${field}" does not apply to ${channelMeta(type).label} channels`);
    }
  }
  return getAdapter(type).prepare(input);
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
      resolved = resolveTarget(body.type, pickTarget(body) ?? {});
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

    // Any target field replaces the stored target as a whole
    let resolved: { target: string; hint: string } | null = null;
    const targetInput = pickTarget(body);
    if (targetInput) {
      try {
        resolved = resolveTarget(existing.type as NotificationChannelType, targetInput);
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
