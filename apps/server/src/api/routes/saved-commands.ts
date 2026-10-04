import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { accessibleServerFilter, canAccessServer } from '../../auth/server-access.js';
import { authorize, accessibleIds, type ResourceAction } from '../../auth/access/index.js';
import {
  baseRoleAllows,
  cronJobFilter,
  denyAccess,
  mayCreate,
  refuseServers,
  savedCommandFilter,
} from '../../auth/command-access.js';
import { getDb } from '../../db/index.js';
import { savedCommands, commandRuns, servers, cronJobs } from '../../db/schema.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { parseTags } from './servers.js';
import { nanoid } from 'nanoid';
import { commandQueue } from '../../worker/queues.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { executeSavedCommand } from '../../commands/run.js';
import { recordingSettings } from '../../recordings/index.js';
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

/**
 * Load a command the caller may see (see `savedCommandFilter`): in their org,
 * reached as a saved command, and either unbound or bound to a server they
 * can access. Anything else is reported as not found.
 */
function visibleCommand(req: FastifyRequest, id: string) {
  return getDb()
    .select()
    .from(savedCommands)
    .where(and(eq(savedCommands.id, id), eq(savedCommands.orgId, req.orgId), savedCommandFilter(req)))
    .get();
}

/**
 * Load a command and check the caller's level on it for `action`. Sends 404
 * (not visible) or 403 (visible, level too low) and returns undefined when
 * refused. `baseRole`: what a scope-`all` member needed for this before
 * custom roles (operators edited commands), kept for them.
 */
function commandFor(
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
  action: ResourceAction<'saved_command'>,
  baseRole?: 'operator',
) {
  const command = visibleCommand(req, id);
  if (!command) {
    reply.status(404).send({ error: 'Not found' });
    return undefined;
  }
  const result = authorize(req, 'saved_command', id, action);
  if (!result.ok && !(baseRole && baseRoleAllows(req, 'saved_command'))) {
    denyAccess(reply, result, 'Saved command');
    return undefined;
  }
  return command;
}

/**
 * Changing or deleting a command changes what every cron job using it runs —
 * as that job's creator, on that job's server. So the caller must be able to
 * operate every such server too, or they could plant commands on servers they
 * were never granted. Sends a 403 and returns false when blocked; the message
 * names no job or server, since the caller may not see them.
 */
function mayRewriteCommand(req: FastifyRequest, reply: FastifyReply, commandId: string): boolean {
  const jobs = getDb()
    .select({ serverId: cronJobs.serverId })
    .from(cronJobs)
    .where(and(eq(cronJobs.savedCommandId, commandId), eq(cronJobs.orgId, req.orgId)))
    .all();
  if (refuseServers(req, jobs.map((job) => job.serverId))) {
    reply.status(403).send({
      error: 'Changing or deleting this command needs operate access to every server it is scheduled to run on',
    });
    return false;
  }
  return true;
}

export async function savedCommandRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    return db
      .select()
      .from(savedCommands)
      .where(and(eq(savedCommands.orgId, req.orgId), savedCommandFilter(req)))
      .all();
  });

  app.post('/', async (req, reply) => {
    const body = createCommandSchema.parse(req.body);
    const db = getDb();
    const id = nanoid();

    if (!mayCreate(req, 'saved_command')) {
      return reply.status(403).send({ error: 'Creating saved commands needs manage access to all saved commands' });
    }
    if (body.serverId && !canAccessServer(req, body.serverId)) {
      return reply.status(404).send({ error: 'Server not found' });
    }

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

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateCommandSchema.parse(req.body);
    const db = getDb();

    // Bound to a server the caller cannot access: as if it did not exist
    const command = commandFor(req, reply, id, 'edit', 'operator');
    if (!command) return reply;
    if (!mayRewriteCommand(req, reply, id)) return reply;

    if (body.serverId && !canAccessServer(req, body.serverId)) {
      return reply.status(404).send({ error: 'Server not found' });
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

  app.post('/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { variables, serverId, serverIds, tag } = runCommandSchema.parse(req.body ?? {});
    const db = getDb();

    const command = commandFor(req, reply, id, 'run');
    if (!command) return reply;

    // A restricted member's fan-out (by tag or id) only ever reaches their servers
    const orgServers = db
      .select({ id: servers.id, name: servers.name, tags: servers.tags })
      .from(servers)
      .where(and(eq(servers.orgId, req.orgId), accessibleServerFilter(req, servers.id)))
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

    // Running needs operate on every target, a tag's fan-out included (spec §2.7):
    // one the caller may only view refuses the whole run rather than skipping it
    const operable = accessibleIds(req, 'server', 'operate');
    if (!operable.all) {
      const allowed = new Set(operable.ids);
      const viewOnly = targets.filter((t) => !allowed.has(t.id));
      if (viewOnly.length) {
        return reply.status(403).send({
          error: `Running a command needs operate access to the server (you can only view ${viewOnly.map((t) => t.name).join(', ')})`,
        });
      }
    }

    // Recording ids are chosen now so the audit entry can link to each run's recording
    const recorded = recordingSettings(req.orgId).enabled;
    const jobs = targets.map((target) => ({
      runId: nanoid(),
      orgId: req.orgId,
      commandId: id,
      serverId: target.id,
      variables,
      ...(recorded && { recordingId: nanoid() }),
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
      ...(recorded && { recordingIds: jobs.map((job) => job.recordingId) }),
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
      .where(
        and(
          inArray(commandRuns.id, wanted),
          eq(savedCommands.orgId, req.orgId),
          savedCommandFilter(req),
          accessibleServerFilter(req, commandRuns.serverId),
        ),
      )
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
      .where(
        and(
          eq(commandRuns.id, runId),
          eq(savedCommands.orgId, req.orgId),
          savedCommandFilter(req),
          accessibleServerFilter(req, commandRuns.serverId),
        ),
      )
      .get();
    if (!row) return reply.status(404).send({ error: 'Not found' });

    return row.run;
  });

  app.get('/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const command = visibleCommand(req, id);
    if (!command) return reply.status(404).send({ error: 'Not found' });

    return db
      .select()
      .from(commandRuns)
      .where(and(eq(commandRuns.commandId, id), accessibleServerFilter(req, commandRuns.serverId)))
      .orderBy(desc(commandRuns.startedAt))
      .limit(20)
      .all();
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    // Before roles only admins deleted commands, which is what `manage` means here
    const command = commandFor(req, reply, id, 'delete');
    if (!command) return reply;
    if (!mayRewriteCommand(req, reply, id)) return reply;

    // cron_jobs references this row without ON DELETE, so the delete would fail
    // with a bare foreign-key error. Explain what is in the way instead —
    // counting only the jobs the caller sees, and none when some are hidden.
    const usedBy = db
      .select({ id: cronJobs.id })
      .from(cronJobs)
      .where(eq(cronJobs.savedCommandId, id))
      .all();
    if (usedBy.length > 0) {
      const seen = db
        .select({ id: cronJobs.id })
        .from(cronJobs)
        .where(and(eq(cronJobs.savedCommandId, id), eq(cronJobs.orgId, req.orgId), cronJobFilter(req)))
        .all().length;
      return reply.status(409).send({
        error:
          seen === usedBy.length
            ? `This command is used by ${seen} cron job${seen > 1 ? 's' : ''}. Delete them or switch them to another command first.`
            : 'This command is used by cron jobs. They must be deleted or switched to another command first.',
      });
    }

    db.delete(savedCommands).where(eq(savedCommands.id, id)).run();
    return reply.status(204).send();
  });
}
