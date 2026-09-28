import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditForwarders, auditLog, organizations, passkeys } from '../../db/schema.js';
import { decryptConfig } from '../../audit/forward.js';
import { csvCell } from './audit.js';
import { seedOrg, seedUser } from './test-utils.js';

type Headers = Record<string, string>;

describe('audit routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: ReturnType<typeof seedUser>;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;

  function row(values: Partial<typeof auditLog.$inferInsert> & { action: string; createdAt: string }, org = orgId) {
    getDb()
      .insert(auditLog)
      .values({
        id: nanoid(),
        orgId: org,
        actorId: 'u-x',
        actorEmail: 'jane@corp.test',
        resourceType: 'server',
        ...values,
      })
      .run();
  }

  const get = (url: string, headers: Headers) => app.inject({ method: 'GET', url, headers });
  const put = (url: string, payload: unknown, headers: Headers) =>
    app.inject({ method: 'PUT', url, payload: payload as object, headers });

  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();
    orgId = seedOrg('audit-routes');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');

    row({ action: 'server.create', resourceId: 's1', resourceName: 'web-1', createdAt: '2026-01-01T09:00:00.000Z' });
    row({
      action: 'user.login_failed',
      actorEmail: 'Mallory@Evil.test',
      resourceType: 'user',
      userAgent: '=HYPERLINK("http://evil.test","x")',
      metadata: JSON.stringify({ reason: 'bad_password', note: 'a,b "c"' }),
      createdAt: '2026-01-02T09:00:00.000Z',
    });
    row({ action: 'user.login_locked', resourceType: 'user', createdAt: '2026-01-02T23:59:59.000Z' });
    row({ action: 'server.delete', resourceId: 's1', createdAt: '2026-01-03T09:00:00.000Z' });
    // Another org's history never shows up
    row({ action: 'server.create', createdAt: '2026-01-02T10:00:00.000Z' }, seedOrg('audit-other'));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('list filters', () => {
    it('filters by action prefix, actor and a date range', async () => {
      const users = await get('/api/audit?action=user.*', admin.headers);
      expect(users.json().items.map((i: { action: string }) => i.action).sort()).toEqual([
        'user.login_failed',
        'user.login_locked',
      ]);
      expect(users.json().total).toBe(2);

      const mallory = await get('/api/audit?actorEmail=mallory@evil.test', admin.headers);
      expect(mallory.json().total).toBe(1);

      // A bare "to" date takes in that whole day
      const day = await get('/api/audit?from=2026-01-02&to=2026-01-02&resourceType=user', admin.headers);
      expect(day.json().total).toBe(2);
    });

    it('rejects a malformed filter instead of ignoring it', async () => {
      expect((await get('/api/audit?from=yesterday', admin.headers)).statusCode).toBe(400);
      expect((await get('/api/audit?action=user.%25', admin.headers)).statusCode).toBe(400);
    });
  });

  describe('export', () => {
    it('streams CSV oldest first, with spreadsheet formulas defused', async () => {
      const res = await get('/api/audit/export?format=csv&from=2026-01-01&to=2026-01-03', admin.headers);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename\*=UTF-8''audit-audit-routes-\d{4}-\d{2}-\d{2}\.csv/);
      const lines = res.body.trim().split('\r\n');
      expect(lines[0]).toBe(
        'createdAt,id,actorId,actorEmail,action,resourceType,resourceId,resourceName,ipAddress,userAgent,metadata',
      );
      expect(lines.slice(1).map((l) => l.split(',')[4])).toEqual([
        'server.create',
        'user.login_failed',
        'user.login_locked',
        'server.delete',
      ]);
      expect(res.body).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
      expect(res.body).toContain('"{""reason"":""bad_password"",""note"":""a,b \\""c\\""""}"');
    });

    it('exports JSON Lines with the same filters, and records the export', async () => {
      const res = await get('/api/audit/export?format=jsonl&action=user.login_failed', admin.headers);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/x-ndjson/);
      const lines = res.body.trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ action: 'user.login_failed', metadata: { reason: 'bad_password' }, orgId });

      const recorded = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'audit.export')))
        .all()
        .map((r) => JSON.parse(r.metadata!));
      expect(recorded).toContainEqual({ format: 'jsonl', filters: { action: 'user.login_failed' } });
    });

    it('is for admins and up', async () => {
      expect((await get('/api/audit/export', operator.headers)).statusCode).toBe(403);
    });

    it('csvCell quotes and defuses', () => {
      expect(csvCell(null)).toBe('');
      expect(csvCell('plain')).toBe('plain');
      expect(csvCell('-1+2')).toBe("'-1+2");
      expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
      expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    });
  });

  describe('retention', () => {
    it('defaults to a year, and only the owner changes it, within bounds', async () => {
      const settings = await get('/api/audit/settings', admin.headers);
      expect(settings.statusCode).toBe(200);
      expect(settings.json()).toEqual({ retentionDays: 365, forwarding: null });
      expect((await get('/api/audit/settings', operator.headers)).statusCode).toBe(403);

      expect((await put('/api/audit/settings/retention', { retentionDays: 90 }, admin.headers)).statusCode).toBe(403);
      expect((await put('/api/audit/settings/retention', { retentionDays: 1 }, owner.headers)).statusCode).toBe(400);
      expect((await put('/api/audit/settings/retention', { retentionDays: 99999 }, owner.headers)).statusCode).toBe(400);

      const res = await put('/api/audit/settings/retention', { retentionDays: 90 }, owner.headers);
      expect(res.statusCode).toBe(200);
      expect(getDb().select().from(organizations).where(eq(organizations.id, orgId)).get()?.auditRetentionDays).toBe(90);
      const change = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'audit.retention_update')))
        .get();
      expect(JSON.parse(change!.metadata!)).toEqual({ from: 365, to: 90 });
    });

    it('needs a passkey-verified session when the owner has a passkey', async () => {
      const org = seedOrg('audit-stepup');
      const withKey = seedUser(org, 'owner');
      getDb()
        .insert(passkeys)
        .values({
          id: nanoid(),
          userId: withKey.userId,
          credentialId: `cred-${nanoid()}`,
          publicKey: Buffer.from([1]),
          transports: '[]',
          deviceType: 'singleDevice',
          backedUp: false,
          name: 'Key',
        })
        .run();
      const res = await put('/api/audit/settings/retention', { retentionDays: 30 }, withKey.headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');
    });
  });

  describe('forwarding', () => {
    it('refuses internal and metadata targets', async () => {
      for (const body of [
        { type: 'syslog', host: '127.0.0.1', port: 514, protocol: 'udp' },
        { type: 'syslog', host: '10.0.0.8', port: 6514, protocol: 'tls' },
        { type: 'webhook', url: 'https://169.254.169.254/latest/meta-data' },
        { type: 'webhook', url: 'https://[::1]/hook' },
      ]) {
        const res = await put('/api/audit/forwarding', body, owner.headers);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error).toMatch(/Refusing to connect/);
      }
      expect(getDb().select().from(auditForwarders).where(eq(auditForwarders.orgId, orgId)).get()).toBeUndefined();
    });

    it('refuses plain HTTP to a public address, and bad input', async () => {
      const http = await put('/api/audit/forwarding', { type: 'webhook', url: 'http://203.0.113.10/hook' }, owner.headers);
      expect(http.statusCode).toBe(400);
      expect(http.json().error).toMatch(/https/);
      expect((await put('/api/audit/forwarding', { type: 'webhook', url: 'ftp://x/' }, owner.headers)).statusCode).toBe(400);
      expect((await put('/api/audit/forwarding', { type: 'webhook' }, owner.headers)).statusCode).toBe(400);
      expect(
        (await put('/api/audit/forwarding', { type: 'syslog', host: 'a b', port: 514, protocol: 'udp' }, owner.headers)).statusCode,
      ).toBe(400);
      expect(
        (await put('/api/audit/forwarding', { type: 'syslog', host: '203.0.113.10', port: 514, protocol: 'tls', caCert: 'nope' }, owner.headers))
          .statusCode,
      ).toBe(400);
    });

    it('is owner-only', async () => {
      const body = { type: 'syslog', host: '203.0.113.10', port: 514, protocol: 'udp' };
      expect((await put('/api/audit/forwarding', body, admin.headers)).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: '/api/audit/forwarding', headers: admin.headers })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/audit/forwarding/test', headers: admin.headers })).statusCode).toBe(403);
    });

    it('vaults the webhook URL and secret, never returns them, and keeps the secret unless told otherwise', async () => {
      const url = 'https://203.0.113.10/services/hook-token-123';
      const res = await put('/api/audit/forwarding', { type: 'webhook', url, secret: 'sign-me' }, owner.headers);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        type: 'webhook',
        enabled: true,
        targetHint: '203.0.113.10/services/…',
        webhook: { hasSecret: true },
        lastStatus: null,
      });
      expect(res.body).not.toContain('hook-token-123');
      expect(res.body).not.toContain('sign-me');

      const stored = getDb().select().from(auditForwarders).where(eq(auditForwarders.orgId, orgId)).get()!;
      expect(JSON.stringify(stored)).not.toContain('hook-token-123');
      expect(JSON.stringify(stored)).not.toContain('sign-me');
      expect(await decryptConfig(stored)).toEqual({ type: 'webhook', url, secret: 'sign-me' });
      // Starts after the existing history
      expect(stored.cursorCreatedAt >= '2026-01-03T09:00:00.000Z').toBe(true);

      const settings = await get('/api/audit/settings', admin.headers);
      expect(settings.body).not.toContain('hook-token-123');

      // Toggle without resending the URL or secret
      const off = await put('/api/audit/forwarding', { type: 'webhook', enabled: false }, owner.headers);
      expect(off.json()).toMatchObject({ enabled: false, webhook: { hasSecret: true } });
      const cleared = await put('/api/audit/forwarding', { type: 'webhook', secret: '' }, owner.headers);
      expect(cleared.json()).toMatchObject({ enabled: false, webhook: { hasSecret: false } });

      const updates = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'audit.forwarding_update')))
        .all();
      expect(updates).toHaveLength(3);
      expect(JSON.stringify(updates)).not.toContain('sign-me');
      expect(JSON.stringify(updates)).not.toContain('hook-token-123');
    });

    it('switches to syslog, sends a test event, and deletes', async () => {
      const res = await put(
        '/api/audit/forwarding',
        { type: 'syslog', host: '203.0.113.10', port: 514, protocol: 'udp', enabled: true },
        owner.headers,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        type: 'syslog',
        targetHint: 'udp://203.0.113.10:514',
        syslog: { host: '203.0.113.10', port: 514, protocol: 'udp', facility: 13, hasCaCert: false },
      });

      // UDP is fire-and-forget, so a public test address "accepts" it
      const test = await app.inject({ method: 'POST', url: '/api/audit/forwarding/test', headers: owner.headers });
      expect(test.statusCode).toBe(200);
      expect(test.json()).toEqual({ ok: true });

      const del = await app.inject({ method: 'DELETE', url: '/api/audit/forwarding', headers: owner.headers });
      expect(del.statusCode).toBe(204);
      expect((await app.inject({ method: 'DELETE', url: '/api/audit/forwarding', headers: owner.headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/audit/forwarding/test', headers: owner.headers })).statusCode).toBe(404);

      const actions = getDb()
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.orgId, orgId))
        .all()
        .map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['audit.forwarding_test', 'audit.forwarding_delete']));
    });
  });
});
