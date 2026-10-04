import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { authorize, type ResourceAction } from '../../auth/access/index.js';
import {
  baseRoleAllows,
  cronJobFilter,
  denyAccess,
  mayCreate,
  refuseServers,
  savedCommandFilter,
} from '../../auth/command-access.js';
import { getDb } from '../../db/index.js';
import { cronJobs, cronRuns, savedCommands } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { parseCronSchedule, getNextRun } from '@smt/cron-parser';
import { audit } from '../../audit/index.js';
import { scheduleCronJob, unscheduleCronJob } from '../../worker/scheduler.js';
import { cronQueue } from '../../worker/queues.js';
import { runCronJob } from '../../worker/processors/cron.js';
import { config } from '../../config/index.js';
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
 * one the caller can see (not bound to a server they cannot access) and run:
 * the job runs it. Sends 404 / 403 and returns false when refused.
 */
function maySchedule(req: FastifyRequest, reply: FastifyReply, id: string): boolean {
  const found = getDb()
    .select({ id: savedCommands.id })
    .from(savedCommands)
    .where(and(eq(savedCommands.id, id), eq(savedCommands.orgId, req.orgId), savedCommandFilter(req)))
    .get();
  if (!found) {
    reply.status(404).send({ error: 'Saved command not found' });
    return false;
  }
  const result = authorize(req, 'saved_command', id, 'run');
  if (!result.ok) {
    denyAccess(reply, result, 'Saved command');
    return false;
  }
  return true;
}

/**
 * A job runs on its server, so creating one there, moving one there or
 * changing what it runs needs `operate` on that server (spec §5). Sends 404 /
 * 403 and returns false when refused.
 */
function mayRunOn(req: FastifyRequest, reply: FastifyReply, serverId: string): boolean {
  const refused = refuseServers(req, [serverId]);
  if (!refused) return true;
  if (refused.status === 404) reply.status(404).send({ error: 'Server not found' });
  else reply.status(403).send({ error: `A cron job's server needs operate access (you have ${refused.level})` });
  return false;
}

/**
 * Starting a job — running it now, or switching it on so it runs on schedule —
 * puts its command on its server, so it needs what running it by hand would:
 * `operate` on the server and on the saved command it runs. Switching a job
 * off needs neither. Sends 404 / 403 and returns false when refused.
 */
function mayStart(
  req: FastifyRequest,
  reply: FastifyReply,
  job: { serverId: string; savedCommandId: string | null; inlineCommand: string | null },
): boolean {
  if (!mayRunOn(req, reply, job.serverId)) return false;
  if (!job.inlineCommand && job.savedCommandId && !maySchedule(req, reply, job.savedCommandId)) return false;
  return true;
}

/**
 * A job in the caller's org that they may see — `view` on the job and on its
 * server — checked at the level `action` needs. Jobs out of sight are reported
 * as not found, like their server. Sends 404 / 403 and returns undefined when
 * refused. `baseRole`: what a scope-`all` member needed for this before custom
 * roles (operators edited and deleted jobs), kept for them.
 */
function loadJob(
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
  action: ResourceAction<'cron_job'>,
  baseRole?: 'operator',
) {
  const job = getDb()
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.id, id), eq(cronJobs.orgId, req.orgId), cronJobFilter(req)))
    .get();
  if (!job) {
    reply.status(404).send({ error: 'Not found' });
    return undefined;
  }
  const result = authorize(req, 'cron_job', id, action);
  if (!result.ok && !(baseRole && baseRoleAllows(req, baseRole))) {
    denyAccess(reply, result, 'Cron job');
    return undefined;
  }
  return job;
}

export async function cronJobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    return db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.orgId, req.orgId), cronJobFilter(req)))
      .all();
  });

  app.post('/', async (req, reply) => {
    const body = createCronSchema.parse(req.body);
    const db = getDb();

    if (!mayCreate(req, 'cron_job'))
      return reply.status(403).send({ error: 'Creating cron jobs needs manage access to all cron jobs' });
    if (body.savedCommandId && body.inlineCommand)
      return reply.status(400).send({ error: BOTH_COMMANDS_ERROR });
    if (body.savedCommandId && !maySchedule(req, reply, body.savedCommandId)) return reply;
    // The worker runs the job as its creator and checks again before every
    // run (worker/processors/cron.ts); this settles it for the creator now.
    if (!mayRunOn(req, reply, body.serverId)) return reply;

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

    // Switching a job on or off is `operate`; any other change is an edit (`manage`)
    const toggleOnly = Object.keys(body).every((key) => key === 'enabled');
    const job = toggleOnly ? loadJob(req, reply, id, 'toggle') : loadJob(req, reply, id, 'edit', 'operator');
    if (!job) return reply;

    if (body.savedCommandId && body.inlineCommand)
      return reply.status(400).send({ error: BOTH_COMMANDS_ERROR });
    if (body.savedCommandId && !maySchedule(req, reply, body.savedCommandId)) return reply;
    // Moving the job, or changing what it runs, puts commands on a server
    const runsElsewhere =
      (body.serverId !== undefined && body.serverId !== job.serverId) ||
      body.savedCommandId !== undefined ||
      body.inlineCommand !== undefined;
    if (runsElsewhere && !mayRunOn(req, reply, body.serverId ?? job.serverId)) return reply;
    // Switching a job on starts it running: the same checks as running it now,
    // on the job as it will be after this change
    if (body.enabled === true && !job.enabled) {
      const after = {
        serverId: body.serverId ?? job.serverId,
        savedCommandId: body.savedCommandId ?? (body.inlineCommand ? null : job.savedCommandId),
        inlineCommand: body.inlineCommand ?? (body.savedCommandId ? null : job.inlineCommand),
      };
      if (!mayStart(req, reply, after)) return reply;
    }

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

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const job = loadJob(req, reply, id, 'delete', 'operator');
    if (!job) return reply;

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
    const job = loadJob(req, reply, id, 'history');
    if (!job) return reply;
    return db
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.cronJobId, id))
      .orderBy(desc(cronRuns.startedAt))
      .limit(50)
      .all();
  });

  /**
   * Run a job once now, enabled or not. It runs as its creator like any
   * scheduled run (so the worker's creator check applies); the caller needs
   * `operate` on the job, on its server and on the saved command it runs.
   */
  app.post('/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(req, reply, id, 'run');
    if (!job) return reply;
    if (!mayStart(req, reply, job)) return reply;

    const data = { cronJobId: id, scheduledAt: new Date().toISOString(), manual: true };
    let mode: 'queued' | 'inline' = 'inline';
    if (config.redisUrl) {
      try {
        await cronQueue.add('run-cron', data, {
          jobId: `cron-${id}-manual-${nanoid()}`,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
        });
        mode = 'queued';
      } catch (err) {
        logger.warn({ err, cronJobId: id }, 'Queue unavailable — running the cron job in-process');
      }
    }
    if (mode === 'inline') {
      // runCronJob records its own failures on the run row
      void runCronJob(data).catch((err) => {
        logger.error({ err, cronJobId: id }, 'In-process cron run failed');
      });
    }

    await audit(req, 'cron_job.run', 'cron_job', id, job.name, { mode });
    return reply.status(202).send({ mode });
  });

  app.get('/schedule/preview', async (req, reply) => {
    const { expression, timezone = 'UTC' } = req.query as { expression: string; timezone?: string };
    if (!expression) return reply.status(400).send({ error: 'expression is required' });
    return parseCronSchedule(expression, timezone);
  });
}
