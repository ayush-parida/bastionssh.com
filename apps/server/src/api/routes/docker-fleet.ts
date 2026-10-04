import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DockerFleetResponse } from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { requireModule } from '../../auth/access/modules.js';
import { requireDocker } from '../../docker/permissions.js';
import { fleetContainers } from '../../docker/fleet.js';
import { boolQuery } from '../query.js';

/**
 * The fleet view (§4.6): containers across servers, under `/api/docker` next
 * to the per-server routes (docker.ts). Listing is a viewer capability, like
 * a server's own container list; per-server access decides which servers are
 * asked at all (docker/fleet.ts). Reads are not audited.
 */

/** At most this many servers per request, so one call cannot hold the pool for long. */
const MAX_SERVER_IDS = 200;

const fleetQuery = z.object({
  /** Comma-separated server ids; omitted means every accessible server where Docker was detected. */
  serverIds: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))],
    )
    .refine((v) => v === undefined || v.length <= MAX_SERVER_IDS, `At most ${MAX_SERVER_IDS} servers at once`),
  all: boolQuery,
});

export async function dockerFleetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  // Containers across servers: the Containers module (unified roles spec §3.1)
  app.addHook('preHandler', requireModule('containers'));

  /** GET /containers?serverIds=a,b&all=1 — partial results, one row per server with its error. */
  app.get('/containers', { preHandler: requireDocker('view') }, async (req, reply): Promise<DockerFleetResponse> => {
    const { serverIds, all } = fleetQuery.parse(req.query);
    // The browser leaving before the answer stops the fan-out: nobody is waiting for the rest
    const gone = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    return fleetContainers(req, { serverIds, all, signal: gone.signal });
  });
}
