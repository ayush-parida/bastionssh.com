import { Transform, type TransformCallback } from 'node:stream';
import {
  dockerPlatform,
  normalizeDockerArch,
  type DockerArchiveFormat,
  type DockerLoadedImage,
  type DockerPullProgress,
} from '@smt/shared';
import { compareApiVersions } from './client.js';
import { DockerError } from './errors.js';

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
