import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import {
  accessibleSavedCommandFilter,
  accessibleServerFilter,
  canAccessServer,
} from '../../auth/server-access.js';
import { getDb } from '../../db/index.js';
import { aiProviderConfigs, servers, savedCommands, cronJobs } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { vault } from '../../vault/index.js';
import { getAIProvider } from '../../ai/registry.js';
import { AGENT_TOOLS, ToolExecutor, buildSystemPrompt } from '../../ai/tools.js';
import { classifyCommand } from '../../ai/command-safety.js';
import { resolveApproval, waitForApproval } from '../../ai/approvals.js';
import { registerAgentStream } from '../../ai/streams.js';
import { audit } from '../../audit/index.js';
import type { AIAgentEvent } from '@smt/shared';

/** While a command waits for approval, keep proxies from closing the idle stream. */
const APPROVAL_HEARTBEAT_MS = 15_000;

/** Tool results the model sees when a command is not run. */
const DECLINED = 'The user declined to run this command. Do not retry it.';
const EXPIRED =
  'The user did not approve this command in time, so it was not run. Do not retry it.';

const createProviderSchema = z.object({
  name: z.string().min(1).max(100),
  provider: z.enum(['openai', 'anthropic', 'openai_compatible']),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  isDefault: z.boolean().default(false),
});

const chatSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
    }),
  ),
  context: z
    .object({
      serverId: z.string().optional(),
      lastOutput: z.string().optional(),
      serverInfo: z.string().optional(),
    })
    .optional(),
  providerId: z.string().optional(),
  /** Active SSH session ID — enables run_command tool via the existing connection */
  sessionId: z.string().optional(),
  /** Set false to skip tool-calling and use plain streaming chat */
  agentMode: z.boolean().default(true),
});

export async function aiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ── Provider management ──────────────────────────────────────
  app.get('/providers', async (req) => {
    const db = getDb();
    return db
      .select({
        id: aiProviderConfigs.id,
        name: aiProviderConfigs.name,
        provider: aiProviderConfigs.provider,
        baseUrl: aiProviderConfigs.baseUrl,
        model: aiProviderConfigs.model,
        isDefault: aiProviderConfigs.isDefault,
        createdAt: aiProviderConfigs.createdAt,
      })
      .from(aiProviderConfigs)
      .where(eq(aiProviderConfigs.orgId, req.orgId))
      .all();
  });

  app.post('/providers', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = createProviderSchema.parse(req.body);
    const db = getDb();
    const id = nanoid();
    const encryptedApiKey = await vault.encrypt(body.apiKey, id);

    db.insert(aiProviderConfigs)
      .values({
        id,
        orgId: req.orgId,
        name: body.name,
        provider: body.provider,
        baseUrl: body.baseUrl,
        model: body.model,
        encryptedApiKey,
        isDefault: body.isDefault,
      })
      .run();

    return reply
      .status(201)
      .send({ id, name: body.name, provider: body.provider, model: body.model });
  });

  app.patch('/providers/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const existing = db
      .select()
      .from(aiProviderConfigs)
      .where(and(eq(aiProviderConfigs.id, id), eq(aiProviderConfigs.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    const updateSchema = z.object({
      name: z.string().min(1).max(100).optional(),
      provider: z.enum(['openai', 'anthropic', 'openai_compatible']).optional(),
      baseUrl: z.string().url().nullable().optional(),
      model: z.string().min(1).optional(),
      apiKey: z.string().min(1).optional(),
      isDefault: z.boolean().optional(),
    });
    const body = updateSchema.parse(req.body);

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) updates.name = body.name;
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
    if (body.model !== undefined) updates.model = body.model;
    if (body.isDefault !== undefined) updates.isDefault = body.isDefault;
    if (body.apiKey !== undefined) updates.encryptedApiKey = await vault.encrypt(body.apiKey, id);

    db.update(aiProviderConfigs).set(updates).where(eq(aiProviderConfigs.id, id)).run();
    return reply.send({ id, ...updates });
  });

  app.delete('/providers/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const config = db
      .select()
      .from(aiProviderConfigs)
      .where(and(eq(aiProviderConfigs.id, id), eq(aiProviderConfigs.orgId, req.orgId)))
      .get();
    if (!config) return reply.status(404).send({ error: 'Not found' });
    db.delete(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).run();
    return reply.status(204).send();
  });

  // ── App context snapshot ──────────────────────────────────────
  app.get('/context', async (req) => {
    const db = getDb();
    const allServers = db
      .select({
        id: servers.id,
        name: servers.name,
        host: servers.host,
        username: servers.username,
        port: servers.port,
        tags: servers.tags,
      })
      .from(servers)
      .where(and(eq(servers.orgId, req.orgId), accessibleServerFilter(req, servers.id)))
      .all()
      .map((s) => ({ ...s, tags: s.tags ? (JSON.parse(s.tags) as string[]) : [] }));

    const allCommands = db
      .select({
        id: savedCommands.id,
        name: savedCommands.name,
        command: savedCommands.command,
        serverId: savedCommands.serverId,
      })
      .from(savedCommands)
      .where(and(eq(savedCommands.orgId, req.orgId), accessibleSavedCommandFilter(req)))
      .all();

    const allCrons = db
      .select({
        id: cronJobs.id,
        name: cronJobs.name,
        schedule: cronJobs.schedule,
        enabled: cronJobs.enabled,
      })
      .from(cronJobs)
      .where(and(eq(cronJobs.orgId, req.orgId), accessibleServerFilter(req, cronJobs.serverId)))
      .all();

    return { servers: allServers, commands: allCommands, cronJobs: allCrons };
  });

  // ── Chat / Agent (streaming SSE) ──────────────────────────────
  app.post('/chat', { preHandler: requireRole('operator') }, async (req, reply) => {
    const body = chatSchema.parse(req.body);
    const db = getDb();
    if (body.context?.serverId && !canAccessServer(req, body.context.serverId)) {
      return reply.status(404).send({ error: 'Server not found' });
    }

    const providerConfig = body.providerId
      ? db
          .select()
          .from(aiProviderConfigs)
          .where(
            and(eq(aiProviderConfigs.id, body.providerId), eq(aiProviderConfigs.orgId, req.orgId)),
          )
          .get()
      : db
          .select()
          .from(aiProviderConfigs)
          .where(and(eq(aiProviderConfigs.orgId, req.orgId), eq(aiProviderConfigs.isDefault, true)))
          .get();

    if (!providerConfig) return reply.status(400).send({ error: 'No AI provider configured' });

    const apiKey = await vault.decrypt(providerConfig.encryptedApiKey, providerConfig.id);
    const provider = getAIProvider(providerConfig as Parameters<typeof getAIProvider>[0], apiKey);

    // Build the rich system prompt with all app context
    const systemPrompt = buildSystemPrompt({
      orgId: req.orgId,
      userId: req.user.id,
      terminalOutput: body.context?.lastOutput,
      sessionServerId: body.context?.serverId,
    });

    const messagesWithSystem = [
      { role: 'system' as const, content: systemPrompt },
      ...body.messages,
    ];

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // The browser aborts when the user stops or closes the panel. Stop the agent
    // then, so it does not keep running tools nobody is watching — and deny any
    // command still waiting for approval.
    let clientGone = false;
    /** Stopped from outside by an access revocation, not by the browser. */
    let revoked = false;
    const disconnected = new AbortController();
    // Registered so revoking the user's access (suspension, removal, a narrowed
    // grant, a password reset) can stop this stream from outside the request.
    const tracked = registerAgentStream({ orgId: req.orgId, userId: req.user.id }, disconnected);
    reply.raw.on('close', () => {
      clientGone = true;
      disconnected.abort();
    });

    const send = (event: AIAgentEvent) => {
      if (!clientGone) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Revoked while streaming: tell the browser why and end the response now,
    // rather than waiting for the provider's next event.
    disconnected.signal.addEventListener(
      'abort',
      () => {
        if (clientGone) return;
        revoked = true;
        send({ type: 'error', error: 'Your access has changed. This conversation was stopped.' });
        clientGone = true;
        reply.raw.end();
      },
      { once: true },
    );

    try {
      // Use agent loop if provider supports it and agent mode is enabled
      if (provider.agentLoop && body.agentMode) {
        const executor = new ToolExecutor(
          req.orgId,
          req.user.id,
          body.sessionId,
          body.context?.serverId,
        );

        /**
         * run_command goes through here: read-only commands run straight away,
         * anything else waits for the user's decision. Every run and decision
         * is audited against the target server.
         */
        const runCommand = async (id: string, input: Record<string, unknown>) => {
          const command = typeof input.command === 'string' ? input.command.trim() : '';
          const { serverId, serverName, sshUser, hostKeyStatus } = executor.resolveTarget(input);
          const { mutating, reason } = classifyCommand(command);
          const details = { command, mutating, toolCallId: id };

          if (mutating) {
            send({
              type: 'approval_required',
              id,
              name: 'run_command',
              input,
              reason,
              serverId,
              serverName,
              sshUser,
              hostKeyStatus,
            });
            const heartbeat = setInterval(() => {
              if (!clientGone) reply.raw.write(': waiting for approval\n\n');
            }, APPROVAL_HEARTBEAT_MS);
            const outcome = await waitForApproval(
              id,
              { orgId: req.orgId, userId: req.user.id },
              { signal: disconnected.signal },
            ).finally(() => clearInterval(heartbeat));

            send({
              type: 'approval_resolved',
              id,
              approved: outcome === 'approved',
              ...(outcome === 'expired' && { expired: true }),
            });

            if (outcome !== 'approved') {
              await audit(req, 'ai.command_denied', 'server', serverId, serverName, {
                ...details,
                reason,
                deniedBy:
                  outcome === 'denied'
                    ? 'user'
                    : outcome === 'expired'
                      ? 'timeout'
                      : revoked
                        ? 'access_revoked'
                        : 'disconnect',
              });
              if (outcome === 'cancelled') throw new Error('Client disconnected');
              throw new Error(outcome === 'expired' ? EXPIRED : DECLINED);
            }
            await audit(req, 'ai.command_approved', 'server', serverId, serverName, {
              ...details,
              reason,
            });
          }

          try {
            const result = await executor.runCommand(input);
            await audit(req, 'ai.command_run', 'server', result.serverId ?? serverId, serverName, {
              ...details,
              exitCode: result.exitCode,
              ...(result.recordingId && { recordingId: result.recordingId }),
            });
            return result.output;
          } catch (err) {
            await audit(req, 'ai.command_run', 'server', serverId, serverName, {
              ...details,
              error: err instanceof Error ? err.message : 'Command failed',
            });
            throw err;
          }
        };

        /**
         * The read-only Docker tools. What they return goes to the AI provider,
         * so each read is audited against its server, like a read-only
         * run_command — the container, not the output.
         */
        const dockerRead = async (id: string, name: string, input: Record<string, unknown>) => {
          const { serverId, serverName } = executor.resolveTarget(input);
          const details = {
            tool: name,
            toolCallId: id,
            ...(typeof input.container === 'string' && { container: input.container }),
          };
          try {
            const output = await executor.execute(name, input);
            await audit(req, 'ai.docker_read', 'server', serverId, serverName, details);
            return output;
          } catch (err) {
            await audit(req, 'ai.docker_read', 'server', serverId, serverName, {
              ...details,
              error: err instanceof Error ? err.message : 'Docker read failed',
            });
            throw err;
          }
        };

        for await (const event of provider.agentLoop(
          messagesWithSystem,
          AGENT_TOOLS,
          (name, input, id) => {
            if (clientGone) throw new Error('Client disconnected');
            if (name === 'run_command') return runCommand(id, input);
            if (name.startsWith('docker_')) return dockerRead(id, name, input);
            return executor.execute(name, input);
          },
        )) {
          if (clientGone) break;
          send(event);
          if (event.type === 'done' || event.type === 'error') break;
        }
      } else {
        // Fallback: simple streaming chat without tools
        for await (const token of provider.chat(messagesWithSystem)) {
          if (clientGone) break;
          send({ type: 'delta', content: token });
        }
        send({ type: 'done' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI request failed';
      send({ type: 'error', error: message });
    } finally {
      tracked.release();
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  // ── Command approvals ─────────────────────────────────────────
  // Settles a command the agent is waiting on. Only the user whose chat raised
  // it can decide; anyone else gets the same 404 as for an unknown id.
  app.post('/approvals/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { approved } = z.object({ approved: z.boolean() }).parse(req.body);
    const settled = resolveApproval(id, { orgId: req.orgId, userId: req.user.id }, approved);
    if (!settled) return reply.status(404).send({ error: 'No pending approval with this id' });
    return reply.send({ id, approved });
  });
}
