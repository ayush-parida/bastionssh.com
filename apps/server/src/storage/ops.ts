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

export function createBucket(client: S3Client, bucket: string, rawRegion: string): Promise<void> {
  const region = rawRegion.trim();
  return run('Could not create bucket', async () => {
    await client.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // S3 rejects a LocationConstraint of us-east-1 and requires one everywhere else.
        ...(region && region !== DEFAULT_REGION
          ? {
              CreateBucketConfiguration: {
                LocationConstraint: region as BucketLocationConstraint,
              },
            }
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
  /** Forwarded as-is so a gzip-stored object is not served as plain bytes. */
  contentEncoding: string | null;
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
      contentEncoding: out.ContentEncoding ?? null,
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
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: prefix, Body: '', ContentLength: 0 }),
    );
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

export function copyObject(
  client: S3Client,
  bucket: string,
  from: string,
  to: string,
): Promise<void> {
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
 *
 * Runs to completion inside one request: a million objects is a thousand
 * sequential round-trips. Acceptable for a management console; a job queue
 * would be the next step if that ever hurts.
 */
export async function deletePrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<number> {
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
