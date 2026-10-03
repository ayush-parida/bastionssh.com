import type { FastifyInstance } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { stringify as toYaml } from 'yaml';
import {
  KUBE_RESOURCES,
  type KubeExecSession,
  type KubeLogEvent,
  type KubeObjectYaml,
  type KubePodDetail,
  type KubePodShellTarget,
} from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { audit, auditActorOf, auditAs } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { startTerminalRecording } from '../../recordings/index.js';
import { SSHBroker } from '../../ssh/broker.js';
import type { KubeObject } from '../../kube/client.js';
import { KubeError } from '../../kube/errors.js';
import { DEFAULT_POD_SHELL, openPodShell, type PodShell } from '../../kube/exec.js';
import { DEFAULT_LOG_TAIL, MAX_DOWNLOAD_BYTES, MAX_LOG_TAIL, pipeLogsToSse, resolveContainer } from '../../kube/logs.js';
import { requireKube } from '../../kube/permissions.js';
import { containerUsage, podDetail } from '../../kube/pods.js';
import { redactObject } from '../../kube/redact.js';
import { withKubeClient, type KubeContext } from '../../kube/service.js';
import { namespaceName, objectName, objectRef } from '../../kube/validation.js';
import { boolQuery } from '../query.js';
import { clusterParams, sendKubeError } from './kube.js';
import { kubeSseRoute } from './kube-views.js';

/**
 * Inside a pod (K4, spec §4.2 and §5.3):
 *
 * - `GET …/pods/:ns/:name` — the pod panel: container lanes, lifecycle,
 *   requests and limits against live usage (everyone who may view);
 * - `GET …/pods/:ns/:name/logs` — logs as server-sent events, one
 *   container at a time, current or previous run, followed or not
 *   (operators and up); `…/logs/download` the same as plain text;
 * - `POST …/pods/:ns/:name/exec` — a shell in a container, handed to the
 *   terminal broker like a Docker container shell: attach at
 *   `/api/ssh-sessions/:id/ws`, recorded by the org's policy, audited, and
 *   closed by revocation, losing the cluster or the `exec` capability;
 * - `GET …/objects/:resource/:ns/:name/yaml` — the read-only YAML,
 *   redacted (operators and up; a Secret's is audited).
 *
 * Everything goes through `withKubeClient` (cluster access → 404) and the
 * cluster's namespace allowlist (a namespace outside it is a 404 too).
 */

const podParams = clusterParams.extend({ ns: z.string(), name: z.string() });
const objectParams = clusterParams.extend({ resource: z.string(), ns: z.string(), name: z.string() });

/** Container names follow DNS labels; checked before they reach a URL. */
const containerName = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Invalid container name').max(63);

const logsQuery = z.object({
  container: containerName.optional(),
  previous: boolQuery,
  follow: boolQuery,
  timestamps: boolQuery,
  tail: z.coerce.number().int().min(0).max(MAX_LOG_TAIL).default(DEFAULT_LOG_TAIL),
  sinceSeconds: z.coerce.number().int().min(1).max(366 * 24 * 3600).optional(),
});

const downloadQuery = logsQuery.omit({ follow: true }).extend({
  tail: z.coerce.number().int().min(0).max(MAX_LOG_TAIL).default(MAX_LOG_TAIL),
});

const execSchema = z
  .object({
    container: containerName.optional(),
    cmd: z
      .array(z.string().min(1).max(4096).refine((a) => !a.includes('\0'), 'cannot contain NUL bytes'))
      .min(1)
      .max(64)
      .optional(),
    cols: z.number().int().min(10).max(1000).default(220),
    rows: z.number().int().min(5).max(500).default(50),
  })
  .strict();

/** The pod, if the caller may see its namespace (404 otherwise). */
async function readPod(ctx: KubeContext, namespace: string, name: string, signal?: AbortSignal): Promise<KubeObject> {
  namespaceName(namespace);
  objectName(name, 'pods');
  if (!ctx.namespaceAllowed(namespace)) throw new KubeError('Not found', 404);
  return ctx.client.get('pods', namespace, name, signal);
}

/** A container's current state block, wherever its status lives. */
function containerState(pod: KubeObject, container: string): { running?: unknown; waiting?: { reason?: string }; terminated?: unknown } | null {
  const status = (pod.status ?? {}) as Record<string, { name?: string; state?: Record<string, unknown> }[] | undefined>;
  for (const key of ['containerStatuses', 'initContainerStatuses', 'ephemeralContainerStatuses']) {
    const found = status[key]?.find((s) => s.name === container);
    if (found) return (found.state ?? {}) as ReturnType<typeof containerState>;
  }
  return null;
}

export async function kubePodRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** GET /clusters/:id/pods/:ns/:name — containers as lanes, lifecycle, usage against requests and limits. */
  app.get('/clusters/:id/pods/:ns/:name', { preHandler: requireKube('view') }, async (req, reply) => {
    const { id, ns, name } = podParams.parse(req.params);
    try {
      return await withKubeClient(req, id, async (ctx): Promise<KubePodDetail> => {
        const pod = await readPod(ctx, ns, name);
        const metrics = await containerUsage(ctx.source.key, ctx.client, ns, name);
        return podDetail(pod, metrics.usage, metrics.available);
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /**
   * GET /clusters/:id/pods/:ns/:name/logs?container&previous&follow&tail&timestamps&sinceSeconds
   * — SSE: `ready` naming the container, `logs` batches, `end` when the log
   * ends (or `end` with `truncated` at the size cap).
   */
  app.get('/clusters/:id/pods/:ns/:name/logs', { preHandler: requireKube('logs') }, async (req, reply) => {
    const { id, ns, name } = podParams.parse(req.params);
    const q = logsQuery.parse(req.query);
    // Counted against the per-user cap as a Kubernetes stream, so revocation and cluster edits end it too
    return kubeSseRoute<KubeLogEvent>(req, reply, id, async (ctx, open, signal) => {
      const pod = await readPod(ctx, ns, name, signal);
      const container = resolveContainer(pod, q.container);
      const res = await ctx.client.logs(ns, name, {
        container,
        previous: q.previous,
        follow: q.follow,
        tailLines: q.tail,
        sinceSeconds: q.sinceSeconds,
        timestamps: q.timestamps,
        signal,
      });
      const sse = open();
      if (!sse) return void res.destroy();
      sse.send({ type: 'ready', container, previous: q.previous });
      await pipeLogsToSse(res, sse, q.timestamps);
    });
  });

  /** GET /clusters/:id/pods/:ns/:name/logs/download?container&previous&tail&timestamps — plain text, streamed. */
  app.get('/clusters/:id/pods/:ns/:name/logs/download', { preHandler: requireKube('logs') }, async (req, reply) => {
    const { id, ns, name } = podParams.parse(req.params);
    const q = downloadQuery.parse(req.query);
    try {
      await withKubeClient(req, id, async (ctx) => {
        const pod = await readPod(ctx, ns, name);
        const container = resolveContainer(pod, q.container);
        const res = await ctx.client.logs(ns, name, {
          container,
          previous: q.previous,
          tailLines: q.tail,
          sinceSeconds: q.sinceSeconds,
          timestamps: q.timestamps,
          limitBytes: MAX_DOWNLOAD_BYTES,
        });
        reply.hijack();
        reply.raw.writeHead(200, {
          ...(reply.getHeaders() as Record<string, string>),
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}-${container}${q.previous ? '-previous' : ''}.log"`,
          'Cache-Control': 'no-store',
        });
        // Streamed from the API server to the browser; nothing is buffered here
        await pipeline(res, reply.raw).catch(() => {
          if (!reply.raw.writableEnded) reply.raw.destroy();
        });
      });
    } catch (err) {
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      return sendKubeError(reply, err);
    }
  });

  /** POST /clusters/:id/pods/:ns/:name/exec `{ container?, cmd?, cols, rows }` → a terminal session. */
  app.post('/clusters/:id/pods/:ns/:name/exec', { preHandler: requireKube('exec') }, async (req, reply) => {
    const { id, ns, name } = podParams.parse(req.params);
    const body = execSchema.parse(req.body ?? {});
    try {
      return await withKubeClient(req, id, async (ctx) => {
        const pod = await readPod(ctx, ns, name);
        const container = resolveContainer(pod, body.container);
        const state = containerState(pod, container);
        if (!state?.running) {
          const why = state?.waiting?.reason ? ` (${state.waiting.reason})` : state?.terminated ? ' (it has exited)' : '';
          throw new KubeError(`${container} in ${name} is not running${why}`, 409);
        }
        const cmd = body.cmd ?? DEFAULT_POD_SHELL;
        const target: KubePodShellTarget = { clusterId: ctx.cluster.id, clusterName: ctx.cluster.name, namespace: ns, name, container };

        let shell: PodShell | undefined;
        let recording: ReturnType<typeof startTerminalRecording> = null;
        let handedOver = false;
        try {
          // The exec runs on its own connection, so it outlives this request's client
          shell = await openPodShell(ctx.client, { namespace: ns, pod: name, container }, { cmd, cols: body.cols, rows: body.rows });
          recording = startTerminalRecording({
            orgId: req.orgId,
            serverId: null,
            serverName: ctx.cluster.name,
            userId: req.user.id,
            cols: body.cols,
            rows: body.rows,
            pod: { namespace: ns, name, container },
          });
          const actor = auditActorOf(req);
          const started = Date.now();
          const opened = shell;
          let sessionId = '';
          const where = { namespace: ns, pod: name, container };
          // Ends when the shell exits, the user disconnects, or access is lost
          const end = () => {
            void opened.close().then((exitCode) =>
              auditAs(actor, 'kube.exec_end', 'kube_cluster', target.clusterId, target.clusterName, {
                ...where,
                sessionId,
                exitCode,
                durationMs: Date.now() - started,
              }),
            );
          };
          sessionId = SSHBroker.adoptSession(
            {
              // A pod shell is on no server; the cluster and pod say where it runs
              server: { id: '', host: '', port: 0, username: '' },
              userId: req.user.id,
              orgId: req.orgId,
              cols: body.cols,
              rows: body.rows,
              recording,
              pod: { clusterId: target.clusterId, namespace: ns, name, container },
            },
            shell.channel,
            end,
          );
          handedOver = true;

          await audit(req, 'kube.exec_start', 'kube_cluster', target.clusterId, target.clusterName, {
            ...where,
            cmd,
            sessionId,
            protocol: shell.protocol,
            ...(recording && { recordingId: recording.id }),
          });
          const result: KubeExecSession = {
            sessionId,
            wsUrl: `${config.baseUrl.replace(/^http/, 'ws')}/api/ssh-sessions/${sessionId}/ws`,
            pod: target,
            cmd,
            recording: recording ? { id: recording.id, inputRecorded: recording.inputRecorded } : null,
          };
          return reply.status(201).send(result);
        } finally {
          if (!handedOver) {
            void shell?.close().catch(() => null);
            void recording?.discard().catch(() => {});
          }
        }
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });

  /**
   * GET /clusters/:id/objects/:resource/:ns/:name/yaml — read-only YAML,
   * redacted like every view (redact.ts): a Secret keeps its keys, never its
   * values, and env values from Secrets are references. A Secret's view is audited.
   */
  app.get('/clusters/:id/objects/:resource/:ns/:name/yaml', { preHandler: requireKube('yaml') }, async (req, reply) => {
    const params = objectParams.parse(req.params);
    try {
      const ref = objectRef(params.resource, params.ns, params.name);
      return await withKubeClient(req, params.id, async (ctx): Promise<KubeObjectYaml> => {
        if (!ctx.namespaceAllowed(ref.namespace)) throw new KubeError('Not found', 404);
        if (ref.resource === 'namespaces' && !ctx.namespaceAllowed(ref.name)) throw new KubeError('Not found', 404);
        const raw = await ctx.client.get(ref.resource, ref.namespace, ref.name);
        const claimNamespace = (raw.spec as { claimRef?: { namespace?: unknown } } | undefined)?.claimRef?.namespace;
        if (ref.resource === 'persistentvolumes' && typeof claimNamespace === 'string' && !ctx.namespaceAllowed(claimNamespace)) {
          throw new KubeError('Not found', 404);
        }
        const kind = raw.kind ?? KUBE_RESOURCES[ref.resource].kind;
        const object = redactObject({ ...raw, kind }, { showConfigMapValues: ctx.settings.showConfigMapValues });
        if (kind === 'Secret') {
          await audit(req, 'kube.secret_view', 'kube_cluster', ctx.cluster.id, ctx.cluster.name, {
            namespace: ref.namespace,
            name: ref.name,
            view: 'yaml',
          });
        }
        return {
          yaml: toYaml(object, { lineWidth: 0 }),
          redacted: kind === 'Secret' || (kind === 'ConfigMap' && !ctx.settings.showConfigMapValues),
        };
      });
    } catch (err) {
      return sendKubeError(reply, err);
    }
  });
}
