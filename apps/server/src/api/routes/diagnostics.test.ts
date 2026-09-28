import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Must run before `config` is imported: a fixed egress IP means no lookup ever
// leaves the machine, and the remediation text is predictable.
vi.hoisted(() => {
  process.env.SMT_EGRESS_IP = '49.43.168.212';
});

// No network: the probes get fake dns/net/tls, so the routes, auth, per-server
// access, audit and the step runner around them are what is under test.
vi.mock('../../diagnostics/steps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../diagnostics/steps.js')>();
  const { fakeDeps } = await import('../../diagnostics/fakes.test-helper.js');
  return { ...actual, defaultDeps: fakeDeps() };
});

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { DiagnosticsResult } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, ftpConnections, storageConnections } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

describe('diagnostics routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let restricted: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let serverA: string;
  let serverB: string;
  let otherOrgServer: string;
  let ftpId: string;
  let storageId: string;

  const post = (who: { headers: Record<string, string> }, url: string, payload: object = {}) =>
    app.inject({ method: 'POST', url, headers: who.headers, payload });

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-diag');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    restricted = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    serverA = seedServer(orgId, admin.userId, 'alpha');
    serverB = seedServer(orgId, admin.userId, 'bravo');
    const otherOrg = seedOrg('org-diag-other');
    otherOrgServer = seedServer(otherOrg, seedUser(otherOrg, 'admin').userId, 'elsewhere');

    const db = getDb();
    ftpId = nanoid();
    db.insert(ftpConnections)
      .values({
        id: ftpId,
        orgId,
        name: 'shared host',
        host: 'ftp.example.com',
        port: 22,
        protocol: 'sftp',
        username: 'deploy',
        encryptedPassword: await vault.encrypt('shh-secret', ftpId),
        createdBy: admin.userId,
      })
      .run();
    storageId = nanoid();
    db.insert(storageConnections)
      .values({
        id: storageId,
        orgId,
        name: 'minio',
        endpoint: 'http://minio.example.com:9000',
        accessKeyId: 'AKIAEXAMPLE',
        encryptedSecretAccessKey: await vault.encrypt('secret', storageId),
        createdBy: admin.userId,
      })
      .run();

    app = await buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/team/members/${restricted.userId}/access`,
      headers: admin.headers,
      payload: { serverAccess: 'restricted', serverIds: [serverA] },
    });
    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('diagnoses a server step by step without logging in', async () => {
    const res = await post(operator, `/api/diagnostics/servers/${serverA}`);
    expect(res.statusCode).toBe(200);
    const result = res.json() as DiagnosticsResult;
    expect(result.target).toMatchObject({ kind: 'server', id: serverA, host: '10.0.0.1', port: 22, protocol: 'ssh' });
    expect(result.steps.map((s) => s.id)).toEqual(['dns', 'tcp', 'banner', 'host_key', 'auth']);
    expect(result.steps.at(-1)!.status).toBe('skipped');
    expect(result.egressIp).toBe('49.43.168.212');

    const row = getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'server.diagnose'), eq(auditLog.resourceId, serverA)))
      .get();
    expect(row).toBeDefined();
    expect(JSON.parse(row!.metadata!)).toMatchObject({ auth: false });
  });

  it('logs in only when asked, and explains missing credentials', async () => {
    const res = await post(operator, `/api/diagnostics/servers/${serverB}`, { auth: true });
    expect(res.statusCode).toBe(200);
    const auth = (res.json() as DiagnosticsResult).steps.find((s) => s.id === 'auth')!;
    expect(auth.status).toBe('fail');
    expect(auth.remediation).toContain('SSH key or password');
  });

  it('is operator and up', async () => {
    const res = await post(viewer, `/api/diagnostics/servers/${serverA}`);
    expect(res.statusCode).toBe(403);
  });

  it('hides servers a restricted member was not granted', async () => {
    expect((await post(restricted, `/api/diagnostics/servers/${serverB}`)).statusCode).toBe(404);
    expect((await post(restricted, `/api/diagnostics/servers/${serverA}`)).statusCode).toBe(200);
  });

  it('never reaches another org’s server', async () => {
    expect((await post(admin, `/api/diagnostics/servers/${otherOrgServer}`)).statusCode).toBe(404);
  });

  it('diagnoses an SFTP connection including its host key', async () => {
    const res = await post(operator, `/api/diagnostics/ftp/${ftpId}`);
    expect(res.statusCode).toBe(200);
    const result = res.json() as DiagnosticsResult;
    expect(result.target).toMatchObject({ kind: 'ftp_connection', protocol: 'sftp' });
    const hostKey = result.steps.find((s) => s.id === 'host_key')!;
    // Nothing pinned yet: the key is shown, the first connection would trust it
    expect(hostKey.status).toBe('warn');
    expect((await post(operator, `/api/diagnostics/ftp/${nanoid()}`)).statusCode).toBe(404);
  });

  it('diagnoses a storage endpoint', async () => {
    const res = await post(operator, `/api/diagnostics/storage/${storageId}`);
    expect(res.statusCode).toBe(200);
    const result = res.json() as DiagnosticsResult;
    expect(result.target).toMatchObject({ kind: 'storage_connection', host: 'minio.example.com', port: 9000, protocol: 'http' });
    // The fake port speaks SSH, which is not HTTP
    expect(result.failedStep).toBe('banner');
  });

  it('reports the configured egress IP', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/diagnostics/egress-ip', headers: viewer.headers });
    expect(res.statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/api/diagnostics/egress-ip', headers: operator.headers });
    expect(ok.json()).toMatchObject({ ip: '49.43.168.212', source: 'configured' });
  });

  it('rate limits runs per user', async () => {
    const busy = seedUser(orgId, 'operator');
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(busy, `/api/diagnostics/servers/${serverA}`)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    // Someone else is unaffected
    expect((await post(admin, `/api/diagnostics/servers/${serverA}`)).statusCode).toBe(200);
  });
});
