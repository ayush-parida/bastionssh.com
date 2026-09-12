import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Readable } from 'node:stream';
import { nanoid } from 'nanoid';

// Must run before `config` is imported: a tiny cap lets the upload guard be
// exercised with a handful of bytes.
vi.hoisted(() => {
  process.env.SMT_STORAGE_MAX_UPLOAD_BYTES = '16';
});

// No network: every S3 call is replaced, but the routes, auth, DB, vault and
// key handling around them are real.
vi.mock('../../storage/ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/ops.js')>();
  return {
    ...actual,
    testConnection: vi.fn(async () => ({ ok: true, bucketCount: 1 })),
    deletePrefix: vi.fn(async () => 2),
    deleteBucket: vi.fn(async () => {}),
    deleteObject: vi.fn(async () => {}),
    putObject: vi.fn(async (_c: unknown, _b: string, _k: string, body: Readable) => {
      for await (const _chunk of body) {
        /* drain */
      }
    }),
  };
});

import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { apiTokens, memberships, organizations, users } from '../../db/schema.js';
import { generateApiToken } from '../../auth/token.js';
import type { Role } from '../../auth/middleware.js';
import * as ops from '../../storage/ops.js';
import { resolveConnection } from '../../storage/index.js';

function seedOrg(slug: string): string {
  const id = nanoid();
  getDb().insert(organizations).values({ id, name: slug, slug }).run();
  return id;
}

/** A user in `orgId` with a read+write API token, so requests carry their real role. */
function seedUser(orgId: string, role: Role) {
  const db = getDb();
  const userId = nanoid();
  db.insert(users)
    .values({ id: userId, email: `${userId}@test.local`, displayName: role })
    .run();
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

const connectionBody = {
  name: 'minio',
  provider: 'minio',
  endpoint: 'http://127.0.0.1:9',
  accessKeyId: 'AKIA',
  secretAccessKey: 'shh-secret',
};

describe('storage routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;
  let connectionId: string;

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-a');
    admin = seedUser(orgId, 'admin');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-b'), 'owner');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets an admin create a connection and never returns the secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage/connections',
      headers: admin.headers,
      payload: connectionBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    connectionId = body.id;
    expect(body.accessKeyId).toBe('AKIA');
    expect(body.forcePathStyle).toBe(true); // MinIO default
    expect(JSON.stringify(body)).not.toContain('shh-secret');
    expect(Object.keys(body).some((k) => /secret/i.test(k))).toBe(false);
  });

  it('refuses a viewer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage/connections',
      headers: viewer.headers,
      payload: connectionBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts preset providers and still requires their endpoint', async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/storage/connections',
        headers: admin.headers,
        payload: { ...connectionBody, ...payload },
      });

    const r2 = await post({
      name: 'r2',
      provider: 'r2',
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      region: 'auto',
    });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().provider).toBe('r2');

    const gcsNoEndpoint = await post({ name: 'gcs', provider: 'gcs', endpoint: null });
    expect(gcsNoEndpoint.statusCode).toBe(400);

    const unknown = await post({ name: 'x', provider: 'nope' });
    expect(unknown.statusCode).toBe(400);
  });

  it('hides a connection from another organisation', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/storage/connections/${connectionId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('only empties a bucket when force is literally true', async () => {
    const deletePrefix = vi.mocked(ops.deletePrefix);
    for (const suffix of ['', '?force=false', '?force=0']) {
      deletePrefix.mockClear();
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/storage/connections/${connectionId}/buckets/media${suffix}`,
        headers: admin.headers,
      });
      expect(res.statusCode, suffix).toBe(200);
      expect(deletePrefix, suffix).not.toHaveBeenCalled();
    }

    deletePrefix.mockClear();
    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/storage/connections/${connectionId}/buckets/media?force=true`,
      headers: admin.headers,
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toEqual({ bucket: 'media', deletedObjects: 2 });
    expect(deletePrefix).toHaveBeenCalledWith(expect.anything(), 'media', '');
  });

  it('deletes a single object when recursive is false', async () => {
    const deletePrefix = vi.mocked(ops.deletePrefix);
    const deleteObject = vi.mocked(ops.deleteObject);
    deletePrefix.mockClear();
    deleteObject.mockClear();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/storage/connections/${connectionId}/buckets/media/object?key=photos/cat.jpg&recursive=false`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(deleteObject).toHaveBeenCalledWith(expect.anything(), 'media', 'photos/cat.jpg');
    expect(deletePrefix).not.toHaveBeenCalled();
  });

  it('rejects an upload the declared length says is over the cap, before reading it', async () => {
    const putObject = vi.mocked(ops.putObject);
    putObject.mockClear();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/storage/connections/${connectionId}/buckets/media/object?key=big.bin`,
      headers: { ...admin.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(32),
    });
    expect(res.statusCode).toBe(413);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('accepts an upload under the cap', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/storage/connections/${connectionId}/buckets/media/object?key=small.bin`,
      headers: { ...admin.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(8),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ bucket: 'media', key: 'small.bin', size: 8 });
  });

  it('answers 400, not 500, when the upload body is not a raw stream', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/storage/connections/${connectionId}/buckets/media/object?key=x.json`,
      headers: admin.headers,
      // Small enough to clear the length precheck, so the body-type guard is what answers
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a viewer upload', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/storage/connections/${connectionId}/buckets/media/object?key=x.bin`,
      headers: { ...viewer.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(1),
    });
    expect(res.statusCode).toBe(403);
  });

  it('hands concurrent first requests the same cached client', async () => {
    // Editing the row invalidates the cache, so the next two resolves both miss
    await app.inject({
      method: 'PATCH',
      url: `/api/storage/connections/${connectionId}`,
      headers: admin.headers,
      payload: { name: 'renamed' },
    });
    const [a, b] = await Promise.all([
      resolveConnection(orgId, connectionId),
      resolveConnection(orgId, connectionId),
    ]);
    expect(a.client).toBe(b.client);
  });
});
