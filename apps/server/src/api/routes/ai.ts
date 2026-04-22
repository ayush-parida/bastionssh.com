import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { aiProviderConfigs } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { vault } from '../../vault/index.js';
import { getAIProvider } from '../../ai/registry.js';

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

  // ── Chat (streaming SSE) ──────────────────────────────────────
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
    const provider = getAIProvider(providerConfig, apiKey);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const messages = body.context?.lastOutput
      ? [
          { role: 'system' as const, content: `Server context:\n${body.context.lastOutput}` },
          ...body.messages,
        ]
      : body.messages;

    try {
      for await (const token of provider.chat(messages)) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'delta', content: token })}\n\n`);
      }
      reply.raw.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI request failed';
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
}
