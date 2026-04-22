import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { auditLog, users } from '../../db/schema.js';
import { eq, count, desc } from 'drizzle-orm';

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => {
    const db = getDb();
    const { page = 1, limit = 50 } = req.query as { page?: number; limit?: number };
    const offset = (page - 1) * limit;

    const items = db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        resourceType: auditLog.resourceType,
        resourceId: auditLog.resourceId,
        resourceName: auditLog.resourceName,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
        actorId: auditLog.actorId,
        actorEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorId, users.id))
      .where(eq(auditLog.orgId, req.orgId))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    const results = db
      .select({ value: count() })
      .from(auditLog)
      .where(eq(auditLog.orgId, req.orgId))
      .all();
    const total = results[0]?.value ?? 0;

    return { items, total };
  });
}
