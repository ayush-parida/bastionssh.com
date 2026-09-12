import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { CloudInstance } from '@smt/shared';

// No network: the provider adapter is replaced, everything around it is real.
const provider = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<CloudInstance[]> => []),
}));
vi.mock('../../cloud/providers/index.js', () => ({
  getProvider: () => ({ listInstances: provider.list }),
}));

import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { servers } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { CloudError } from '../../cloud/types.js';
import { isMonitored } from '../../monitoring/scheduler.js';
import { seedOrg, seedUser } from './test-utils.js';

const inst = (over: Partial<CloudInstance>): CloudInstance => ({
  id: 'h1',
  name: 'web-1',
  region: 'fsn1',
  state: 'running',
  publicIp: '1.2.3.4',
  privateIp: '10.0.0.2',
  tags: ['env:prod'],
  instanceType: 'cx22',
  ...over,
});

const hetznerBody = {
  name: 'Hetzner prod',
  provider: 'hetzner',
  token: 'hcloud-token-secret-value',
  defaultUsername: 'deploy',
};

describe('cloud account routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;
  let accountId: string;

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-cloud');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-cloud-b'), 'owner');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a viewer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cloud/accounts',
      headers: viewer.headers,
      payload: hetznerBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects credentials the provider refuses, before storing anything', async () => {
    provider.list.mockRejectedValueOnce(new CloudError('The provider rejected the credentials', 403));
    const res = await app.inject({
      method: 'POST',
      url: '/api/cloud/accounts',
      headers: admin.headers,
      payload: hetznerBody,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('rejected');

    const list = await app.inject({ method: 'GET', url: '/api/cloud/accounts', headers: admin.headers });
    expect(list.json()).toEqual([]);
  });

  it('requires the credential shape that matches the provider', async () => {
    for (const payload of [
      { name: 'x', provider: 'aws' },
      { name: 'x', provider: 'hetzner' },
      { name: 'x', provider: 'aws', token: 'not-for-aws-accounts' },
      { name: 'x', provider: 'gcp', token: 'unknown-provider-token' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/cloud/accounts',
        headers: admin.headers,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('creates an account and never returns the token', async () => {
    provider.list.mockResolvedValueOnce([inst({})]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/cloud/accounts',
      headers: admin.headers,
      payload: hetznerBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    accountId = body.id;
    expect(body.provider).toBe('hetzner');
    expect(body.credentialHint).toBe('…alue');
    expect(body.defaultUsername).toBe('deploy');
    expect(body.lastSummary).toBeNull();
    expect(JSON.stringify(body)).not.toContain('hcloud-token');
    expect(Object.keys(body).some((k) => /credential|token/i.test(k) && k !== 'credentialHint')).toBe(false);
  });

  it('lets an operator sync, which imports the instances as servers', async () => {
    provider.list.mockResolvedValueOnce([
      inst({ id: 'h1', name: 'web-1' }),
      inst({ id: 'h2', name: 'db-1', publicIp: '5.6.7.8', state: 'stopped' }),
      inst({ id: 'h3', name: 'no-ip', publicIp: null, privateIp: null }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/cloud/accounts/${accountId}/sync`,
      headers: operator.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ discovered: 3, created: 2, updated: 0, missing: 0, skipped: 1 });

    const list = await app.inject({ method: 'GET', url: '/api/servers', headers: viewer.headers });
    const imported = (list.json() as { name: string; host: string; username: string; tags: string[]; cloud: { provider: string; instanceId: string; state: string } | null }[])
      .filter((s) => s.cloud?.provider === 'hetzner');
    expect(imported).toHaveLength(2);
    const web = imported.find((s) => s.cloud!.instanceId === 'h1')!;
    expect(web).toMatchObject({ name: 'web-1', host: '1.2.3.4', username: 'deploy' });
    expect(web.tags).toEqual(['cloud:hetzner', 'fsn1', 'env:prod']);
    const db = imported.find((s) => s.cloud!.instanceId === 'h2')!;
    expect(db.cloud!.state).toBe('stopped');

    const account = (await app.inject({ method: 'GET', url: '/api/cloud/accounts', headers: viewer.headers })).json()[0];
    expect(account.lastStatus).toBe('ok');
    expect(account.lastSummary).toEqual({ discovered: 3, created: 2, updated: 0, missing: 0, skipped: 1 });
  });

  it('keeps user edits, refreshes the host, and marks vanished instances missing', async () => {
    const row = getDb().select().from(servers).where(eq(servers.cloudInstanceId, 'h1')).get()!;
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${row.id}`,
      headers: admin.headers,
      payload: { name: 'my-web', tags: ['custom'] },
    });
    expect(rename.statusCode).toBe(200);

    provider.list.mockResolvedValueOnce([inst({ id: 'h1', publicIp: '9.9.9.9' })]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/cloud/accounts/${accountId}/sync`,
      headers: operator.headers,
    });
    expect(res.json()).toEqual({ discovered: 1, created: 0, updated: 1, missing: 1, skipped: 0 });

    const after = getDb().select().from(servers).where(eq(servers.cloudAccountId, accountId)).all();
    const web = after.find((s) => s.cloudInstanceId === 'h1')!;
    expect(web).toMatchObject({ name: 'my-web', host: '9.9.9.9', tags: '["custom"]', cloudState: 'running' });
    const db = after.find((s) => s.cloudInstanceId === 'h2')!;
    expect(db.cloudState).toBe('missing');
    expect(db.host).toBe('5.6.7.8');
  });

  it('excludes stopped and missing cloud servers from the health sweep', () => {
    expect(isMonitored({ monitoringEnabled: true, cloudState: null })).toBe(true);
    expect(isMonitored({ monitoringEnabled: true, cloudState: 'running' })).toBe(true);
    expect(isMonitored({ monitoringEnabled: true, cloudState: 'stopped' })).toBe(false);
    expect(isMonitored({ monitoringEnabled: true, cloudState: 'missing' })).toBe(false);
    expect(isMonitored({ monitoringEnabled: false, cloudState: 'running' })).toBe(false);
  });

  it('stops importing when auto-import is switched off', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/cloud/accounts/${accountId}`,
      headers: admin.headers,
      payload: { autoImport: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().autoImport).toBe(false);

    provider.list.mockResolvedValueOnce([inst({ id: 'h1' }), inst({ id: 'h4', name: 'new' })]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/cloud/accounts/${accountId}/sync`,
      headers: operator.headers,
    });
    expect(res.json()).toMatchObject({ discovered: 2, created: 0, updated: 1 });
  });

  it('reports a provider failure on sync and records it on the account', async () => {
    provider.list.mockRejectedValueOnce(new CloudError('Provider request timed out after 30000 ms', 504));
    const res = await app.inject({
      method: 'POST',
      url: `/api/cloud/accounts/${accountId}/sync`,
      headers: operator.headers,
    });
    expect(res.statusCode).toBe(504);
    const account = (await app.inject({ method: 'GET', url: '/api/cloud/accounts', headers: viewer.headers })).json()[0];
    expect(account.lastStatus).toBe('failed');
    expect(account.lastError).toContain('timed out');
  });

  it('accepts a GCP service account key and an Azure service principal', async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/cloud/accounts', headers: admin.headers, payload });

    const badJson = await post({ name: 'g', provider: 'gcp', gcp: { serviceAccountJson: '{ not json at all, but long enough to pass the length check' } });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error).toContain('valid JSON');

    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const keyFile = JSON.stringify({
      type: 'service_account',
      project_id: 'proj',
      client_email: 'sync@proj.iam.gserviceaccount.com',
      private_key: pem,
    });
    provider.list.mockResolvedValueOnce([]);
    const gcp = await post({ name: 'GCP', provider: 'gcp', gcp: { serviceAccountJson: keyFile } });
    expect(gcp.statusCode).toBe(201);
    expect(gcp.json().credentialHint).toBe('sync@proj.iam.gserviceaccount.com');
    expect(JSON.stringify(gcp.json())).not.toContain('PRIVATE KEY');

    const wrongShape = await post({ name: 'x', provider: 'azure', token: 'a-token-for-hetzner' });
    expect(wrongShape.statusCode).toBe(400);

    provider.list.mockResolvedValueOnce([]);
    const azure = await post({
      name: 'Azure',
      provider: 'azure',
      azure: {
        tenantId: '11111111-1111-1111-1111-111111111111',
        clientId: '22222222-2222-2222-2222-222222222222',
        clientSecret: 'very-secret-value',
        subscriptionId: '33333333-3333-3333-3333-333333333333',
      },
    });
    expect(azure.statusCode).toBe(201);
    expect(azure.json().credentialHint).toBe('22222222… / 33333333…');
    expect(JSON.stringify(azure.json())).not.toContain('very-secret');
  });

  it('hides the account from another organisation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/cloud/accounts/${accountId}/sync`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes the account but keeps the imported servers, unlinked', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/cloud/accounts/${accountId}`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/api/servers', headers: viewer.headers });
    const mine = (list.json() as { name: string; cloud: unknown }[]).filter((s) =>
      ['my-web', 'db-1'].includes(s.name),
    );
    expect(mine).toHaveLength(2);
    expect(mine.every((s) => s.cloud === null)).toBe(true);
  });
});
