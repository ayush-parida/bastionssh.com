/** A storage failure that already knows which HTTP status it maps to. */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

const NOT_FOUND = new Set(['NoSuchBucket', 'NoSuchKey', 'NotFound', 'NoSuchUpload']);
const FORBIDDEN = new Set([
  'AccessDenied',
  'AllAccessDisabled',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AuthorizationHeaderMalformed',
  'InvalidToken',
  'ExpiredToken',
]);
const CONFLICT = new Set([
  'BucketNotEmpty',
  'BucketAlreadyExists',
  'BucketAlreadyOwnedByYou',
  'OperationAborted',
]);
const TIMEOUT = new Set(['TimeoutError', 'ETIMEDOUT', 'RequestTimeout']);
const UNREACHABLE = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'EPROTO',
  'ERR_INVALID_URL',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
]);

interface ErrorLike {
  name?: string;
  code?: string;
  message?: string;
  cause?: unknown;
  $metadata?: { httpStatusCode?: number };
}

interface Link {
  ids: string[];
  message: string | undefined;
}

/**
 * Walk the `cause` chain. Node often wraps the informative error ("connect
 * ECONNREFUSED …") inside a generic one, so each link keeps its own message.
 */
function chain(err: ErrorLike): Link[] {
  const out: Link[] = [];
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const e = current as ErrorLike;
    const ids: string[] = [];
    if (e.name) ids.push(e.name);
    if (e.code) ids.push(e.code);
    out.push({ ids, message: e.message?.trim() || undefined });
    current = e.cause;
  }
  return out;
}

/**
 * Turn whatever the S3 client threw into a StorageError with an HTTP status a
 * route can send as-is. The provider's own message is kept so the user sees the
 * real reason; only the status is ours.
 */
export function toStorageError(err: unknown, fallback = 'Storage request failed'): StorageError {
  if (err instanceof StorageError) return err;
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  const links = chain(e);
  const topMessage = links[0]?.message ?? fallback;
  /** The message of the first link carrying an id from `set`, else undefined. */
  const find = (set: Set<string>) => links.find((l) => l.ids.some((id) => set.has(id)));

  if (find(NOT_FOUND)) return new StorageError(topMessage, 404);
  if (find(FORBIDDEN)) return new StorageError(topMessage, 403);
  if (links.some((l) => l.ids.includes('BucketNotEmpty'))) {
    return new StorageError(
      'Bucket is not empty — delete its contents first (a versioned bucket must also have its object versions removed)',
      409,
    );
  }
  if (find(CONFLICT)) return new StorageError(topMessage, 409);

  const timeout = find(TIMEOUT);
  if (timeout) {
    return new StorageError(`Storage request timed out: ${timeout.message ?? topMessage}`, 504);
  }
  const unreachable = find(UNREACHABLE);
  if (unreachable) {
    return new StorageError(
      `Could not reach storage endpoint: ${unreachable.message ?? topMessage}`,
      502,
    );
  }

  const status = e.$metadata?.httpStatusCode;
  if (status && status >= 400 && status < 500) return new StorageError(topMessage, status);
  return new StorageError(topMessage, 502);
}
