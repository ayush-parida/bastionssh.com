import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { savedCommands, commandRuns } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { commandQueue } from '../../worker/queues.js';
import { audit } from '../../audit/index.js';

const createCommandSchema = z.object({
  serverId: z.string().optional(),
  name: z.string().min(1).max(200),
  command: z.string().min(1),
  variables: z
    .record(z.object({ label: z.string(), defaultValue: z.string().optional() }))
    .default({}),
  category: z.string().optional(),
});

export async function savedCommandRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    return db.select().from(savedCommands).where(eq(savedCommands.orgId, req.orgId)).all();
  });

  app.post('/', async (req, reply) => {
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

  app.post('/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { variables = {} } = (req.body ?? {}) as { variables?: Record<string, string> };
    const db = getDb();

    const command = db
      .select()
      .from(savedCommands)
      .where(and(eq(savedCommands.id, id), eq(savedCommands.orgId, req.orgId)))
      .get();
    if (!command) return reply.status(404).send({ error: 'Not found' });
    if (!command.serverId)
      return reply.status(400).send({ error: 'Command has no associated server' });

    const runId = nanoid();
    db.insert(commandRuns)
      .values({
        id: runId,
        commandId: id,
        serverId: command.serverId,
        triggeredBy: req.user.id,
        status: 'pending',
        stdout: '',
        stderr: '',
      })
      .run();

    await commandQueue.add('run-command', {
      runId,
      commandId: id,
      serverId: command.serverId,
      variables,
    });
    await audit(req, 'command.run', 'command', id, command.name);

    return reply.status(202).send({ runId });
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

    return db.select().from(commandRuns).where(eq(commandRuns.commandId, id)).all();
  });

  app.delete('/:id', async (req, reply) => {
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
