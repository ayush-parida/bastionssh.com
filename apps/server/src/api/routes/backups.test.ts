import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import Database from 'better-sqlite3';

// A real file database and backup directory: backups of :memory: are refused
const env = vi.hoisted(() => {
  // Hoisted above the imports, so plain require
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('os') as typeof import('os');
  const dir = mkdtempSync(`${tmpdir()}/smt-backup-routes-`);
  process.env.SMT_DB_URL = `${dir}/smt.db`;
  process.env.SMT_BACKUP_DIR = `${dir}/backups`;
  process.env.SMT_BACKUP_STORAGE_CONNECTION_ID = 'conn-1';
  process.env.SMT_BACKUP_STORAGE_BUCKET = 'offsite';
  process.env.SMT_BACKUP_STORAGE_PREFIX = 'smt';
  return { dir, backups: `${dir}/backups` };
});

const fake = vi.hoisted(() => ({
  upload: vi.fn(async (_file: string, _name: string, _target: unknown) => {}),
}));
vi.mock('../../backup/upload.js', () => ({ uploadBackup: fake.upload }));

import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb, getRawDb } from '../../db/index.js';
import { auditLog, passkeys, sessions } from '../../db/schema.js';
import { seedOrg, seedSession, seedUser } from './test-utils.js';

describe('database backup routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: ReturnType<typeof seedUser>;
  let ownerCookie: { cookie: string };
  let admin: ReturnType<typeof seedUser>;
  let otherOwner: ReturnType<typeof seedUser>;
  let otherOwnerCookie: { cookie: string };

  beforeAll(async () => {
    await runMigrations();
    // The first org is the instance's
    orgId = seedOrg('instance');
    const otherOrg = seedOrg('tenant');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    otherOwner = seedUser(otherOrg, 'owner');
    ownerCookie = (await seedSession(owner.userId)).headers;
    otherOwnerCookie = (await seedSession(otherOwner.userId)).headers;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    getRawDb().close();
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  function audits(action: string) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)))
      .all();
  }

  it('is for owners only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/backups', headers: admin.headers });
    expect(res.statusCode).toBe(403);
    const post = await app.inject({ method: 'POST', url: '/api/admin/backups', headers: admin.headers });
    expect(post.statusCode).toBe(403);
  });

  it("is refused to an owner of another organization, whose data is not theirs to take", async () => {
    for (const headers of [otherOwner.headers, otherOwnerCookie]) {
      const res = await app.inject({ method: 'GET', url: '/api/admin/backups', headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/first organization/);
    }
  });

  it('lists nothing at first, with the settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/backups', headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      backups: [],
      settings: {
        directory: env.backups,
        intervalHours: 24,
        keep: 14,
        gzip: false,
        preMigration: true,
        upload: { bucket: 'offsite', prefix: 'smt' },
      },
    });
    // Listing (which the page refetches) is not audited; creating and downloading are
    await app.inject({ method: 'GET', url: '/api/admin/backups', headers: owner.headers });
    expect(audits('backup.list')).toHaveLength(0);
  });

  let name: string;

  it('takes a manual backup, uploads it, and audits it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/backups', headers: owner.headers });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ backup: { reason: 'manual', compressed: false }, uploaded: true });
    name = body.backup.name;
    expect(name).toMatch(/^smt-\d{8}T\d{6}Z-manual\.db$/);
    expect(fake.upload).toHaveBeenCalledWith(path.join(env.backups, name), name, {
      connectionId: 'conn-1',
      bucket: 'offsite',
      prefix: 'smt',
    });

    const list = await app.inject({ method: 'GET', url: '/api/admin/backups', headers: owner.headers });
    expect(list.json().backups).toEqual([body.backup]);

    const [entry] = audits('backup.create');
    expect(entry).toMatchObject({ actorId: owner.userId, resourceName: name });
    expect(JSON.parse(entry!.metadata!)).toMatchObject({ reason: 'manual', uploaded: true });
  });

  it('records a failed upload without failing the backup', async () => {
    fake.upload.mockRejectedValueOnce(new Error('bucket gone'));
    const res = await app.inject({ method: 'POST', url: '/api/admin/backups', headers: owner.headers });
    expect(res.statusCode).toBe(201);
    expect(res.json().uploaded).toBe(false);
    const [failed] = audits('backup.upload_failed');
    expect(JSON.parse(failed!.metadata!)).toMatchObject({ bucket: 'offsite', error: 'bucket gone' });
  });

  it('downloads only from a browser session, never with an API token', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/admin/backups/${name}/download`, headers: owner.headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/signed-in browser/);
  });

  it('streams the backup to the owner', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/admin/backups/${name}/download`, headers: ownerCookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.sqlite3');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${name}"`);
    expect(res.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(res.rawPayload.length).toBe(fs.statSync(path.join(env.backups, name)).size);

    // The copy carries no live sessions: a download is not a pile of session cookies
    const copy = path.join(env.dir, 'downloaded.db');
    fs.writeFileSync(copy, res.rawPayload);
    const db = new Database(copy, { readonly: true });
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n).toBeGreaterThan(0);
    db.close();

    expect(audits('backup.download')).toHaveLength(1);
  });

  it('asks an owner with a passkey to confirm it first', async () => {
    getDb()
      .insert(passkeys)
      .values({
        id: nanoid(),
        userId: owner.userId,
        credentialId: nanoid(),
        publicKey: Buffer.from([1, 2, 3]),
        deviceType: 'multiDevice',
        name: 'Laptop',
      })
      .run();
    const session = await seedSession(owner.userId);
    const refused = await app.inject({
      method: 'GET',
      url: `/api/admin/backups/${name}/download`,
      headers: session.headers,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');

    getDb().update(sessions).set({ passkeyVerified: true }).where(eq(sessions.id, session.sessionId)).run();
    const ok = await app.inject({ method: 'GET', url: `/api/admin/backups/${name}/download`, headers: session.headers });
    expect(ok.statusCode).toBe(200);
  });

  it('only serves names it could have written, from the backup directory', async () => {
    const session = await seedSession(owner.userId);
    getDb().update(sessions).set({ passkeyVerified: true }).where(eq(sessions.id, session.sessionId)).run();
    fs.writeFileSync(path.join(env.dir, 'secret.txt'), 'nope');
    fs.symlinkSync(path.join(env.dir, 'secret.txt'), path.join(env.backups, 'smt-20260101T000000Z-manual.db'));

    const cases: [string, number][] = [
      ['..%2Fsecret.txt', 400],
      ['..%2F..%2Fetc%2Fpasswd', 400],
      ['%2Fetc%2Fpasswd', 400],
      ['smt.db', 400],
      [`${encodeURIComponent('../')}${name}`, 400],
      ['smt-20260101T000000Z-manual.db.partial', 400],
      // Well-formed but missing, and a symlink planted under a valid name
      ['smt-20250101T000000Z-manual.db', 404],
      ['smt-20260101T000000Z-manual.db', 404],
    ];
    for (const [param, status] of cases) {
      const res = await app.inject({ method: 'GET', url: `/api/admin/backups/${param}/download`, headers: session.headers });
      expect({ param, status: res.statusCode }).toEqual({ param, status });
    }
    // And the listing does not show the symlink either
    const list = await app.inject({ method: 'GET', url: '/api/admin/backups', headers: owner.headers });
    expect(list.json().backups.map((b: { name: string }) => b.name)).not.toContain('smt-20260101T000000Z-manual.db');
  });
});
