import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { apiTokens } from '../../db/schema.js';
import { generateApiToken, isExpired } from '../../auth/token.js';
import { audit } from '../../audit/index.js';

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** 'read' alone caps the token at viewer, whatever the owner's role. */
  scopes: z.array(z.enum(['read', 'write'])).min(1).default(['read']),
  /** Days until expiry; omit for a token that never expires. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export async function apiTokenRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** Tokens belong to a person, so everyone manages their own. */
  app.get('/', async (req) => {
    const rows = getDb()
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, req.user.id))
      .orderBy(desc(apiTokens.createdAt))
      .all();

    return rows.map((token) => ({
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      scopes: safeScopes(token.scopes),
      lastUsedAt: token.lastUsedAt,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
      expired: isExpired(token.expiresAt),
    }));
  });

  app.post('/', async (req, reply) => {
    const body = createTokenSchema.parse(req.body);

    // Minting a credential is an act of authority; a token must not be able to
    // mint another one and quietly outlive its own revocation.
    if (req.viaApiToken) {
      return reply
        .status(403)
        .send({ error: 'API tokens cannot create other tokens' });
    }

    const id = nanoid();
    const { token, prefix, hashedToken } = generateApiToken();
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString()
      : null;

    getDb()
      .insert(apiTokens)
      .values({
        id,
        userId: req.user.id,
        name: body.name,
        hashedToken,
        prefix,
        scopes: JSON.stringify(body.scopes),
        expiresAt,
      })
      .run();

    await audit(req, 'api_token.create', 'api_token', id, body.name, { scopes: body.scopes });

    // The only time the secret exists outside the caller's hands.
    return reply.status(201).send({
      id,
      name: body.name,
      prefix,
      scopes: body.scopes,
      expiresAt,
      createdAt: new Date().toISOString(),
      expired: false,
      token,
    });
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const token = db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, req.user.id)))
      .get();
    if (!token) return reply.status(404).send({ error: 'Not found' });

    db.delete(apiTokens).where(eq(apiTokens.id, id)).run();
    await audit(req, 'api_token.revoke', 'api_token', id, token.name);
    return reply.status(204).send();
  });
}

function safeScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
