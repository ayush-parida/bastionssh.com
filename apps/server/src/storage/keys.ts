import { StorageError } from './errors.js';

/**
 * Object keys are not filesystem paths, but the browser treats `/` as a folder
 * separator, so the same hygiene applies: no empty or `.` segments, no `..`,
 * no null bytes.
 */
function splitSegments(input: string, what: string): string[] {
  if (input.includes('\0')) throw new StorageError(`${what} contains a null byte`, 400);
  const out: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new StorageError(`${what} must not contain ".." segments`, 400);
    out.push(segment);
  }
  return out;
}

/** A single object's key: no leading slash, never ends in `/`. */
export function normalizeKey(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new StorageError('Key is required', 400);
  }
  if (input.endsWith('/')) {
    throw new StorageError('Key must not end with "/" — that is a folder prefix', 400);
  }
  const segments = splitSegments(input, 'Key');
  if (segments.length === 0) throw new StorageError('Key is required', 400);
  return segments.join('/');
}

/** `''` for the bucket root, otherwise a normalized key plus a trailing `/`. */
export function normalizePrefix(input: string | undefined | null): string {
  if (input == null || input === '') return '';
  if (typeof input !== 'string') throw new StorageError('Prefix must be a string', 400);
  const segments = splitSegments(input, 'Prefix');
  return segments.length === 0 ? '' : `${segments.join('/')}/`;
}

export function parentPrefix(prefix: string): string | null {
  if (prefix === '') return null;
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx + 1);
}

export function baseName(keyOrPrefix: string): string {
  const trimmed = keyOrPrefix.endsWith('/') ? keyOrPrefix.slice(0, -1) : keyOrPrefix;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The S3 bucket naming rules — applied when *creating* a bucket. */
export function validateBucketName(name: string): string {
  if (typeof name !== 'string' || name.length < 3 || name.length > 63) {
    throw new StorageError('Bucket name must be 3–63 characters', 400);
  }
  if (!BUCKET_NAME.test(name)) {
    throw new StorageError(
      'Bucket name may only contain lowercase letters, digits, dots and hyphens, and must start and end with a letter or digit',
      400,
    );
  }
  if (name.includes('..')) throw new StorageError('Bucket name must not contain ".."', 400);
  if (IPV4.test(name)) throw new StorageError('Bucket name must not look like an IP address', 400);
  return name;
}

/**
 * The lighter check for a bucket name arriving in a URL. Some providers hold
 * legacy buckets that break the strict rules; refusing to *browse* them helps
 * nobody, so only what would break a request is ruled out.
 */
export function assertBucketParam(name: string): string {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 255 ||
    name.includes('/') ||
    name.includes('\0')
  ) {
    throw new StorageError('Invalid bucket name', 400);
  }
  return name;
}

/**
 * Same guard the webhook URL gets: http(s) only, no cloud metadata addresses.
 * A literal-match check, not a complete SSRF defence — a hostname that resolves
 * to a private address still passes, and it has to: MinIO on a LAN address is
 * the primary use case.
 */
export function assertSafeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StorageError('Endpoint is not a valid URL', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StorageError('Endpoint must use http or https', 400);
  }
  if (url.username || url.password) {
    throw new StorageError('Endpoint must not embed credentials', 400);
  }
  if (url.hostname === '169.254.169.254' || url.hostname === 'metadata.google.internal') {
    throw new StorageError('That address is not allowed', 400);
  }
  if (isAwsBucketUrl(url)) {
    throw new StorageError(
      'Endpoint looks like a bucket URL. Enter the S3 service endpoint (e.g. https://s3.ap-south-1.amazonaws.com) or leave it blank for AWS, then open the bucket by name',
      400,
    );
  }
  return url.toString().replace(/\/$/, '');
}

/** `<bucket>.s3[.-]…amazonaws.com` — a label before `s3` is a bucket name. */
const AWS_VIRTUAL_HOST = /^[^.]+\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i;

/**
 * A bucket's own URL pasted in as the endpoint sends every request to the
 * wrong place, yet ListBuckets still "succeeds" (S3 answers with the bucket's
 * object listing), so the connection test cannot catch it. Refuse it up front.
 */
function isAwsBucketUrl(url: URL): boolean {
  if (!url.hostname.toLowerCase().endsWith('.amazonaws.com')) return false;
  return AWS_VIRTUAL_HOST.test(url.hostname) || url.pathname.replace(/\/+$/, '') !== '';
}
