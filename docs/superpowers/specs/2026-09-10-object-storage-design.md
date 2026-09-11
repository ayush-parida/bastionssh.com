# Object Storage (S3 / MinIO) Management — Design

**Date:** 2026-09-10
**Status:** Implemented under stated assumptions (autonomous session — see "Assumptions")

## 1. Goal

Let a team manage S3-compatible object storage from inside BastionSSH, next to the
servers it already manages. "S3-compatible" covers AWS S3, MinIO, and anything that
speaks the S3 API (Wasabi, DigitalOcean Spaces, Cloudflare R2, Backblaze B2, Ceph RGW).

A user registers a **storage connection** (endpoint + credentials), then browses its
**buckets** and the **objects** inside them, with upload, download, delete, folder
creation, and rename — the same everyday operations the SFTP file browser offers for a
server. Bucket creation and deletion round out "manage buckets".

## 2. Assumptions

This was designed and built in a non-interactive session, so the following calls were
made without asking. Each is easy to revisit.

1. **Scope is day-to-day management, not administration.** Bucket policies, lifecycle
   rules, versioning, CORS, IAM, and presigned share links are out of scope.
2. **Credentials are static access-key pairs.** No STS/assume-role, no instance
   profiles. This is what MinIO uses and what most self-hosters have.
3. **One connection = one endpoint + one key pair.** A connection can see every bucket
   its key can list. There is no per-bucket ACL layer beyond the app's existing roles.
4. **Client library is the official AWS SDK v3** (`@aws-sdk/client-s3` +
   `@aws-sdk/lib-storage`). MinIO's own docs recommend it for Node, it handles
   multipart streaming uploads, and one client covers every provider. The
   alternative — the `minio` npm package — is smaller but MinIO-flavoured, and
   hand-rolling SigV4 was rejected outright.
5. **Role mapping mirrors SFTP.** viewer reads; operator writes objects; admin manages
   connections and buckets. Bucket create/delete is admin because it is
   infrastructure, like adding a server.
6. **Deleting a non-empty bucket is opt-in.** `force=true` empties the bucket first.
   The UI requires typing the bucket name. Versioned buckets with retained versions
   still fail — the error says so.

## 3. Architecture

A new server module `apps/server/src/storage/` sits beside `ssh/` and owns everything
S3: client construction, key/prefix normalisation, listing, streaming, and error
mapping. Routes in `api/routes/storage.ts` are thin: validate, authorise, call the
module, audit. The web app gains three pages under `/storage`.

```
Browser ── /api/storage/* ──▶ routes/storage.ts ──▶ storage/{client,keys,ops}.ts ──▶ S3 / MinIO
                                     │
                                     ├─ vault (decrypt secret key on demand)
                                     └─ audit (storage.* entries)
```

One `S3Client` is cached per connection (keyed on the row's `updatedAt`) so the
SDK's HTTP agent keeps its sockets warm across a browsing session. Editing or
deleting a connection evicts its client, so a credential change takes effect on the
next request — the same shape as the SFTP pool, without the idle-timer bookkeeping.

### 3.1 Storage module (`apps/server/src/storage/`)

| File         | Responsibility                                                                 |
| ------------ | ------------------------------------------------------------------------------ |
| `errors.ts`  | `StorageError`, `toStorageError(err)` (SDK/network error → HTTP status). |
| `keys.ts`    | Pure helpers: `normalizeKey`, `normalizePrefix`, `parentPrefix`, `baseName`, `validateBucketName`, `assertBucketParam`, `assertSafeEndpoint`. |
| `client.ts`  | `buildClientConfig(target, secret)`, `createClient`. |
| `ops.ts`     | Thin async wrappers over SDK commands: `listBuckets`, `testConnection`, `createBucket`, `deleteBucket`, `listObjects` (+ pure `toListing`), `getObject`, `putObject` (lib-storage `Upload`), `createFolder`, `deleteObject`, `copyObject`/`renameObject`, `deleteKeys`, `deletePrefix` (`''` empties a bucket). |
| `index.ts`   | Re-exports + `resolveConnection(orgId, id)` (loads the row, decrypts the secret, caches the client) and `evictConnection(id)`. |

**Client config.** `region` defaults to `us-east-1`. `endpoint` is set only for
non-AWS providers. `forcePathStyle` is stored per connection (default on for
MinIO/other, off for AWS). Two compatibility flags are always set:
`requestChecksumCalculation: 'WHEN_REQUIRED'` and
`responseChecksumValidation: 'WHEN_REQUIRED'`, because SDK ≥ 3.729 otherwise sends
CRC32 checksum trailers that older MinIO releases and several third-party providers
reject. `followRegionRedirects: true` lets an AWS connection in one region browse a
bucket that lives in another.

**Key rules.** Object keys are not filesystem paths, but the browser treats `/` as a
folder separator, so the same hygiene applies: strip a leading `/`, collapse empty and
`.` segments, reject `..` segments and null bytes (400). A **prefix** is a key that is
either empty (bucket root) or ends in `/`. A **folder** is a zero-byte object whose key
is the prefix itself — the convention both the AWS console and MinIO console use.

**Bucket names** follow the S3 rules: 3–63 chars, lowercase letters, digits, `.` and
`-`, must start and end with a letter or digit, no `..`, and not shaped like an IPv4
address.

**Endpoint validation** mirrors the webhook guard: `http:`/`https:` only and the cloud
metadata addresses are refused.

**Error mapping** (`toStorageError`): `NoSuchBucket`/`NoSuchKey`/`NotFound` → 404;
`AccessDenied`/`InvalidAccessKeyId`/`SignatureDoesNotMatch` → 403;
`BucketNotEmpty`/`BucketAlreadyExists`/`BucketAlreadyOwnedByYou` → 409;
`ENOTFOUND`/`ECONNREFUSED`/`ECONNRESET` → 502; timeouts → 504; anything with a 4xx
`$metadata.httpStatusCode` keeps that status; everything else → 502 (the upstream
failed, not us). Messages are the SDK's, so the user sees the real reason.

**Streaming.** Download returns the SDK `Body` (a Node `Readable`) straight to Fastify
with `Content-Type`, `Content-Length` and `Content-Disposition` from the object.
Upload takes a raw `application/octet-stream` body and pipes it through
`lib-storage`'s `Upload`, which does single-PUT for small bodies and multipart for
large ones without buffering the whole file. Uploads are capped by
`SMT_STORAGE_MAX_UPLOAD_BYTES` (default 5 GiB); an optional `contentType` query
parameter carries the browser-detected MIME type onto the object.

**Recursive delete.** `deletePrefix` pages through `ListObjectsV2` and issues
`DeleteObjects` in batches of 1000; a provider that rejects batch deletes (older
MinIO wants `Content-MD5`) falls back to single deletes. Emptying a bucket is
`deletePrefix('')`.

### 3.2 Data model

New table `storage_connections`:

| Column                     | Notes                                                                 |
| -------------------------- | --------------------------------------------------------------------- |
| `id`, `org_id`             | As every other org-scoped table.                                      |
| `name`                     | Display name.                                                         |
| `provider`                 | `s3` \| `minio` \| `other` — a UI hint for defaults, not behaviour.   |
| `endpoint`                 | Nullable; null means AWS's regional endpoint.                         |
| `region`                   | Default `us-east-1`.                                                  |
| `access_key_id`            | Plaintext — an identifier, like `servers.username`.                   |
| `encrypted_secret_access_key` | Vault-encrypted with the row id as AAD. Never returned.            |
| `force_path_style`         | Boolean. MinIO needs it; AWS virtual-host style is the default.       |
| `last_status`, `last_error`, `last_tested_at` | Result of the last "Test connection", like notification channels. |
| `created_by`, `created_at`, `updated_at` |                                                          |

Migration `0004_add_storage_connections.sql` + journal entry, hand-written like
0001–0003.

### 3.3 API (`/api/storage`)

| Method   | Path                                              | Role     | Purpose                                     |
| -------- | ------------------------------------------------- | -------- | ------------------------------------------- |
| `GET`    | `/connections`                                    | viewer   | List connections (secret never included)    |
| `POST`   | `/connections`                                    | admin    | Create                                      |
| `PATCH`  | `/connections/:id`                                | admin    | Update; omit `secretAccessKey` to keep it   |
| `DELETE` | `/connections/:id`                                | admin    | Delete                                      |
| `POST`   | `/connections/:id/test`                           | admin    | `ListBuckets` round-trip; records result    |
| `GET`    | `/connections/:id/buckets`                        | viewer   | List buckets                                |
| `POST`   | `/connections/:id/buckets`                        | admin    | Create bucket `{ name }`                    |
| `DELETE` | `/connections/:id/buckets/:bucket?force=`         | admin    | Delete bucket; `force` empties it first     |
| `GET`    | `/connections/:id/buckets/:bucket/objects?prefix=&token=` | viewer | One page of folders + objects under a prefix |
| `GET`    | `/connections/:id/buckets/:bucket/object?key=`    | viewer   | Stream an object down                       |
| `PUT`    | `/connections/:id/buckets/:bucket/object?key=&contentType=` | operator | Stream a raw body up                 |
| `POST`   | `/connections/:id/buckets/:bucket/folder`         | operator | Create a folder marker `{ prefix }`         |
| `POST`   | `/connections/:id/buckets/:bucket/rename`         | operator | Copy + delete a single object `{ from, to }`|
| `DELETE` | `/connections/:id/buckets/:bucket/object?key=&recursive=` | operator | Delete an object, or a prefix with `recursive` |

Listing uses `Delimiter: '/'`, so a page is `{ prefix, parent, folders[], objects[],
nextToken }`. The folder-marker object equal to the prefix itself is filtered out of
`objects`. Page size is 500.

Every mutating route and every list/download writes an audit entry
(`storage_connection.*`, `storage.bucket_create`, `storage.bucket_delete`,
`storage.list`, `storage.download`, `storage.upload`, `storage.mkdir`,
`storage.rename`, `storage.delete`) with the bucket and key in metadata, matching the
`sftp.*` convention.

### 3.4 Web

Three pages, nav item **Object Storage** (`HardDrive` icon) between Servers and
Monitoring:

- `/storage` — connection cards (name, provider, endpoint/region, last test result)
  with Browse / Test / Edit / Delete. Add/Edit form: name, provider (AWS S3 / MinIO /
  Other S3-compatible), endpoint (hidden for AWS), region, access key ID, secret access
  key (blank on edit = keep), path-style checkbox (defaulted by provider).
- `/storage/:id` — bucket table (name, created) with Create bucket (admin) and Delete
  (admin; typed-name confirmation; "also delete contents" checkbox → `force`).
- `/storage/:id/buckets/:bucket` — object browser modelled on the SFTP Files page:
  breadcrumbs by prefix, folders first, size/modified columns, Upload (drag-drop and
  picker), New folder, Download, Rename, Delete (recursive prompt for folders),
  Load more for paginated listings, Refresh.

Controls are hidden by `useHasRole`, and independently enforced by the server.

## 4. Error handling

- All storage failures surface as `StorageError` with an HTTP status; the route's
  `sendError` mirrors `sftp.ts`. Unknown errors still bubble to the global handler as
  500.
- A failed "Test connection" is recorded on the row (`last_status = failed`,
  `last_error`) so the card shows it without re-testing.
- Uploads that exceed the cap destroy the request stream with a 413; lib-storage
  aborts the multipart upload so no orphan parts are left.
- Download streams release nothing (no pool), so no lease bookkeeping is needed.

## 5. Testing

Unit tests (vitest, pure functions, no network):

- `keys.test.ts` — key/prefix normalisation, traversal rejection, parent/basename,
  bucket-name validation, endpoint validation.
- `client.test.ts` — `toStorageError` mapping table; `buildClientConfig` defaults
  (region, endpoint omitted for AWS, path-style, checksum flags).
- `ops.test.ts` — `toListing` transformation (folders from `CommonPrefixes`, objects
  from `Contents`, marker filtered, token passthrough, `parent`).
- `api/routes/storage.test.ts` — route-level tests over `app.inject` with an in-memory
  DB, real auth and vault, and the S3 ops mocked: role gates, org scoping, the secret
  never returned, `force`/`recursive` only honoured when literally true, the upload
  cap answered before the body is read, and the client cache under concurrency.

Integration test `ops.integration.test.ts` runs only when
`SMT_TEST_S3_ENDPOINT`, `SMT_TEST_S3_ACCESS_KEY` and `SMT_TEST_S3_SECRET_KEY` are set
(skipped otherwise), and exercises create bucket → upload → list → download → rename →
delete → delete bucket against a real endpoint. It was run against a local MinIO
container during implementation.

## 6. Configuration & docs

- `SMT_STORAGE_MAX_UPLOAD_BYTES` (default 5 GiB) added to config, `.env.example`, and
  ARCHITECTURE.md.
- README gains a feature bullet and a short "Object Storage" section.
- ARCHITECTURE.md gains a module section, the table, the RBAC rows, and the route
  table.

## 7. Out of scope / follow-ups

- Presigned share links (`@aws-sdk/s3-request-presigner`) — small addition if wanted.
- Bucket policies, versioning, lifecycle, CORS.
- Object metadata/HEAD view, content-type editing.
- AI tools for storage (list/read objects from the assistant).
- Server-side copy/move of whole prefixes.
