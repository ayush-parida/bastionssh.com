import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { servers } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { seedOrg, seedUser } from './test-utils.js';

describe('server routes: default key ownership', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  let otherAdmin: ReturnType<typeof seedUser>;
  let ownKeyId: string;
  let foreignKeyId: string;

  const newKey = async (headers: Record<string, string>) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/keys/generate',
        headers,
        payload: { name: 'k', type: 'ed25519' },
      })
    ).json().key.id as string;

  const serverBody = (defaultKeyId: string) => ({
    name: 'web',
    host: '10.0.0.5',
    username: 'root',
    authType: 'key',
    defaultKeyId,
  });

  beforeAll(async () => {
    await runMigrations();
    admin = seedUser(seedOrg('org-srv-a'), 'admin');
    otherAdmin = seedUser(seedOrg('org-srv-b'), 'admin');
    app = await buildApp();
    await app.ready();
    ownKeyId = await newKey(admin.headers);
    foreignKeyId = await newKey(otherAdmin.headers);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a key from the caller org', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: admin.headers,
      payload: serverBody(ownKeyId),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().defaultKeyId).toBe(ownKeyId);
  });

  it("rejects another org's key on create", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: admin.headers,
      payload: serverBody(foreignKeyId),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects another org's key on update and leaves the server unchanged", async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: admin.headers,
      payload: serverBody(ownKeyId),
    });
    const id = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${id}`,
      headers: admin.headers,
      payload: { authType: 'key', defaultKeyId: foreignKeyId },
    });
    expect(res.statusCode).toBe(400);
    const row = getDb().select().from(servers).where(eq(servers.id, id)).get()!;
    expect(row.defaultKeyId).toBe(ownKeyId);
  });
});
