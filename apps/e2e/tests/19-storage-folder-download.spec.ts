import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { startFakeS3, type FakeS3 } from '../../server/src/storage/fake-s3.test-helper.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env.js';
import { expect, ownerApi, signInWithPassword, test } from './fixtures.js';

/**
 * Object Storage → Download folder, end to end: a fake S3 (real HTTP, in this
 * process) behind a storage connection, the dialog's estimate and format
 * choice, and the archive saved both ways the page can save it.
 */

/** Entry names and contents of a zip written with data descriptors (as the server writes them). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

let s3: FakeS3;
let connectionId: string;

test.beforeAll(async () => {
  s3 = await startFakeS3();
  s3.put('e2e-bucket', 'reports/', '');
  s3.put('e2e-bucket', 'reports/summary.txt', 'quarterly summary');
  s3.put('e2e-bucket', 'reports/2026/q1.csv', 'a,b\n1,2\n');
  s3.put('e2e-bucket', 'reports/2026/données.txt', 'unicode');
  s3.put('e2e-bucket', 'reports/empty/', '');
  s3.put('e2e-bucket', 'elsewhere.txt', 'not in reports/');
  const owner = await ownerApi();
  const res = await owner.post('/api/storage/connections', {
    data: { name: 'E2E fake S3', provider: 'minio', endpoint: s3.endpoint, accessKeyId: 'AKIA', secretAccessKey: 'secret' },
  });
  expect(res.status(), await res.text()).toBe(201);
  connectionId = ((await res.json()) as { id: string }).id;
  await owner.dispose();
});

test.afterAll(async () => {
  const owner = await ownerApi();
  await owner.delete(`/api/storage/connections/${connectionId}`);
  await owner.dispose();
  await s3.close();
});

test('downloads a folder through the browser when it cannot save to a file itself', async ({ page }) => {
  // As in Firefox and Safari: no File System Access API
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/storage/${connectionId}/buckets/e2e-bucket`);
  await page.getByRole('button', { name: 'Download folder reports' }).click();

  const dialog = page.getByRole('dialog', { name: /Download folder reports\// });
  await expect(dialog).toContainText('This folder holds 3 files, 32 B, subfolders included.');
  await expect(dialog.getByRole('radio', { name: /\.zip/ })).toBeChecked();

  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('reports.zip');
  const entries = unzip(readFileSync((await download.path())!));
  expect([...entries.keys()]).toEqual(['2026/', '2026/données.txt', '2026/q1.csv', 'empty/', 'summary.txt']);
  expect(entries.get('2026/q1.csv')).toBe('a,b\n1,2\n');
  await expect(dialog).toContainText('Saved reports.zip');
});

test('streams the whole bucket into the file picked, as tar.gz', async ({ page }) => {
  // Stand-in for Chromium's save dialog: the bytes land in a page variable
  await page.addInitScript(() => {
    const w = window as unknown as { showSaveFilePicker: unknown; __saved: { name: string; bytes: number[]; closed: boolean } };
    w.__saved = { name: '', bytes: [], closed: false };
    w.showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => {
      w.__saved.name = suggestedName;
      return {
        createWritable: async () => ({
          write: async (chunk: Uint8Array) => {
            w.__saved.bytes.push(...chunk);
          },
          close: async () => {
            w.__saved.closed = true;
          },
          abort: async () => {},
        }),
      };
    };
  });
  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/storage/${connectionId}/buckets/e2e-bucket`);
  await page.getByRole('button', { name: 'Download folder', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: /Download folder e2e-bucket/ });
  await expect(dialog).toContainText('The whole bucket holds 4 files');
  await dialog.getByRole('radio', { name: /\.tar\.gz/ }).check();
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(dialog).toContainText(/Saved e2e-bucket\.tar\.gz \(\d+(\.\d+)? (B|KB)\)/);

  const saved = await page.evaluate(() => (window as unknown as { __saved: { name: string; bytes: number[]; closed: boolean } }).__saved);
  expect(saved.name).toBe('e2e-bucket.tar.gz');
  expect(saved.closed).toBe(true);
  // gzip magic
  expect(saved.bytes.slice(0, 2)).toEqual([0x1f, 0x8b]);
});
