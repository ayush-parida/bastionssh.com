import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { savedCommands, commandRuns, servers } from '../../db/schema.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { parseTags } from './servers.js';
import { nanoid } from 'nanoid';
import { commandQueue } from '../../worker/queues.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { executeSavedCommand } from '../../commands/run.js';
import logger from '../../logger.js';

const variablesSchema = z.record(
  z.object({ label: z.string(), defaultValue: z.string().optional() }),
);

const createCommandSchema = z.object({
  serverId: z.string().optional(),
  name: z.string().min(1).max(200),
  command: z.string().min(1),
  variables: variablesSchema.default({}),
  category: z.string().optional(),
});

const updateCommandSchema = z.object({
  // null clears the default server, making the command runnable anywhere
  serverId: z.string().nullable().optional(),
  name: z.string().min(1).max(200).optional(),
  command: z.string().min(1).optional(),
  variables: variablesSchema.optional(),
  category: z.string().nullable().optional(),
});

const runCommandSchema = z.object({
  variables: z.record(z.string()).default({}),
  /** Run against this server instead of the command's default. */
  serverId: z.string().optional(),
  /** Fan out across an explicit set of servers. */
  serverIds: z.array(z.string()).max(200).optional(),
  /** Fan out across every server carrying this tag. */
  tag: z.string().min(1).optional(),
});

/** How many SSH sessions a fan-out opens at once when running in-process. */
const INLINE_FANOUT_CONCURRENCY = 5;

/** Execute a fan-out in-process, a few servers at a time. Never rejects. */
async function runInlineFanout(jobs: Parameters<typeof executeSavedCommand>[0][]): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(INLINE_FANOUT_CONCURRENCY, jobs.length) },
    async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++]!;
        // executeSavedCommand records its own failures on the run row
        await executeSavedCommand(job);
      }
    },
  );
  await Promise.all(workers);
}

export async function savedCommandRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    return db.select().from(savedCommands).where(eq(savedCommands.orgId, req.orgId)).all();
  });

  app.post('/', { preHandler: requireRole('operator') }, async (req, reply) => {
    const body = createCommandSchema.parse(req.body);
    const db = getDb();
    const id = nanoid();

    db.insert(savedCommands)
      .values({
        id,
        orgId: req.orgId,
        createdBy: req.user.id,
        ...body,
        variables: JSON.stringify(body.variables),
      })
      .run();

    return reply
      .status(201)
      .send(db.select().from(savedCommands).where(eq(savedCommands.id, id)).get());
  });

  app.patch('/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateCommandSchema.parse(req.body);
    const db = getDb();

    const command = db
      .select()
      .from(savedCommands)
      .where(and(eq(savedCommands.id, id), eq(savedCommands.orgId, req.orgId)))
      .get();
    if (!command) return reply.status(404).send({ error: 'Not found' });

    if (body.serverId) {
      const target = db
        .select({ id: servers.id })
        .from(servers)
        .where(and(eq(servers.id, body.serverId), eq(servers.orgId, req.orgId)))
        .get();
      if (!target) return reply.status(404).send({ error: 'Server not found' });
    }

    db.update(savedCommands)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.command !== undefined && { command: body.command }),
        ...(body.category !== undefined && { category: body.category }),
        ...(body.serverId !== undefined && { serverId: body.serverId }),
        ...(body.variables !== undefined && { variables: JSON.stringify(body.variables) }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(savedCommands.id, id))
      .run();

    await audit(req, 'command.update', 'command', id, body.name ?? command.name);
    return db.select().from(savedCommands).where(eq(savedCommands.id, id)).get();
  });

  app.post('/:id/run', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { variables, serverId, serverIds, tag } = runCommandSchema.parse(req.body ?? {});
    const db = getDb();

    const command = db
      .select()
      .from(savedCommands)
      .where(and(eq(savedCommands.id, id), eq(savedCommands.orgId, req.orgId)))
      .get();
    if (!command) return reply.status(404).send({ error: 'Not found' });

    const orgServers = db
      .select({ id: servers.id, name: servers.name, tags: servers.tags })
      .from(servers)
      .where(eq(servers.orgId, req.orgId))
      .all();

    let targets: { id: string; name: string }[];

    if (tag) {
      targets = orgServers.filter((s) => parseTags(s.tags).includes(tag));
      if (targets.length === 0) {
        return reply.status(404).send({ error: `No servers are tagged "${tag}"` });
      }
    } else {
      // A command may carry a default server, be pointed at others per run, or both.
      const requested = serverIds?.length ? serverIds : serverId ? [serverId] : [];
      const ids = requested.length ? requested : command.serverId ? [command.serverId] : [];

      if (ids.length === 0) {
        return reply
          .status(400)
          .send({ error: 'This command has no default server — choose one to run it on' });
      }

      const byId = new Map(orgServers.map((s) => [s.id, s]));
      const missing = ids.filter((serverId) => !byId.has(serverId));
      if (missing.length) {
        return reply.status(404).send({ error: `Server not found: ${missing.join(', ')}` });
      }
      // Deduplicate so the same server is not hit twice in one fan-out
      targets = [...new Set(ids)].map((serverId) => byId.get(serverId)!);
    }

    const jobs = targets.map((target) => ({
      runId: nanoid(),
      orgId: req.orgId,
      commandId: id,
      serverId: target.id,
      variables,
    }));

    for (const job of jobs) {
      db.insert(commandRuns)
        .values({
          id: job.runId,
          commandId: id,
          serverId: job.serverId,
          triggeredBy: req.user.id,
          status: 'pending',
          stdout: '',
          stderr: '',
        })
        .run();
    }

    let mode: 'queued' | 'inline' = 'queued';
    if (config.redisUrl) {
      try {
        for (const job of jobs) await commandQueue.add('run-command', job);
      } catch (err) {
        logger.warn({ err, commandId: id }, 'Queue unavailable — running commands in-process');
        mode = 'inline';
      }
    } else {
      mode = 'inline';
    }

    if (mode === 'inline') {
      // No queue to hand these to. Run them here without making the caller wait,
      // and bounded, so a fan-out across a large fleet does not open one SSH
      // session per server at once.
      void runInlineFanout(jobs).catch((err) => {
        logger.error({ err, commandId: id }, 'In-process fan-out failed');
      });
    }

    await audit(req, 'command.run', 'command', id, command.name, {
      servers: targets.map((t) => t.name),
      ...(tag && { tag }),
      mode,
    });

    return reply.status(202).send({
      mode,
      runs: jobs.map((job, index) => ({
        runId: job.runId,
        serverId: job.serverId,
        serverName: targets[index]!.name,
      })),
    });
  });

  /** Poll several runs at once so a fan-out costs one request, not one per server. */
  app.get('/runs', async (req) => {
    const { ids = '' } = req.query as { ids?: string };
    const wanted = ids.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    if (wanted.length === 0) return [];

    const db = getDb();
    return db
      .select({ run: commandRuns })
      .from(commandRuns)
      .innerJoin(savedCommands, eq(commandRuns.commandId, savedCommands.id))
      .where(and(inArray(commandRuns.id, wanted), eq(savedCommands.orgId, req.orgId)))
      .all()
      .map((row) => row.run);
  });

  /** Poll a single run for status and output. */
  app.get('/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const db = getDb();

    // command_runs has no org column of its own — scope through its command
    const row = db
      .select({ run: commandRuns })
      .from(commandRuns)
      .innerJoin(savedCommands, eq(commandRuns.commandId, savedCommands.id))
      .where(and(eq(commandRuns.id, runId), eq(savedCommands.orgId, req.orgId)))
      .get();
    if (!row) return reply.status(404).send({ error: 'Not found' });

    return row.run;
  });

  app.get('/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const command = db
      .select()
      .from(savedCommands)
      .where(and(eq(savedCommands.id, id), eq(savedCommands.orgId, req.orgId)))
      .get();
    if (!command) return reply.status(404).send({ error: 'Not found' });

    return db
      .select()
      .from(commandRuns)
      .where(eq(commandRuns.commandId, id))
      .orderBy(desc(commandRuns.startedAt))
      .limit(20)
      .all();
  });

  app.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const command = db
      .select()
      .from(savedCommands)
      .where(and(eq(savedCommands.id, id), eq(savedCommands.orgId, req.orgId)))
      .get();
    if (!command) return reply.status(404).send({ error: 'Not found' });

    db.delete(savedCommands).where(eq(savedCommands.id, id)).run();
    return reply.status(204).send();
  });
}
