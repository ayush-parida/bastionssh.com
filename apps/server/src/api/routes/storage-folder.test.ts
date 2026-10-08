import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

// Must run before `config` is imported: small limits so truncation needs only a few objects
vi.hoisted(() => {
  process.env.SMT_FOLDER_DOWNLOAD_MAX_FILES = '300';
  process.env.SMT_FOLDER_DOWNLOAD_MAX_BYTES = String(4 * 1024 * 1024);
});

import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { apiTokens, auditLog, memberships, organizations, users } from '../../db/schema.js';
import { generateApiToken } from '../../auth/token.js';
import type { Role } from '../../auth/middleware.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import { activeStreamCount } from '../sse.js';
import { readTarGz, readZip } from '../../archive/archive.test-helper.js';
import { SKIPPED_NOTE, TRUNCATED_NOTE } from '../../archive/index.js';
import { abortStorageFolderDownloads, estimatePrefix, resolveConnection } from '../../storage/index.js';
import { generatedBody, startFakeS3, type FakeS3 } from '../../storage/fake-s3.test-helper.js';

/**
 * Object Storage → Download folder against a fake S3 speaking real HTTP: the
 * SDK, the archive engine, the routes, auth, DB and audit are all real.
 */

function seedOrg(slug: string): string {
  const id = nanoid();
  getDb().insert(organizations).values({ id, name: slug, slug }).run();
  return id;
}

function seedUser(orgId: string, role: Role) {
  const db = getDb();
  const userId = nanoid();
  db.insert(users).values({ id: userId, email: `${userId}@test.local`, displayName: role }).run();
  db.insert(memberships).values({ userId, orgId, role }).run();
  const token = generateApiToken();
  db.insert(apiTokens)
    .values({
      id: nanoid(),
      userId,
      name: 'test',
      hashedToken: token.hashedToken,
      prefix: token.prefix,
      scopes: JSON.stringify(['read', 'write']),
    })
    .run();
  return { userId, headers: { authorization: `Bearer ${token.token}` } };
}

const until = async (cond: () => boolean, what: string, ms = 10_000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('storage folder download', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let s3: FakeS3;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;
  let connectionId: string;
  let base: string;

  const audits = () =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, connectionId), eq(auditLog.action, 'storage.folder_download')))
      .all()
      .map((row) => ({ actorId: row.actorId, ...(JSON.parse(row.metadata ?? '{}') as Record<string, unknown>) }));

  beforeAll(async () => {
    await runMigrations();
    s3 = await startFakeS3();
    orgId = seedOrg('org-folder');
    admin = seedUser(orgId, 'admin');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-other'), 'owner');
    app = await buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage/connections',
      headers: admin.headers,
      payload: { name: 'fake', provider: 'minio', endpoint: s3.endpoint, accessKeyId: 'AKIA', secretAccessKey: 'secret' },
    });
    expect(res.statusCode).toBe(201);
    connectionId = res.json().id;
    base = `/api/storage/connections/${connectionId}/buckets`;
  });

  afterAll(async () => {
    await app.close();
    await s3.close();
  });

  beforeEach(() => {
    s3.buckets.clear();
    s3.pageSize = 1000;
    s3.stats = { lists: 0, gets: [], abortedGets: [], completedGets: [] };
    getDb().delete(auditLog).where(eq(auditLog.action, 'storage.folder_download')).run();
  });

  it('zips a prefix across paginated listings: nested folders, many keys, unicode, empty folder markers', async () => {
    s3.pageSize = 7; // every folder listing takes several pages
    s3.put('photos', 'trip/a.txt', 'alpha');
    s3.put('photos', 'trip/', ''); // the folder's own marker: not a file in it
    s3.put('photos', 'trip/nested/deep/b.txt', 'bravo');
    s3.put('photos', 'trip/empty/', ''); // an empty folder, kept as one
    s3.put('photos', 'trip/données/été 🌞.txt', 'unicode');
    for (let i = 0; i < 120; i++) s3.put('photos', `trip/many/${String(i).padStart(3, '0')}.log`, `line ${i}\n`);
    s3.put('photos', 'trip-other/x.txt', 'not under trip/');
    s3.put('photos', 'other/y.txt', 'nor this');

    const res = await app.inject({ method: 'GET', url: `${base}/photos/folder?prefix=trip`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="trip.zip"; filename*=UTF-8''trip.zip`);
    const zip = await readZip(res.rawPayload);
    const names = zip.entries.map((e) => e.name);
    expect(names.slice(0, 5)).toEqual(['a.txt', 'données/', 'données/été 🌞.txt', 'empty/', 'many/']);
    expect(names.filter((n) => n.startsWith('many/') && n !== 'many/')).toHaveLength(120);
    expect(names.slice(-3)).toEqual(['nested/', 'nested/deep/', 'nested/deep/b.txt']);
    expect(names.some((n) => n.includes('trip-other') || n.includes('other/y'))).toBe(false);
    const data = (n: string) => zip.entries.find((e) => e.name === n)?.data?.toString();
    expect(data('a.txt')).toBe('alpha');
    expect(data('données/été 🌞.txt')).toBe('unicode');
    expect(data('many/042.log')).toBe('line 42\n');
    expect(data('nested/deep/b.txt')).toBe('bravo');
    expect(s3.stats.lists).toBeGreaterThan(20);
    expect(res.trailers['x-archive-summary']).toMatch(/^files=123; bytes=\d+; skipped=0; truncated=false$/);

    expect(audits()).toEqual([
      {
        actorId: admin.userId,
        bucket: 'photos',
        prefix: 'trip/',
        format: 'zip',
        files: 123,
        bytes: expect.any(Number),
        skipped: 0,
        truncated: false,
        aborted: false,
        durationMs: expect.any(Number),
      },
    ]);
    expect(activeStreamCount(admin.userId)).toBe(0);
  });

  it('serves the whole bucket as tar.gz, named after the bucket, to a viewer', async () => {
    s3.put('logs', 'a/1.txt', 'one');
    s3.put('logs', 'top.txt', 'top');
    const res = await app.inject({ method: 'GET', url: `${base}/logs/folder?format=tar.gz`, headers: viewer.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-disposition']).toMatch(/filename="logs\.tar\.gz"/);
    const entries = readTarGz(res.rawPayload);
    expect(entries.map((e) => [e.name, e.data.toString()])).toEqual([
      ['a/', ''],
      ['a/1.txt', 'one'],
      ['top.txt', 'top'],
    ]);
    expect(entries[1]!.mtime).toBe(Date.parse('2026-01-02T03:04:05Z') / 1000);
    expect(audits()[0]).toMatchObject({ actorId: viewer.userId, prefix: '', format: 'tar.gz', files: 2 });
  });

  it('leaves out keys whose segments cannot be archive names (.., empty, separators), listing them in _skipped.txt', async () => {
    s3.put('odd', 'base/ok.txt', 'ok');
    s3.put('odd', 'base/../escape.txt', 'climb');
    s3.put('odd', 'base/sub/..', 'dotdot file');
    s3.put('odd', 'base//double.txt', 'empty segment');
    s3.put('odd', 'base/back\\slash.txt', 'backslash');
    const res = await app.inject({ method: 'GET', url: `${base}/odd/folder?prefix=base/`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    const zip = await readZip(res.rawPayload);
    const names = zip.entries.map((e) => e.name);
    expect(names).toEqual(['back_slash.txt', 'ok.txt', 'sub/', SKIPPED_NOTE]);
    for (const n of names) {
      expect(n.split('/')).not.toContain('..');
      expect(n.startsWith('/')).toBe(false);
    }
    const skipped = zip.entries.find((e) => e.name === SKIPPED_NOTE)!.data!.toString();
    expect(skipped).toContain('..\tname cannot be stored in an archive');
    expect(skipped).toContain('sub/..\tname cannot be stored in an archive');
    expect(skipped.split('\n').filter((l) => l.includes('name cannot be stored'))).toHaveLength(3);
    // Nothing under a `..` key was ever fetched
    expect(s3.stats.gets.sort()).toEqual(['base/back\\slash.txt', 'base/ok.txt']);
    expect(audits()[0]).toMatchObject({ files: 2, skipped: 3 });
  });

  it('refuses a prefix with .. segments or a null byte, and a format it does not know', async () => {
    for (const prefix of ['a/../b', '..', 'a/\u0000']) {
      const res = await app.inject({
        method: 'GET',
        url: `${base}/photos/folder?prefix=${encodeURIComponent(prefix)}`,
        headers: admin.headers,
      });
      expect(res.statusCode).toBe(400);
    }
    const res = await app.inject({ method: 'GET', url: `${base}/photos/folder?format=rar`, headers: admin.headers });
    expect(res.statusCode).toBe(400);
    expect(s3.stats.lists).toBe(0);
  });

  it('answers a JSON 404 for a prefix with nothing under it, or a missing bucket, before any archive', async () => {
    s3.put('photos', 'a.txt', 'a');
    const missing = await app.inject({ method: 'GET', url: `${base}/photos/folder?prefix=nope/`, headers: admin.headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Nothing is stored under "nope/"' });
    const noBucket = await app.inject({ method: 'GET', url: `${base}/ghost/folder`, headers: admin.headers });
    expect(noBucket.statusCode).toBe(404);
    expect(audits()).toEqual([]);
    expect(activeStreamCount(admin.userId)).toBe(0);
  });

  it('hides the connection from another organisation', async () => {
    s3.put('photos', 'a.txt', 'a');
    for (const url of [`${base}/photos/folder`, `${base}/photos/folder/estimate`]) {
      const res = await app.inject({ method: 'GET', url, headers: outsider.headers });
      expect(res.statusCode).toBe(404);
    }
    expect(s3.stats.lists).toBe(0);
  });

  it('stops at SMT_FOLDER_DOWNLOAD_MAX_FILES with _TRUNCATED.txt, and does not list far past it', async () => {
    s3.pageSize = 50;
    for (let i = 0; i < 2000; i++) s3.put('big', `many/${String(i).padStart(4, '0')}`, 'x');
    const res = await app.inject({ method: 'GET', url: `${base}/big/folder?prefix=many/`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    const zip = await readZip(res.rawPayload);
    expect(zip.entries).toHaveLength(301);
    expect(zip.entries.at(-1)!.name).toBe(TRUNCATED_NOTE);
    expect(zip.entries.at(-1)!.data!.toString()).toMatch(/limit of 300 files and folders/);
    // The listing stopped once it held more than the archive could take (pages of 50)
    expect(s3.stats.lists).toBeLessThanOrEqual(8);
    expect(res.trailers['x-archive-summary']).toBe('files=300; bytes=300; skipped=0; truncated=true');
    expect(audits()[0]).toMatchObject({ files: 300, truncated: true, aborted: false });
  });

  it('stops before the file that would pass SMT_FOLDER_DOWNLOAD_MAX_BYTES', async () => {
    s3.put('big', 'blobs/1.bin', { size: 3 * 1024 * 1024 });
    s3.put('big', 'blobs/2.bin', { size: 3 * 1024 * 1024 });
    const res = await app.inject({ method: 'GET', url: `${base}/big/folder?prefix=blobs/&format=tar.gz`, headers: admin.headers });
    const entries = readTarGz(res.rawPayload);
    expect(entries.map((e) => e.name)).toEqual(['1.bin', TRUNCATED_NOTE]);
    expect(entries[0]!.data.equals(generatedBody(3 * 1024 * 1024))).toBe(true);
    expect(s3.stats.gets).toEqual(['blobs/1.bin']);
    expect(audits()[0]).toMatchObject({ files: 1, bytes: 3 * 1024 * 1024, truncated: true });
  });

  it('skips an object that vanished between listing and download, and carries on', async () => {
    // Listed, then deleted before GetObject: the fake answers NoSuchKey
    s3.put('photos', 'set/a.txt', { data: Buffer.from('a'), gone: true });
    s3.put('photos', 'set/b.txt', 'b');
    const res = await app.inject({ method: 'GET', url: `${base}/photos/folder?prefix=set/`, headers: admin.headers });
    const zip = await readZip(res.rawPayload);
    expect(zip.entries.map((e) => e.name)).toEqual(['b.txt', SKIPPED_NOTE]);
    expect(zip.entries[1]!.data!.toString()).toMatch(/^Left out.*\n\na\.txt\tcould not be opened: The specified key does not exist\./s);
  });

  describe('cancellation', () => {
    /**
     * Download over a real socket, calling `act` with the bytes received so
     * far — on every chunk and every 10 ms (the archive may sit still while an
     * object is being fetched) — until it says it has acted.
     */
    async function download(path: string, act: (got: number, req: http.ClientRequest) => boolean): Promise<void> {
      // Listening stays on for the rest of the suite; inject keeps working alongside it
      if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      let got = 0;
      let acted = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port, path, headers: admin.headers }, (res) => {
            res.on('data', (c: Buffer) => {
              got += c.length;
              if (!acted) acted = act(got, req);
            });
            res.on('close', () => resolve());
            res.on('error', () => resolve());
          });
          timer = setInterval(() => {
            if (!acted) acted = act(got, req);
          }, 10);
          req.on('error', () => resolve());
          setTimeout(() => reject(new Error('download did not stop')), 15_000);
        });
      } finally {
        clearInterval(timer);
      }
      expect(acted).toBe(true);
      await until(() => audits().length > 0, 'the audit row');
    }

    it('aborts the in-flight GetObject when the browser goes away mid-body', async () => {
      const pattern = randomBytes(256 * 1024);
      s3.put('big', 'stall/a.bin', { data: pattern });
      // Incompressible bytes, then the object stalls: the request is still open when the browser leaves
      s3.put('big', 'stall/b.bin', { size: 2 * 1024 * 1024, stallAfter: 512 * 1024 });
      s3.put('big', 'stall/c.bin', 'never fetched');
      await download(`${base}/big/folder?prefix=stall/`, (got, req) => {
        if (got < 256 * 1024 || !s3.stats.gets.includes('stall/b.bin')) return false;
        req.destroy();
        return true;
      });
      await until(() => s3.stats.abortedGets.includes('stall/b.bin'), 'the GetObject to be aborted');
      expect(s3.stats.completedGets).toEqual(['stall/a.bin']);
      expect(s3.stats.gets).not.toContain('stall/c.bin');
      expect(audits()[0]).toMatchObject({ aborted: true });
      expect(activeStreamCount(admin.userId)).toBe(0);
    });

    it('aborts a GetObject still waiting for its headers', async () => {
      s3.put('big', 'slow/a.bin', { data: randomBytes(256 * 1024) });
      s3.put('big', 'slow/b.bin', { size: 1024, delayMs: 5_000 });
      await download(`${base}/big/folder?prefix=slow/`, (got, req) => {
        if (got < 128 * 1024 || !s3.stats.gets.includes('slow/b.bin')) return false;
        req.destroy();
        return true;
      });
      await until(() => s3.stats.abortedGets.includes('slow/b.bin'), 'the pending GetObject to be aborted');
      expect(s3.stats.completedGets).toEqual(['slow/a.bin']);
      expect(audits()[0]).toMatchObject({ aborted: true });
    });

    it('ends the download when access to the connection is revoked, and spares it when the connection is kept', async () => {
      s3.put('big', 'rev/a.bin', { data: randomBytes(256 * 1024) });
      s3.put('big', 'rev/b.bin', { size: 2 * 1024 * 1024, stallAfter: 256 * 1024 });
      let kept = -1;
      let ended = -1;
      await download(`${base}/big/folder?prefix=rev/`, (got) => {
        if (got < 128 * 1024 || !s3.stats.gets.includes('rev/b.bin')) return false;
        // Narrowed, but this connection is still seen: nothing ends
        kept = revokeLiveAccess(admin.userId, { orgId, keepServerIds: [], keepStorageConnectionIds: [connectionId] }).storage ?? 0;
        ended = abortStorageFolderDownloads(admin.userId, { orgId, keepConnectionIds: ['some-other-connection'] });
        return true;
      });
      expect(kept).toBe(0);
      expect(ended).toBe(1);
      await until(() => s3.stats.abortedGets.includes('rev/b.bin'), 'the GetObject to be aborted');
      expect(audits()[0]).toMatchObject({ aborted: true });
    });

    it('ends the download when its connection is deleted', async () => {
      // A connection of its own: the rest of the suite keeps using the shared one
      const created = await app.inject({
        method: 'POST',
        url: '/api/storage/connections',
        headers: admin.headers,
        payload: { name: 'doomed', provider: 'minio', endpoint: s3.endpoint, accessKeyId: 'AKIA', secretAccessKey: 'secret' },
      });
      expect(created.statusCode).toBe(201);
      const doomed = created.json().id as string;
      s3.put('big', 'del/a.bin', { data: randomBytes(256 * 1024) });
      s3.put('big', 'del/b.bin', { size: 2 * 1024 * 1024, stallAfter: 256 * 1024 });
      if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      let deleted = -1;
      await new Promise<void>((resolve, reject) => {
        const path = `/api/storage/connections/${doomed}/buckets/big/folder?prefix=del/`;
        const req = http.get({ host: '127.0.0.1', port, path, headers: admin.headers }, (res) => {
          expect(res.statusCode).toBe(200);
          res.resume();
          res.on('close', () => resolve());
          res.on('error', () => resolve());
        });
        req.on('error', () => resolve());
        const timer = setInterval(() => {
          if (deleted !== -1 || !s3.stats.gets.includes('del/b.bin')) return;
          deleted = 0;
          void app
            .inject({ method: 'DELETE', url: `/api/storage/connections/${doomed}`, headers: admin.headers })
            .then((r) => (deleted = r.statusCode));
        }, 10);
        setTimeout(() => {
          clearInterval(timer);
          reject(new Error('download did not stop'));
        }, 15_000).unref();
        req.on('close', () => clearInterval(timer));
      });
      expect(deleted).toBe(204);
      await until(() => s3.stats.abortedGets.includes('del/b.bin'), 'the GetObject to be aborted');
      await until(() => activeStreamCount(admin.userId) === 0, 'the stream slot to be released');
      const row = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.resourceId, doomed), eq(auditLog.action, 'storage.folder_download')))
        .get();
      expect(JSON.parse(row?.metadata ?? '{}')).toMatchObject({ aborted: true });
    });
  });

  describe('estimate', () => {
    it('counts objects and bytes under a prefix, folder markers left out, with the limits', async () => {
      s3.pageSize = 3;
      s3.put('photos', 'trip/', '');
      s3.put('photos', 'trip/a.txt', 'alpha');
      s3.put('photos', 'trip/sub/', '');
      s3.put('photos', 'trip/sub/b.txt', 'bravo!');
      s3.put('photos', 'elsewhere.txt', 'nope');
      const res = await app.inject({ method: 'GET', url: `${base}/photos/folder/estimate?prefix=trip`, headers: viewer.headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        bucket: 'photos',
        prefix: 'trip/',
        files: 2,
        bytes: 11,
        complete: true,
        maxBytes: 4 * 1024 * 1024,
        maxFiles: 300,
      });
    });

    it('stops early and says so', async () => {
      for (let i = 0; i < 2500; i++) s3.put('big', `k/${i}`, 'xy');
      const { client } = await resolveConnection(orgId, connectionId);
      expect(await estimatePrefix(client, 'big', 'k/', { maxObjects: 1000 })).toEqual({ files: 1000, bytes: 2000, complete: false });
      expect(await estimatePrefix(client, 'big', 'k/')).toEqual({ files: 2500, bytes: 5000, complete: true });
      // A listing slower than the time allowed: whatever was counted, marked incomplete
      s3.pageSize = 1;
      const slow = await estimatePrefix(client, 'big', 'k/', { maxMs: 30 });
      expect(slow.complete).toBe(false);
      expect(slow.files).toBeLessThan(2500);
    });

    it('answers 404 for a missing bucket', async () => {
      const res = await app.inject({ method: 'GET', url: `${base}/ghost/folder/estimate`, headers: admin.headers });
      expect(res.statusCode).toBe(404);
    });
  });
});
