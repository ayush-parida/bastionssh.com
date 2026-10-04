import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { KUBE_CLUSTER_SCOPE, type KubeExplainEvent } from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { canAccessCluster, clusterDenial } from '../../auth/cluster-access.js';
import { audit } from '../../audit/index.js';
import { getDb } from '../../db/index.js';
import { aiProviderConfigs } from '../../db/schema.js';
import { getAIProvider } from '../../ai/registry.js';
import { vault } from '../../vault/index.js';
import { EXPLAIN_SYSTEM_PROMPT, aiObjectRef, explainMaterial, type ExplainMaterial } from '../../kube/ai-tools.js';
import { KubeError } from '../../kube/errors.js';
import { TOO_MANY_KUBE_STREAMS } from '../../kube/sse.js';
import { withKubeClient } from '../../kube/service.js';
import { MAX_STREAMS_PER_USER, activeStreamCount, openEventStream } from '../sse.js';
import { clusterParams, sendKubeError } from './kube.js';

/**
 * AI "Explain this" (spec §5.4, K5): the object's redacted form, its related
 * events, the status of a workload's troubled pods and — for callers who may
 * read logs — a short log tail (kube/ai-tools.ts `explainMaterial`) go to the
 * org's AI provider, and the narrative streams back as server-sent events.
 *
 * `operate` on the cluster (in the object's namespace), like the AI assistant; the cluster must be one the
 * caller may access (404 otherwise) and the object in an allowed namespace.
 * The stream counts against the per-user cap and is a Kubernetes stream for
 * revocation, so losing access to the cluster stops it. Audited with what
 * was sent (counts, never content). The AI never performs an action.
 */

const explainSchema = z.object({
  resource: z.string().max(64),
  namespace: z.string().max(63).nullable().optional(),
  name: z.string().min(1).max(253),
  providerId: z.string().max(64).optional(),
});

const EXPLAIN_RATE_LIMIT = {
  rateLimit: {
    max: 10,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => `kube-explain:${req.user?.id ?? req.ip}`,
  },
};

/** The org's chosen (or default) AI provider. */
function providerFor(orgId: string, providerId?: string) {
  const db = getDb();
  return providerId
    ? db
        .select()
        .from(aiProviderConfigs)
        .where(and(eq(aiProviderConfigs.id, providerId), eq(aiProviderConfigs.orgId, orgId)))
        .get()
    : db
        .select()
        .from(aiProviderConfigs)
        .where(and(eq(aiProviderConfigs.orgId, orgId), eq(aiProviderConfigs.isDefault, true)))
        .get();
}

/**
 * Explaining an object needs `operate` on the cluster (custom roles spec §5),
 * in the object's namespace when it has one — from the base role or a custom
 * role. 404 when the caller cannot reach the cluster or that namespace.
 */
async function requireExplain(req: FastifyRequest, reply: FastifyReply) {
  const { id } = (req.params ?? {}) as { id?: string };
  const namespace = (req.body as { namespace?: unknown } | undefined)?.namespace;
  const scoped = typeof namespace === 'string' && namespace && namespace !== KUBE_CLUSTER_SCOPE ? namespace : undefined;
  const denied = id ? clusterDenial(req, id, 'explain', scoped) : { status: 404 as const, error: 'Cluster not found' };
  if (denied) return reply.status(denied.status).send({ error: denied.error });
}

export async function kubeAiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** POST /clusters/:id/explain — stream a plain-language explanation of one object. */
  app.post('/clusters/:id/explain', { preHandler: requireExplain, config: EXPLAIN_RATE_LIMIT }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const body = explainSchema.parse(req.body);
    if (activeStreamCount(req.user.id) >= MAX_STREAMS_PER_USER) {
      return reply.status(429).send({ error: TOO_MANY_KUBE_STREAMS });
    }

    let material: ExplainMaterial;
    let clusterName: string;
    try {
      const ref = aiObjectRef(body.resource, body.namespace, body.name);
      ({ material, clusterName } = await withKubeClient(req, id, async (ctx) => ({
        material: await explainMaterial(ctx, ref),
        clusterName: ctx.cluster.name,
      })));
    } catch (err) {
      return sendKubeError(reply, err);
    }

    const config = providerFor(req.orgId, body.providerId);
    if (!config) return reply.status(400).send({ error: 'No AI provider configured' });
    // Access may have been revoked while the object was being read
    if (!canAccessCluster(req, id)) return sendKubeError(reply, new KubeError('Cluster not found', 404));

    const sse = openEventStream<KubeExplainEvent>(
      req,
      reply,
      { feature: 'kube', resourceId: id },
      (error, status) => ({ type: 'error', error, ...(status !== undefined && { status }) }),
      TOO_MANY_KUBE_STREAMS,
    );
    if (!sse) return;

    const context = { ...material.context, provider: config.name };
    await audit(req, 'kube.ai_explain', 'kube_cluster', id, clusterName, {
      resource: context.ref.resource,
      namespace: context.ref.namespace,
      name: context.ref.name,
      provider: config.name,
      events: context.events,
      logLines: context.logLines,
      pods: context.pods,
    });
    sse.send({ type: 'context', context });
    try {
      const apiKey = await vault.decrypt(config.encryptedApiKey, config.id);
      const provider = getAIProvider(config as Parameters<typeof getAIProvider>[0], apiKey);
      for await (const token of provider.chat([
        { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
        { role: 'user', content: material.prompt },
      ])) {
        if (sse.closed) break;
        sse.send({ type: 'delta', content: token });
      }
      if (!sse.closed) sse.send({ type: 'done' });
    } catch (err) {
      sse.fail(new Error(`The AI provider failed: ${err instanceof Error ? err.message : 'unknown error'}`));
    } finally {
      sse.end();
    }
  });
}
