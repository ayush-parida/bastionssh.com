import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_STREAMS_PER_USER, activeStreamCount, reserveStream, type StreamReservation } from '../api/sse.js';
import { dir, fakeWalker, file, readTarGz, readZip, type FakeNode } from './archive.test-helper.js';
import { TRUNCATED_NOTE } from './driver.js';
import { abortFolderDownloads, sendFolderArchive, type FolderDownloadResult } from './http.js';
import type { ArchiveFormat } from './types.js';

/** The Fastify side of folder downloads: headers, the stream cap, listing errors, disconnects and the outcome. */

const USER = 'u-folder-dl';

function appFor(
  tree: FakeNode,
  opts: { format?: ArchiveFormat; maxFiles?: number; rootRef?: string } = {},
): { app: FastifyInstance; results: FolderDownloadResult[]; walker: ReturnType<typeof fakeWalker> } {
  const results: FolderDownloadResult[] = [];
  const walker = fakeWalker(tree);
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.user = { id: USER, email: '', displayName: '' } as typeof req.user;
    req.orgId = 'org-folder-dl';
  });
  app.get('/download', async (req, reply) => {
    try {
      await sendFolderArchive(req, reply, {
        resourceId: 'srv-1',
        walker,
        rootRef: opts.rootRef ?? '',
        folderName: 'données',
        format: opts.format ?? 'zip',
        maxFiles: opts.maxFiles,
        onDone: (r) => {
          results.push(r);
        },
      });
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });
  return { app, results, walker };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('sendFolderArchive', () => {
  it('streams a zip with attachment headers, a summary trailer and one outcome; frees the stream slot', async () => {
    const t = appFor(dir({ 'a.txt': file('alpha'), sub: dir({ 'b.txt': file('bravo') }) }));
    app = t.app;
    const res = await app.inject('/download');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="donn_es.zip"; filename*=UTF-8''donn%C3%A9es.zip`,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const zip = await readZip(res.rawPayload);
    expect(zip.entries.map((e) => e.name)).toEqual(['a.txt', 'sub/', 'sub/b.txt']);
    expect(res.trailers['x-archive-summary']).toBe('files=2; bytes=10; skipped=0; truncated=false');
    expect(t.results).toEqual([
      { files: 2, bytes: 10, skipped: 0, truncated: false, aborted: false, format: 'zip', durationMs: expect.any(Number) },
    ]);
    expect(t.walker.stats.closed).toBe(true);
    expect(activeStreamCount(USER)).toBe(0);
  });

  it('serves tar.gz and records truncation', async () => {
    const t = appFor(dir({ a: file('1'), b: file('2'), c: file('3') }), { format: 'tar.gz', maxFiles: 2 });
    app = t.app;
    const res = await app.inject('/download');
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-disposition']).toMatch(/filename\*=UTF-8''donn%C3%A9es\.tar\.gz$/);
    expect(readTarGz(res.rawPayload).map((e) => e.name)).toEqual(['a', 'b', TRUNCATED_NOTE]);
    expect(t.results[0]).toMatchObject({ files: 2, truncated: true, format: 'tar.gz' });
  });

  it('rejects before any header when the folder itself cannot be listed', async () => {
    const t = appFor(dir({}), { rootRef: '\u0001missing' });
    app = t.app;
    const res = await app.inject('/download');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'No such file: \u0001missing' });
    expect(t.results).toEqual([]);
    expect(t.walker.stats.closed).toBe(true);
    expect(activeStreamCount(USER)).toBe(0);
  });

  it(`answers 429 when the user already holds ${MAX_STREAMS_PER_USER} streams`, async () => {
    const t = appFor(dir({ 'a.txt': file('a') }));
    app = t.app;
    const held: StreamReservation[] = [];
    const fakeReq = { user: { id: USER }, orgId: 'org-folder-dl' } as Parameters<typeof reserveStream>[0];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) held.push(reserveStream(fakeReq, { feature: 'docker', resourceId: 'x' })!);
    try {
      const res = await app.inject('/download');
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatch(/Too many downloads/);
      expect(t.walker.stats.closed).toBe(true);
    } finally {
      for (const h of held) h.release();
    }
  });

  it('cancels the remote read when the browser disconnects, and when access is revoked', async () => {
    for (const how of ['disconnect', 'revoke'] as const) {
      let produced = 0;
      // Incompressible, so bytes on the wire track bytes read
      const pattern = randomBytes(1024 * 1024);
      const t = appFor(dir({ 'big.bin': { type: 'file', size: 2 * 1024 ** 3, pattern, onRead: (n) => (produced += n) } }));
      app = t.app;
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/download' }, (res) => {
          let got = 0;
          res.on('data', (c: Buffer) => {
            got += c.length;
            if (got > 1024 * 1024 && got - c.length <= 1024 * 1024) {
              if (how === 'disconnect') req.destroy();
              else abortFolderDownloads(USER, { orgId: 'org-folder-dl' });
            }
          });
          res.on('close', () => resolve());
          res.on('error', () => resolve());
        });
        req.on('error', () => resolve());
        setTimeout(() => reject(new Error('download did not stop')), 15_000);
      });
      for (let i = 0; i < 100 && t.results.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(t.results[0]).toMatchObject({ aborted: true });
      expect(produced).toBeLessThan(256 * 1024 * 1024);
      expect(t.walker.stats.destroyed).toEqual(['big.bin']);
      expect(t.walker.stats.closed).toBe(true);
      expect(activeStreamCount(USER)).toBe(0);
      await app.close();
      app = undefined;
    }
  });
});
