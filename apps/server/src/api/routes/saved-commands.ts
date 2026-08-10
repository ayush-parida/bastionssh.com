import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { savedCommands, commandRuns, servers } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
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
});

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
    const { variables, serverId } = runCommandSchema.parse(req.body ?? {});
    const db = getDb();

    const command = db
      .select()
      .from(savedCommands)
      .where(and(eq(savedCommands.id, id), eq(savedCommands.orgId, req.orgId)))
      .get();
    if (!command) return reply.status(404).send({ error: 'Not found' });

    // A command may carry a default server, be pointed at one per run, or both.
    const targetId = serverId ?? command.serverId;
    if (!targetId) {
      return reply
        .status(400)
        .send({ error: 'This command has no default server — choose one to run it on' });
    }

    const target = db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .where(and(eq(servers.id, targetId), eq(servers.orgId, req.orgId)))
      .get();
    if (!target) return reply.status(404).send({ error: 'Server not found' });

    const runId = nanoid();
    db.insert(commandRuns)
      .values({
        id: runId,
        commandId: id,
        serverId: target.id,
        triggeredBy: req.user.id,
        status: 'pending',
        stdout: '',
        stderr: '',
      })
      .run();

    const job = { runId, orgId: req.orgId, commandId: id, serverId: target.id, variables };
    let mode: 'queued' | 'inline' = 'queued';

    if (config.redisUrl) {
      try {
        await commandQueue.add('run-command', job);
      } catch (err) {
        logger.warn({ err, runId }, 'Queue unavailable — running command in-process');
        mode = 'inline';
      }
    } else {
      mode = 'inline';
    }

    if (mode === 'inline') {
      // No queue to hand this to. Run it here but do not make the caller wait —
      // they get the runId and poll for the result exactly as with a queued run.
      void executeSavedCommand(job).catch((err) => {
        logger.error({ err, runId }, 'In-process command run failed');
      });
    }

    await audit(req, 'command.run', 'command', id, command.name, {
      serverId: target.id,
      serverName: target.name,
      mode,
    });

    return reply.status(202).send({ runId, mode });
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
