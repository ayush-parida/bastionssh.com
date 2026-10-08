import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { writeFolderArchive } from '../archive/index.js';
import { collector, hasTool, run } from '../archive/archive.test-helper.js';
import { createClient } from './client.js';
import { estimatePrefix, prefixWalker } from './folder.js';
import * as ops from './ops.js';

/**
 * Folder downloads against a real S3-compatible endpoint (MinIO, SeaweedFS):
 * a nested prefix with a large object, a folder of more keys than one
 * listing page and unicode names is archived as zip and tar.gz, extracted
 * with the system unzip / tar and compared by checksum.
 *
 *   docker run -d --name smt-it-minio -p 19000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin quay.io/minio/minio server /data
 *   SMT_TEST_S3_ENDPOINT=http://127.0.0.1:19000 SMT_TEST_S3_ACCESS_KEY=minioadmin SMT_TEST_S3_SECRET_KEY=minioadmin \
 *     pnpm vitest run src/storage/folder.integration.test.ts
 */
const endpoint = process.env.SMT_TEST_S3_ENDPOINT;
const accessKeyId = process.env.SMT_TEST_S3_ACCESS_KEY ?? '';
const secret = process.env.SMT_TEST_S3_SECRET_KEY ?? '';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Every file under `dir`, by path relative to it, with its checksum. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p).normalize('NFC'), sha(readFileSync(p)));
    }
  };
  walk(dir);
  return out;
}

describe.skipIf(!endpoint)('storage folder download against a live endpoint', () => {
  const client = createClient(
    { provider: 'other', endpoint: endpoint ?? null, region: 'us-east-1', accessKeyId, forcePathStyle: true },
    secret,
  );
  const bucket = `smt-fd-${Date.now().toString(36)}`;
  const expected = new Map<string, string>();
  let work: string;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'smt-fd-'));
    await ops.createBucket(client, bucket, 'us-east-1');
    const put = async (key: string, body: Buffer) => {
      await ops.putObject(client, bucket, key, Readable.from([body]));
      expected.set(key.slice('root/'.length), sha(body));
    };
    await put('root/big.bin', randomBytes(24 * 1024 * 1024));
    await put('root/nested/deep/er/x.txt', Buffer.from('deep'));
    await put('root/données/été 🌞.txt', Buffer.from('unicode'));
    await ops.createFolder(client, bucket, 'root/empty/');
    const many = Array.from({ length: 1100 }, (_, i) => `root/many/${String(i).padStart(4, '0')}.txt`);
    for (let i = 0; i < many.length; i += 50) {
      await Promise.all(many.slice(i, i + 50).map((k) => put(k, Buffer.from(`file ${k}\n`))));
    }
    await ops.putObject(client, bucket, 'outside.txt', Readable.from([Buffer.from('not in root/')]));
  }, 240_000);

  afterAll(async () => {
    rmSync(work, { recursive: true, force: true });
    try {
      await ops.deletePrefix(client, bucket, '');
      await ops.deleteBucket(client, bucket);
    } catch {
      /* already gone */
    }
    client.destroy();
  }, 120_000);

  it('estimates the prefix', async () => {
    const estimate = await estimatePrefix(client, bucket, 'root/');
    expect(estimate.complete).toBe(true);
    expect(estimate.files).toBe(expected.size);
  });

  for (const format of ['zip', 'tar.gz'] as const) {
    it.skipIf(!hasTool(format === 'zip' ? 'unzip' : 'tar'))(`round-trips through ${format}`, async () => {
      const out = collector();
      const summary = await writeFolderArchive(prefixWalker(client, bucket, { maxEntries: 100_000 }), out, {
        format,
        rootRef: 'root/',
        maxBytes: 1024 ** 3,
        maxFiles: 100_000,
        signal: new AbortController().signal,
      });
      out.end();
      expect(summary).toMatchObject({ files: expected.size, skipped: 0, truncated: false, aborted: false });
      const file = join(work, `out.${format}`);
      const dir = join(work, format.replace('.', '-'));
      writeFileSync(file, out.result());
      run('mkdir', ['-p', dir]);
      if (format === 'zip') run('unzip', ['-q', file, '-d', dir]);
      else run('tar', ['-xzf', file, '-C', dir]);
      expect(tree(dir)).toEqual(expected);
      expect(statSync(join(dir, 'empty')).isDirectory()).toBe(true);
    }, 240_000);
  }
});
