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
import { auditLog, cloudAccounts, memberships, resourceGrants, roleMembers, roles, servers } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AccessLevel } from '@smt/shared';
import { vault } from '../../vault/index.js';
import { CloudError } from '../../cloud/types.js';
import { isMonitored } from '../../monitoring/scheduler.js';
import { seedOrg, seedUser } from './test-utils.js';
import { decodeCredentials } from './cloud.js';

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

  /** A custom role holding `members`, with one grant. */
  function roleWith(
    members: ReturnType<typeof seedUser>[],
    g: { resourceType: 'server' | 'cloud_account'; level: AccessLevel; selector: 'id' | 'tag'; resourceId?: string; tag?: string },
  ) {
    const id = nanoid();
    getDb().insert(roles).values({ id, orgId, name: `role-${id}`, createdBy: admin.userId }).run();
    for (const m of members) getDb().insert(roleMembers).values({ roleId: id, userId: m.userId, orgId }).run();
    getDb()
      .insert(resourceGrants)
      .values({
        id: nanoid(),
        orgId,
        principalType: 'role',
        principalId: id,
        resourceType: g.resourceType,
        selector: g.selector,
        resourceId: g.resourceId ?? null,
        tag: g.tag ?? null,
        level: g.level,
        grantedBy: admin.userId,
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  /** A member who sees only what their roles grant. */
  function roleScoped(base: 'viewer' | 'operator') {
    const who = seedUser(orgId, base);
    getDb().update(memberships).set({ scope: 'roles' }).where(and(eq(memberships.userId, who.userId), eq(memberships.orgId, orgId))).run();
    return who;
  }

  async function storedToken(id: string) {
    const row = getDb().select().from(cloudAccounts).where(eq(cloudAccounts.id, id)).get()!;
    return decodeCredentials(await vault.decrypt(row.encryptedCredentials, row.id));
  }

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

    // The first sync starts right away instead of waiting for the next sweep
    await vi.waitFor(async () => {
      const [account] = (await app.inject({ method: 'GET', url: '/api/cloud/accounts', headers: admin.headers })).json();
      expect(account.lastStatus).toBe('ok');
    });
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
    const imported = (list.json() as { name: string; host: string; username: string; tags: string[]; cloud: { provider: string; instanceId: string; state: string; tags: string[] } | null }[])
      .filter((s) => s.cloud?.provider === 'hetzner');
    expect(imported).toHaveLength(2);
    const web = imported.find((s) => s.cloud!.instanceId === 'h1')!;
    expect(web).toMatchObject({ name: 'web-1', host: '1.2.3.4', username: 'deploy' });
    // The provider's own tags are kept apart as provider tags, never as app tags
    expect(web.tags).toEqual(['cloud:hetzner', 'fsn1']);
    expect(web.cloud!.tags).toEqual(['env:prod']);
    const db = imported.find((s) => s.cloud!.instanceId === 'h2')!;
    expect(db.cloud!.state).toBe('stopped');

    const account = (await app.inject({ method: 'GET', url: '/api/cloud/accounts', headers: viewer.headers })).json()[0];
    expect(account.lastStatus).toBe('ok');
    expect(account.lastSummary).toEqual({ discovered: 3, created: 2, updated: 0, missing: 0, skipped: 1 });
  });

  it('never lets a provider tag match a tag selector', async () => {
    const byProviderTag = roleScoped('viewer');
    roleWith([byProviderTag], { resourceType: 'server', level: 'operate', selector: 'tag', tag: 'env:prod' });
    const byAppTag = roleScoped('viewer');
    roleWith([byAppTag], { resourceType: 'server', level: 'view', selector: 'tag', tag: 'cloud:hetzner' });
    const web = getDb().select().from(servers).where(eq(servers.cloudInstanceId, 'h1')).get()!;

    const hidden = await app.inject({ method: 'GET', url: '/api/servers', headers: byProviderTag.headers });
    expect(hidden.json()).toEqual([]);
    const direct = await app.inject({ method: 'GET', url: `/api/servers/${web.id}`, headers: byProviderTag.headers });
    expect(direct.statusCode).toBe(404);

    // App tags still select as before
    const shown = await app.inject({ method: 'GET', url: '/api/servers', headers: byAppTag.headers });
    expect((shown.json() as { id: string }[]).map((s) => s.id)).toContain(web.id);
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

    provider.list.mockResolvedValueOnce([inst({ id: 'h1', publicIp: '9.9.9.9', tags: ['env:prod', 'team:web'] })]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/cloud/accounts/${accountId}/sync`,
      headers: operator.headers,
    });
    expect(res.json()).toEqual({ discovered: 1, created: 0, updated: 1, missing: 1, skipped: 0 });

    const after = getDb().select().from(servers).where(eq(servers.cloudAccountId, accountId)).all();
    const web = after.find((s) => s.cloudInstanceId === 'h1')!;
    // Provider tags follow the provider; the app tags stay the user's
    expect(web).toMatchObject({ name: 'my-web', host: '9.9.9.9', tags: '["custom"]', cloudTags: '["env:prod","team:web"]', cloudState: 'running' });
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

  it('imports a new instance once when two syncs of one account overlap', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/cloud/accounts/${accountId}`,
      headers: admin.headers,
      payload: { autoImport: true },
    });
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return [inst({ id: 'h1' }), inst({ id: 'h9', name: 'burst', publicIp: '7.7.7.7' })];
    };
    provider.list.mockImplementationOnce(slow).mockImplementationOnce(slow);
    const sync = () =>
      app.inject({ method: 'POST', url: `/api/cloud/accounts/${accountId}/sync`, headers: operator.headers });
    const [first, second] = await Promise.all([sync(), sync()]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(first.json().created + second.json().created).toBe(1);
    expect(getDb().select().from(servers).where(eq(servers.cloudInstanceId, 'h9')).all()).toHaveLength(1);
  });

  it('lets a manager below admin rename, toggle and sync an account, but not change its credentials', async () => {
    const manager = seedUser(orgId, 'operator');
    roleWith([manager], { resourceType: 'cloud_account', level: 'manage', selector: 'id', resourceId: accountId });
    const patch = (who: { headers: Record<string, string> }, payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/cloud/accounts/${accountId}`, headers: who.headers, payload });

    const rename = await patch(manager, { name: 'Hetzner (renamed)', syncEnabled: false, autoImport: true });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ name: 'Hetzner (renamed)', syncEnabled: false, autoImport: true });
    const updateAudit = getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'cloud_account.update'), eq(auditLog.resourceId, accountId), eq(auditLog.actorId, manager.userId)))
      .get()!;
    expect(JSON.parse(updateAudit.metadata!)).toMatchObject({
      before: { name: 'Hetzner prod', syncEnabled: true },
      after: { name: 'Hetzner (renamed)', syncEnabled: false },
      credentialsChanged: false,
    });
    expect(updateAudit.metadata).not.toContain('hcloud-token');

    provider.list.mockResolvedValueOnce([]);
    const sync = await app.inject({ method: 'POST', url: `/api/cloud/accounts/${accountId}/sync`, headers: manager.headers });
    expect(sync.statusCode).toBe(200);

    // Repointing the account at other provider credentials is refused, whatever else comes with it,
    // before anything reaches the provider
    provider.list.mockClear();
    for (const payload of [{ token: 'attacker-owned-token-value' }, { name: 'x', token: 'attacker-owned-token-value' }, { aws: { accessKeyId: 'AKIAAAAAAAAAAAAAAAAA', secretAccessKey: 'secret-secret-secret' } }]) {
      const res = await patch(manager, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
    }
    expect(provider.list).not.toHaveBeenCalled();
    expect(await storedToken(accountId)).toEqual({ kind: 'token', token: 'hcloud-token-secret-value' });
    expect(getDb().select().from(cloudAccounts).where(eq(cloudAccounts.id, accountId)).get()!.name).toBe('Hetzner (renamed)');

    // An admin still can
    provider.list.mockResolvedValueOnce([]);
    const admins = await patch(admin, { token: 'hcloud-token-rotated-value', name: 'Hetzner prod', syncEnabled: true });
    expect(admins.statusCode).toBe(200);
    expect(admins.json().credentialHint).toBe('…alue');
    expect(await storedToken(accountId)).toEqual({ kind: 'token', token: 'hcloud-token-rotated-value' });
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
    const unlinked = getDb().select().from(servers).where(eq(servers.name, 'my-web')).get()!;
    expect(unlinked.cloudTags).toBe('[]');
  });
});
