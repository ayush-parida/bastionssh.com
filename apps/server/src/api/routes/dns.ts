import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { DnsLookupResult } from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { servers } from '../../db/schema.js';
import { audit } from '../../audit/index.js';
import { DnsError, lookupDomain } from '../../dns/index.js';

const lookupQuery = z.object({ domain: z.string().min(1).max(300) });

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof DnsError) return reply.status(err.statusCode).send({ error: err.message });
  throw err;
}

export async function dnsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Read-only, so any signed-in role may look a domain up.
  app.get('/lookup', async (req, reply): Promise<DnsLookupResult | undefined> => {
    const { domain } = lookupQuery.parse(req.query);

    // Only host, name and id: enough to label records that point at a server.
    const inventory = getDb()
      .select({ id: servers.id, name: servers.name, host: servers.host })
      .from(servers)
      .where(eq(servers.orgId, req.orgId))
      .all();

    try {
      const result = await lookupDomain(domain, inventory);
      await audit(req, 'dns.lookup', 'dns', undefined, result.domain, {
        nameservers: result.nameservers.length,
        consistent: result.propagation.consistent,
      });
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
