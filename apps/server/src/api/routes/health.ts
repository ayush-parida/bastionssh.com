import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      const db = getDb();
      db.run('SELECT 1');
      return { status: 'ok', db: 'ok' };
    } catch {
      reply.status(503);
      return { status: 'error', db: 'unavailable' };
    }
  });

  app.get('/metrics', async () => {
    // TODO: expose Prometheus metrics
    return '# SMT metrics\n';
  });
}
