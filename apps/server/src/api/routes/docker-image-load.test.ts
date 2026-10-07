import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Uploading an image archive (`POST …/images/load`) end to end through the
 * real pool, detection and client, into the fake daemon's `/images/load`
 * (actions-daemon.test-helper.ts) behind a stand-in ssh2. Under test: the
 * archive streamed through whole (plain and gzipped), the size cap before
 * and during the upload with nothing loaded, refusing what is not an
 * archive, the platform check, what a tag replaced and its unused-only
 * cleanup, the role matrix, the per-user stream cap, and the audit rows.
 */
vi.hoisted(() => {
  process.env.SMT_DOCKER_IMAGE_UPLOAD_MAX_BYTES = String(64 * 1024);
});

const fake = vi.hoisted(() => ({
  options: { daemonSocket: '', cli: true } as import('../../docker/fake-daemon.test-helper.js').FakeSshOptions,
  log: { streamlocal: [] as string[], exec: [] as string[] },
}));

vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const { fakeSshMethods } = await import('../../docker/fake-daemon.test-helper.js');
  // Methods and a closure map only — class fields in a vi.mock factory break the import
  const channels = new WeakMap<object, Set<import('node:net').Socket>>();
  class Client extends EventEmitter {
    constructor() {
      super();
      const open = new Set<import('node:net').Socket>();
      channels.set(this, open);
      Object.assign(
        this,
        fakeSshMethods(
          () => fake.options,
          fake.log,
          (s) => {
            open.add(s);
            s.on('close', () => open.delete(s));
          },
        ),
      );
    }
    connect() {
      setImmediate(() => this.emit('ready'));
      return this;
    }
    end() {
      for (const s of channels.get(this) ?? []) s.destroy();
      setImmediate(() => this.emit('close'));
      return this;
    }
  }
  return { ...actual, default: { ...(actual as { default?: object }).default, Client }, Client };
});

import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { and, desc, eq } from 'drizzle-orm';
import type { DockerImageLoadResult } from '@smt/shared';
import { buildApp } from '../app.js';
import { MAX_REPORTED_IMAGES } from './docker-image-load.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, servers } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { activeStreamCount, MAX_STREAMS_PER_USER } from '../sse.js';
import { startFakeDaemon, type FakeDaemon } from '../../docker/fake-daemon.test-helper.js';
import { fakeEngine, imageArchive, type FakeEngine } from '../../docker/actions-daemon.test-helper.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

const LIMIT = 64 * 1024;

function events(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
}

const until = async (check: () => boolean, ms = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('docker image load route', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let daemon: FakeDaemon;
  let engine: FakeEngine;
  let base: string;
  let orgId: string;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let serverA: string;
  let serverB: string;

  const path = (server = serverA, name = 'app.tar') => `/api/docker/servers/${server}/images/load?name=${encodeURIComponent(name)}`;
  const upload = (who: Who, body: Buffer, server = serverA, name?: string) =>
    app.inject({
      method: 'POST',
      url: path(server, name),
      headers: { ...who.headers, 'content-type': 'application/octet-stream' },
      payload: body,
    });
  const loaded = (body: string) => events(body).find((e) => e.type === 'loaded')?.result as DockerImageLoadResult | undefined;

  function audits(action: string) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action as 'docker.image_load'), eq(auditLog.orgId, orgId)))
      .orderBy(desc(auditLog.createdAt))
      .all()
      .map((r) => ({ ...r, meta: JSON.parse(r.metadata ?? '{}') as Record<string, unknown> }));
  }
  /** The audit row is written after the stream ended, so possibly just after the response. */
  async function lastLoadAudit(count: number) {
    await until(() => audits('docker.image_load').length >= count);
    return audits('docker.image_load')[0]!;
  }

  async function withPassword(orgOf: string, createdBy: string, name: string) {
    const id = seedServer(orgOf, createdBy, name);
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', id) })
      .where(eq(servers.id, id))
      .run();
    return id;
  }

  beforeAll(async () => {
    engine = fakeEngine();
    daemon = await startFakeDaemon(engine.options);
    fake.options.daemonSocket = daemon.socketPath;
    await runMigrations();
    orgId = seedOrg('org-docker-load');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');
    serverA = await withPassword(orgId, admin.userId, 'alpha');
    serverB = await withPassword(orgId, admin.userId, 'bravo');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const grant = await app.inject({
      method: 'PUT',
      url: `/api/team/members/${restricted.userId}/access`,
      headers: admin.headers,
      payload: { serverAccess: 'restricted', serverIds: [serverA] },
    });
    expect(grant.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await daemon.close();
  });

  beforeEach(() => {
    fake.options = { daemonSocket: daemon.socketPath, cli: true };
  });

  it('tells the Docker tab the upload limit', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/docker/servers/${serverA}`, headers: operator.headers });
    expect(res.json().imageUploadMaxBytes).toBe(LIMIT);
  });

  it('streams a plain archive into the engine and reports what it loaded, audited', async () => {
    const archive = imageArchive({ tags: ['shop-web:latest'], seed: 'plain' });
    const before = audits('docker.image_load').length;
    const res = await upload(operator, archive, serverA, 'shop-web.tar');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    const got = events(res.body);
    expect(got[0]).toEqual({ type: 'uploaded', bytes: archive.length, format: 'tar' });
    expect(got).toContainEqual({ type: 'load', progress: { id: 'abcdef012345', status: 'Loading layer', current: 512, total: 1024 } });
    expect(got).toContainEqual({ type: 'load', progress: { id: null, status: 'Loaded image: shop-web:latest', current: null, total: null } });
    expect(got.at(-1)).toEqual({ type: 'end' });

    const result = loaded(res.body)!;
    expect(result).toMatchObject({ bytes: archive.length, format: 'tar', serverPlatform: 'linux/amd64', warnings: [] });
    expect(result.images).toEqual([
      {
        ref: 'shop-web:latest',
        id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        os: 'linux',
        architecture: 'amd64',
        variant: null,
        size: 100,
        replacedId: null,
        platformMismatch: false,
      },
    ]);
    // The engine got the whole archive, byte for byte
    expect(engine.loads.at(-1)).toEqual({ bytes: archive.length, complete: true, loaded: ['shop-web:latest'] });

    const row = await lastLoadAudit(before + 1);
    expect(row).toMatchObject({ actorId: operator.userId, resourceType: 'server', resourceId: serverA, resourceName: 'alpha' });
    expect(row.meta).toEqual({
      file: 'shop-web.tar',
      bytes: archive.length,
      format: 'tar',
      outcome: 'loaded',
      images: [{ ref: 'shop-web:latest', id: result.images[0]!.id, platform: 'linux/amd64', replaced: null }],
    });
  });

  it('hands a gzipped archive to the engine as it is', async () => {
    const archive = gzipSync(imageArchive({ tags: ['shop-api:1.0'], seed: 'gz' }));
    const res = await upload(admin, archive);
    expect(res.statusCode).toBe(200);
    expect(events(res.body)[0]).toEqual({ type: 'uploaded', bytes: archive.length, format: 'gzip' });
    expect(loaded(res.body)!.images.map((i) => i.ref)).toEqual(['shop-api:1.0']);
    // Not decompressed on the way: the engine received the gzip bytes
    expect(engine.loads.at(-1)!.bytes).toBe(archive.length);
  });

  it('reports an untagged image by its id', async () => {
    const res = await upload(operator, imageArchive({ tags: [], seed: 'untagged' }));
    const [image] = loaded(res.body)!.images;
    expect(image).toMatchObject({ ref: null, id: expect.stringMatching(/^sha256:/) });
  });

  it('warns when the image is built for another architecture than the server', async () => {
    const before = audits('docker.image_load').length;
    const res = await upload(operator, imageArchive({ tags: ['knexbi-website:arm'], architecture: 'arm64', seed: 'arm' }));
    const result = loaded(res.body)!;
    expect(result.images[0]).toMatchObject({ architecture: 'arm64', platformMismatch: true });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/knexbi-website:arm is built for linux\/arm64, but this server is linux\/amd64/);
    expect(result.warnings[0]).toMatch(/exec format error/);
    expect(result.warnings[0]).toMatch(/--platform linux\/amd64/);
    expect((await lastLoadAudit(before + 1)).meta).toMatchObject({ outcome: 'loaded', platformMismatch: true });
  });

  it('says which image a moved tag replaced, and removes it only when nothing uses it', async () => {
    const first = loaded((await upload(operator, imageArchive({ tags: ['blog:latest'], seed: 'v1' }))).body)!.images[0]!;
    const second = loaded((await upload(operator, imageArchive({ tags: ['blog:latest'], seed: 'v2' }))).body)!.images[0]!;
    expect(second.replacedId).toBe(first.id);
    expect(second.id).not.toBe(first.id);

    const remove = (who: Who, id: string, query = 'unused=1') =>
      app.inject({ method: 'DELETE', url: `/api/docker/servers/${serverA}/images/${encodeURIComponent(id)}?${query}`, headers: who.headers });
    // The unused-only cleanup needs what an upload needs; any other removal still needs `remove`
    expect((await remove(viewer, first.id)).statusCode).toBe(403);
    expect((await remove(operator, first.id, '')).statusCode).toBe(403);
    expect((await remove(operator, first.id, 'force=1')).statusCode).toBe(403);
    expect((await remove(operator, 'blog:latest', '')).statusCode).toBe(403);
    // Still tagged: kept, for operators too
    expect((await remove(operator, second.id)).statusCode).toBe(409);
    const tagged = await remove(admin, second.id);
    expect(tagged.statusCode).toBe(409);
    expect(tagged.json().error).toMatch(/still tagged blog:latest/);
    // A container still runs the old image: kept
    daemon.containers.push({ Id: 'e'.repeat(64), Names: ['/blog-web-1'], Image: first.id, ImageID: first.id, State: 'running', Status: 'Up' });
    const used = await remove(admin, first.id);
    expect(used.statusCode).toBe(409);
    expect(used.json().error).toMatch(/container blog-web-1 still uses/);
    daemon.containers.pop();
    // Only by full id, never forced
    expect((await remove(admin, 'blog:latest')).statusCode).toBe(400);
    expect((await remove(admin, first.id, 'unused=1&force=1')).statusCode).toBe(400);

    // An operator may clean up the image nothing uses any more
    const removed = await remove(operator, first.id);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ untagged: [], deleted: [first.id] });
    expect(engine.images.some((i) => i.Id === first.id)).toBe(false);
    expect(engine.images.find((i) => i.Id === second.id)!.RepoTags).toEqual(['blog:latest']);
    expect(audits('docker.image_remove')[0]!.meta).toMatchObject({ image: first.id, unusedOnly: true, force: false });
  });

  it('lists and audits at most MAX_REPORTED_IMAGES of an archive naming many tags, counting the rest', async () => {
    const before = audits('docker.image_load').length;
    const tags = Array.from({ length: MAX_REPORTED_IMAGES + 20 }, (_, i) => `many:${i}`);
    const res = await upload(operator, imageArchive({ tags, seed: 'many' }));
    expect(res.statusCode).toBe(200);
    const result = loaded(res.body)!;
    expect(result.images).toHaveLength(MAX_REPORTED_IMAGES);
    expect(result.warnings).toContain(`Docker loaded ${tags.length} images; only the first ${MAX_REPORTED_IMAGES} are listed and checked here.`);
    const { meta } = await lastLoadAudit(before + 1);
    expect(meta.images).toHaveLength(MAX_REPORTED_IMAGES);
    expect(meta.imagesLoaded).toBe(tags.length);
  });

  it('refuses an upload over the limit before reading it, with nothing sent to the engine', async () => {
    const loads = engine.loads.length;
    const res = await upload(operator, Buffer.alloc(LIMIT + 1));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('The image archive is larger than this BastionSSH accepts (64 KiB)');
    expect(res.headers.connection).toBe('close');
    expect(engine.loads.length).toBe(loads);
  });

  it('stops an upload that grows past the limit mid-way: 413, audited, and nothing loaded', async () => {
    const images = engine.images.length;
    const before = audits('docker.image_load').length;
    const archive = imageArchive({ tags: ['too:big'], padding: 2 * LIMIT, seed: 'big' });
    // Chunked, without a length: the limit can only be noticed while it streams
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(`${base}${path()}`, {
        method: 'POST',
        headers: { ...operator.headers, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
      });
      req.on('response', (res) => {
        let text = '';
        res.on('data', (d: Buffer) => (text += d.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      let at = 0;
      const pump = () => {
        if (at >= archive.length) return req.end();
        req.write(archive.subarray(at, at + 8192));
        at += 8192;
        setTimeout(pump, 2);
      };
      pump();
    });
    expect(status).toBe(413);
    expect(JSON.parse(body).error).toMatch(/larger than this BastionSSH accepts/);
    await until(() => engine.loads.at(-1)?.complete === false);
    expect(engine.loads.at(-1)!.bytes).toBeLessThanOrEqual(LIMIT);
    expect(engine.images.length).toBe(images);
    const { meta } = await lastLoadAudit(before + 1);
    expect(meta.outcome).toBe('too_large');
    expect(meta.bytes).toBeGreaterThan(LIMIT);
  });

  it('refuses what is not an image archive before the engine gets any of it', async () => {
    const images = engine.images.length;
    const loads = engine.loads.length;
    const res = await upload(operator, Buffer.from('<html>not a tar</html>'.repeat(40)));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not an image archive/);
    expect(engine.loads.slice(loads).every((l) => l.bytes === 0 && !l.complete)).toBe(true);
    expect(engine.images.length).toBe(images);
    const empty = await upload(operator, Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
  });

  it('wants the archive as the raw body', async () => {
    const res = await app.inject({ method: 'POST', url: path(), headers: operator.headers, payload: { image: 'x' } });
    expect(res.statusCode).toBe(415);
  });

  it('is for operators and up, on servers they can access', async () => {
    const archive = imageArchive({ tags: ['perm:1'] });
    expect((await upload(viewer, archive)).statusCode).toBe(403);
    expect((await upload(restricted, archive, serverB)).statusCode).toBe(404);
    expect((await upload(restricted, archive)).statusCode).toBe(200);
    expect((await upload(admin, archive, 'nope')).statusCode).toBe(404);
    const otherOrg = seedOrg('org-docker-load-other');
    expect((await upload(seedUser(otherOrg, 'owner'), archive)).statusCode).toBe(404);
  });

  it(`counts against the ${MAX_STREAMS_PER_USER} streams a user may hold, from the start of the request`, async () => {
    const who = seedUser(orgId, 'operator');
    const aborts: AbortController[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
      const abort = new AbortController();
      aborts.push(abort);
      const res = await fetch(`${base}/api/docker/servers/${serverA}/events`, { headers: who.headers, signal: abort.signal });
      expect(res.status).toBe(200);
      void res.body!.getReader().read().catch(() => {});
    }
    await until(() => activeStreamCount(who.userId) === MAX_STREAMS_PER_USER);
    const refused = await upload(who, imageArchive({ tags: ['cap:1'] }));
    expect(refused.statusCode).toBe(429);
    for (const a of aborts) a.abort();
    await until(() => activeStreamCount(who.userId) === 0);

    // While an upload is in flight it holds a place: a ninth stream is refused
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const req = http.request(`${base}${path()}`, {
      method: 'POST',
      headers: { ...who.headers, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
    });
    req.on('error', () => {});
    req.write(imageArchive({ tags: ['cap:2'] }).subarray(0, 1024));
    await until(() => activeStreamCount(who.userId) === 1);
    req.destroy();
    release();
    await slow;
    await until(() => activeStreamCount(who.userId) === 0);
  });
});
