import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  KUBE_MAX_REPLICAS,
  KUBE_RESTARTABLE_KINDS,
  KUBE_SCALABLE_KINDS,
  type AuditAction,
  type KubeActionPreview,
  type KubeActionResult,
  type KubeRestartableKind,
  type KubeScalableKind,
} from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { requireModule } from '../../auth/access/modules.js';
import { audit } from '../../audit/index.js';
import {
  actionPreview,
  deletePod,
  restartRollout,
  rollbackDeployment,
  scaleWorkload,
  setCronJobSuspended,
  setNodeSchedulable,
  triggerCronJob,
} from '../../kube/actions.js';
import { KubeError } from '../../kube/errors.js';
import { requireKube } from '../../kube/permissions.js';
import { withKubeClient, type KubeContext } from '../../kube/service.js';
import { namespaceName, objectName, objectRef } from '../../kube/validation.js';
import { clusterParams, sendKubeError } from './kube.js';

/**
 * Guided actions (spec §6, K3): `POST /clusters/:id/actions/<action>` for
 * scale, restart, rollback, delete-pod, cordon, uncordon, suspend-cronjob
 * and trigger-cronjob, plus the read the action panels open with
 * (`GET /clusters/:id/actions/preview/:resource/:ns/:name`).
 *
 * Guards, in order: `requireAuth`; the action's capability (spec §7 —
 * kube/permissions.ts, following the org's `operatorsCanScale` /
 * `operatorsCanDeletePods`; rollback and cordon are admin-only) answers 403;
 * then cluster access and org in `withKubeClient` (404), the name checks
 * (400) and the cluster's namespace allowlist (404). The change itself is a
 * minimal patch (kube/actions.ts); the cluster credential's RBAC may still
 * refuse it (403 with the API server's reason).
 *
 * Every action is audited against the cluster with namespace, kind, name and
 * the before/after of what it touched (`changed: false` when nothing was sent). UI actions do not go through AI
 * command approval (like Docker's), and the AI never performs them.
 */

const scaleSchema = z
  .object({
    kind: z.enum(KUBE_SCALABLE_KINDS as [KubeScalableKind, ...KubeScalableKind[]]),
    namespace: z.string().max(63),
    name: z.string().max(253),
    replicas: z.number().int().min(0).max(KUBE_MAX_REPLICAS),
  })
  .strict();

const restartSchema = z
  .object({
    kind: z.enum(KUBE_RESTARTABLE_KINDS as [KubeRestartableKind, ...KubeRestartableKind[]]),
    namespace: z.string().max(63),
    name: z.string().max(253),
  })
  .strict();

const rollbackSchema = z
  .object({
    namespace: z.string().max(63),
    name: z.string().max(253),
    revision: z.number().int().min(1),
  })
  .strict();

const namespacedSchema = z.object({ namespace: z.string().max(63), name: z.string().max(253) }).strict();
const nodeSchema = z.object({ name: z.string().max(253) }).strict();
const suspendSchema = namespacedSchema.extend({ suspend: z.boolean() }).strict();

const previewParams = clusterParams.extend({ resource: z.string(), ns: z.string(), name: z.string() });

/** A namespace from a body: valid, and one the cluster's allowlist lets the caller see (404 otherwise). */
function allowedNamespace(ctx: KubeContext, value: string): string {
  const namespace = namespaceName(value);
  if (!ctx.namespaceAllowed(namespace)) throw new KubeError('Not found', 404);
  return namespace;
}

/**
 * Audit an action (spec §6: all of them), with what it changed; one that
 * found the object already that way is recorded with `changed: false`, as
 * Docker's actions are.
 */
async function auditAction(req: FastifyRequest, ctx: KubeContext, action: AuditAction, result: KubeActionResult) {
  await audit(req, action, 'kube_cluster', ctx.cluster.id, ctx.cluster.name, {
    namespace: result.ref.namespace,
    kind: result.ref.kind,
    name: result.ref.name,
    before: result.before,
    after: result.after,
    ...(result.created && { created: { kind: result.created.kind, name: result.created.name } }),
    ...(!result.changed && { changed: false }),
  });
}

export async function kubeActionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireModule('kubernetes'));

  /**
   * GET /clusters/:id/actions/preview/:resource/:ns/:name — the object's
   * current state for the action panels (replicas, autoscaler, revisions
   * with images and env names, a pod's owner, a node's pods, a CronJob's
   * schedule) and the actions the caller may take on it.
   */
  app.get('/clusters/:id/actions/preview/:resource/:ns/:name', { preHandler: requireKube('view', 'param') }, async (req, reply) => {
    const params = previewParams.parse(req.params);
    try {
      const ref = objectRef(params.resource, params.ns, params.name);
      return await withKubeClient(req, params.id, async (ctx): Promise<KubeActionPreview> => {
        if (!ctx.namespaceAllowed(ref.namespace)) throw new KubeError('Not found', 404);
        return actionPreview(ctx.client, ref, ctx.permissionsIn(ref.namespace), ctx.namespaceAllowed);
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** POST /clusters/:id/actions/scale `{ kind, namespace, name, replicas }` */
  app.post('/clusters/:id/actions/scale', { preHandler: requireKube('scale', 'body') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const body = scaleSchema.parse(req.body);
    try {
      const name = objectName(body.name);
      return await withKubeClient(req, id, async (ctx) => {
        const { hpa, ...result } = await scaleWorkload(ctx.client, { ...body, namespace: allowedNamespace(ctx, body.namespace), name });
        await auditAction(req, ctx, 'kube.scale', { ...result, after: { ...result.after, ...(hpa && { autoscaler: hpa }) } });
        return result;
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** POST /clusters/:id/actions/restart `{ kind, namespace, name }` */
  app.post('/clusters/:id/actions/restart', { preHandler: requireKube('scale', 'body') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const body = restartSchema.parse(req.body);
    try {
      const name = objectName(body.name);
      return await withKubeClient(req, id, async (ctx) => {
        const result = await restartRollout(ctx.client, { kind: body.kind, namespace: allowedNamespace(ctx, body.namespace), name });
        await auditAction(req, ctx, 'kube.restart', result);
        return result;
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** POST /clusters/:id/actions/rollback `{ namespace, name, revision }` — Deployments; admins. */
  app.post('/clusters/:id/actions/rollback', { preHandler: requireKube('rollback', 'body') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const body = rollbackSchema.parse(req.body);
    try {
      const name = objectName(body.name);
      return await withKubeClient(req, id, async (ctx) => {
        const result = await rollbackDeployment(ctx.client, {
          namespace: allowedNamespace(ctx, body.namespace),
          name,
          revision: body.revision,
        });
        await auditAction(req, ctx, 'kube.rollback', result);
        return result;
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** POST /clusters/:id/actions/delete-pod `{ namespace, name }` */
  app.post('/clusters/:id/actions/delete-pod', { preHandler: requireKube('deletePod', 'body') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const body = namespacedSchema.parse(req.body);
    try {
      const name = objectName(body.name);
      return await withKubeClient(req, id, async (ctx) => {
        const result = await deletePod(ctx.client, { namespace: allowedNamespace(ctx, body.namespace), name });
        await auditAction(req, ctx, 'kube.delete_pod', result);
        return result;
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** POST /clusters/:id/actions/cordon and …/uncordon `{ name }` — admins. */
  for (const action of ['cordon', 'uncordon'] as const) {
    app.post(`/clusters/:id/actions/${action}`, { preHandler: requireKube('cordon') }, async (req, reply) => {
      const { id } = clusterParams.parse(req.params);
      const body = nodeSchema.parse(req.body);
      try {
        const name = objectName(body.name, 'nodes');
        return await withKubeClient(req, id, async (ctx) => {
          const result = await setNodeSchedulable(ctx.client, name, action === 'cordon');
          await auditAction(req, ctx, `kube.${action}`, result);
          return result;
        });
      } catch (err) {
        return sendKubeError(reply, err);
      }
    });
  }

  /** POST /clusters/:id/actions/suspend-cronjob `{ namespace, name, suspend }` — `suspend: false` resumes. */
  app.post('/clusters/:id/actions/suspend-cronjob', { preHandler: requireKube('scale', 'body') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const body = suspendSchema.parse(req.body);
    try {
      const name = objectName(body.name);
      return await withKubeClient(req, id, async (ctx) => {
        const result = await setCronJobSuspended(ctx.client, {
          namespace: allowedNamespace(ctx, body.namespace),
          name,
          suspend: body.suspend,
        });
        await auditAction(req, ctx, body.suspend ? 'kube.cronjob_suspend' : 'kube.cronjob_resume', result);
        return result;
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /** POST /clusters/:id/actions/trigger-cronjob `{ namespace, name }` — starts a Job now. */
  app.post('/clusters/:id/actions/trigger-cronjob', { preHandler: requireKube('scale', 'body') }, async (req, reply) => {
    const { id } = clusterParams.parse(req.params);
    const body = namespacedSchema.parse(req.body);
    try {
      const name = objectName(body.name);
      return await withKubeClient(req, id, async (ctx) => {
        const result = await triggerCronJob(ctx.client, { namespace: allowedNamespace(ctx, body.namespace), name });
        await auditAction(req, ctx, 'kube.cronjob_trigger', result);
        return reply.status(201).send(result);
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });
}
