import { DockerError } from './errors.js';

/**
 * Checks for everything a client hands us that ends up in a daemon API path
 * or a remote command line. Path segments are also `encodeURIComponent`-ed
 * when the request is built; these checks keep nonsense and traversal out
 * before that, and give the caller a 400 that says what was wrong.
 */

/** Container names as Docker allows them — also covers full and short hex ids. */
export const CONTAINER_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

/** A full or short image/object id, optionally with its algorithm. */
export const IMAGE_ID_PATTERN = /^(?:sha256:)?[a-f0-9]{12,64}$/;

/** Volume and network names or ids follow the same rule as container names. */
export const OBJECT_NAME_PATTERN = CONTAINER_REF_PATTERN;

/** Unix socket paths: absolute, and plain characters only (they end up in a command line too). */
export const SOCKET_PATH_PATTERN = /^\/[A-Za-z0-9._/@+:-]{1,254}$/;

// The Docker reference grammar (distribution/reference), for image references.
const ALNUM = '[a-z0-9]+';
const SEPARATOR = '(?:[._]|__|-+)';
const PATH_COMPONENT = `${ALNUM}(?:${SEPARATOR}${ALNUM})*`;
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?`;
const TAG = '[\\w][\\w.-]{0,127}';
const DIGEST = '[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}';
const REFERENCE = new RegExp(
  `^(?:(${DOMAIN})/)?(${PATH_COMPONENT}(?:/${PATH_COMPONENT})*)(?::(${TAG}))?(?:@(${DIGEST}))?$`,
);
/** Longest repository name Docker accepts (domain and path). */
const MAX_NAME_LENGTH = 255;

export interface ImageReference {
  domain: string | null;
  path: string;
  tag: string | null;
  digest: string | null;
}

/** Split an image reference (`nginx`, `ghcr.io/org/app:1.2`, `app@sha256:…`), or null when it is not one. */
export function parseImageReference(ref: string): ImageReference | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 512) return null;
  const match = REFERENCE.exec(ref);
  if (!match) return null;
  const [, domain, path, tag, digest] = match;
  const name = domain ? `${domain}/${path}` : path!;
  if (name.length > MAX_NAME_LENGTH) return null;
  return { domain: domain ?? null, path: path!, tag: tag ?? null, digest: digest ?? null };
}

export function isValidImageReference(ref: string): boolean {
  return parseImageReference(ref) !== null;
}

function check(value: unknown, ok: (v: string) => boolean, what: string): string {
  if (typeof value !== 'string' || !ok(value)) throw new DockerError(`Invalid ${what}`, 400);
  return value;
}

/** A container name or id. */
export function containerRef(value: unknown): string {
  return check(value, (v) => CONTAINER_REF_PATTERN.test(v), 'container name or id');
}

/** An image id or reference. */
export function imageRef(value: unknown): string {
  return check(value, (v) => IMAGE_ID_PATTERN.test(v) || isValidImageReference(v), 'image id or reference');
}

/** A volume or network name or id. */
export function objectName(value: unknown, what = 'name'): string {
  return check(value, (v) => OBJECT_NAME_PATTERN.test(v), what);
}

export function isValidSocketPath(value: string): boolean {
  return SOCKET_PATH_PATTERN.test(value) && !value.split('/').includes('..');
}

/** An API path with each dynamic segment encoded: `apiPath('containers', id, 'json')`. */
export function apiPath(...segments: string[]): string {
  return `/${segments.map(encodeURIComponent).join('/')}`;
}

/**
 * An image API path: `/images/<ref>` plus `suffix` segments. References may
 * hold `/` (registry, namespace), so each part is encoded and the slashes kept.
 */
export function imageApiPath(ref: string, ...suffix: string[]): string {
  return `/images/${[...ref.split('/'), ...suffix].map(encodeURIComponent).join('/')}`;
}
