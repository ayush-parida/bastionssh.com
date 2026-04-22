import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { cronJobs, cronRuns } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { parseCronSchedule, getNextRun } from '@smt/cron-parser';
import { audit } from '../../audit/index.js';
import { scheduleCronJob, unscheduleCronJob } from '../../worker/scheduler.js';

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

export async function cronJobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    return db.select().from(cronJobs).where(eq(cronJobs.orgId, req.orgId)).all();
  });

  app.post('/', async (req, reply) => {
    const body = createCronSchema.parse(req.body);
    const db = getDb();

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

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createCronBaseSchema.partial().parse(req.body);
    const db = getDb();

    const job = db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.id, id), eq(cronJobs.orgId, req.orgId)))
      .get();
    if (!job) return reply.status(404).send({ error: 'Not found' });

    if (body.schedule) {
      const parsed = parseCronSchedule(body.schedule, body.timezone ?? job.timezone);
      if (!parsed.isValid)
        return reply.status(400).send({ error: `Invalid cron expression: ${parsed.error}` });
    }

    db.update(cronJobs)
      .set({ ...body, updatedAt: new Date().toISOString() })
      .where(eq(cronJobs.id, id))
      .run();
    await unscheduleCronJob(id);
    if (body.enabled ?? job.enabled) await scheduleCronJob(id);
    await audit(req, 'cron_job.update', 'cron_job', id, job.name);
    return db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const job = db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.id, id), eq(cronJobs.orgId, req.orgId)))
      .get();
    if (!job) return reply.status(404).send({ error: 'Not found' });

    await unscheduleCronJob(id);
    db.delete(cronJobs).where(eq(cronJobs.id, id)).run();
    await audit(req, 'cron_job.delete', 'cron_job', id, job.name);
    return reply.status(204).send();
  });

  app.get('/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const job = db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.id, id), eq(cronJobs.orgId, req.orgId)))
      .get();
    if (!job) return reply.status(404).send({ error: 'Not found' });
    return db.select().from(cronRuns).where(eq(cronRuns.cronJobId, id)).all();
  });

  app.get('/schedule/preview', async (req, reply) => {
    const { expression, timezone = 'UTC' } = req.query as { expression: string; timezone?: string };
    if (!expression) return reply.status(400).send({ error: 'expression is required' });
    return parseCronSchedule(expression, timezone);
  });
}
