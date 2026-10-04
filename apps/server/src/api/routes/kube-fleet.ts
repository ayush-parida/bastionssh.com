import type { FastifyInstance } from 'fastify';
import type { KubeFleetOverview } from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { requireModule } from '../../auth/access/modules.js';
import { fleetOverview } from '../../kube/fleet.js';
import { requireKube } from '../../kube/permissions.js';

/**
 * The fleet overview (spec §4.2 `GET /api/kube/overview`, K5): every cluster
 * the caller may use, a few at a time with a deadline each, partial results
 * (kube/fleet.ts). A viewer capability like each cluster's own map; per-cluster
 * access decides which clusters are asked at all, so restricted members only
 * ever see their granted clusters. Reads are not audited.
 */
export async function kubeFleetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireModule('kubernetes'));

  /** GET /overview — one row per cluster: its numbers and worst problems, or its error. */
  app.get('/overview', { preHandler: requireKube('view') }, async (req, reply): Promise<KubeFleetOverview> => {
    // The browser leaving before the answer stops the fan-out: nobody is waiting for the rest
    const gone = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    return fleetOverview(req, { signal: gone.signal });
  });
}
