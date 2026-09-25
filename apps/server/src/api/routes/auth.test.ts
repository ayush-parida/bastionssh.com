import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { apiTokens, users } from '../../db/schema.js';
import { generateApiToken } from '../../auth/token.js';
import { hashPassword } from '../../auth/password.js';
import { seedOrg, seedUser } from './test-utils.js';

describe('auth routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: ReturnType<typeof seedUser>;
  let readHeaders: { authorization: string };
  let writeTokenId: string;

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('org-auth');
    owner = seedUser(orgId, 'owner');

    const db = getDb();
    // Stored mixed-case, as a seeded admin was before emails were normalized
    db.insert(users)
      .values({
        id: nanoid(),
        email: 'Jane@Corp.com',
        displayName: 'Jane',
        passwordHash: await hashPassword('jane-password'),
      })
      .run();

    const read = generateApiToken();
    db.insert(apiTokens)
      .values({
        id: nanoid(),
        userId: owner.userId,
        name: 'ci',
        hashedToken: read.hashedToken,
        prefix: read.prefix,
        scopes: JSON.stringify(['read']),
      })
      .run();
    readHeaders = { authorization: `Bearer ${read.token}` };
    writeTokenId = db.select().from(apiTokens).all().find((t) => t.name === 'test')!.id;

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('matches the login email case-insensitively', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'JANE@corp.COM', password: 'jane-password' },
    });
    // Jane has no membership, but the credentials were accepted
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('Jane@Corp.com');
  });

  describe('read-only API tokens', () => {
    it('can still read', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tokens', headers: readHeaders });
      expect(res.statusCode).toBe(200);
    });

    it('cannot revoke the owner’s other tokens', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/tokens/${writeTokenId}`,
        headers: readHeaders,
      });
      expect(res.statusCode).toBe(403);
      expect(getDb().select().from(apiTokens).all().some((t) => t.id === writeTokenId)).toBe(true);
    });

    it('cannot edit the profile', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/auth/me',
        headers: readHeaders,
        payload: { displayName: 'pwned' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('does not block a write token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/auth/me',
        headers: owner.headers,
        payload: { displayName: 'Owner' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  it('rate-limits login per client even when X-Forwarded-For changes', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
        payload: { email: 'nobody@corp.com', password: 'wrong' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toContain(429);
  });
});
