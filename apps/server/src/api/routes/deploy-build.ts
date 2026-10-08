import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import {
  DEPLOY_NAME_PATTERN,
  type AuditAction,
  type DeployAppStatus,
  type DeployBuilderPruneResult,
  type DeployBuilderStatus,
  type DeployOutcome,
  type DeployServerPlatform,
} from '@smt/shared';
import { audit } from '../../audit/index.js';
import { requireModule } from '../../auth/access/modules.js';
import { config } from '../../config/index.js';
import { builderCacheBytes, builderWorker, pruneBuildCache } from '../../build/buildctl.js';
import { buildOnBastion, buildQueue, builderOptions, removeImage, requireBuilder, serverPlatform } from '../../build/builder.js';
import { jobDir, receiveUpload, workRoot } from '../../build/context.js';
import type { DockerClient } from '../../docker/client.js';
import { DeployError } from '../../deploy/errors.js';
import { sendDeployError, withRemote, type DeployContext } from '../../deploy/service.js';
import type { DeploySse } from '../../deploy/sse.js';
import type { StreamReservation } from '../sse.js';
import { syncProxy } from './deploy-domains.js';
import type { ServiceRouteHelpers } from './deploy-services.js';

/**
 * Builds on the BastionSSH side (bastion-side builds spec), under
 * `/api/deploy`:
 *
 * - `GET /builder` — the BuildKit service: reachable, platform, cache size,
 *   the build running and how many wait (Deployments view).
 * - `POST /builder/prune` — Clear build cache: BuildKit's cache records of
 *   our builds (Deployments manage); audited.
 * - `GET /servers/:id/platform` — the platform the server's Docker runs, for
 *   the Deploy dialog's note on emulation (view on the server).
 * - `POST /servers/:id/apps/:app/build/cancel` — stop the build of a deploy
 *   (waiting, building or loading the image) before the server takes over
 *   (operate on the server); audited.
 *
 * The deploy itself (`build.where: bastion`, or the Deploy dialog's choice)
 * arrives at the usual deploy route, which hands it to
 * {@link deployOnBastion}: the upload is kept in a folder of its own on this
 * host for the length of the build, never on the server; the image is built,
 * loaded into the server's Docker, and bastionctl serves it with
 * `deploy --prebuilt`.
 */

type Level = 'view' | 'operate' | 'manage';

const serverParams = z.object({ id: z.string().min(1) });
const appParams = serverParams.extend({ app: z.string().regex(DEPLOY_NAME_PATTERN, 'Invalid app name') });

/** A build in progress, by server and app: what Cancel stops. Only until the server takes over. */
const active = new Map<string, { controller: AbortController; userId: string; orgId: string }>();
const activeKey = (serverId: string, app: string) => `${serverId}\0${app}`;

/** Builds in progress (tests). */
export function activeBuildCount(): number {
  return active.size;
}

export interface BastionDeployHelpers extends Pick<ServiceRouteHelpers, 'streamCommand' | 'auditError'> {
  auditDeploy: (req: FastifyRequest, action: AuditAction, ctx: Pick<DeployContext, 'server'>, metadata: Record<string, unknown>) => Promise<unknown> | unknown;
}

/**
 * `build.where: bastion`: take the upload (multipart `part`) to this host,
 * build its image here, load it into the server's Docker, then have
 * bastionctl serve it (`deploy --prebuilt`) — the release flow as for any
 * deploy. The log is one stream: the build's lines, then bastionctl's;
 * `build` events say where it is (queued, building, loading, deploying).
 */
export async function deployOnBastion(
  req: FastifyRequest,
  ctx: DeployContext,
  open: () => DeploySse | null,
  slot: StreamReservation,
  app: string,
  status: DeployAppStatus,
  file: NodeJS.ReadableStream & { truncated?: boolean; destroy: (err?: Error) => void },
  opts: { includeEnvFiles: boolean },
  helpers: BastionDeployHelpers,
): Promise<void> {
  if (!status.config) throw new DeployError(`bastion.yml of ${app} is not valid: fix it first`, 409);
  if (status.config.build.type === 'image') throw new DeployError(`${app} pulls its image (build.type: image): nothing is built`, 400);
  requireBuilder();
  const remoteDocker = ctx.remote.docker;
  if (!remoteDocker) throw new DeployError("This connection cannot reach the server's Docker", 500);
  const key = activeKey(ctx.server.id, app);
  if (active.has(key)) throw new DeployError(`A build of ${app} on this server is running already`, 409, 'locked');

  const job = jobDir(workRoot(config.builder.workDir));
  const controller = new AbortController();
  active.set(key, { controller, userId: req.user.id, orgId: req.orgId });
  // Access revoked before the log opened: nothing is built
  const revoked = () => {
    const err = new DeployError('Your access has changed. The build was stopped.', 403);
    file.destroy(err);
    controller.abort(err);
  };
  if (slot.signal.aborted) revoked();
  slot.signal.addEventListener('abort', revoked, { once: true });
  let docker: DockerClient | null = null;
  let tag: string | null = null;
  try {
    const upload = path.join(job.dir, 'upload');
    const { bytes, sha256 } = await receiveUpload(file as unknown as import('node:stream').Readable, upload, config.sftpMaxUploadBytes);
    if (file.truncated) throw new DeployError('The upload is too large', 413);
    const sse = open();
    if (!sse) return;
    slot.signal.removeEventListener('abort', revoked);
    const started = Date.now();
    await helpers.auditDeploy(req, 'deploy.start', ctx, { app, bytes, builtOn: 'bastion', ...(opts.includeEnvFiles && { includeEnvFiles: true }) });
    const log = (text: string) => sse.send({ type: 'log', lines: [{ stream: 'stderr', text }] });

    docker = await remoteDocker.call(ctx.remote);
    let built: Awaited<ReturnType<typeof buildOnBastion>> | null = null;
    let buildError: DeployError | null = null;
    try {
      built = await buildOnBastion({
        app,
        serverId: ctx.server.id,
        config: status.config,
        upload,
        checksum: sha256,
        includeEnvFiles: opts.includeEnvFiles,
        workDir: job.dir,
        docker,
        dockerVersion: ctx.server.dockerVersion,
        // NEXT_PUBLIC_* and build.args only; stdout of this command is never logged
        buildArgs: async () => (await ctx.run<{ args: Record<string, string> }>(['env', 'build-args', app])).value.args,
        log,
        onState: (state, extra) => sse.send({ type: 'build', state, ...extra }),
        signal: controller.signal,
      });
      tag = built.tag;
    } catch (err) {
      buildError = err instanceof DeployError ? err : new DeployError((err as Error).message, 500);
    } finally {
      // The upload and its unpacked context are gone before anything else happens
      job.remove();
      // From here the server has it: Cancel no longer applies (a deploy runs to its end)
      active.delete(key);
    }

    let outcome: DeployOutcome | null = null;
    let error: string | null = buildError?.message ?? null;
    let exit: { exitCode: number | null; durationMs: number; timedOut: boolean } = { exitCode: null, durationMs: Date.now() - started, timedOut: false };
    if (built) {
      sse.send({ type: 'build', state: 'deploying' });
      const args = ['deploy', app, '--prebuilt', built.tag, '--checksum', sha256, '--build-ms', String(built.buildMs)];
      const r = await helpers.streamCommand(req, ctx, sse, args, (l) => syncProxy(req, ctx, app, 'apply', l));
      outcome = r.outcome;
      error = r.error;
      exit = { exitCode: r.result.exitCode, durationMs: Date.now() - started, timedOut: r.result.timedOut };
      // Refused before a release existed (locked, config): the loaded image is ours to remove
      if (outcome?.result !== 'success') await removeImage(docker, built.tag).catch(() => {});
    } else {
      log(`Build failed: ${error}`);
      sse.send({ type: 'error', error: error ?? 'The build failed', ...(buildError && { status: buildError.statusCode }) });
      sse.send({ type: 'exit', exitCode: null, signal: null, durationMs: exit.durationMs, timedOut: buildError?.code === 'build_timeout' });
      sse.send({ type: 'end' });
    }
    await helpers.auditDeploy(req, 'deploy.finish', ctx, {
      app,
      builtOn: 'bastion',
      release: outcome?.release ?? null,
      result: outcome?.result ?? (buildError?.code === 'build_cancelled' ? 'cancelled' : 'failed'),
      error: helpers.auditError(outcome?.error ?? error),
      exitCode: exit.exitCode,
      durationMs: exit.durationMs,
      ...(built && { platform: built.platform, queueMs: built.queueMs, buildMs: built.buildMs, loadMs: built.loadMs, imageBytes: built.bytes }),
      ...(exit.timedOut && { timedOut: true }),
      ...(sse.closed && { detached: true }),
    });
  } catch (err) {
    if (tag && docker) await removeImage(docker, tag).catch(() => {});
    throw err;
  } finally {
    slot.signal.removeEventListener('abort', revoked);
    job.remove();
    active.delete(key);
    docker?.close();
  }
}

export async function deployBuildRoutes(app: FastifyInstance, opts: { gate: (level: Level) => preHandlerHookHandler[] }) {
  const { gate } = opts;

  /** GET /builder — the BuildKit service as it is now; never fails for an unreachable one (it says so). */
  app.get('/builder', async (): Promise<DeployBuilderStatus> => {
    const options = builderOptions();
    const queue = buildQueue.status();
    const base: DeployBuilderStatus = {
      configured: !!options,
      reachable: false,
      platform: null,
      platforms: [],
      version: null,
      cacheBytes: null,
      cacheLimitBytes: null,
      ...queue,
      error: null,
    };
    if (!options) return base;
    try {
      const [worker, cacheBytes] = await Promise.all([builderWorker(options), builderCacheBytes(options)]);
      return { ...base, reachable: true, ...worker, cacheBytes };
    } catch (err) {
      return { ...base, error: (err as Error).message };
    }
  });

  /** POST /builder/prune — Clear build cache (the next build of each app starts cold). */
  app.post('/builder/prune', { preHandler: requireModule('deployments', 'manage') }, async (req, reply) => {
    try {
      const result: DeployBuilderPruneResult = await pruneBuildCache(requireBuilder());
      await audit(req, 'deploy.build_cache_clear', 'builder', 'buildkit', 'BuildKit', { reclaimedBytes: result.reclaimedBytes, records: result.records });
      return result;
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /** GET /servers/:id/platform — `linux/amd64`, from the server's Docker. */
  app.get('/servers/:id/platform', { preHandler: gate('view') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    try {
      return await withRemote(req, id, async (remote): Promise<DeployServerPlatform> => {
        if (!remote.docker) throw new DeployError("This connection cannot reach the server's Docker", 500);
        const docker = await remote.docker();
        try {
          return { platform: await serverPlatform(docker) };
        } finally {
          docker.close();
        }
      });
    } catch (err) {
      return sendDeployError(reply, err);
    }
  });

  /**
   * POST /servers/:id/apps/:app/build/cancel — stop the app's build on the
   * BastionSSH side: BuildKit's solve and the image's transfer; an image the
   * server may have taken in is removed. 409 once the server has taken over
   * (a deploy runs to its end).
   */
  app.post('/servers/:id/apps/:app/build/cancel', { preHandler: gate('operate') }, async (req, reply) => {
    const { id, app: name } = appParams.parse(req.params);
    const build = active.get(activeKey(id, name));
    if (!build || build.orgId !== req.orgId) {
      return reply.status(409).send({ error: `No build of ${name} is running on BastionSSH: the server may be deploying it already (that runs to its end)`, code: 'no_build' });
    }
    build.controller.abort(new DeployError(`The build was cancelled by ${req.user.email || req.user.id}`, 499, 'build_cancelled'));
    await audit(req, 'deploy.build_cancel', 'server', id, undefined, { app: name, ...(build.userId !== req.user.id && { startedBy: build.userId }) });
    return { cancelled: true };
  });
}

/** Leftover work folders (a crash mid-build) are removed when BastionSSH starts. */
export function cleanBuildWorkRoot(): void {
  try {
    const root = workRoot(config.builder.workDir);
    for (const name of fs.readdirSync(root)) if (name.startsWith('build-')) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  } catch {
    // nothing to clean, or not ours to clean
  }
}
