import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { aiProviderConfigs, servers, savedCommands, cronJobs } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { vault } from '../../vault/index.js';
import { getAIProvider } from '../../ai/registry.js';
import { AGENT_TOOLS, ToolExecutor, buildSystemPrompt } from '../../ai/tools.js';

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

  app.post('/providers', async (req, reply) => {
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

  app.patch('/providers/:id', async (req, reply) => {
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

  app.delete('/providers/:id', async (req, reply) => {
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
      .where(eq(servers.orgId, req.orgId))
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
      .where(eq(savedCommands.orgId, req.orgId))
      .all();

    const allCrons = db
      .select({
        id: cronJobs.id,
        name: cronJobs.name,
        schedule: cronJobs.schedule,
        enabled: cronJobs.enabled,
      })
      .from(cronJobs)
      .where(eq(cronJobs.orgId, req.orgId))
      .all();

    return { servers: allServers, commands: allCommands, cronJobs: allCrons };
  });

  // ── Chat / Agent (streaming SSE) ──────────────────────────────
  app.post('/chat', async (req, reply) => {
    const body = chatSchema.parse(req.body);
    const db = getDb();

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

    const send = (event: Record<string, unknown>) =>
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

    try {
      // Use agent loop if provider supports it and agent mode is enabled
      if (provider.agentLoop && body.agentMode) {
        const executor = new ToolExecutor(req.orgId, body.sessionId, body.context?.serverId);

        for await (const event of provider.agentLoop(
          messagesWithSystem,
          AGENT_TOOLS,
          (name, input) => executor.execute(name, input),
        )) {
          send(event);
          if (event.type === 'done' || event.type === 'error') break;
        }
      } else {
        // Fallback: simple streaming chat without tools
        for await (const token of provider.chat(messagesWithSystem)) {
          send({ type: 'delta', content: token });
        }
        send({ type: 'done' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI request failed';
      send({ type: 'error', error: message });
    } finally {
      reply.raw.end();
    }
  });
}
