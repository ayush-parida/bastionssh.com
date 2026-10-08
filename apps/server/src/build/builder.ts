import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import {
  deployEnvFilesNote,
  deployReleaseId,
  dockerPlatform,
  isEmulatedBuild,
  secretMasker,
  type DeployAppConfig,
  type DeployBuildState,
} from '@smt/shared';
import { config } from '../config/index.js';
import type { DockerClient } from '../docker/client.js';
import { DockerError } from '../docker/errors.js';
import { ArchiveMeter, engineAccepts, readLoadOutput, sendArchive } from '../docker/image-load.js';
import { imageApiPath } from '../docker/validation.js';
import { DeployError } from '../deploy/errors.js';
import { buildImage, builderWorker, type BuildctlOptions } from './buildctl.js';
import { prepareContext } from './context.js';
import { BuildQueue } from './queue.js';

/**
 * Builds on the BastionSSH side (bastion-side builds spec): an app with
 * `build.where: bastion` is built by BastionSSH's BuildKit service, for the
 * target server's platform, and only the finished image travels to the
 * server — streamed, gzipped, into its Docker's `POST /images/load` over the
 * existing SSH connection (the image upload's code). The server never runs
 * `npm install` or `next build`; bastionctl takes it from there
 * (`deploy --prebuilt`): health check, zero-downtime switch, rollback.
 *
 * - One build at a time ({@link BuildQueue}); a deploy that arrives meanwhile
 *   waits and is told its place.
 * - The context is an ephemeral folder (build/context.ts), removed by the
 *   caller whatever happens.
 * - Build args: only `NEXT_PUBLIC_*` and `build.args`, read from the
 *   server's `.env` for this build (`bastionctl env build-args`); their
 *   values are masked in the log and stored nowhere here.
 * - Cancelling (or the timeout) stops the solve and the transfer; an image
 *   the engine may have taken in is removed again, so nothing partial stays.
 */

/** One per BastionSSH: BuildKit gets one build at a time. */
export const buildQueue = new BuildQueue(config.builder.queueMax);

/** The builder as configured, or null when this BastionSSH has none (`SMT_BUILDKIT_ADDR` unset). */
export function builderOptions(): BuildctlOptions | null {
  if (!config.builder.addr) return null;
  return { bin: config.builder.buildctl, addr: config.builder.addr, tlsDir: config.builder.tlsDir };
}

export function requireBuilder(): BuildctlOptions {
  const opts = builderOptions();
  if (!opts) {
    throw new DeployError(
      'This BastionSSH has no builder (SMT_BUILDKIT_ADDR is not set), so it cannot build on its side. Deploy with "Build on the server", or set up the buildkit service (docker-compose.yml).',
      409,
      'builder_unavailable',
    );
  }
  return opts;
}

/** The platform the server's Docker runs images for, from its `/info` (`linux/amd64`). */
export async function serverPlatform(docker: DockerClient, signal?: AbortSignal): Promise<string> {
  const info = await docker.json<{ OSType?: string; Architecture?: string }>({ path: '/info', signal });
  if (!info?.Architecture) throw new DeployError("The server's Docker did not say its architecture", 502);
  return dockerPlatform(info.OSType || 'linux', info.Architecture);
}

export interface BastionBuildInput {
  app: string;
  serverId: string;
  config: Pick<DeployAppConfig, 'build' | 'run'>;
  /** The upload, on this host (in `workDir`). */
  upload: string;
  /** Its SHA-256: the release id's suffix and release.json's checksum. */
  checksum: string;
  includeEnvFiles: boolean;
  /** The job's own folder; the caller removes it. */
  workDir: string;
  /** The target server's engine (over its SSH connection). */
  docker: DockerClient;
  /** For an engine that cannot read the archive's format (never gzip). */
  dockerVersion: string | null;
  /** `NEXT_PUBLIC_*` and `build.args` values from the server's `.env`. */
  buildArgs: () => Promise<Record<string, string>>;
  log: (line: string) => void;
  onState: (state: DeployBuildState, extra?: { platform?: string; position?: number }) => void;
  /** Cancel: stops the build and the transfer. */
  signal: AbortSignal;
  now?: () => Date;
}

export interface BastionBuildResult {
  /** `bastion-<app>:<release>`, loaded into the server's Docker. */
  tag: string;
  release: string;
  platform: string;
  queueMs: number;
  buildMs: number;
  loadMs: number;
  /** Bytes sent to the server (gzipped). */
  bytes: number;
}

const MiB = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MiB`;

/** Why a signal was aborted, as the error the build ends with. */
function stopReason(signal: AbortSignal, timedOut: boolean): DeployError {
  if (timedOut) return new DeployError(`The build did not finish within ${Math.round(config.builder.timeoutMs / 60_000)} minutes and was stopped`, 504, 'build_timeout');
  const reason = signal.reason as unknown;
  return reason instanceof DeployError ? reason : new DeployError('The build was cancelled', 499, 'build_cancelled');
}

/** Remove a tag the engine may hold from a cut-off or refused build; gone already is fine. */
export async function removeImage(docker: DockerClient, tag: string): Promise<void> {
  try {
    await docker.json({ method: 'DELETE', path: imageApiPath(tag), query: { force: true, noprune: false }, timeoutMs: 60_000 });
  } catch (err) {
    if (err instanceof DockerError && err.statusCode === 404) return;
    throw err;
  }
}

/**
 * Wait for the first bytes of `stream`: a build's image only comes out of
 * buildctl when BuildKit exports it, minutes after it starts, and the load
 * request is not opened before. Returns the stream from those bytes on, or
 * null when it ended without any (the build failed).
 */
async function fromFirstChunk(stream: Readable, after: () => Promise<void>): Promise<Readable | null> {
  const it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const first = await it.next();
  if (first.done) return null;
  return Readable.from(
    (async function* () {
      yield first.value;
      for (;;) {
        const next = await it.next();
        if (next.done) break;
        yield next.value;
      }
      // buildctl must have succeeded, or the engine gets a broken body (and loads nothing)
      await after();
    })(),
  );
}

/**
 * Build `input.app`'s image on the BastionSSH side and load it into the
 * server's Docker as `bastion-<app>:<release>`. Throws a DeployError on a
 * refused upload (422), a failed build (422), a cancel (499), the timeout
 * (504) or the builder being away (503); the image is then not on the
 * server.
 */
export async function buildOnBastion(input: BastionBuildInput): Promise<BastionBuildResult> {
  const opts = requireBuilder();
  const now = input.now ?? (() => new Date());
  const queuedAt = Date.now();
  return buildQueue.run(
    { app: input.app, serverId: input.serverId },
    input.signal,
    async () => {
      const queueMs = Date.now() - queuedAt;
      input.signal.throwIfAborted();
      const timeout = AbortSignal.timeout(config.builder.timeoutMs);
      const signal = AbortSignal.any([input.signal, timeout]);
      const fail = () => stopReason(input.signal, timeout.aborted && !input.signal.aborted);

      const [target, worker] = await Promise.all([serverPlatform(input.docker, signal), builderWorker(opts)]);
      input.onState('building', { platform: target });
      input.log(`Building on BastionSSH for ${target} (BuildKit ${worker.version ?? 'unknown version'} on ${worker.platform ?? 'an unknown platform'})`);
      if (worker.platform && !worker.platforms.includes(target)) {
        throw new DeployError(
          `The builder cannot build for ${target} (it builds for ${worker.platforms.join(', ')}). On a Linux host, install QEMU emulation once: docker run --privileged --rm tonistiigi/binfmt --install all`,
          409,
          'builder_platform',
        );
      }
      if (isEmulatedBuild(worker.platform, target)) {
        input.log(`The builder is ${worker.platform}: ${target} is built under QEMU emulation, which is several times slower than a native build`);
      }

      // Values for this build only; masked wherever they could be printed
      const args = await input.buildArgs();
      const mask = secretMasker(Object.values(args));
      const log = (line: string) => input.log(mask(line));
      signal.throwIfAborted();

      log('Unpacking the upload');
      const prepared = await prepareContext(input.upload, input.workDir, input.config, {
        includeEnvFiles: input.includeEnvFiles,
        maxBytes: config.builder.maxContextBytes,
        buildArgs: Object.keys(args),
      });
      log(`Unpacked ${prepared.files} entries (${Math.round(prepared.bytes / 1024)} KiB)`);
      if (prepared.skippedCount > 0) log(deployEnvFilesNote(prepared.skipped, prepared.skippedCount));
      else if (input.includeEnvFiles) log('Environment files in the upload were kept, as asked (they are part of this build and can end up in the image)');
      for (const note of prepared.plan.notes) log(note);
      if (Object.keys(args).length > 0) log(`Build args from .env: ${Object.keys(args).join(', ')}`);

      const release = deployReleaseId(now(), input.checksum);
      const tag = `bastion-${input.app}:${release}`;
      const started = Date.now();
      const build = buildImage(opts, {
        context: prepared.dir,
        dockerfile: prepared.plan.dockerfile,
        platform: target,
        buildArgs: args,
        labels: { 'bastion.app': input.app, 'bastion.release': release, 'bastion.managed': 'app' },
        name: tag,
        onLine: log,
      });
      const stop = () => build.stop();
      signal.addEventListener('abort', stop, { once: true });
      // Surfaces with the load (or alone, when there is nothing to load)
      build.done.catch(() => {});

      let loadStarted = 0;
      let bytes = 0;
      let loaded = false;
      try {
        // The first bytes of the image itself (an empty output gzipped is still 20 bytes)
        const raw = await fromFirstChunk(build.stdout, () => build.done);
        if (!raw) {
          await build.done;
          throw new DeployError('The build ended without an image', 502, 'build_failed');
        }
        signal.throwIfAborted();
        loadStarted = Date.now();
        input.onState('loading');
        log(`Built in ${Math.round((loadStarted - started) / 1000)} s; loading the image into the server's Docker`);
        const meter = new ArchiveMeter(config.dockerImageUploadMaxBytes, engineAccepts(input.docker, input.dockerVersion));
        // Why the transfer was cut, when it was: the request's own error then only says it broke
        let cut: unknown = null;
        meter.on('error', (err) => (cut ??= err));
        const gzip = zlib.createGzip();
        raw.on('error', (err) => gzip.destroy(err));
        gzip.on('error', (err) => meter.destroy(err));
        raw.pipe(gzip).pipe(meter);
        loaded = true; // from here the engine may hold part of it: removed again on failure
        const res = await sendArchive(input.docker, meter, signal).catch((err: unknown) => {
          throw cut ?? err;
        });
        const out = await readLoadOutput(res, { max: 10 });
        bytes = meter.bytes;
        await build.done;
        if (!out.loaded.some((l) => 'ref' in l && l.ref === tag)) {
          throw new DeployError(`The server's Docker did not report ${tag} as loaded`, 502, 'build_failed');
        }
        if (signal.aborted) throw fail();
      } catch (err) {
        if (loaded) await removeImage(input.docker, tag).catch(() => {});
        if (signal.aborted) throw fail();
        if (err instanceof DeployError) throw err;
        if (err instanceof DockerError) throw new DeployError(`Loading the image into the server failed: ${err.message}`, 502, 'build_failed');
        throw err;
      } finally {
        signal.removeEventListener('abort', stop);
        build.stop();
      }
      const done = Date.now();
      log(`Loaded ${tag} into the server's Docker (${MiB(bytes)} sent) in ${Math.round((done - loadStarted) / 1000)} s`);
      return { tag, release, platform: target, queueMs, buildMs: loadStarted - started, loadMs: done - loadStarted, bytes };
    },
    (position) => {
      input.onState('queued', { position });
      input.log(position === 1 ? 'Waiting for the build before this one to finish' : `Waiting for ${position} builds to finish before this one`);
    },
  );
}
