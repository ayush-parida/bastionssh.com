import type { IncomingMessage } from 'node:http';
import { Transform, type TransformCallback } from 'node:stream';
import {
  dockerPlatform,
  normalizeDockerArch,
  type DockerArchiveFormat,
  type DockerLoadedImage,
  type DockerPullProgress,
} from '@smt/shared';
import { compareApiVersions, type DockerClient } from './client.js';
import { LineSplitter } from './demux.js';
import { DockerError, fromDaemonStatus } from './errors.js';

/**
 * Uploading an image built elsewhere (`docker save`) into a server's engine:
 * the browser's upload is piped through {@link ArchiveMeter} straight into
 * `POST /images/load` over the server's SSH connection — never written to a
 * file here or on the server. The engine reads plain tar and gzip, bzip2, xz
 * and (from Docker 23, API 1.42) zstd compressed archives itself, so nothing
 * is decompressed on the way.
 */

/** Docker 23 (API 1.42) is the first engine whose `docker load` reads zstd. */
export const ZSTD_MIN_API = '1.42';

/** Bytes needed to tell a tar from anything else: its `ustar` magic sits at offset 257. */
const SNIFF_BYTES = 512;

const MAGIC: Array<[DockerArchiveFormat, number[]]> = [
  ['gzip', [0x1f, 0x8b]],
  ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ['zstd', [0x28, 0xb5, 0x2f, 0xfd]],
  ['bzip2', [0x42, 0x5a, 0x68]],
];

/**
 * What an archive is from its first bytes, or null when it is not one
 * `docker load` reads. Needs at least the first 262 bytes for a plain tar.
 */
export function detectArchiveFormat(head: Buffer): DockerArchiveFormat | null {
  for (const [format, magic] of MAGIC) {
    if (head.length >= magic.length && magic.every((b, i) => head[i] === b)) return format;
  }
  if (head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return null;
}

/** Whether an engine speaking `apiVersion` can load archives in `format`. */
export function engineReads(format: DockerArchiveFormat, apiVersion: string | null): boolean {
  return format !== 'zstd' || (!!apiVersion && compareApiVersions(apiVersion, ZSTD_MIN_API) >= 0);
}

export function tooLarge(limit: number): DockerError {
  return new DockerError(`The image archive is larger than this BastionSSH accepts (${formatLimit(limit)})`, 413);
}

function formatLimit(bytes: number): string {
  const units = ['GiB', 'MiB', 'KiB'];
  for (const [i, unit] of units.entries()) {
    const size = bytes / 1024 ** (3 - i);
    if (size >= 1) return `${Number(size.toFixed(1))} ${unit}`;
  }
  return `${bytes} bytes`;
}

/**
 * Passes an upload through, counting it: fails with 413 past `limit`, and
 * holds the first bytes back until it knows the archive's format — failing
 * with 400 when it is not an archive, or one `accept` refuses — so a bad
 * upload is stopped before the engine receives any of it.
 */
export class ArchiveMeter extends Transform {
  bytes = 0;
  format: DockerArchiveFormat | null = null;
  private head: Buffer[] = [];
  private headBytes = 0;

  constructor(
    private readonly limit: number,
    private readonly accept: (format: DockerArchiveFormat) => DockerError | null,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) return done(tooLarge(this.limit));
    if (this.format) return done(null, chunk);
    this.head.push(chunk);
    this.headBytes += chunk.length;
    if (this.headBytes < SNIFF_BYTES) return done();
    done(this.release());
  }

  override _flush(done: TransformCallback): void {
    if (this.format) return done();
    if (this.headBytes === 0) return done(new DockerError('The upload was empty', 400));
    done(this.release());
  }

  /** Decide the format from the held bytes and pass them on; the error when refused. */
  private release(): DockerError | null {
    const head = Buffer.concat(this.head);
    this.head = [];
    const format = detectArchiveFormat(head);
    if (!format) {
      return new DockerError(
        'This is not an image archive. Upload what `docker save` writes: a .tar, or a .tar.gz (also .tar.xz, .tar.zst, .tar.bz2)',
        400,
      );
    }
    const refused = this.accept(format);
    if (refused) return refused;
    this.format = format;
    this.push(head);
    return null;
  }
}

/** One parsed line of `/images/load` output. */
export type LoadLine =
  | { kind: 'progress'; progress: DockerPullProgress; loaded: { ref: string } | { id: string } | null }
  | { kind: 'error'; error: string };

/**
 * A line of `/images/load` output: `{ stream: "Loaded image: app:1\n" }`,
 * `{ stream: "Loaded image ID: sha256:…" }` for an untagged image,
 * `{ status: "Loading layer", progressDetail }`, or `{ error }`.
 */
export function parseLoadLine(raw: Record<string, unknown>): LoadLine {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const detail = (typeof raw.errorDetail === 'object' && raw.errorDetail !== null ? raw.errorDetail : {}) as Record<string, unknown>;
  const error = str(raw.error) || str(detail.message);
  if (error) return { kind: 'error', error };
  const text = (str(raw.stream) || str(raw.status)).trim();
  const progressDetail = (typeof raw.progressDetail === 'object' && raw.progressDetail !== null ? raw.progressDetail : {}) as Record<
    string,
    unknown
  >;
  const progress: DockerPullProgress = {
    id: str(raw.id) || null,
    status: text,
    current: typeof progressDetail.current === 'number' ? progressDetail.current : null,
    total: typeof progressDetail.total === 'number' ? progressDetail.total : null,
  };
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^Loaded image ID: (sha256:[a-f0-9]{64})$/))) return { kind: 'progress', progress, loaded: { id: m[1]! } };
  if ((m = text.match(/^Loaded image: (\S+)$/))) return { kind: 'progress', progress, loaded: { ref: m[1]! } };
  return { kind: 'progress', progress, loaded: null };
}

/** Tag → image id, from `/images/json`: what each tag pointed at before a load. */
export function tagIndex(images: Array<Record<string, unknown>>): Map<string, string> {
  const index = new Map<string, string>();
  for (const image of images) {
    const id = typeof image.Id === 'string' ? image.Id : '';
    const tags = Array.isArray(image.RepoTags) ? image.RepoTags : [];
    for (const tag of tags) if (typeof tag === 'string' && tag !== '<none>:<none>') index.set(tag, id);
  }
  return index;
}

/** A loaded image from its inspect output, compared with the engine's platform and what its tag replaced. */
export function toLoadedImage(
  ref: string | null,
  inspect: Record<string, unknown>,
  engine: { os: string; arch: string },
  before: Map<string, string>,
): DockerLoadedImage {
  const id = typeof inspect.Id === 'string' ? inspect.Id : '';
  const os = typeof inspect.Os === 'string' ? inspect.Os : '';
  const architecture = typeof inspect.Architecture === 'string' ? inspect.Architecture : '';
  const variant = typeof inspect.Variant === 'string' && inspect.Variant ? inspect.Variant : null;
  const previous = ref ? before.get(ref) : undefined;
  const platformMismatch =
    !!architecture &&
    !!engine.arch &&
    (normalizeDockerArch(architecture) !== normalizeDockerArch(engine.arch) || (!!os && !!engine.os && os !== engine.os));
  return {
    ref,
    id,
    os,
    architecture,
    variant,
    size: typeof inspect.Size === 'number' ? inspect.Size : 0,
    replacedId: previous && previous !== id ? previous : null,
    platformMismatch,
  };
}

/** The warning for an image built for another platform than the server's. */
export function platformWarning(image: DockerLoadedImage, engine: { os: string; arch: string }): string {
  const name = image.ref ?? image.id.slice(7, 19);
  const built = dockerPlatform(image.os, image.architecture) + (image.variant ? `/${image.variant}` : '');
  const server = dockerPlatform(engine.os, engine.arch);
  return (
    `${name} is built for ${built}, but this server is ${server}. Containers from it would fail with "exec format error". ` +
    `Rebuild it with docker build --platform ${server} and upload it again.`
  );
}

/** Read a small error body (the engine refusing the archive). */
async function readSmall(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= 64 * 1024) chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** An engine able to read archives in what {@link engineReads} allows, or the error saying why not. */
export function engineAccepts(docker: Pick<DockerClient, 'apiVersion'>, dockerVersion: string | null): (format: DockerArchiveFormat) => DockerError | null {
  return (format) =>
    engineReads(format, docker.apiVersion)
      ? null
      : new DockerError(
          `This server's Docker Engine (${dockerVersion ?? `API ${docker.apiVersion}`}) cannot read zstd archives. Save the image with gzip instead: docker save <image> | gzip > image.tar.gz`,
          400,
        );
}

/**
 * Send an archive (already piped into `meter`) to the engine's
 * `POST /images/load`. Resolves with the engine's answer once its headers
 * arrive with a 2xx status — the engine then has the whole archive — and
 * throws the engine's refusal otherwise. Aborting `signal` before that cuts
 * the body, so nothing is loaded.
 */
export async function sendArchive(docker: DockerClient, meter: ArchiveMeter, signal: AbortSignal): Promise<IncomingMessage> {
  const res = await docker.send({
    method: 'POST',
    path: '/images/load',
    query: { quiet: false },
    body: meter,
    contentType: 'application/x-tar',
    signal,
  });
  if (!res.statusCode || res.statusCode >= 300) throw fromDaemonStatus(res.statusCode ?? 502, await readSmall(res).catch(() => ''));
  return res;
}

/**
 * Read `/images/load` output to its end: progress lines go to `onProgress`;
 * returns what the engine reported loaded (the first `max`, all counted).
 * An `error` line throws (502) once the output ends.
 */
export async function readLoadOutput(
  res: IncomingMessage,
  opts: { max: number; onProgress?: (progress: DockerPullProgress) => void },
): Promise<{ loaded: Array<{ ref: string } | { id: string }>; count: number }> {
  const loaded: Array<{ ref: string } | { id: string }> = [];
  let count = 0;
  let failure: string | null = null;
  const splitter = new LineSplitter(1024 * 1024);
  const handle = (line: string) => {
    if (!line.trim()) return;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const parsed = parseLoadLine(raw);
    if (parsed.kind === 'error') {
      failure = parsed.error;
      return;
    }
    if (parsed.loaded && count++ < opts.max) loaded.push(parsed.loaded);
    if (parsed.progress.status) opts.onProgress?.(parsed.progress);
  };
  for await (const chunk of res as AsyncIterable<Buffer>) splitter.push(chunk).forEach(handle);
  splitter.flush().forEach(handle);
  if (failure) throw new DockerError(failure, 502);
  return { loaded, count };
}
