import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import {
  accessibleSavedCommandFilter,
  accessibleServerFilter,
  canAccessServer,
} from '../../auth/server-access.js';
import { getDb } from '../../db/index.js';
import { cronJobs, cronRuns, savedCommands } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { parseCronSchedule, getNextRun } from '@smt/cron-parser';
import { audit } from '../../audit/index.js';
import { scheduleCronJob, unscheduleCronJob } from '../../worker/scheduler.js';
import logger from '../../logger.js';

const createCronBaseSchema = z.object({
  serverId: z.string(),
  savedCommandId: z.string().optional(),
  inlineCommand: z.string().optional(),
  name: z.string().min(1).max(200),
  schedule: z.string().min(1),
  timezone: z.string().default('UTC'),
  enabled: z.boolean().default(true),
  notify: z
    .object({
      onFailure: z.boolean().optional(),
      webhookUrl: z.string().url().optional(),
      email: z.string().email().optional(),
    })
    .default({}),
});

const createCronSchema = createCronBaseSchema.refine((d) => d.savedCommandId ?? d.inlineCommand, {
  message: 'Provide either savedCommandId or inlineCommand',
});

// The worker prefers an inline command, so accepting both would silently run
// the inline one instead of the saved command the user picked.
const BOTH_COMMANDS_ERROR = 'Provide either savedCommandId or inlineCommand, not both';

/**
 * A saved command can only be referenced by a job in the same org, and only
 * one the caller can see (not bound to a server they cannot access).
 */
function savedCommandInOrg(req: FastifyRequest, id: string) {
  return getDb()
    .select({ id: savedCommands.id })
    .from(savedCommands)
    .where(
      and(
        eq(savedCommands.id, id),
        eq(savedCommands.orgId, req.orgId),
        accessibleSavedCommandFilter(req),
      ),
    )
    .get();
}

/**
 * A job in the caller's org whose server they may access. Jobs on servers a
 * restricted member cannot see are reported as not found, like the server.
 */
function loadJob(req: FastifyRequest, id: string) {
  return getDb()
    .select()
    .from(cronJobs)
    .where(
      and(
        eq(cronJobs.id, id),
        eq(cronJobs.orgId, req.orgId),
        accessibleServerFilter(req, cronJobs.serverId),
      ),
    )
    .get();
}

export async function cronJobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    return db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.orgId, req.orgId), accessibleServerFilter(req, cronJobs.serverId)))
      .all();
  });

  app.post('/', { preHandler: requireRole('operator') }, async (req, reply) => {
    const body = createCronSchema.parse(req.body);
    const db = getDb();

    if (body.savedCommandId && body.inlineCommand)
      return reply.status(400).send({ error: BOTH_COMMANDS_ERROR });
    if (body.savedCommandId && !savedCommandInOrg(req, body.savedCommandId))
      return reply.status(404).send({ error: 'Saved command not found' });
    // The worker runs the job as its creator with no request to check against,
    // so the creator's access is settled here, once.
    if (!canAccessServer(req, body.serverId))
      return reply.status(404).send({ error: 'Server not found' });

    const parsed = parseCronSchedule(body.schedule, body.timezone);
    if (!parsed.isValid) {
      return reply.status(400).send({ error: `Invalid cron expression: ${parsed.error}` });
    }

    const id = nanoid();
    const nextRunAt = getNextRun(body.schedule, body.timezone)?.toISOString();

    db.insert(cronJobs)
      .values({
        id,
        orgId: req.orgId,
        createdBy: req.user.id,
        ...body,
        notify: JSON.stringify(body.notify),
        nextRunAt,
      })
      .run();

    if (body.enabled) await scheduleCronJob(id);
    await audit(req, 'cron_job.create', 'cron_job', id, body.name);
    return reply.status(201).send(db.select().from(cronJobs).where(eq(cronJobs.id, id)).get());
  });

  app.patch('/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createCronBaseSchema.partial().parse(req.body);
    const db = getDb();

    const job = loadJob(req, id);
    if (!job) return reply.status(404).send({ error: 'Not found' });

    if (body.serverId && !canAccessServer(req, body.serverId))
      return reply.status(404).send({ error: 'Server not found' });
    if (body.savedCommandId && body.inlineCommand)
      return reply.status(400).send({ error: BOTH_COMMANDS_ERROR });
    if (body.savedCommandId && !savedCommandInOrg(req, body.savedCommandId))
      return reply.status(404).send({ error: 'Saved command not found' });

    // A bad timezone alone would otherwise be saved and the job never scheduled.
    if (body.schedule || body.timezone) {
      const parsed = parseCronSchedule(body.schedule ?? job.schedule, body.timezone ?? job.timezone);
      if (!parsed.isValid)
        return reply.status(400).send({ error: `Invalid cron expression: ${parsed.error}` });
    }

    // Switching command source clears the other one, so only one is ever stored.
    const commandSource = body.savedCommandId
      ? { inlineCommand: null }
      : body.inlineCommand
        ? { savedCommandId: null }
        : {};

    db.update(cronJobs)
      .set({
        ...body,
        ...commandSource,
        notify: body.notify ? JSON.stringify(body.notify) : undefined,
        updatedAt: new Date().toISOString(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial body spread over typed columns
      } as any)
      .where(eq(cronJobs.id, id))
      .run();
    await unscheduleCronJob(id);
    if (body.enabled ?? job.enabled) await scheduleCronJob(id);
    await audit(req, 'cron_job.update', 'cron_job', id, job.name);
    return db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
  });

  app.delete('/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const job = loadJob(req, id);
    if (!job) return reply.status(404).send({ error: 'Not found' });

    db.delete(cronJobs).where(eq(cronJobs.id, id)).run();
    // Best effort: a queued run left behind finds no job and does nothing.
    await unscheduleCronJob(id).catch((err) => {
      logger.warn({ err, cronJobId: id }, 'Failed to remove queued cron runs');
    });
    await audit(req, 'cron_job.delete', 'cron_job', id, job.name);
    return reply.status(204).send();
  });

  app.get('/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const job = loadJob(req, id);
    if (!job) return reply.status(404).send({ error: 'Not found' });
    return db
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.cronJobId, id))
      .orderBy(desc(cronRuns.startedAt))
      .limit(50)
      .all();
  });

  app.get('/schedule/preview', async (req, reply) => {
    const { expression, timezone = 'UTC' } = req.query as { expression: string; timezone?: string };
    if (!expression) return reply.status(400).send({ error: 'expression is required' });
    return parseCronSchedule(expression, timezone);
  });
}
