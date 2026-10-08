import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { normalizeDockerArch } from '@smt/shared';
import { LineSplitter } from '../docker/demux.js';
import { DeployError } from '../deploy/errors.js';

/**
 * BastionSSH's side of BuildKit (bastion-side builds spec §2): the pinned
 * `buildctl` binary in the BastionSSH image, talking to the `buildkit`
 * service of docker-compose.yml over TCP on a network only the two share.
 * Everything is an argv — no shell — and a build's arguments (which carry
 * build-arg values) are never logged.
 */

export interface BuildctlOptions {
  /** The binary (`SMT_BUILDCTL_PATH`). */
  bin: string;
  /** `tcp://buildkit:1234` (`SMT_BUILDKIT_ADDR`). */
  addr: string;
  /** A folder with ca.pem, cert.pem and key.pem for mTLS (`SMT_BUILDKIT_TLS_DIR`), when set. */
  tlsDir?: string | null;
}

/** How long a status or prune call may take (a busy builder still answers these quickly). */
const QUICK_TIMEOUT_MS = 20_000;
/** After SIGTERM, how long buildctl gets to cancel the solve before SIGKILL. */
const KILL_GRACE_MS = 5_000;

function globalArgs(opts: BuildctlOptions): string[] {
  return ['--addr', opts.addr, ...(opts.tlsDir ? ['--tlsdir', opts.tlsDir] : [])];
}

/** Stop a buildctl process: SIGTERM (it cancels the solve on BuildKit), then SIGKILL if it lingers. */
export function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  timer.unref?.();
  child.once('exit', () => clearTimeout(timer));
}

/** Run a short buildctl command and return its stdout; throws with its last stderr lines. */
export function buildctlText(opts: BuildctlOptions, args: string[], timeoutMs = QUICK_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(opts.bin, [...globalArgs(opts), ...args], { stdio: 'pipe' });
    } catch (err) {
      return reject(new DeployError(`buildctl could not start: ${(err as Error).message}`, 503, 'builder_unavailable'));
    }
    child.stdin.end();
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (err = (err + c.toString('utf8')).slice(-8192)));
    const timer = setTimeout(() => stopProcess(child), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new DeployError(`buildctl could not start: ${e.message}`, 503, 'builder_unavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
      const detail = err.trim().split('\n').slice(-3).join(' ').trim();
      reject(new DeployError(`The builder did not answer${detail ? `: ${detail}` : ''}`, 503, 'builder_unavailable'));
    });
  });
}

export interface BuilderWorker {
  /** `linux/arm64` — the first platform BuildKit lists is its own. */
  platform: string | null;
  platforms: string[];
  version: string | null;
  /** The largest cache size BuildKit's garbage collection keeps, when it says. */
  cacheLimitBytes: number | null;
}

interface RawWorker {
  platforms?: Array<{ os?: string; architecture?: string; variant?: string }> | null;
  buildkitVersion?: { version?: string } | null;
  gcPolicy?: Array<{ maxUsedSpace?: number; reservedSpace?: number; keepBytes?: number }> | null;
}

const platformName = (p: { os?: string; architecture?: string; variant?: string }) =>
  `${p.os || 'linux'}/${normalizeDockerArch(p.architecture ?? '')}${p.variant ? `/${p.variant}` : ''}`;

/** `buildctl debug workers --format '{{json .}}'`: the worker's platforms, version and cache limit. */
export function parseWorkers(text: string): BuilderWorker {
  let workers: RawWorker[];
  try {
    workers = JSON.parse(text.trim() || '[]') as RawWorker[];
  } catch {
    throw new DeployError('The builder answered with something that is not JSON', 502, 'builder_unavailable');
  }
  const worker = Array.isArray(workers) ? workers[0] : undefined;
  if (!worker) throw new DeployError('The builder has no worker', 503, 'builder_unavailable');
  const platforms = (worker.platforms ?? []).map(platformName);
  const limits = (worker.gcPolicy ?? []).map((r) => r.maxUsedSpace || r.keepBytes || r.reservedSpace || 0).filter((n) => n > 0);
  return {
    platform: platforms[0] ?? null,
    platforms,
    version: worker.buildkitVersion?.version ?? null,
    cacheLimitBytes: limits.length > 0 ? Math.max(...limits) : null,
  };
}

/** `buildctl du --format '{{json .}}'`: the cache's size on disk. */
export function parseDiskUsage(text: string): number {
  let records: Array<{ size?: number }>;
  try {
    records = JSON.parse(text.trim() || '[]') as Array<{ size?: number }>;
  } catch {
    return 0;
  }
  return (Array.isArray(records) ? records : []).reduce((n, r) => n + (typeof r.size === 'number' ? r.size : 0), 0);
}

export async function builderWorker(opts: BuildctlOptions): Promise<BuilderWorker> {
  return parseWorkers(await buildctlText(opts, ['debug', 'workers', '--format', '{{json .}}']));
}

export async function builderCacheBytes(opts: BuildctlOptions): Promise<number> {
  return parseDiskUsage(await buildctlText(opts, ['du', '--format', '{{json .}}']));
}

/**
 * The cache records a build of ours makes: layers and exec mounts
 * (`regular`), uploaded contexts (`source.local`) and cache mounts
 * (`exec.cachemount`). BuildKit ORs them. Internal and frontend references
 * (the Dockerfile frontend itself) are left alone: no `--all`.
 */
export const BUILD_CACHE_FILTERS = ['type==regular', 'type==source.local', 'type==exec.cachemount'] as const;

/** Clear the build cache ("Clear build cache"); returns what was freed. Records in use by a running build stay. */
export async function pruneBuildCache(opts: BuildctlOptions): Promise<{ reclaimedBytes: number; records: number }> {
  const filters = BUILD_CACHE_FILTERS.flatMap((f) => ['--filter', f]);
  const out = await buildctlText(opts, ['prune', ...filters, '--format', '{{json .}}'], 10 * 60_000);
  let reclaimedBytes = 0;
  let records = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { size?: number };
      records++;
      reclaimedBytes += typeof r.size === 'number' ? r.size : 0;
    } catch {
      // a line of something else
    }
  }
  return { reclaimedBytes, records };
}

export interface ImageBuild {
  /** The image as a `docker load` tarball (`--output type=docker`), written as BuildKit exports it. */
  stdout: Readable;
  /** Settles when buildctl exits: rejects unless it succeeded. */
  done: Promise<void>;
  /** Cancel the solve (SIGTERM, then SIGKILL). */
  stop(): void;
}

export interface ImageBuildRequest {
  /** The build context (a folder; also where the Dockerfile is). */
  context: string;
  /** The Dockerfile's name inside it. */
  dockerfile: string;
  /** `linux/amd64`: the target server's platform. */
  platform: string;
  /** Build-arg values: on buildctl's command line only, never in a log. */
  buildArgs: Record<string, string>;
  labels: Record<string, string>;
  /** `bastion-<app>:<release>`, the name the image is loaded as. */
  name: string;
  /** Each progress line (`--progress plain`), as it comes. */
  onLine: (line: string) => void;
}

/** The argv of a build (exported for tests; it holds build-arg values, so it is never logged). */
export function buildArgv(opts: BuildctlOptions, req: Omit<ImageBuildRequest, 'onLine'>): string[] {
  return [
    ...globalArgs(opts),
    'build',
    '--progress',
    'plain',
    '--frontend',
    'dockerfile.v0',
    '--local',
    `context=${req.context}`,
    '--local',
    `dockerfile=${req.context}`,
    '--opt',
    `filename=${req.dockerfile}`,
    '--opt',
    `platform=${req.platform}`,
    ...Object.entries(req.buildArgs).flatMap(([k, v]) => ['--opt', `build-arg:${k}=${v}`]),
    ...Object.entries(req.labels).flatMap(([k, v]) => ['--opt', `label:${k}=${v}`]),
    '--output',
    `type=docker,name=${req.name}`,
  ];
}

/** Start a build; its image streams out of `stdout` once BuildKit exports it. */
export function buildImage(opts: BuildctlOptions, req: ImageBuildRequest): ImageBuild {
  const child = spawn(opts.bin, buildArgv(opts, req), { stdio: 'pipe' });
  child.stdin.end();
  // The end of the log, for the error message
  let tail: string[] = [];
  const emit = (line: string) => {
    tail = [...tail.slice(-19), line];
    req.onLine(line);
  };
  const lines = new LineSplitter();
  child.stderr.on('data', (chunk: Buffer) => lines.push(chunk).forEach(emit));
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (err) => reject(new DeployError(`buildctl could not start: ${err.message}`, 503, 'builder_unavailable')));
    child.on('close', (code, signal) => {
      lines.flush().forEach(emit);
      if (code === 0) return resolve();
      const error = [...tail].reverse().find((l) => /error|failed/i.test(l));
      const detail = error ? `: ${error.replace(/^#\d+\s+(?:\d+\.\d+\s+)?/, '')}` : ` (buildctl exit ${code})`;
      reject(new DeployError(signal ? `The build was stopped (${signal})` : `The build failed${detail}`, 422, 'build_failed'));
    });
  });
  return { stdout: child.stdout, done, stop: () => stopProcess(child) };
}
