import type {
  DockerImageRemoveResult,
  DockerPrunePreview,
  DockerPruneResult,
  DockerPullProgress,
} from '@smt/shared';
import { compareApiVersions } from './client.js';
import { DockerError } from './errors.js';
import { parseImageReference } from './validation.js';

/**
 * Pure helpers for the Act routes (D2, api/routes/docker-actions.ts): what
 * to ask the daemon for, and how to read what it answers. Kept apart from the
 * routes so they can be tested without a daemon.
 */

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Tags as Docker allows them. */
const TAG_PATTERN = /^[\w][\w.-]{0,127}$/;

/** Kill signals: a name (`SIGTERM`, `TERM`, `SIGRTMIN+3`) or a number. */
export const SIGNAL_PATTERN = /^(?:(?:SIG)?[A-Z][A-Z0-9+-]{0,15}|[0-9]{1,2})$/;

export interface PullTarget {
  /** Repository, with its registry when there is one: `ghcr.io/org/app`. */
  fromImage: string;
  /** A tag or a digest (`sha256:…`) — always given, or Docker pulls every tag. */
  tag: string;
  /** The whole reference, for the audit log and the UI: `ghcr.io/org/app:1.2`. */
  reference: string;
}

/**
 * Validate what to pull against the Docker reference grammar and split it the
 * way `POST /images/create` wants. `tag` may be given separately (then the
 * image must not carry its own); without either, `latest`.
 */
export function pullTarget(image: string, tag?: string): PullTarget {
  const ref = parseImageReference(image.trim());
  if (!ref) throw new DockerError('Invalid image reference', 400);
  if (tag !== undefined && tag !== '') {
    if (!TAG_PATTERN.test(tag)) throw new DockerError('Invalid tag', 400);
    if (ref.tag || ref.digest) throw new DockerError('Give the tag either in the image or separately, not both', 400);
  }
  const fromImage = ref.domain ? `${ref.domain}/${ref.path}` : ref.path;
  const chosen = ref.digest ?? ref.tag ?? (tag || 'latest');
  const separator = ref.digest ? '@' : ':';
  return { fromImage, tag: chosen, reference: `${fromImage}${separator}${chosen}` };
}

/**
 * One line of `POST /images/create` output. A line with `error` means the pull
 * failed (the HTTP status was already 200 by then): returned as `{ error }`.
 */
export function toPullProgress(raw: Raw): DockerPullProgress | { error: string } {
  const error = str(raw.error) || str(obj(raw.errorDetail).message);
  if (error) return { error };
  const detail = obj(raw.progressDetail);
  return {
    id: str(raw.id) || null,
    status: str(raw.status),
    current: typeof detail.current === 'number' ? detail.current : null,
    total: typeof detail.total === 'number' ? detail.total : null,
  };
}

/** `DELETE /images/:id` answers `[{ Untagged }, { Deleted }]`. */
export function toImageRemoveResult(raw: unknown): DockerImageRemoveResult {
  const items = arr(raw).map(obj);
  return {
    untagged: items.map((i) => str(i.Untagged)).filter(Boolean),
    deleted: items.map((i) => str(i.Deleted)).filter(Boolean),
  };
}

/** Container states `docker container prune` removes. */
const STOPPED = new Set(['exited', 'created', 'dead']);
/** Networks Docker creates itself; prune never removes them. */
const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none']);
/** From Docker 23 (API 1.42), volume prune spares named volumes unless told otherwise. */
const ANONYMOUS_ONLY_API = '1.42';

function isDangling(image: Raw): boolean {
  const tags = arr(image.RepoTags).map(str);
  return tags.length === 0 || tags.every((t) => t === '<none>:<none>');
}

function isAnonymousVolume(volume: Raw): boolean {
  return 'com.docker.volume.anonymous' in obj(volume.Labels) || /^[0-9a-f]{64}$/.test(str(volume.Name));
}

/** Named volumes are pruned too by engines older than API 1.42. */
export function pruneIncludesNamedVolumes(apiVersion: string | null): boolean {
  return !!apiVersion && compareApiVersions(apiVersion, ANONYMOUS_ONLY_API) < 0;
}

/**
 * What a prune would remove, from `/system/df` and `/networks` (with
 * `/containers/json?all=1` to see which networks are in use). An estimate:
 * the daemon decides at prune time.
 */
export function toPrunePreview(df: Raw, networks: Raw[], networksInUse: Map<string, number>, apiVersion: string | null): DockerPrunePreview {
  const stopped = arr(df.Containers).map(obj).filter((c) => STOPPED.has(str(c.State)));
  const unused = arr(df.Images).map(obj).filter((i) => num(i.Containers) <= 0);
  const imageSize = (images: Raw[]) => images.reduce((sum, i) => sum + Math.max(0, num(i.Size) - Math.max(0, num(i.SharedSize))), 0);
  const dangling = unused.filter(isDangling);
  const includeNamed = pruneIncludesNamedVolumes(apiVersion);
  const volumes = arr(df.Volumes)
    .map(obj)
    .filter((v) => num(obj(v.UsageData).RefCount) === 0 && (includeNamed || isAnonymousVolume(v)));
  const idleNetworks = networks.filter((n) => {
    const name = str(n.Name);
    return !BUILTIN_NETWORKS.has(name) && str(n.Scope) !== 'swarm' && !(networksInUse.get(name) ?? 0);
  });
  return {
    containers: { count: stopped.length, size: stopped.reduce((sum, c) => sum + num(c.SizeRw), 0) },
    danglingImages: { count: dangling.length, size: imageSize(dangling) },
    unusedImages: { count: unused.length, size: imageSize(unused) },
    volumes: { count: volumes.length, size: volumes.reduce((sum, v) => sum + Math.max(0, num(obj(v.UsageData).Size)), 0) },
    volumesIncludeNamed: includeNamed,
    networks: { count: idleNetworks.length, size: null },
  };
}

/** The four prune answers (each null when not asked for) as one result. */
export function toPruneResult(parts: {
  containers?: Raw | null;
  images?: Raw | null;
  volumes?: Raw | null;
  networks?: Raw | null;
}): DockerPruneResult {
  const part = (raw: Raw | null | undefined, key: string) =>
    raw ? { deleted: arr(raw[key]).length, reclaimed: num(raw.SpaceReclaimed) } : null;
  const containers = part(parts.containers, 'ContainersDeleted');
  const images = part(parts.images, 'ImagesDeleted');
  const volumes = part(parts.volumes, 'VolumesDeleted');
  const networks = parts.networks ? { deleted: arr(parts.networks.NetworksDeleted).length } : null;
  return {
    containers,
    images,
    volumes,
    networks,
    reclaimed: (containers?.reclaimed ?? 0) + (images?.reclaimed ?? 0) + (volumes?.reclaimed ?? 0),
  };
}
