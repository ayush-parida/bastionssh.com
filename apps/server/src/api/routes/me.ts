import type { FastifyInstance } from 'fastify';
import type { MeAccess, MeModules } from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { accessSummary, visibleModules } from '../../auth/access/modules.js';

/**
 * The caller's own access (unified roles spec §5): which modules to show and
 * at what level, and a summary of the roles they hold and what those reach.
 * Every member may ask — a member with No access gets empty answers, which is
 * what the web's "ask an admin" home is built from.
 */
export async function meRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** GET /api/me/modules — the modules to show (spec §3.1 visibility rule), for navigation. */
  app.get('/modules', async (req): Promise<MeModules> => ({ modules: visibleModules(req) }));

  /** GET /api/me/access — roles held, every module's level, what is shown, and what they reach per type. */
  app.get('/access', async (req): Promise<MeAccess> => accessSummary(req));
}
