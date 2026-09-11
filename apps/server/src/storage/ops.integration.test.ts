import { describe, it, expect, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { createClient } from './client.js';
import * as ops from './ops.js';

/**
 * Runs only against a real S3-compatible endpoint, e.g. a local MinIO:
 *
 *   docker run -d -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin quay.io/minio/minio server /data
 *   SMT_TEST_S3_ENDPOINT=http://127.0.0.1:9000 SMT_TEST_S3_ACCESS_KEY=minioadmin SMT_TEST_S3_SECRET_KEY=minioadmin \
 *     pnpm vitest run src/storage/ops.integration.test.ts
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
    {
      provider: 'other',
      endpoint: endpoint ?? null,
      region: 'us-east-1',
      accessKeyId,
      forcePathStyle: true,
    },
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
    await ops.putObject(
      client,
      bucket,
      'docs/hello.txt',
      Readable.from([Buffer.from('hello world')]),
      'text/plain',
    );
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

  it('streams a multipart upload larger than one part', async () => {
    const size = 9 * 1024 * 1024; // above the 8 MiB part size → multipart path
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const body = Readable.from(Array.from({ length: 9 }, () => chunk));
    await ops.putObject(client, bucket, 'big.bin', body, 'application/octet-stream');

    const listing = await ops.listObjects(client, bucket, '');
    expect(listing.objects.find((o) => o.key === 'big.bin')?.size).toBe(size);

    const got = await ops.getObject(client, bucket, 'big.bin');
    expect(got.contentLength).toBe(size);
    expect((await drain(got.body)).length).toBe(size);
    await ops.deleteObject(client, bucket, 'big.bin');
  });

  it('maps a missing key and a missing bucket to 404', async () => {
    await expect(ops.getObject(client, bucket, 'nope.txt')).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(ops.listObjects(client, `${bucket}-missing`, '')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses to delete a non-empty bucket, then succeeds once emptied', async () => {
    await ops.putObject(client, bucket, 'keep.txt', Readable.from([Buffer.from('x')]));
    await expect(ops.deleteBucket(client, bucket)).rejects.toMatchObject({ statusCode: 409 });
    await ops.deletePrefix(client, bucket, '');
    await ops.deleteBucket(client, bucket);
    expect((await ops.listBuckets(client)).map((b) => b.name)).not.toContain(bucket);
  });
});
