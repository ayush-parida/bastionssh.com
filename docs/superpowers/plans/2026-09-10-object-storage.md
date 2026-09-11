# Object Storage (S3 / MinIO) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users register S3-compatible storage connections (AWS S3, MinIO, others), then list/create/delete buckets and browse/upload/download/rename/delete objects from the web UI.

**Architecture:** A new `apps/server/src/storage/` module wraps the AWS SDK v3 S3 client (pure key/prefix helpers, error mapping, thin async ops). A new `api/routes/storage.ts` exposes it under `/api/storage`, scoped to the caller's org, role-gated like SFTP, and audited. The web app adds three pages under `/storage`.

**Tech Stack:** Fastify 5, Drizzle (SQLite), zod, vitest, `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` (already added to `apps/server/package.json`), React 18 + react-query 5 + Tailwind, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-10-object-storage-design.md`

## Global Constraints

- Node ≥ 20, pnpm 9, ESM everywhere; server imports use `.js` suffixes.
- Secrets go through `vault.encrypt(value, rowId)` and never leave the server.
- Roles: viewer reads; operator writes objects; admin manages connections and buckets. Enforce with `requireRole` server-side; hide with `useHasRole` client-side.
- Client config must set `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'`, `followRegionRedirects: true`.
- Upload cap: `SMT_STORAGE_MAX_UPLOAD_BYTES`, default `5_368_709_120` (5 GiB).
- Listing page size: 500. Batch delete size: 1000.
- Audit action names: `storage_connection.create|update|delete|test`, `storage.bucket_create`, `storage.bucket_delete`, `storage.list|download|upload|mkdir|rename|delete`.
- Tests: `cd apps/server && pnpm vitest run <file>`; typecheck: `pnpm -r run typecheck` from the repo root.

---

## File map

| Path | Responsibility |
| --- | --- |
| `packages/shared/src/types/storage.ts` (create) | Wire types shared by server and web. |
| `packages/shared/src/index.ts` (modify) | Export the new types. |
| `packages/shared/src/types/audit.ts` (modify) | New `AuditAction` members. |
| `apps/server/src/storage/errors.ts` (create) | `StorageError`, `toStorageError`. |
| `apps/server/src/storage/keys.ts` (create) | Key/prefix/bucket-name/endpoint helpers. |
| `apps/server/src/storage/client.ts` (create) | `buildClientConfig`, `createClient`. |
| `apps/server/src/storage/ops.ts` (create) | SDK command wrappers + pure `toListing`, `copySource`, `isBatchDeleteUnsupported`. |
| `apps/server/src/storage/index.ts` (create) | Re-exports, `resolveConnection`, `evictConnection`. |
| `apps/server/src/db/schema.ts` (modify) | `storageConnections` table. |
| `apps/server/src/db/migrations/0004_add_storage_connections.sql` + `meta/_journal.json` | Migration. |
| `apps/server/src/config/index.ts` (modify) | `storageMaxUploadBytes`. |
| `apps/server/src/api/routes/storage.ts` (create) | HTTP surface. |
| `apps/server/src/api/app.ts` (modify) | Register routes. |
| `apps/web/src/lib/api.ts` (modify) | Generic `upload<T>`. |
| `apps/web/src/pages/Storage.tsx`, `StorageBuckets.tsx`, `StorageObjects.tsx` (create) | UI. |
| `apps/web/src/App.tsx`, `components/layout/Layout.tsx` (modify) | Routes + nav. |
| `.env.example`, `README.md`, `docs/ARCHITECTURE.md` (modify) | Docs. |

---

### Task 1: Shared types and audit actions

**Files:**
- Create: `packages/shared/src/types/storage.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/types/audit.ts`

**Interfaces:**
- Produces: every type below, imported by later tasks as `import type { … } from '@smt/shared'`.

- [x] **Step 1: Create the types file**

```ts
// packages/shared/src/types/storage.ts
/** A hint for form defaults only — every provider speaks the same S3 API. */
export type StorageProvider = 's3' | 'minio' | 'other';

export type StorageTestStatus = 'ok' | 'failed';

export interface StorageConnection {
  id: string;
  orgId: string;
  name: string;
  provider: StorageProvider;
  /** null means AWS's regional endpoint for `region`. */
  endpoint: string | null;
  region: string;
  accessKeyId: string;
  /** Path-style addressing (`host/bucket/key`); MinIO needs it, AWS prefers virtual-host style. */
  forcePathStyle: boolean;
  /** Result of the last "Test connection", if any. */
  lastStatus: StorageTestStatus | null;
  lastError: string | null;
  lastTestedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** secretAccessKey is never returned to the client */
}

export interface CreateStorageConnectionRequest {
  name: string;
  provider?: StorageProvider;
  /** Required unless provider is `s3`. */
  endpoint?: string | null;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Defaults to true for minio/other, false for s3. */
  forcePathStyle?: boolean;
}

export interface UpdateStorageConnectionRequest {
  name?: string;
  provider?: StorageProvider;
  endpoint?: string | null;
  region?: string;
  accessKeyId?: string;
  /** Omit to keep the stored secret. */
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export interface StorageTestResult {
  ok: boolean;
  error?: string;
  bucketCount?: number;
}

export interface StorageBucket {
  name: string;
  createdAt: string | null;
}

export interface StorageCreateBucketRequest {
  name: string;
}

/** A "folder" is a common prefix — it may or may not have a zero-byte marker object. */
export interface StorageFolder {
  name: string;
  /** Always ends with `/`. */
  prefix: string;
}

export interface StorageObject {
  name: string;
  key: string;
  size: number;
  modifiedAt: string | null;
  etag: string | null;
  storageClass: string | null;
}

export interface StorageListResponse {
  bucket: string;
  /** `''` at the bucket root, otherwise ends with `/`. */
  prefix: string;
  /** Parent prefix, or null at the bucket root. */
  parent: string | null;
  folders: StorageFolder[];
  objects: StorageObject[];
  /** Pass back as `token` to fetch the next page. */
  nextToken: string | null;
  truncated: boolean;
}

export interface StorageCreateFolderRequest {
  /** Trailing slash optional. */
  prefix: string;
}

export interface StorageRenameRequest {
  from: string;
  to: string;
}

export interface StorageUploadResponse {
  bucket: string;
  key: string;
  size: number;
}

export interface StorageDeleteBucketResponse {
  bucket: string;
  /** Objects removed before the bucket itself, when `force` was set. */
  deletedObjects: number;
}
```

- [x] **Step 2: Export it and add audit actions**

In `packages/shared/src/index.ts` add `export * from './types/storage.js';` after the `sftp` line.

In `packages/shared/src/types/audit.ts`, append to the `AuditAction` union (before the final `;`):

```ts
  | 'storage_connection.create'
  | 'storage_connection.update'
  | 'storage_connection.delete'
  | 'storage_connection.test'
  | 'storage.bucket_create'
  | 'storage.bucket_delete'
  | 'storage.list'
  | 'storage.download'
  | 'storage.upload'
  | 'storage.mkdir'
  | 'storage.rename'
  | 'storage.delete'
```

- [x] **Step 3: Typecheck**

Run: `pnpm --filter @smt/shared run typecheck`
Expected: no errors.

- [x] **Step 4: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): object storage types and audit actions"
```

---

### Task 2: Storage errors and key helpers (TDD)

**Files:**
- Create: `apps/server/src/storage/errors.ts`
- Create: `apps/server/src/storage/keys.ts`
- Test: `apps/server/src/storage/errors.test.ts`, `apps/server/src/storage/keys.test.ts`

**Interfaces:**
- Produces: `StorageError(message, statusCode)`, `toStorageError(err, fallback?)`, `normalizeKey(input): string`, `normalizePrefix(input?): string`, `parentPrefix(prefix): string | null`, `baseName(keyOrPrefix): string`, `validateBucketName(name): string`, `assertBucketParam(name): string`, `assertSafeEndpoint(raw): string`.

- [x] **Step 1: Write the failing error tests**

```ts
// apps/server/src/storage/errors.test.ts
import { describe, it, expect } from 'vitest';
import { StorageError, toStorageError } from './errors.js';

function sdkError(name: string, httpStatusCode?: number, message = `${name} happened`) {
  const err = new Error(message);
  err.name = name;
  (err as Error & { $metadata?: unknown }).$metadata = { httpStatusCode };
  return err;
}

describe('toStorageError', () => {
  it('passes an existing StorageError through untouched', () => {
    const original = new StorageError('nope', 418);
    expect(toStorageError(original)).toBe(original);
  });

  it('maps missing buckets and keys to 404', () => {
    expect(toStorageError(sdkError('NoSuchBucket', 404)).statusCode).toBe(404);
    expect(toStorageError(sdkError('NoSuchKey', 404)).statusCode).toBe(404);
    expect(toStorageError(sdkError('NotFound', 404)).statusCode).toBe(404);
  });

  it('maps credential problems to 403', () => {
    for (const name of ['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch']) {
      expect(toStorageError(sdkError(name, 403)).statusCode).toBe(403);
    }
  });

  it('maps bucket conflicts to 409 and explains a non-empty bucket', () => {
    expect(toStorageError(sdkError('BucketAlreadyExists', 409)).statusCode).toBe(409);
    const notEmpty = toStorageError(sdkError('BucketNotEmpty', 409));
    expect(notEmpty.statusCode).toBe(409);
    expect(notEmpty.message).toMatch(/not empty/i);
  });

  it('maps network failures to 502 even when Node hides the code in `cause`', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), { code: 'ECONNREFUSED' });
    const outer = new Error('request failed', { cause: inner });
    const mapped = toStorageError(outer);
    expect(mapped.statusCode).toBe(502);
    expect(mapped.message).toContain('ECONNREFUSED');
  });

  it('maps timeouts to 504', () => {
    expect(toStorageError(sdkError('TimeoutError')).statusCode).toBe(504);
  });

  it('keeps an unrecognised 4xx status from the provider', () => {
    expect(toStorageError(sdkError('InvalidRequest', 400)).statusCode).toBe(400);
  });

  it('treats anything else as an upstream failure', () => {
    expect(toStorageError(sdkError('InternalError', 500)).statusCode).toBe(502);
    expect(toStorageError(new Error('boom')).statusCode).toBe(502);
    expect(toStorageError(undefined, 'fallback text').message).toBe('fallback text');
  });
});
```

- [x] **Step 2: Write the failing key tests**

```ts
// apps/server/src/storage/keys.test.ts
import { describe, it, expect } from 'vitest';
import { StorageError } from './errors.js';
import {
  assertBucketParam,
  assertSafeEndpoint,
  baseName,
  normalizeKey,
  normalizePrefix,
  parentPrefix,
  validateBucketName,
} from './keys.js';

describe('normalizeKey', () => {
  it('keeps a plain key', () => {
    expect(normalizeKey('docs/readme.md')).toBe('docs/readme.md');
  });

  it('strips a leading slash and collapses empty or dot segments', () => {
    expect(normalizeKey('/docs//./readme.md')).toBe('docs/readme.md');
  });

  it('rejects traversal, trailing slashes, empty input and null bytes', () => {
    expect(() => normalizeKey('docs/../secret')).toThrow(StorageError);
    expect(() => normalizeKey('docs/')).toThrow(StorageError);
    expect(() => normalizeKey('')).toThrow(StorageError);
    expect(() => normalizeKey('/')).toThrow(StorageError);
    expect(() => normalizeKey('a\0b')).toThrow(StorageError);
  });

  it('reports a 400 for bad input', () => {
    expect.assertions(1);
    try {
      normalizeKey('../x');
    } catch (err) {
      expect((err as StorageError).statusCode).toBe(400);
    }
  });
});

describe('normalizePrefix', () => {
  it('treats empty, undefined and "/" as the bucket root', () => {
    expect(normalizePrefix('')).toBe('');
    expect(normalizePrefix(undefined)).toBe('');
    expect(normalizePrefix('/')).toBe('');
  });

  it('always ends a non-root prefix with a slash', () => {
    expect(normalizePrefix('docs')).toBe('docs/');
    expect(normalizePrefix('docs/')).toBe('docs/');
    expect(normalizePrefix('/docs//2024/')).toBe('docs/2024/');
  });

  it('rejects traversal', () => {
    expect(() => normalizePrefix('docs/../')).toThrow(StorageError);
  });
});

describe('parentPrefix', () => {
  it('returns null at the root', () => {
    expect(parentPrefix('')).toBeNull();
  });

  it('walks up one level, landing on the root as ""', () => {
    expect(parentPrefix('docs/2024/')).toBe('docs/');
    expect(parentPrefix('docs/')).toBe('');
  });
});

describe('baseName', () => {
  it('returns the last segment of a key or prefix', () => {
    expect(baseName('docs/2024/report.pdf')).toBe('report.pdf');
    expect(baseName('docs/2024/')).toBe('2024');
    expect(baseName('report.pdf')).toBe('report.pdf');
    expect(baseName('')).toBe('');
  });
});

describe('validateBucketName', () => {
  it('accepts DNS-compatible names', () => {
    expect(validateBucketName('my-bucket')).toBe('my-bucket');
    expect(validateBucketName('logs.2024')).toBe('logs.2024');
    expect(validateBucketName('abc')).toBe('abc');
  });

  it('rejects names S3 would refuse', () => {
    for (const bad of ['ab', 'A'.repeat(3), 'My-Bucket', '-lead', 'trail-', 'a..b', '192.168.0.1', 'x'.repeat(64), 'sp ace']) {
      expect(() => validateBucketName(bad), bad).toThrow(StorageError);
    }
  });
});

describe('assertBucketParam', () => {
  it('only rules out what would break a URL or a request', () => {
    expect(assertBucketParam('Legacy_Bucket')).toBe('Legacy_Bucket');
    expect(() => assertBucketParam('')).toThrow(StorageError);
    expect(() => assertBucketParam('a/b')).toThrow(StorageError);
    expect(() => assertBucketParam('a\0b')).toThrow(StorageError);
  });
});

describe('assertSafeEndpoint', () => {
  it('accepts http and https and trims a trailing slash', () => {
    expect(assertSafeEndpoint('http://minio.local:9000/')).toBe('http://minio.local:9000');
    expect(assertSafeEndpoint('https://s3.wasabisys.com')).toBe('https://s3.wasabisys.com');
  });

  it('rejects other schemes, embedded credentials, and metadata addresses', () => {
    expect(() => assertSafeEndpoint('ftp://minio.local')).toThrow(StorageError);
    expect(() => assertSafeEndpoint('not a url')).toThrow(StorageError);
    expect(() => assertSafeEndpoint('http://user:pass@minio.local')).toThrow(StorageError);
    expect(() => assertSafeEndpoint('http://169.254.169.254/latest')).toThrow(StorageError);
    expect(() => assertSafeEndpoint('http://metadata.google.internal')).toThrow(StorageError);
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `cd apps/server && pnpm vitest run src/storage/errors.test.ts src/storage/keys.test.ts`
Expected: FAIL — cannot resolve `./errors.js` / `./keys.js`.

- [x] **Step 4: Implement `errors.ts`**

```ts
// apps/server/src/storage/errors.ts
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
const TIMEOUT = new Set(['TimeoutError', 'ETIMEDOUT', 'RequestTimeout', 'AbortError']);
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

/** Every identifier the SDK — or Node underneath it — may have hung on this error. */
function identifiers(err: ErrorLike): string[] {
  const out: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const e = current as ErrorLike;
    if (e.name) out.push(e.name);
    if (e.code) out.push(e.code);
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
  const ids = identifiers(e);
  const has = (set: Set<string>) => ids.some((id) => set.has(id));
  const message = e.message?.trim() || fallback;

  if (has(NOT_FOUND)) return new StorageError(message, 404);
  if (has(FORBIDDEN)) return new StorageError(message, 403);
  if (ids.includes('BucketNotEmpty')) {
    return new StorageError(
      'Bucket is not empty — delete its contents first (a versioned bucket must also have its object versions removed)',
      409,
    );
  }
  if (has(CONFLICT)) return new StorageError(message, 409);
  if (has(TIMEOUT)) return new StorageError(`Storage request timed out: ${message}`, 504);
  if (has(UNREACHABLE)) return new StorageError(`Could not reach storage endpoint: ${message}`, 502);

  const status = e.$metadata?.httpStatusCode;
  if (status && status >= 400 && status < 500) return new StorageError(message, status);
  return new StorageError(message, 502);
}
```

- [x] **Step 5: Implement `keys.ts`**

```ts
// apps/server/src/storage/keys.ts
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

/** Same guard the webhook URL gets: http(s) only, no cloud metadata addresses. */
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
  return url.toString().replace(/\/$/, '');
}
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `cd apps/server && pnpm vitest run src/storage/errors.test.ts src/storage/keys.test.ts`
Expected: PASS (all).

- [x] **Step 7: Commit**

```bash
git add apps/server/src/storage/errors.ts apps/server/src/storage/errors.test.ts apps/server/src/storage/keys.ts apps/server/src/storage/keys.test.ts
git commit -m "feat(storage): error mapping and key helpers"
```

---

### Task 3: Client config and ops (TDD on the pure parts)

**Files:**
- Create: `apps/server/src/storage/client.ts`
- Create: `apps/server/src/storage/ops.ts`
- Test: `apps/server/src/storage/client.test.ts`, `apps/server/src/storage/ops.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers.
- Produces: `StorageTarget`, `buildClientConfig(target, secret): S3ClientConfig`, `createClient(target, secret): S3Client`, `DEFAULT_REGION`; from ops: `PAGE_SIZE`, `listBuckets(client)`, `testConnection(client)`, `createBucket(client, bucket, region)`, `deleteBucket(client, bucket)`, `listObjects(client, bucket, prefix, token?)`, `toListing(bucket, prefix, out)`, `getObject(client, bucket, key): Promise<ObjectStream>`, `putObject(client, bucket, key, body, contentType?)`, `createFolder(client, bucket, prefix)`, `deleteObject(client, bucket, key)`, `copySource(bucket, key)`, `copyObject`, `renameObject(client, bucket, from, to)`, `isBatchDeleteUnsupported(err)`, `deleteKeys(client, bucket, keys)`, `deletePrefix(client, bucket, prefix): Promise<number>`.

- [x] **Step 1: Write the failing client-config test**

```ts
// apps/server/src/storage/client.test.ts
import { describe, it, expect } from 'vitest';
import { buildClientConfig, type StorageTarget } from './client.js';

const minio: StorageTarget = {
  provider: 'minio',
  endpoint: 'http://minio.local:9000',
  region: 'us-east-1',
  accessKeyId: 'AKIA',
  forcePathStyle: true,
};

describe('buildClientConfig', () => {
  it('points at a custom endpoint with path-style addressing', () => {
    const cfg = buildClientConfig(minio, 'secret');
    expect(cfg.endpoint).toBe('http://minio.local:9000');
    expect(cfg.forcePathStyle).toBe(true);
    expect(cfg.credentials).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 'secret' });
  });

  it('omits the endpoint for AWS so the SDK derives it from the region', () => {
    const cfg = buildClientConfig({ ...minio, provider: 's3', endpoint: null, region: 'eu-west-1', forcePathStyle: false }, 's');
    expect(cfg).not.toHaveProperty('endpoint');
    expect(cfg.region).toBe('eu-west-1');
    expect(cfg.forcePathStyle).toBe(false);
  });

  it('falls back to us-east-1 when the region is blank', () => {
    expect(buildClientConfig({ ...minio, region: '  ' }, 's').region).toBe('us-east-1');
  });

  it('only checksums when the operation demands it, and follows region redirects', () => {
    const cfg = buildClientConfig(minio, 's');
    expect(cfg.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(cfg.responseChecksumValidation).toBe('WHEN_REQUIRED');
    expect(cfg.followRegionRedirects).toBe(true);
  });
});
```

- [x] **Step 2: Write the failing ops tests (pure functions only)**

```ts
// apps/server/src/storage/ops.test.ts
import { describe, it, expect } from 'vitest';
import { StorageError } from './errors.js';
import { copySource, isBatchDeleteUnsupported, toListing } from './ops.js';

describe('toListing', () => {
  it('turns common prefixes into folders and contents into objects', () => {
    const listing = toListing('media', 'photos/', {
      CommonPrefixes: [{ Prefix: 'photos/2024/' }, { Prefix: 'photos/raw/' }],
      Contents: [
        { Key: 'photos/', Size: 0 },
        { Key: 'photos/cat.jpg', Size: 1234, LastModified: new Date('2026-01-02T03:04:05Z'), ETag: '"abc"', StorageClass: 'STANDARD' },
      ],
      NextContinuationToken: 'tok',
      IsTruncated: true,
    });

    expect(listing.bucket).toBe('media');
    expect(listing.prefix).toBe('photos/');
    expect(listing.parent).toBe('');
    expect(listing.folders).toEqual([
      { name: '2024', prefix: 'photos/2024/' },
      { name: 'raw', prefix: 'photos/raw/' },
    ]);
    // The folder marker for the prefix itself is not an entry
    expect(listing.objects).toEqual([
      { name: 'cat.jpg', key: 'photos/cat.jpg', size: 1234, modifiedAt: '2026-01-02T03:04:05.000Z', etag: '"abc"', storageClass: 'STANDARD' },
    ]);
    expect(listing.nextToken).toBe('tok');
    expect(listing.truncated).toBe(true);
  });

  it('handles an empty root listing', () => {
    const listing = toListing('media', '', {});
    expect(listing).toEqual({ bucket: 'media', prefix: '', parent: null, folders: [], objects: [], nextToken: null, truncated: false });
  });

  it('fills in defaults for sparse objects', () => {
    const listing = toListing('b', '', { Contents: [{ Key: 'x' }] });
    expect(listing.objects[0]).toEqual({ name: 'x', key: 'x', size: 0, modifiedAt: null, etag: null, storageClass: null });
  });
});

describe('copySource', () => {
  it('percent-encodes each segment but keeps the slashes', () => {
    expect(copySource('media', 'photos/my cat #1.jpg')).toBe('media/photos/my%20cat%20%231.jpg');
  });
});

describe('isBatchDeleteUnsupported', () => {
  it('recognises a provider that wants Content-MD5 or rejects checksum headers', () => {
    expect(isBatchDeleteUnsupported(new StorageError('Missing required header for this request: Content-Md5', 400))).toBe(true);
    expect(isBatchDeleteUnsupported(new StorageError('x-amz-checksum-crc32 not supported', 400))).toBe(true);
  });

  it('does not swallow other failures', () => {
    expect(isBatchDeleteUnsupported(new StorageError('Access Denied', 403))).toBe(false);
    expect(isBatchDeleteUnsupported(new StorageError('Bad Request', 400))).toBe(false);
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `cd apps/server && pnpm vitest run src/storage/client.test.ts src/storage/ops.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 4: Implement `client.ts`**

```ts
// apps/server/src/storage/client.ts
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { StorageProvider } from '@smt/shared';

export interface StorageTarget {
  provider: StorageProvider;
  /** null = AWS's regional endpoint */
  endpoint: string | null;
  region: string;
  accessKeyId: string;
  forcePathStyle: boolean;
}

export const DEFAULT_REGION = 'us-east-1';
export const CONNECT_TIMEOUT_MS = 10_000;
/** Socket inactivity — a healthy transfer keeps resetting it, a hung request does not. */
export const REQUEST_TIMEOUT_MS = 30_000;

export function buildClientConfig(target: StorageTarget, secretAccessKey: string): S3ClientConfig {
  return {
    region: target.region.trim() || DEFAULT_REGION,
    ...(target.endpoint ? { endpoint: target.endpoint } : {}),
    forcePathStyle: target.forcePathStyle,
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey },
    // SDK ≥ 3.729 defaults to CRC32 trailers on every upload, which older MinIO
    // releases and several third-party providers reject. Only checksum when the
    // operation itself demands it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // A connection pinned to one AWS region can still browse a bucket in another.
    followRegionRedirects: true,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  };
}

export function createClient(target: StorageTarget, secretAccessKey: string): S3Client {
  return new S3Client(buildClientConfig(target, secretAccessKey));
}
```

- [x] **Step 5: Implement `ops.ts`**

```ts
// apps/server/src/storage/ops.ts
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type BucketLocationConstraint,
  type ListObjectsV2CommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';
import type { StorageBucket, StorageListResponse, StorageTestResult } from '@smt/shared';
import { DEFAULT_REGION } from './client.js';
import { StorageError, toStorageError } from './errors.js';
import { baseName, parentPrefix } from './keys.js';

export const PAGE_SIZE = 500;
const DELETE_BATCH = 1000;
const PART_SIZE = 8 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 3;
const SINGLE_DELETE_CONCURRENCY = 8;

/** Every SDK call goes through here so routes only ever see a StorageError. */
async function run<T>(fallback: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toStorageError(err, fallback);
  }
}

// ── Buckets ──────────────────────────────────────────────────────────────────

export function listBuckets(client: S3Client): Promise<StorageBucket[]> {
  return run('Could not list buckets', async () => {
    const out = await client.send(new ListBucketsCommand({}));
    return (out.Buckets ?? [])
      .flatMap((b) =>
        b.Name ? [{ name: b.Name, createdAt: b.CreationDate?.toISOString() ?? null }] : [],
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** A ListBuckets round-trip proves endpoint, credentials and signing all line up. */
export async function testConnection(client: S3Client): Promise<StorageTestResult> {
  try {
    const buckets = await listBuckets(client);
    return { ok: true, bucketCount: buckets.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createBucket(client: S3Client, bucket: string, region: string): Promise<void> {
  return run('Could not create bucket', async () => {
    await client.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // S3 rejects a LocationConstraint of us-east-1 and requires one everywhere else.
        ...(region && region !== DEFAULT_REGION
          ? { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }
          : {}),
      }),
    );
  });
}

export function deleteBucket(client: S3Client, bucket: string): Promise<void> {
  return run('Could not delete bucket', async () => {
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  });
}

// ── Listing ──────────────────────────────────────────────────────────────────

type ListPage = Pick<
  ListObjectsV2CommandOutput,
  'CommonPrefixes' | 'Contents' | 'NextContinuationToken' | 'IsTruncated'
>;

/** Shape one ListObjectsV2 page into what the browser renders. Pure. */
export function toListing(bucket: string, prefix: string, out: ListPage): StorageListResponse {
  const folders = (out.CommonPrefixes ?? []).flatMap((p) =>
    p.Prefix ? [{ name: baseName(p.Prefix), prefix: p.Prefix }] : [],
  );
  const objects = (out.Contents ?? []).flatMap((o) => {
    // The zero-byte marker for the prefix itself is a folder, not a file in it
    if (!o.Key || o.Key === prefix) return [];
    return [
      {
        name: baseName(o.Key),
        key: o.Key,
        size: o.Size ?? 0,
        modifiedAt: o.LastModified?.toISOString() ?? null,
        etag: o.ETag ?? null,
        storageClass: o.StorageClass ?? null,
      },
    ];
  });
  return {
    bucket,
    prefix,
    parent: parentPrefix(prefix),
    folders,
    objects,
    nextToken: out.NextContinuationToken ?? null,
    truncated: out.IsTruncated ?? false,
  };
}

export function listObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  token?: string,
): Promise<StorageListResponse> {
  return run('Could not list objects', async () => {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        Delimiter: '/',
        MaxKeys: PAGE_SIZE,
        ContinuationToken: token || undefined,
      }),
    );
    return toListing(bucket, prefix, out);
  });
}

// ── Objects ──────────────────────────────────────────────────────────────────

export interface ObjectStream {
  body: Readable;
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
}

export function getObject(client: S3Client, bucket: string, key: string): Promise<ObjectStream> {
  return run('Could not download object', async () => {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) throw new StorageError('Object has no body', 502);
    return {
      // In Node the SDK body is an IncomingMessage with stream mixins — a Readable
      body: out.Body as unknown as Readable,
      contentType: out.ContentType ?? null,
      contentLength: out.ContentLength ?? null,
      lastModified: out.LastModified?.toISOString() ?? null,
    };
  });
}

/** Streams straight through: single PUT below one part, multipart above it. */
export function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable,
  contentType?: string,
): Promise<void> {
  return run('Could not upload object', async () => {
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      },
      partSize: PART_SIZE,
      queueSize: UPLOAD_CONCURRENCY,
      leavePartsOnError: false,
    });
    await upload.done();
  });
}

/** The console convention: a zero-byte object whose key is the prefix. */
export function createFolder(client: S3Client, bucket: string, prefix: string): Promise<void> {
  return run('Could not create folder', async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: prefix, Body: '', ContentLength: 0 }));
  });
}

export function deleteObject(client: S3Client, bucket: string, key: string): Promise<void> {
  return run('Could not delete object', async () => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  });
}

/** S3 wants the copy source URL-encoded — each segment, slashes kept. */
export function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function copyObject(client: S3Client, bucket: string, from: string, to: string): Promise<void> {
  return run('Could not copy object', async () => {
    await client.send(
      new CopyObjectCommand({ Bucket: bucket, CopySource: copySource(bucket, from), Key: to }),
    );
  });
}

/** S3 has no rename: copy, then delete the original. */
export async function renameObject(
  client: S3Client,
  bucket: string,
  from: string,
  to: string,
): Promise<void> {
  if (from === to) return;
  await copyObject(client, bucket, from, to);
  await deleteObject(client, bucket, from);
}

// ── Bulk delete ──────────────────────────────────────────────────────────────

/** Providers that predate S3's flexible checksums reject DeleteObjects outright. */
export function isBatchDeleteUnsupported(err: StorageError): boolean {
  return err.statusCode === 400 && /content-?md5|checksum/i.test(err.message);
}

async function deleteBatch(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  const out = await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  const failed = out.Errors?.[0];
  if (failed) {
    throw new StorageError(
      `Could not delete ${failed.Key ?? 'object'}: ${failed.Message ?? failed.Code ?? 'unknown error'}`,
      502,
    );
  }
}

async function deleteOneByOne(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += SINGLE_DELETE_CONCURRENCY) {
    await Promise.all(
      keys.slice(i, i + SINGLE_DELETE_CONCURRENCY).map((key) => deleteObject(client, bucket, key)),
    );
  }
}

export async function deleteKeys(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await run('Could not delete objects', () => deleteBatch(client, bucket, keys));
  } catch (err) {
    if (err instanceof StorageError && isBatchDeleteUnsupported(err)) {
      return deleteOneByOne(client, bucket, keys);
    }
    throw err;
  }
}

/**
 * Delete every object under a prefix — `''` empties the whole bucket. Pages
 * with a continuation token rather than re-listing from the top, so a delete
 * that silently does nothing cannot loop forever. Returns the number removed.
 */
export async function deletePrefix(client: S3Client, bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await run('Could not list objects', () =>
      client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix || undefined,
          MaxKeys: DELETE_BATCH,
          ContinuationToken: token,
        }),
      ),
    );
    const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : []));
    await deleteKeys(client, bucket, keys);
    deleted += keys.length;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `cd apps/server && pnpm vitest run src/storage/client.test.ts src/storage/ops.test.ts`
Expected: PASS.

- [x] **Step 7: Typecheck the server**

Run: `pnpm --filter @smt/server run typecheck`
Expected: no errors (in particular, `requestHandler` object form and `BucketLocationConstraint` cast compile).

- [x] **Step 8: Commit**

```bash
git add apps/server/src/storage
git commit -m "feat(storage): S3 client config and operations"
```

---

### Task 4: Schema, migration, config, and connection resolver

**Files:**
- Modify: `apps/server/src/db/schema.ts` (append before the Audit Log section)
- Create: `apps/server/src/db/migrations/0004_add_storage_connections.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Modify: `apps/server/src/config/index.ts`
- Create: `apps/server/src/storage/index.ts`

**Interfaces:**
- Produces: `storageConnections` table; `config.storageMaxUploadBytes`; `resolveConnection(orgId, id): Promise<{ connection, client }>`; `evictConnection(id)`; `StorageConnectionRow`; re-exports of errors/keys and `ops` namespace.

- [x] **Step 1: Add the table to `schema.ts`** (after the Notification Channels section)

```ts
// ── Object Storage ───────────────────────────────────────────────────────────

/** An S3-compatible endpoint plus one access-key pair. Covers AWS S3, MinIO, and friends. */
export const storageConnections = sqliteTable(
  'storage_connections',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull().default('s3'), // s3 | minio | other
    endpoint: text('endpoint'), // null = AWS regional endpoint
    region: text('region').notNull().default('us-east-1'),
    accessKeyId: text('access_key_id').notNull(),
    encryptedSecretAccessKey: text('encrypted_secret_access_key').notNull(),
    forcePathStyle: integer('force_path_style', { mode: 'boolean' }).notNull().default(false),
    lastStatus: text('last_status'), // ok | failed
    lastError: text('last_error'),
    lastTestedAt: text('last_tested_at'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    orgIdx: index('storage_connections_org_idx').on(t.orgId),
  }),
);
```

- [x] **Step 2: Write the migration**

```sql
-- apps/server/src/db/migrations/0004_add_storage_connections.sql
CREATE TABLE `storage_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text DEFAULT 's3' NOT NULL,
	`endpoint` text,
	`region` text DEFAULT 'us-east-1' NOT NULL,
	`access_key_id` text NOT NULL,
	`encrypted_secret_access_key` text NOT NULL,
	`force_path_style` integer DEFAULT false NOT NULL,
	`last_status` text,
	`last_error` text,
	`last_tested_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `storage_connections_org_idx` ON `storage_connections` (`org_id`);
```

Append to `meta/_journal.json` `entries`:

```json
    {
      "idx": 4,
      "version": "6",
      "when": 1777200000000,
      "tag": "0004_add_storage_connections",
      "breakpoints": true
    }
```

- [x] **Step 3: Add the config knob**

In `envSchema`, after `SMT_SFTP_MAX_UPLOAD_BYTES`:

```ts
  SMT_STORAGE_MAX_UPLOAD_BYTES: z.coerce.number().default(5_368_709_120), // 5 GiB
```

In `config`, after `sftpMaxUploadBytes`:

```ts
  storageMaxUploadBytes: env.SMT_STORAGE_MAX_UPLOAD_BYTES,
```

- [x] **Step 4: Create `storage/index.ts`**

```ts
// apps/server/src/storage/index.ts
import { and, eq } from 'drizzle-orm';
import type { S3Client } from '@aws-sdk/client-s3';
import type { StorageProvider } from '@smt/shared';
import { getDb } from '../db/index.js';
import { storageConnections } from '../db/schema.js';
import { vault } from '../vault/index.js';
import { createClient } from './client.js';
import { StorageError } from './errors.js';

export * from './errors.js';
export * from './keys.js';
export * as ops from './ops.js';

export type StorageConnectionRow = typeof storageConnections.$inferSelect;

/**
 * One client per connection, reused across requests so the HTTP agent keeps
 * its sockets warm. `updatedAt` is part of the cache check, so editing a
 * connection rebuilds its client on the next request.
 */
const clients = new Map<string, { updatedAt: string; client: S3Client }>();

export function evictConnection(id: string): void {
  const cached = clients.get(id);
  if (!cached) return;
  clients.delete(id);
  cached.client.destroy();
}

/** Load a connection scoped to the caller's org and hand back a ready client. */
export async function resolveConnection(
  orgId: string,
  id: string,
): Promise<{ connection: StorageConnectionRow; client: S3Client }> {
  const connection = getDb()
    .select()
    .from(storageConnections)
    .where(and(eq(storageConnections.id, id), eq(storageConnections.orgId, orgId)))
    .get();
  if (!connection) throw new StorageError('Storage connection not found', 404);

  const cached = clients.get(id);
  if (cached && cached.updatedAt === connection.updatedAt) {
    return { connection, client: cached.client };
  }
  if (cached) evictConnection(id);

  const secret = await vault.decrypt(connection.encryptedSecretAccessKey, connection.id);
  const client = createClient(
    {
      provider: connection.provider as StorageProvider,
      endpoint: connection.endpoint,
      region: connection.region,
      accessKeyId: connection.accessKeyId,
      forcePathStyle: connection.forcePathStyle,
    },
    secret,
  );
  clients.set(id, { updatedAt: connection.updatedAt, client });
  return { connection, client };
}
```

- [x] **Step 5: Typecheck and run the full server suite**

Run: `pnpm --filter @smt/server run typecheck && cd apps/server && pnpm vitest run`
Expected: typecheck clean; all tests pass.

- [x] **Step 6: Commit**

```bash
git add apps/server/src/db apps/server/src/config apps/server/src/storage/index.ts
git commit -m "feat(storage): connections table, migration, config, resolver"
```

---

### Task 5: HTTP routes

**Files:**
- Create: `apps/server/src/api/routes/storage.ts`
- Modify: `apps/server/src/api/app.ts`

**Interfaces:**
- Consumes: Task 3 ops, Task 4 resolver/schema/config, `audit`, `requireAuth`, `requireRole`, `vault`.
- Produces: the `/api/storage` surface from the spec (table in §3.3).

- [x] **Step 1: Write the routes file**

```ts
// apps/server/src/api/routes/storage.ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { StorageConnection, StorageProvider } from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { getDb } from '../../db/index.js';
import { storageConnections } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import {
  StorageError,
  assertBucketParam,
  assertSafeEndpoint,
  baseName,
  evictConnection,
  normalizeKey,
  normalizePrefix,
  ops,
  resolveConnection,
  validateBucketName,
} from '../../storage/index.js';

const providerSchema = z.enum(['s3', 'minio', 'other']);
const endpointSchema = z.string().min(1).max(2000);
const keySchema = z.string().min(1).max(1024);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  provider: providerSchema.default('s3'),
  endpoint: endpointSchema.nullable().optional(),
  region: z.string().min(1).max(64).default('us-east-1'),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(1024),
  forcePathStyle: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  provider: providerSchema.optional(),
  endpoint: endpointSchema.nullable().optional(),
  region: z.string().min(1).max(64).optional(),
  accessKeyId: z.string().min(1).max(256).optional(),
  secretAccessKey: z.string().min(1).max(1024).optional(),
  forcePathStyle: z.boolean().optional(),
});

const createBucketSchema = z.object({ name: z.string().min(1).max(255) });
const deleteBucketQuery = z.object({ force: z.coerce.boolean().default(false) });
const listQuery = z.object({
  prefix: z.string().max(1024).default(''),
  token: z.string().max(4096).optional(),
});
const keyQuery = z.object({ key: keySchema });
const uploadQuery = z.object({ key: keySchema, contentType: z.string().max(255).optional() });
const deleteObjectQuery = z.object({ key: keySchema, recursive: z.coerce.boolean().default(false) });
const folderSchema = z.object({ prefix: keySchema });
const renameSchema = z.object({ from: keySchema, to: keySchema });

/** Everything but the secret. */
const publicColumns = {
  id: storageConnections.id,
  orgId: storageConnections.orgId,
  name: storageConnections.name,
  provider: storageConnections.provider,
  endpoint: storageConnections.endpoint,
  region: storageConnections.region,
  accessKeyId: storageConnections.accessKeyId,
  forcePathStyle: storageConnections.forcePathStyle,
  lastStatus: storageConnections.lastStatus,
  lastError: storageConnections.lastError,
  lastTestedAt: storageConnections.lastTestedAt,
  createdBy: storageConnections.createdBy,
  createdAt: storageConnections.createdAt,
  updatedAt: storageConnections.updatedAt,
};

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof StorageError) {
    return reply.status(err.statusCode).send({ error: err.message });
  }
  throw err;
}

/** A non-AWS provider has nowhere to go without an endpoint. */
function resolveEndpoint(provider: StorageProvider, endpoint: string | null | undefined): string | null {
  if (endpoint) return assertSafeEndpoint(endpoint);
  if (provider !== 's3') {
    throw new StorageError('An endpoint is required for MinIO and other S3-compatible providers', 400);
  }
  return null;
}

function publicConnection(orgId: string, id: string): StorageConnection | undefined {
  return getDb()
    .select(publicColumns)
    .from(storageConnections)
    .where(and(eq(storageConnections.id, id), eq(storageConnections.orgId, orgId)))
    .get() as StorageConnection | undefined;
}

export async function storageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Uploads arrive as a raw body so large objects never buffer in memory.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  // ── Connections ──────────────────────────────────────────────────────────

  app.get('/connections', async (req) => {
    return getDb()
      .select(publicColumns)
      .from(storageConnections)
      .where(eq(storageConnections.orgId, req.orgId))
      .orderBy(desc(storageConnections.createdAt))
      .all();
  });

  app.get('/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connection = publicConnection(req.orgId, id);
    if (!connection) return reply.status(404).send({ error: 'Not found' });
    return connection;
  });

  app.post('/connections', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    try {
      const endpoint = resolveEndpoint(body.provider, body.endpoint);
      const id = nanoid();
      getDb()
        .insert(storageConnections)
        .values({
          id,
          orgId: req.orgId,
          name: body.name,
          provider: body.provider,
          endpoint,
          region: body.region,
          accessKeyId: body.accessKeyId,
          encryptedSecretAccessKey: await vault.encrypt(body.secretAccessKey, id),
          // AWS prefers virtual-host style; everyone else usually needs path style
          forcePathStyle: body.forcePathStyle ?? body.provider !== 's3',
          createdBy: req.user.id,
        })
        .run();

      await audit(req, 'storage_connection.create', 'storage_connection', id, body.name, {
        provider: body.provider,
        endpoint,
      });
      return reply.status(201).send(publicConnection(req.orgId, id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/connections/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);
    const db = getDb();

    const existing = db
      .select()
      .from(storageConnections)
      .where(and(eq(storageConnections.id, id), eq(storageConnections.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    try {
      const provider = (body.provider ?? existing.provider) as StorageProvider;
      const endpoint =
        body.endpoint !== undefined
          ? resolveEndpoint(provider, body.endpoint)
          : resolveEndpoint(provider, existing.endpoint);

      db.update(storageConnections)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          provider,
          endpoint,
          ...(body.region !== undefined && { region: body.region }),
          ...(body.accessKeyId !== undefined && { accessKeyId: body.accessKeyId }),
          ...(body.forcePathStyle !== undefined && { forcePathStyle: body.forcePathStyle }),
          ...(body.secretAccessKey !== undefined && {
            encryptedSecretAccessKey: await vault.encrypt(body.secretAccessKey, id),
          }),
          // Credentials changed, so whatever the last test said no longer applies
          lastStatus: null,
          lastError: null,
          lastTestedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(storageConnections.id, id))
        .run();

      evictConnection(id);
      await audit(req, 'storage_connection.update', 'storage_connection', id, existing.name);
      return publicConnection(req.orgId, id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/connections/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const existing = db
      .select()
      .from(storageConnections)
      .where(and(eq(storageConnections.id, id), eq(storageConnections.orgId, req.orgId)))
      .get();
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    db.delete(storageConnections).where(eq(storageConnections.id, id)).run();
    evictConnection(id);
    await audit(req, 'storage_connection.delete', 'storage_connection', id, existing.name);
    return reply.status(204).send();
  });

  app.post('/connections/:id/test', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { connection, client } = await resolveConnection(req.orgId, id);
      const result = await ops.testConnection(client);
      getDb()
        .update(storageConnections)
        .set({
          lastStatus: result.ok ? 'ok' : 'failed',
          lastError: result.ok ? null : (result.error ?? 'Unknown error'),
          lastTestedAt: new Date().toISOString(),
        })
        .where(eq(storageConnections.id, id))
        .run();
      await audit(req, 'storage_connection.test', 'storage_connection', id, connection.name, {
        ok: result.ok,
      });
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── Buckets ──────────────────────────────────────────────────────────────

  app.get('/connections/:id/buckets', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { client } = await resolveConnection(req.orgId, id);
      return await ops.listBuckets(client);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post(
    '/connections/:id/buckets',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = createBucketSchema.parse(req.body);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = validateBucketName(body.name);
        await ops.createBucket(client, bucket, connection.region);
        await audit(req, 'storage.bucket_create', 'storage_connection', id, connection.name, {
          bucket,
        });
        return reply.status(201).send({ name: bucket, createdAt: new Date().toISOString() });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    '/connections/:id/buckets/:bucket',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const query = deleteBucketQuery.parse(req.query);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);
        const deletedObjects = query.force ? await ops.deletePrefix(client, bucket, '') : 0;
        await ops.deleteBucket(client, bucket);
        await audit(req, 'storage.bucket_delete', 'storage_connection', id, connection.name, {
          bucket,
          force: query.force,
          deletedObjects,
        });
        return { bucket, deletedObjects };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── Objects ──────────────────────────────────────────────────────────────

  /** GET …/objects?prefix=photos/&token= — one page of folders and objects */
  app.get('/connections/:id/buckets/:bucket/objects', async (req, reply) => {
    const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
    const query = listQuery.parse(req.query);
    try {
      const { connection, client } = await resolveConnection(req.orgId, id);
      const bucket = assertBucketParam(rawBucket);
      const prefix = normalizePrefix(query.prefix);
      const listing = await ops.listObjects(client, bucket, prefix, query.token);
      await audit(req, 'storage.list', 'storage_connection', id, connection.name, {
        bucket,
        prefix,
      });
      return listing;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** GET …/object?key=photos/cat.jpg — stream the object down */
  app.get('/connections/:id/buckets/:bucket/object', async (req, reply) => {
    const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
    const query = keyQuery.parse(req.query);
    try {
      const { connection, client } = await resolveConnection(req.orgId, id);
      const bucket = assertBucketParam(rawBucket);
      const key = normalizeKey(query.key);
      const object = await ops.getObject(client, bucket, key);
      await audit(req, 'storage.download', 'storage_connection', id, connection.name, {
        bucket,
        key,
        size: object.contentLength,
      });

      void reply
        .header('Content-Type', object.contentType ?? 'application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(baseName(key))}`,
        );
      if (object.contentLength != null) {
        void reply.header('Content-Length', String(object.contentLength));
      }
      return reply.send(object.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** PUT …/object?key=photos/cat.jpg&contentType=image/jpeg — stream a raw body up */
  app.put(
    '/connections/:id/buckets/:bucket/object',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const query = uploadQuery.parse(req.query);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);
        const key = normalizeKey(query.key);
        const source = req.body as Readable;

        let bytes = 0;
        source.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > config.storageMaxUploadBytes) {
            source.destroy(
              new StorageError(
                `Upload exceeds the ${config.storageMaxUploadBytes} byte limit`,
                413,
              ),
            );
          }
        });

        await ops.putObject(client, bucket, key, source, query.contentType);
        await audit(req, 'storage.upload', 'storage_connection', id, connection.name, {
          bucket,
          key,
          size: bytes,
        });
        return reply.status(201).send({ bucket, key, size: bytes });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** POST …/folder { prefix } — create a folder marker */
  app.post(
    '/connections/:id/buckets/:bucket/folder',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const body = folderSchema.parse(req.body);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);
        const prefix = normalizePrefix(body.prefix);
        if (prefix === '') return reply.status(400).send({ error: 'Folder name is required' });
        await ops.createFolder(client, bucket, prefix);
        await audit(req, 'storage.mkdir', 'storage_connection', id, connection.name, {
          bucket,
          prefix,
        });
        return reply.status(201).send({ bucket, prefix });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** POST …/rename { from, to } — copy + delete a single object */
  app.post(
    '/connections/:id/buckets/:bucket/rename',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const body = renameSchema.parse(req.body);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);
        const from = normalizeKey(body.from);
        const to = normalizeKey(body.to);
        await ops.renameObject(client, bucket, from, to);
        await audit(req, 'storage.rename', 'storage_connection', id, connection.name, {
          bucket,
          from,
          to,
        });
        return { bucket, from, to };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** DELETE …/object?key=photos/cat.jpg — or ?key=photos/&recursive=true for a prefix */
  app.delete(
    '/connections/:id/buckets/:bucket/object',
    { preHandler: requireRole('operator') },
    async (req, reply) => {
      const { id, bucket: rawBucket } = req.params as { id: string; bucket: string };
      const query = deleteObjectQuery.parse(req.query);
      try {
        const { connection, client } = await resolveConnection(req.orgId, id);
        const bucket = assertBucketParam(rawBucket);

        if (query.recursive) {
          const prefix = normalizePrefix(query.key);
          if (prefix === '') {
            return reply.status(400).send({ error: 'Refusing to empty the whole bucket here — delete the bucket with force instead' });
          }
          const deleted = await ops.deletePrefix(client, bucket, prefix);
          await audit(req, 'storage.delete', 'storage_connection', id, connection.name, {
            bucket,
            prefix,
            recursive: true,
            deleted,
          });
          return { bucket, prefix, deleted };
        }

        const key = normalizeKey(query.key);
        await ops.deleteObject(client, bucket, key);
        await audit(req, 'storage.delete', 'storage_connection', id, connection.name, {
          bucket,
          key,
        });
        return reply.status(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
```

- [x] **Step 2: Register the routes in `app.ts`**

Add the import next to the others:

```ts
import { storageRoutes } from './routes/storage.js';
```

Add after the sftp registration:

```ts
  await app.register(storageRoutes, { prefix: '/api/storage' });
```

- [x] **Step 3: Typecheck and run the suite**

Run: `pnpm --filter @smt/server run typecheck && cd apps/server && pnpm vitest run`
Expected: clean.

- [x] **Step 4: Commit**

```bash
git add apps/server/src/api
git commit -m "feat(storage): /api/storage routes"
```

---

### Task 6: Live integration test (skipped unless an endpoint is configured)

**Files:**
- Create: `apps/server/src/storage/ops.integration.test.ts`

**Interfaces:**
- Consumes: Task 3 `createClient` and ops.

- [x] **Step 1: Write the test**

```ts
// apps/server/src/storage/ops.integration.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { createClient } from './client.js';
import * as ops from './ops.js';

/**
 * Runs only against a real S3-compatible endpoint, e.g. a local MinIO:
 *
 *   docker run -d -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin quay.io/minio/minio server /data
 *   SMT_TEST_S3_ENDPOINT=http://127.0.0.1:9000 SMT_TEST_S3_ACCESS_KEY=minioadmin SMT_TEST_S3_SECRET_KEY=minioadmin pnpm vitest run src/storage/ops.integration.test.ts
 */
const endpoint = process.env.SMT_TEST_S3_ENDPOINT;
const accessKeyId = process.env.SMT_TEST_S3_ACCESS_KEY ?? '';
const secret = process.env.SMT_TEST_S3_SECRET_KEY ?? '';

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe.skipIf(!endpoint)('storage ops against a live endpoint', () => {
  const client = createClient(
    { provider: 'other', endpoint: endpoint ?? null, region: 'us-east-1', accessKeyId, forcePathStyle: true },
    secret,
  );
  const bucket = `smt-it-${Date.now().toString(36)}`;

  afterAll(async () => {
    try {
      await ops.deletePrefix(client, bucket, '');
      await ops.deleteBucket(client, bucket);
    } catch {
      /* already gone */
    }
    client.destroy();
  });

  it('creates a bucket and lists it', async () => {
    await ops.createBucket(client, bucket, 'us-east-1');
    const buckets = await ops.listBuckets(client);
    expect(buckets.map((b) => b.name)).toContain(bucket);
  });

  it('uploads, lists, downloads, renames and deletes objects', async () => {
    await ops.createFolder(client, bucket, 'docs/');
    await ops.putObject(client, bucket, 'docs/hello.txt', Readable.from([Buffer.from('hello world')]), 'text/plain');
    await ops.putObject(client, bucket, 'root.bin', Readable.from([Buffer.alloc(3)]));

    const root = await ops.listObjects(client, bucket, '');
    expect(root.folders.map((f) => f.prefix)).toEqual(['docs/']);
    expect(root.objects.map((o) => o.key)).toEqual(['root.bin']);

    const docs = await ops.listObjects(client, bucket, 'docs/');
    expect(docs.parent).toBe('');
    expect(docs.objects.map((o) => o.key)).toEqual(['docs/hello.txt']);
    expect(docs.objects[0]?.size).toBe(11);

    const got = await ops.getObject(client, bucket, 'docs/hello.txt');
    expect(got.contentType).toBe('text/plain');
    expect((await drain(got.body)).toString()).toBe('hello world');

    await ops.renameObject(client, bucket, 'docs/hello.txt', 'docs/renamed.txt');
    const afterRename = await ops.listObjects(client, bucket, 'docs/');
    expect(afterRename.objects.map((o) => o.key)).toEqual(['docs/renamed.txt']);

    await ops.deleteObject(client, bucket, 'root.bin');
    expect((await ops.listObjects(client, bucket, '')).objects).toEqual([]);

    const deleted = await ops.deletePrefix(client, bucket, 'docs/');
    expect(deleted).toBe(2); // marker + renamed file
    expect((await ops.listObjects(client, bucket, '')).folders).toEqual([]);
  });

  it('maps a missing key to 404 and a bad bucket to 404', async () => {
    await expect(ops.getObject(client, bucket, 'nope.txt')).rejects.toMatchObject({ statusCode: 404 });
    await expect(ops.listObjects(client, `${bucket}-missing`, '')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses to delete a non-empty bucket, then succeeds once emptied', async () => {
    await ops.putObject(client, bucket, 'keep.txt', Readable.from([Buffer.from('x')]));
    await expect(ops.deleteBucket(client, bucket)).rejects.toMatchObject({ statusCode: 409 });
    await ops.deletePrefix(client, bucket, '');
    await ops.deleteBucket(client, bucket);
    expect((await ops.listBuckets(client)).map((b) => b.name)).not.toContain(bucket);
  });
});
```

- [x] **Step 2: Verify it is skipped without config**

Run: `cd apps/server && pnpm vitest run src/storage/ops.integration.test.ts`
Expected: suite reported as skipped.

- [x] **Step 3: Run it against MinIO**

```bash
docker run -d --name smt-minio-test -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin quay.io/minio/minio server /data
cd apps/server && SMT_TEST_S3_ENDPOINT=http://127.0.0.1:9000 SMT_TEST_S3_ACCESS_KEY=minioadmin SMT_TEST_S3_SECRET_KEY=minioadmin pnpm vitest run src/storage/ops.integration.test.ts
docker rm -f smt-minio-test
```
Expected: 4 tests pass.

- [x] **Step 4: Commit**

```bash
git add apps/server/src/storage/ops.integration.test.ts
git commit -m "test(storage): live S3 integration test (opt-in)"
```

---

### Task 7: Web — API helper, nav, routes

**Files:**
- Modify: `apps/web/src/lib/api.ts` (the `upload` helper)
- Modify: `apps/web/src/components/layout/Layout.tsx`
- Modify: `apps/web/src/App.tsx`

- [x] **Step 1: Make `upload` generic**

Replace the `upload` function in `api.ts`:

```ts
/** Stream a raw file body to the server (SFTP and object-storage uploads). */
async function upload<T = { path: string; size: number }>(path: string, file: Blob): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    credentials: 'include',
  });
  if (!res.ok) await fail(res, path);
  return res.json() as Promise<T>;
}
```

- [x] **Step 2: Add the nav item**

In `Layout.tsx` add `HardDrive` to the lucide import and insert after the Servers entry:

```ts
  { to: '/storage', label: 'Object Storage', icon: HardDrive },
```

- [x] **Step 3: Add the routes**

In `App.tsx` import the three pages:

```ts
import StoragePage from '@/pages/Storage.js';
import StorageBucketsPage from '@/pages/StorageBuckets.js';
import StorageObjectsPage from '@/pages/StorageObjects.js';
```

and add after the `servers/:id/health` route:

```tsx
          <Route path="storage" element={<StoragePage />} />
          <Route path="storage/:id" element={<StorageBucketsPage />} />
          <Route path="storage/:id/buckets/:bucket" element={<StorageObjectsPage />} />
```

(Typecheck will fail until Task 8 creates the pages — that is expected; do Tasks 7 and 8 together before committing.)

---

### Task 8: Web — the three pages

**Files:**
- Create: `apps/web/src/pages/Storage.tsx`
- Create: `apps/web/src/pages/StorageBuckets.tsx`
- Create: `apps/web/src/pages/StorageObjects.tsx`

- [x] **Step 1: Connections page**

```tsx
// apps/web/src/pages/Storage.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import type {
  CreateStorageConnectionRequest,
  StorageConnection,
  StorageProvider,
  StorageTestResult,
  UpdateStorageConnectionRequest,
} from '@smt/shared';
import {
  CircleAlert,
  CircleCheck,
  FolderOpen,
  HardDrive,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

interface ConnectionForm {
  name: string;
  provider: StorageProvider;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const empty: ConnectionForm = {
  name: '',
  provider: 'minio',
  endpoint: '',
  region: 'us-east-1',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: true,
};

const PROVIDER_LABEL: Record<StorageProvider, string> = {
  s3: 'AWS S3',
  minio: 'MinIO',
  other: 'S3-compatible',
};

const QUERY_KEY = ['storage-connections'];

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

function describeTarget(c: StorageConnection): string {
  return c.endpoint ? `${c.endpoint} · ${c.region}` : `AWS · ${c.region}`;
}

export default function StoragePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canManage = useHasRole('admin');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectionForm>(empty);

  const { data: connections, isLoading } = useQuery<StorageConnection[]>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/storage/connections'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (body: CreateStorageConnectionRequest) =>
      api.post<StorageConnection>('/storage/connections', body),
    onSuccess: () => {
      invalidate();
      closeForm();
      toast.success('Connection added');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateStorageConnectionRequest }) =>
      api.patch<StorageConnection>(`/storage/connections/${id}`, body),
    onSuccess: () => {
      invalidate();
      closeForm();
      toast.success('Connection updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/storage/connections/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Connection removed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => api.post<StorageTestResult>(`/storage/connections/${id}/test`),
    onSuccess: (result) => {
      invalidate();
      if (result.ok) toast.success(`Connected — ${result.bucketCount ?? 0} bucket(s) visible`);
      else toast.error(result.error ?? 'Connection failed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function openCreate() {
    setEditId(null);
    setForm(empty);
    setShowForm(true);
  }

  function openEdit(c: StorageConnection) {
    setEditId(c.id);
    setForm({
      name: c.name,
      provider: c.provider,
      endpoint: c.endpoint ?? '',
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: '',
      forcePathStyle: c.forcePathStyle,
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditId(null);
    setForm(empty);
  }

  function setProvider(provider: StorageProvider) {
    // AWS prefers virtual-host addressing; everyone else usually needs path style
    setForm((p) => ({ ...p, provider, forcePathStyle: provider !== 's3' }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const endpoint = form.endpoint.trim() || null;
    if (editId) {
      updateMutation.mutate({
        id: editId,
        body: {
          name: form.name,
          provider: form.provider,
          endpoint,
          region: form.region,
          accessKeyId: form.accessKeyId,
          // Blank means "keep the stored secret" — it is never sent back to the client
          ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {}),
          forcePathStyle: form.forcePathStyle,
        },
      });
    } else {
      createMutation.mutate({
        name: form.name,
        provider: form.provider,
        endpoint,
        region: form.region,
        accessKeyId: form.accessKeyId,
        secretAccessKey: form.secretAccessKey,
        forcePathStyle: form.forcePathStyle,
      });
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Object Storage</h1>
          <p className="text-sm text-muted-foreground">
            Browse and manage S3 and MinIO buckets
          </p>
        </div>
        {canManage && (
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={15} /> Add connection
          </button>
        )}
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border border-border bg-card p-5">
          <h2 className="mb-4 font-semibold">{editId ? 'Edit connection' : 'New connection'}</h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Name</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="Backups (MinIO)"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Provider</label>
              <select
                value={form.provider}
                onChange={(e) => setProvider(e.target.value as StorageProvider)}
                className={inputClass}
              >
                <option value="minio">MinIO</option>
                <option value="s3">AWS S3</option>
                <option value="other">Other S3-compatible (Wasabi, R2, Spaces, Ceph…)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                Endpoint{' '}
                {form.provider === 's3' && (
                  <span className="text-xs text-muted-foreground">(optional — blank uses AWS)</span>
                )}
              </label>
              <input
                type="url"
                required={form.provider !== 's3'}
                value={form.endpoint}
                onChange={(e) => setForm((p) => ({ ...p, endpoint: e.target.value }))}
                placeholder={form.provider === 's3' ? 'https://s3.amazonaws.com' : 'http://minio.internal:9000'}
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Region</label>
              <input
                type="text"
                required
                value={form.region}
                onChange={(e) => setForm((p) => ({ ...p, region: e.target.value }))}
                placeholder="us-east-1"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Access key ID</label>
              <input
                type="text"
                required
                autoComplete="off"
                value={form.accessKeyId}
                onChange={(e) => setForm((p) => ({ ...p, accessKeyId: e.target.value }))}
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Secret access key</label>
              <input
                type="password"
                required={!editId}
                autoComplete="new-password"
                value={form.secretAccessKey}
                onChange={(e) => setForm((p) => ({ ...p, secretAccessKey: e.target.value }))}
                className={`${inputClass} font-mono`}
              />
              {editId && (
                <p className="mt-1 text-xs text-muted-foreground">Leave blank to keep the existing secret.</p>
              )}
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.forcePathStyle}
                onChange={(e) => setForm((p) => ({ ...p, forcePathStyle: e.target.checked }))}
                className="size-4 rounded border-input"
              />
              Path-style addressing
              <span className="text-xs text-muted-foreground">
                (host/bucket/key — required by MinIO; AWS uses bucket.host)
              </span>
            </label>
            <div className="col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={createMutation.isPending || updateMutation.isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {editId ? 'Update' : 'Add'}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !connections?.length ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <HardDrive size={40} className="mb-3 opacity-30" />
          <p>
            No storage connections yet.
            {canManage ? ' Click "Add connection" to register an S3 or MinIO endpoint.' : ''}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {connections.map((c) => (
            <div key={c.id} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{c.name}</p>
                  <p className="truncate font-mono text-sm text-muted-foreground">{describeTarget(c)}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{c.accessKeyId}</p>
                </div>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {PROVIDER_LABEL[c.provider]}
                </span>
              </div>
              {c.lastStatus && (
                <p
                  className={`flex items-center gap-1 text-xs ${c.lastStatus === 'ok' ? 'text-emerald-500' : 'text-red-500'}`}
                >
                  {c.lastStatus === 'ok' ? <CircleCheck size={11} /> : <CircleAlert size={11} />}
                  {c.lastStatus === 'ok'
                    ? `Connected${c.lastTestedAt ? ` · ${new Date(c.lastTestedAt).toLocaleString()}` : ''}`
                    : `Failed: ${c.lastError ?? 'unknown error'}`}
                </p>
              )}
              <div className="mt-auto flex gap-2">
                <button
                  onClick={() => navigate(`/storage/${c.id}`)}
                  className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20"
                >
                  <FolderOpen size={12} /> Browse
                </button>
                {canManage && (
                  <>
                    <button
                      onClick={() => testMutation.mutate(c.id)}
                      disabled={testMutation.isPending}
                      className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                    >
                      <PlugZap size={12} /> Test
                    </button>
                    <button
                      onClick={() => openEdit(c)}
                      className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                    >
                      <Pencil size={12} /> Edit
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Remove connection "${c.name}"? Buckets and objects are not touched.`)) {
                          deleteMutation.mutate(c.id);
                        }
                      }}
                      className="ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10"
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 2: Buckets page**

```tsx
// apps/web/src/pages/StorageBuckets.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import type { StorageBucket, StorageConnection, StorageDeleteBucketResponse } from '@smt/shared';
import { ArrowLeft, FolderOpen, Package, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

interface DeleteDialog {
  bucket: string;
  typed: string;
  force: boolean;
}

export default function StorageBucketsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canManage = useHasRole('admin');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [dialog, setDialog] = useState<DeleteDialog | null>(null);

  const { data: connection } = useQuery<StorageConnection>({
    queryKey: ['storage-connections', id],
    queryFn: () => api.get(`/storage/connections/${id}`),
    enabled: !!id,
  });

  const bucketsQuery = useQuery<StorageBucket[]>({
    queryKey: ['storage-buckets', id],
    queryFn: () => api.get(`/storage/connections/${id}/buckets`),
    enabled: !!id,
    retry: false,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['storage-buckets', id] });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      api.post<StorageBucket>(`/storage/connections/${id}/buckets`, { name }),
    onSuccess: (bucket) => {
      refresh();
      setShowCreate(false);
      setNewName('');
      toast.success(`Bucket "${bucket.name}" created`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ bucket, force }: { bucket: string; force: boolean }) =>
      api.delete<StorageDeleteBucketResponse>(
        `/storage/connections/${id}/buckets/${encodeURIComponent(bucket)}?force=${force}`,
      ),
    onSuccess: (res) => {
      refresh();
      setDialog(null);
      toast.success(
        res.deletedObjects > 0
          ? `Deleted "${res.bucket}" and ${res.deletedObjects} object(s)`
          : `Deleted "${res.bucket}"`,
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function openBucket(name: string) {
    navigate(`/storage/${id}/buckets/${encodeURIComponent(name)}`);
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/storage')}
              className="text-muted-foreground hover:text-foreground"
              title="Back to connections"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="truncate text-2xl font-bold">{connection?.name ?? 'Buckets'}</h1>
          </div>
          <p className="truncate font-mono text-sm text-muted-foreground">
            {connection ? (connection.endpoint ?? `AWS · ${connection.region}`) : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Plus size={15} /> New bucket
            </button>
          )}
          <button
            onClick={refresh}
            title="Refresh"
            className="rounded-md border border-border p-2 hover:bg-muted"
          >
            <RefreshCw size={15} className={bucketsQuery.isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {showCreate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate(newName.trim());
          }}
          className="mb-6 flex items-end gap-2 rounded-lg border border-border bg-card p-4"
        >
          <div className="flex-1">
            <label className="mb-1 block text-sm font-medium">Bucket name</label>
            <input
              type="text"
              required
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="my-backups"
              pattern="[a-z0-9.-]{3,63}"
              title="3–63 lowercase letters, digits, dots or hyphens"
              className={`${inputClass} font-mono`}
            />
          </div>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => {
              setShowCreate(false);
              setNewName('');
            }}
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Cancel
          </button>
        </form>
      )}

      {bucketsQuery.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : bucketsQuery.isError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
          {(bucketsQuery.error as Error).message}
        </div>
      ) : bucketsQuery.data?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Package size={40} className="mb-3 opacity-30" />
          <p>No buckets visible to this key.{canManage ? ' Create one to get started.' : ''}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Bucket</th>
                <th className="w-48 px-4 py-2 font-medium">Created</th>
                <th className="w-32 px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {bucketsQuery.data?.map((b) => (
                <tr key={b.name} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2">
                    <button
                      onClick={() => openBucket(b.name)}
                      className="flex items-center gap-2 text-left hover:underline"
                    >
                      <Package size={15} className="text-primary" />
                      <span className="font-mono">{b.name}</span>
                    </button>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openBucket(b.name)}
                        title="Browse"
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <FolderOpen size={13} />
                      </button>
                      {canManage && (
                        <button
                          onClick={() => setDialog({ bucket: b.name, typed: '', force: false })}
                          title="Delete bucket"
                          className="rounded-md p-1.5 text-red-500 hover:bg-red-500/10"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
            <h2 className="mb-1 font-semibold">Delete bucket</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              This cannot be undone. Type <span className="font-mono">{dialog.bucket}</span> to confirm.
            </p>
            <input
              type="text"
              autoFocus
              value={dialog.typed}
              onChange={(e) => setDialog({ ...dialog, typed: e.target.value })}
              className={`${inputClass} mb-3 font-mono`}
            />
            <label className="mb-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dialog.force}
                onChange={(e) => setDialog({ ...dialog, force: e.target.checked })}
                className="size-4 rounded border-input"
              />
              Also delete every object inside it
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDialog(null)}
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate({ bucket: dialog.bucket, force: dialog.force })}
                disabled={dialog.typed !== dialog.bucket || deleteMutation.isPending}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete bucket'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 3: Objects page**

```tsx
// apps/web/src/pages/StorageObjects.tsx
import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';
import { formatBytes } from '@/lib/utils.js';
import type { StorageFolder, StorageListResponse, StorageObject, StorageUploadResponse } from '@smt/shared';
import {
  ArrowLeft,
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';

export default function StorageObjectsPage() {
  const { id, bucket } = useParams<{ id: string; bucket: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [prefix, setPrefix] = useState('');

  // Server enforces these too — this only keeps unusable controls off the screen
  const canWrite = useHasRole('operator');

  const base = `/storage/connections/${id}/buckets/${encodeURIComponent(bucket ?? '')}`;

  const listQuery = useInfiniteQuery({
    queryKey: ['storage-objects', id, bucket, prefix],
    queryFn: ({ pageParam }): Promise<StorageListResponse> =>
      api.get(
        `${base}/objects?prefix=${encodeURIComponent(prefix)}${pageParam ? `&token=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextToken ?? undefined,
    enabled: !!id && !!bucket,
    retry: false,
  });

  const pages = listQuery.data?.pages ?? [];
  const folders = pages.flatMap((p) => p.folders);
  const objects = pages.flatMap((p) => p.objects);
  const parent = pages[0]?.parent ?? null;

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['storage-objects', id, bucket] });
  }

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      api.upload<StorageUploadResponse>(
        `${base}/object?key=${encodeURIComponent(prefix + file.name)}${file.type ? `&contentType=${encodeURIComponent(file.type)}` : ''}`,
        file,
      ),
    onSuccess: (_res, file) => {
      refresh();
      toast.success(`Uploaded ${file.name}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const mkdirMutation = useMutation({
    mutationFn: (target: string) => api.post(`${base}/folder`, { prefix: target }),
    onSuccess: () => {
      refresh();
      toast.success('Folder created');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const renameMutation = useMutation({
    mutationFn: (body: { from: string; to: string }) => api.post(`${base}/rename`, body),
    onSuccess: () => {
      refresh();
      toast.success('Renamed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ key, recursive }: { key: string; recursive: boolean }) =>
      api.delete(`${base}/object?key=${encodeURIComponent(key)}&recursive=${recursive}`),
    onSuccess: () => {
      refresh();
      toast.success('Deleted');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function handleDownload(obj: StorageObject) {
    try {
      await api.download(`${base}/object?key=${encodeURIComponent(obj.key)}`, obj.name);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    }
  }

  function handleMkdir() {
    const name = prompt('New folder name');
    if (name?.trim()) mkdirMutation.mutate(prefix + name.trim());
  }

  function handleRename(obj: StorageObject) {
    const name = prompt('Rename to', obj.name);
    if (name && name !== obj.name) renameMutation.mutate({ from: obj.key, to: prefix + name });
  }

  function handleDeleteObject(obj: StorageObject) {
    if (confirm(`Delete "${obj.name}"?`)) deleteMutation.mutate({ key: obj.key, recursive: false });
  }

  function handleDeleteFolder(folder: StorageFolder) {
    if (confirm(`Delete folder "${folder.name}" and everything inside it?`)) {
      deleteMutation.mutate({ key: folder.prefix, recursive: true });
    }
  }

  function handleFilesChosen(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) uploadMutation.mutate(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const segments = prefix.split('/').filter(Boolean);
  const isEmpty = folders.length === 0 && objects.length === 0;

  return (
    <div
      className="p-6"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (canWrite) handleFilesChosen(e.dataTransfer.files);
      }}
    >
      <div className="mb-6 flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(`/storage/${id}`)}
              className="text-muted-foreground hover:text-foreground"
              title="Back to buckets"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="truncate font-mono text-2xl font-bold">{bucket}</h1>
          </div>
          <p className="text-sm text-muted-foreground">Objects in this bucket</p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite && (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Upload size={15} /> Upload
              </button>
              <button
                onClick={handleMkdir}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
              >
                <FolderPlus size={15} /> New folder
              </button>
            </>
          )}
          <button
            onClick={refresh}
            title="Refresh"
            className="rounded-md border border-border p-2 hover:bg-muted"
          >
            <RefreshCw size={15} className={listQuery.isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => handleFilesChosen(e.target.files)}
      />

      {/* Breadcrumbs */}
      <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        {parent != null && (
          <button
            onClick={() => setPrefix(parent)}
            title="Up one level"
            className="mr-1 rounded-md border border-border p-1 hover:bg-muted"
          >
            <ArrowUp size={13} />
          </button>
        )}
        <button onClick={() => setPrefix('')} className="font-mono text-primary hover:underline">
          {bucket}
        </button>
        {segments.map((seg, i) => (
          <span key={`${seg}-${i}`} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            <button
              onClick={() => setPrefix(`${segments.slice(0, i + 1).join('/')}/`)}
              className="font-mono text-primary hover:underline"
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {uploadMutation.isPending && <p className="mb-3 text-sm text-muted-foreground">Uploading…</p>}

      {listQuery.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : listQuery.isError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
          {(listQuery.error as Error).message}
        </div>
      ) : isEmpty ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Folder size={40} className="mb-3 opacity-30" />
          <p>
            Nothing here yet.
            {canWrite ? ' Drop files here or click "Upload".' : ''}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="w-28 px-4 py-2 font-medium">Size</th>
                <th className="w-44 px-4 py-2 font-medium">Modified</th>
                <th className="w-32 px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr key={folder.prefix} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2">
                    <button
                      onClick={() => setPrefix(folder.prefix)}
                      className="flex items-center gap-2 text-left hover:underline"
                    >
                      <Folder size={15} className="text-primary" />
                      <span className="font-mono">{folder.name}</span>
                    </button>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2 text-muted-foreground">—</td>
                  <td className="px-4 py-2">
                    {canWrite && (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleDeleteFolder(folder)}
                          title="Delete folder"
                          className="rounded-md p-1.5 text-red-500 hover:bg-red-500/10"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {objects.map((obj) => (
                <tr key={obj.key} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleDownload(obj)}
                      className="flex items-center gap-2 text-left hover:underline"
                      title="Download"
                    >
                      <FileIcon size={15} className="text-muted-foreground" />
                      <span className="font-mono">{obj.name}</span>
                    </button>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{formatBytes(obj.size)}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {obj.modifiedAt ? new Date(obj.modifiedAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleDownload(obj)}
                        title="Download"
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Download size={13} />
                      </button>
                      {canWrite && (
                        <>
                          <button
                            onClick={() => handleRename(obj)}
                            title="Rename"
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => handleDeleteObject(obj)}
                            title="Delete"
                            className="rounded-md p-1.5 text-red-500 hover:bg-red-500/10"
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {listQuery.hasNextPage && (
            <div className="border-t border-border p-3 text-center">
              <button
                onClick={() => listQuery.fetchNextPage()}
                disabled={listQuery.isFetchingNextPage}
                className="rounded-md border border-border px-4 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                {listQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 4: Typecheck the web app**

Run: `pnpm --filter @smt/web run typecheck`
Expected: no errors.

- [x] **Step 5: Build the web app**

Run: `pnpm --filter @smt/web run build`
Expected: Vite build succeeds.

- [x] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): object storage pages"
```

---

### Task 9: Docs and env example

**Files:**
- Modify: `.env.example`, `README.md`, `docs/ARCHITECTURE.md`

- [x] **Step 1: `.env.example`** — after the SFTP upload line:

```bash
# Max object-storage (S3/MinIO) upload size in bytes (default: 5368709120 = 5 GiB)
# SMT_STORAGE_MAX_UPLOAD_BYTES=5368709120
```

- [x] **Step 2: README** — add a feature bullet after the SFTP-related bullets and a section after "Health Monitoring":

Feature bullet:
```md
- 🪣 **Object Storage** — Register AWS S3, MinIO, or any S3-compatible endpoint. List, create and delete buckets; browse, upload, download, rename and delete objects — all from the same UI and audit log as your servers.
```

Section:
```md
## 🪣 Object Storage

Add an S3-compatible connection under **Object Storage** (AWS S3, MinIO, Wasabi, Cloudflare R2, DigitalOcean Spaces, Ceph RGW…) with an endpoint, region and access-key pair. The secret key is encrypted at rest with the same vault as SSH keys and never leaves the server.

- Buckets: list, create, delete (optionally emptying it first, with a typed-name confirmation)
- Objects: browse by folder, upload (streamed, multipart above 8 MiB), download, rename, delete a file or a whole folder
- Every action is audited with the bucket and key
- Roles: viewers browse and download, operators change objects, admins manage connections and buckets

Uploads are capped by `SMT_STORAGE_MAX_UPLOAD_BYTES` (default 5 GiB).
```

Roadmap: no change needed.

- [x] **Step 3: ARCHITECTURE.md**

Add a section `### 4.4b Object Storage (`/server/storage`)` after the SFTP subsection:

```md
### 4.4b Object Storage (`/server/storage`)

S3-compatible bucket and object management, covering AWS S3, MinIO, and anything
else that speaks the S3 API. Built on `@aws-sdk/client-s3` (+ `lib-storage` for
streaming multipart uploads), which MinIO itself recommends for Node.

- `keys.ts` — pure helpers: key/prefix normalisation (no `..`, no leading slash,
  prefixes end in `/`), bucket-name validation, endpoint safety check.
- `client.ts` — builds the `S3Client`. Always sets
  `requestChecksumCalculation: 'WHEN_REQUIRED'` (newer SDKs default to CRC32 trailers
  that older MinIO releases and some providers reject) and `followRegionRedirects`.
- `ops.ts` — thin wrappers over SDK commands; every failure is mapped to a
  `StorageError` carrying an HTTP status (404 missing bucket/key, 403 bad
  credentials, 409 bucket conflicts, 502/504 unreachable/timeout).
- `index.ts` — resolves a connection for the caller's org, decrypts the secret, and
  caches one client per connection until the row changes.

Downloads stream the SDK body straight to the response; uploads pipe a raw
`application/octet-stream` body through `lib-storage`'s `Upload` (single PUT below
one part, multipart above). Recursive deletes page through `ListObjectsV2` and use
`DeleteObjects` in batches of 1000, falling back to single deletes for providers
that reject batch deletes.

REST surface, all under `/api/storage`:

| Method   | Path                                                | Purpose                                      |
| -------- | --------------------------------------------------- | -------------------------------------------- |
| `GET`    | `/connections`                                      | List connections (secret never returned)     |
| `POST`   | `/connections`                                      | Create                                       |
| `PATCH`  | `/connections/:id`                                  | Update (omit `secretAccessKey` to keep it)   |
| `DELETE` | `/connections/:id`                                  | Delete                                       |
| `POST`   | `/connections/:id/test`                             | `ListBuckets` round-trip, result recorded    |
| `GET`    | `/connections/:id/buckets`                          | List buckets                                 |
| `POST`   | `/connections/:id/buckets`                          | Create bucket                                |
| `DELETE` | `/connections/:id/buckets/:bucket?force=`           | Delete bucket (`force` empties it first)     |
| `GET`    | `/connections/:id/buckets/:bucket/objects?prefix=&token=` | One page of folders + objects        |
| `GET`    | `/connections/:id/buckets/:bucket/object?key=`      | Stream an object down                        |
| `PUT`    | `/connections/:id/buckets/:bucket/object?key=&contentType=` | Stream a raw body up                 |
| `POST`   | `/connections/:id/buckets/:bucket/folder`           | Create a folder marker                       |
| `POST`   | `/connections/:id/buckets/:bucket/rename`           | Copy + delete one object                     |
| `DELETE` | `/connections/:id/buckets/:bucket/object?key=&recursive=` | Delete an object or a whole prefix     |
```

Data model: add `Organization 1───* StorageConnection` to the diagram and a bullet:

```md
- **storage_connections** — `name`, `provider` (`s3 | minio | other`), `endpoint` (null = AWS), `region`, `access_key_id`, `encrypted_secret_access_key`, `force_path_style`, last-test status.
```

Encrypted columns: add `storage_connections.encrypted_secret_access_key`.

RBAC table rows:

```md
| Storage connections         | viewer   | admin       |
| Buckets (create / delete)   | viewer   | admin       |
| Objects list / download     | viewer   | —           |
| Objects upload / folder / rename / delete | — | operator |
```

Config table row:

```md
| `SMT_STORAGE_MAX_UPLOAD_BYTES` | no    | Max object-storage upload size in bytes (default 5 GiB)      |
```

Repository layout: add `│       │   ├── storage/  # S3 / MinIO client + ops` under `ssh/`.

- [x] **Step 4: Commit**

```bash
git add .env.example README.md docs/ARCHITECTURE.md docs/superpowers
git commit -m "docs: object storage"
```

---

### Task 10: End-to-end smoke test against the real API

**Files:** none (verification only).

- [x] **Step 1: Start MinIO and the API on a spare port**

```bash
docker run -d --name smt-minio-test -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin quay.io/minio/minio server /data
cd apps/server && SMT_PORT=8090 SMT_DB_URL=/tmp/smt-smoke.db pnpm dev   # background
```

- [x] **Step 2: Log in, create a connection, exercise the flow with curl**

```bash
J=/tmp/smt-smoke.jar
curl -s -c $J -H 'Content-Type: application/json' -d '{"email":"admin@smt.local","password":"admin1234"}' http://localhost:8090/api/auth/login
CONN=$(curl -s -b $J -H 'Content-Type: application/json' -d '{"name":"local minio","provider":"minio","endpoint":"http://127.0.0.1:9000","accessKeyId":"minioadmin","secretAccessKey":"minioadmin"}' http://localhost:8090/api/storage/connections | jq -r .id)
curl -s -b $J -X POST http://localhost:8090/api/storage/connections/$CONN/test
curl -s -b $J -H 'Content-Type: application/json' -d '{"name":"smoke"}' http://localhost:8090/api/storage/connections/$CONN/buckets
printf 'hello' | curl -s -b $J -X PUT -H 'Content-Type: application/octet-stream' --data-binary @- "http://localhost:8090/api/storage/connections/$CONN/buckets/smoke/object?key=docs/hi.txt&contentType=text/plain"
curl -s -b $J "http://localhost:8090/api/storage/connections/$CONN/buckets/smoke/objects?prefix="
curl -s -b $J "http://localhost:8090/api/storage/connections/$CONN/buckets/smoke/object?key=docs/hi.txt"
curl -s -b $J -X DELETE "http://localhost:8090/api/storage/connections/$CONN/buckets/smoke?force=true"
```
Expected: 201 on create, `{"ok":true,…}` on test, listing shows the `docs/` folder, download prints `hello`, bucket delete reports one deleted object.

- [x] **Step 3: Tear down**

```bash
docker rm -f smt-minio-test; rm -f /tmp/smt-smoke.db* /tmp/smt-smoke.jar
```
