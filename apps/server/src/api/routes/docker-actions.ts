import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DOCKER_CONTAINER_ACTIONS,
  type AuditAction,
  type DockerActionResult,
  type DockerEnvReveal,
  type DockerImageRemoveResult,
  type DockerPrunePreview,
  type DockerPruneResult,
} from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { requireModule } from '../../auth/access/modules.js';
import { passkeyCount, requireBrowserSession, STEP_UP_MESSAGE } from '../../auth/passkey.js';
import { audit } from '../../audit/index.js';
import { boolQuery } from '../query.js';
import { DockerError, fromDaemonStatus } from '../../docker/errors.js';
import { LineSplitter } from '../../docker/demux.js';
import { requireDocker } from '../../docker/permissions.js';
import { apiPath, containerRef, imageApiPath, imageRef } from '../../docker/validation.js';
import { containersPerNetwork } from '../../docker/objects.js';
import {
  SIGNAL_PATTERN,
  pullTarget,
  toImageRemoveResult,
  toPrunePreview,
  toPruneResult,
  toPullProgress,
} from '../../docker/actions.js';
import { withDockerClient, type DockerContext } from '../../docker/service.js';
import { pipeToSse, type DockerSse } from '../../docker/sse.js';
import { dockerSseRoute, sendDockerError, serverParams } from './docker.js';

/**
 * Docker actions (D2): container lifecycle, removal, image pull and removal,
 * prune, and revealing a container's environment. Registered under
 * `/api/docker` next to the read routes (docker.ts), with the same guards:
 * `requireAuth`, a §6 capability (docker/permissions.ts, which follows the
 * org's `operatorsCanRemove` / `allowPrune`), then per-server access in
 * `withDockerClient` — 404 for a server the caller cannot access.
 *
 * Every mutation is audited against the server, naming the container or
 * image; so is revealing an environment, the one read that is.
 */

type RawJson = Record<string, unknown>;

/** Extra time past a stop timeout for the daemon to answer (it kills, then replies). */
const STOP_GRACE_MS = 20_000;
/** Docker's own default before a stop turns into a kill. */
const DEFAULT_STOP_TIMEOUT_S = 10;
/** Pruning walks every object on the host; give it time. */
const PRUNE_TIMEOUT_MS = 5 * 60_000;
/** Removing an image with many layers can take a while too. */
const REMOVE_IMAGE_TIMEOUT_MS = 2 * 60_000;

const containerParams = serverParams.extend({ cid: z.string() });
const imageParams = serverParams.extend({ iid: z.string() });

const actionSchema = z
  .object({
    timeout: z.number().int().min(0).max(600).optional(),
    signal: z.string().regex(SIGNAL_PATTERN, 'must be a signal name like SIGTERM, or its number').optional(),
  })
  .strict();

const removeSchema = z.object({ force: boolQuery, volumes: boolQuery });

const pullSchema = z
  .object({
    image: z.string().trim().min(1).max(512),
    tag: z.string().trim().max(128).optional(),
  })
  .strict();

const pruneSchema = z
  .object({
    containers: z.boolean().default(false),
    images: z.boolean().default(false),
    volumes: z.boolean().default(false),
    networks: z.boolean().default(false),
    dangling: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.containers || v.images || v.volumes || v.networks, 'Choose something to prune');

/** A container's id and name, from inspect — also how a missing one becomes a 404 before acting. */
async function identify(ctx: DockerContext, ref: string): Promise<{ id: string; name: string; info: RawJson }> {
  const info = await ctx.docker.json<RawJson>({ path: apiPath('containers', ref, 'json') });
  return { id: String(info.Id ?? ref), name: String(info.Name ?? ref).replace(/^\//, ''), info };
}

async function readSmall(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= 64 * 1024) chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * POST a lifecycle action. Docker answers 304 when the container already is
 * in that state (start a running one, stop a stopped one): not an error here,
 * just nothing changed.
 */
async function postAction(ctx: DockerContext, path: string, query: Record<string, string | number | undefined>, timeoutMs: number) {
  const res = await ctx.docker.request({ method: 'POST', path, query, timeoutMs });
  const body = await readSmall(res);
  if (res.statusCode === 304) return false;
  if (!res.statusCode || res.statusCode >= 300) throw fromDaemonStatus(res.statusCode ?? 502, body);
  return true;
}

/** A whole image id, the only form an unused-only removal takes. */
const FULL_IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

/** 409 unless the image has no tags and no container uses it. */
async function assertUnused(ctx: DockerContext, imageId: string): Promise<void> {
  const [info, containers] = await Promise.all([
    ctx.docker.json<RawJson>({ path: imageApiPath(imageId, 'json') }),
    ctx.docker.json<RawJson[]>({ path: '/containers/json', query: { all: true } }),
  ]);
  const tags = (Array.isArray(info.RepoTags) ? info.RepoTags : []).filter((t): t is string => typeof t === 'string' && t !== '<none>:<none>');
  if (tags.length > 0) throw new DockerError(`Kept: the image is still tagged ${tags.join(', ')}`, 409);
  const user = containers.find((c) => c.ImageID === imageId);
  if (user) {
    const name = Array.isArray(user.Names) && typeof user.Names[0] === 'string' ? user.Names[0].replace(/^\//, '') : String(user.Id ?? '').slice(0, 12);
    throw new DockerError(`Kept: container ${name} still uses the image`, 409);
  }
}

/** Image references may hold `/` (registry, namespace): each part is encoded, the slashes kept. */
function imagePath(ref: string): string {
  return `/images/${ref.split('/').map(encodeURIComponent).join('/')}`;
}

export async function dockerActionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  // Docker on one server is the server's Docker tab: the Servers module (unified roles spec §3.1)
  app.addHook('preHandler', requireModule('servers'));

  // ── Container lifecycle ───────────────────────────────────────

  /** POST /servers/:id/containers/:cid/{start,stop,restart,kill,pause,unpause} — `{ timeout? , signal? }`. */
  for (const action of DOCKER_CONTAINER_ACTIONS) {
    app.post(`/servers/:id/containers/:cid/${action}`, { preHandler: requireDocker('control') }, async (req, reply) => {
      const { id, cid } = containerParams.parse(req.params);
      const body = actionSchema.parse(req.body ?? {});
      try {
        const ref = containerRef(cid);
        return await withDockerClient(req, id, async (ctx): Promise<DockerActionResult> => {
          const container = await identify(ctx, ref);
          const timeout = action === 'stop' || action === 'restart' ? body.timeout : undefined;
          const signal = action === 'kill' ? body.signal : undefined;
          const changed = await postAction(
            ctx,
            apiPath('containers', container.id, action),
            { t: timeout, signal },
            ((timeout ?? DEFAULT_STOP_TIMEOUT_S) * 1000) + STOP_GRACE_MS,
          );
          await audit(req, `docker.container_${action}` as AuditAction, 'server', ctx.server.id, ctx.server.name, {
            container: { id: container.id, name: container.name },
            ...(timeout !== undefined && { timeout }),
            ...(signal && { signal }),
            ...(!changed && { changed: false }),
          });
          return { changed };
        });
      } catch (err) {
        return sendDockerError(reply, err);
      }
    });
  }

  /** DELETE /servers/:id/containers/:cid?force&volumes — remove it (and its anonymous volumes with `volumes`). */
  app.delete('/servers/:id/containers/:cid', { preHandler: requireDocker('remove') }, async (req, reply) => {
    const { id, cid } = containerParams.parse(req.params);
    const query = removeSchema.parse(req.query);
    try {
      const ref = containerRef(cid);
      await withDockerClient(req, id, async (ctx) => {
        const container = await identify(ctx, ref);
        await ctx.docker.text({
          method: 'DELETE',
          path: apiPath('containers', container.id),
          query: { force: query.force, v: query.volumes },
          timeoutMs: STOP_GRACE_MS + DEFAULT_STOP_TIMEOUT_S * 1000,
        });
        await audit(req, 'docker.container_remove', 'server', ctx.server.id, ctx.server.name, {
          container: { id: container.id, name: container.name },
          image: (container.info.Config as { Image?: unknown } | undefined)?.Image ?? null,
          force: query.force,
          volumes: query.volumes,
        });
      });
      return reply.status(204).send();
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  // ── Images ────────────────────────────────────────────────────

  /**
   * POST /servers/:id/images/pull `{ image, tag? }` — SSE of `{ type: 'pull',
   * progress }` lines, then `end`; a failed pull ends with `error`. Leaving
   * the page cancels the pull.
   */
  app.post('/servers/:id/images/pull', { preHandler: requireDocker('pull') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    const body = pullSchema.parse(req.body);
    let target: ReturnType<typeof pullTarget>;
    try {
      target = pullTarget(body.image, body.tag);
    } catch (err) {
      return sendDockerError(reply, err);
    }
    // Filled in as the pull goes; `outcome` stays null when the daemon never started it
    const pull: { serverName?: string; outcome: 'pulled' | 'failed' | 'cancelled' | null; error?: string } = {
      outcome: null,
    };
    const sent = await dockerSseRoute(req, reply, id, async (ctx, open, signal) => {
      pull.serverName = ctx.server.name;
      const res = await ctx.docker.stream({
        method: 'POST',
        path: '/images/create',
        query: { fromImage: target.fromImage, tag: target.tag },
        signal,
      });
      const sse = open();
      if (!sse) return void res.destroy();
      pull.outcome = 'cancelled';
      const splitter = new LineSplitter(1024 * 1024);
      const handle = (line: string) => {
        if (!line.trim() || sse.closed) return;
        let raw: RawJson;
        try {
          raw = JSON.parse(line) as RawJson;
        } catch {
          return;
        }
        const progress = toPullProgress(raw);
        if ('error' in progress) {
          pull.outcome = 'failed';
          pull.error = progress.error;
          sse.fail(new DockerError(progress.error, 502));
          return;
        }
        sse.send({ type: 'pull', progress });
      };
      await pipeToSseLines(res, sse, splitter, handle, () => {
        if (pull.outcome === 'cancelled') pull.outcome = 'pulled';
      });
    });
    // Only pulls the daemon started are audited; one refused up front (bad reference, 404) changed nothing
    if (pull.outcome) {
      await audit(req, 'docker.image_pull', 'server', id, pull.serverName, {
        image: target.reference,
        outcome: pull.outcome,
        ...(pull.error && { error: pull.error.slice(0, 500) }),
      });
    }
    return sent;
  });

  /**
   * DELETE /servers/:id/images/:iid?force&unused — untag and delete an image.
   * With `unused`, only an image nothing needs any more — given by its full
   * id, with no tags left and no container (in any state) using it — is
   * removed; anything else is a 409 and nothing changes. That is the cleanup
   * after an upload moved a tag to a new image: it can never take a tag away.
   */
  app.delete('/servers/:id/images/:iid', { preHandler: requireDocker('remove') }, async (req, reply) => {
    const { id, iid } = imageParams.parse(req.params);
    const { force, unused } = z.object({ force: boolQuery, unused: boolQuery }).parse(req.query);
    try {
      const ref = imageRef(iid);
      if (unused && !FULL_IMAGE_ID.test(ref)) throw new DockerError('Give the full image id (sha256:…) to remove an unused image', 400);
      if (unused && force) throw new DockerError('An unused image is never removed by force', 400);
      return await withDockerClient(req, id, async (ctx): Promise<DockerImageRemoveResult> => {
        if (unused) await assertUnused(ctx, ref);
        const raw = await ctx.docker.json<unknown>({
          method: 'DELETE',
          path: imagePath(ref),
          query: { force },
          timeoutMs: REMOVE_IMAGE_TIMEOUT_MS,
        });
        const result = toImageRemoveResult(raw);
        await audit(req, 'docker.image_remove', 'server', ctx.server.id, ctx.server.name, {
          image: ref,
          force,
          ...(unused && { unusedOnly: true }),
          untagged: result.untagged,
          deleted: result.deleted.length,
        });
        return result;
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  // ── Prune ─────────────────────────────────────────────────────

  /** GET /servers/:id/prune — dry run: what a prune would remove (admins, when pruning is allowed). */
  app.get('/servers/:id/prune', { preHandler: requireDocker('prune') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      return await withDockerClient(req, id, async (ctx): Promise<DockerPrunePreview> => {
        const [df, networks, containers] = await Promise.all([
          ctx.docker.json<RawJson>({ path: '/system/df', timeoutMs: PRUNE_TIMEOUT_MS }),
          ctx.docker.json<RawJson[]>({ path: '/networks' }),
          ctx.docker.json<RawJson[]>({ path: '/containers/json', query: { all: true } }),
        ]);
        return toPrunePreview(df, networks, containersPerNetwork(containers), ctx.docker.apiVersion);
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  /**
   * POST /servers/:id/prune `{ containers, images, volumes, networks, dangling }`
   * — in the order `docker system prune` uses. Audited with what was reclaimed,
   * also when a later step fails after earlier ones removed things.
   */
  app.post('/servers/:id/prune', { preHandler: requireDocker('prune') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    const body = pruneSchema.parse(req.body);
    try {
      return await withDockerClient(req, id, async (ctx): Promise<DockerPruneResult> => {
        const done: Parameters<typeof toPruneResult>[0] = {};
        const prune = (path: string, query?: Record<string, string>) =>
          ctx.docker.json<RawJson>({ method: 'POST', path, query, timeoutMs: PRUNE_TIMEOUT_MS });
        const requested = { containers: body.containers, images: body.images, volumes: body.volumes, networks: body.networks, dangling: body.dangling };
        try {
          if (body.containers) done.containers = await prune('/containers/prune');
          if (body.networks) done.networks = await prune('/networks/prune');
          if (body.volumes) done.volumes = await prune('/volumes/prune');
          if (body.images) {
            done.images = await prune('/images/prune', {
              filters: JSON.stringify({ dangling: [body.dangling ? 'true' : 'false'] }),
            });
          }
        } catch (err) {
          const partial = toPruneResult(done);
          await audit(req, 'docker.prune', 'server', ctx.server.id, ctx.server.name, {
            requested,
            ...partial,
            error: err instanceof Error ? err.message.slice(0, 500) : String(err),
          });
          throw err;
        }
        const result = toPruneResult(done);
        await audit(req, 'docker.prune', 'server', ctx.server.id, ctx.server.name, { requested, ...result });
        return result;
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });

  // ── Environment ───────────────────────────────────────────────

  /**
   * POST /servers/:id/containers/:cid/env/reveal — the unredacted environment.
   * Admins only, from a browser session that has just confirmed a passkey
   * (step-up); an admin without a passkey must add one first. Audited with the
   * variable names, never their values.
   */
  app.post('/servers/:id/containers/:cid/env/reveal', { preHandler: requireDocker('revealEnv') }, async (req, reply) => {
    const { id, cid } = containerParams.parse(req.params);
    if (!requireBrowserSession(req, reply, 'Environment values are revealed from a signed-in browser, not with an API token')) {
      return reply;
    }
    if (!req.passkeyVerified) {
      if (passkeyCount(req.user.id) === 0) {
        return reply.status(403).send({
          error: 'Revealing environment values needs a passkey. Add one under Settings → Passkeys, then try again.',
          code: 'DOCKER_REVEAL_NEEDS_PASSKEY',
        });
      }
      return reply.status(403).send({ error: STEP_UP_MESSAGE, code: 'PASSKEY_STEP_UP_REQUIRED' });
    }
    try {
      const ref = containerRef(cid);
      return await withDockerClient(req, id, async (ctx): Promise<DockerEnvReveal> => {
        const container = await identify(ctx, ref);
        const raw = (container.info.Config as { Env?: unknown } | undefined)?.Env;
        const env = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
        await audit(req, 'docker.env_reveal', 'server', ctx.server.id, ctx.server.name, {
          container: { id: container.id, name: container.name },
          variables: env.map((e) => e.split('=', 1)[0]),
        });
        return { env };
      });
    } catch (err) {
      return sendDockerError(reply, err);
    }
  });
}

/** {@link pipeToSse} over newline-delimited output, with the last partial line handled at the end. */
function pipeToSseLines(
  res: IncomingMessage,
  sse: DockerSse,
  splitter: LineSplitter,
  handle: (line: string) => void,
  onEnd: () => void,
) {
  return pipeToSse(
    res,
    sse,
    (chunk) => splitter.push(chunk).forEach(handle),
    () => {
      splitter.flush().forEach(handle);
      onEnd();
    },
  );
}
