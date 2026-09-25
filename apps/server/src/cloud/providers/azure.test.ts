import { describe, it, expect, vi, afterEach } from 'vitest';
import { azure, foldRows, toInstance, type AzureRow } from './azure.js';

const row: AzureRow = {
  id: '/subscriptions/S/resourceGroups/RG/providers/Microsoft.Compute/virtualMachines/Web-1',
  name: 'web-1',
  location: 'westeurope',
  tags: { env: 'prod', owner: '' },
  vmSize: 'Standard_B2s',
  powerState: 'PowerState/running',
  privateIp: '10.1.0.4',
  publicIp: '20.1.2.3',
};

describe('azure toInstance', () => {
  it('maps a row and lowercases the resource id', () => {
    expect(toInstance(row)).toEqual({
      id: '/subscriptions/s/resourcegroups/rg/providers/microsoft.compute/virtualmachines/web-1',
      name: 'web-1',
      region: 'westeurope',
      state: 'running',
      publicIp: '20.1.2.3',
      privateIp: '10.1.0.4',
      tags: ['env:prod', 'owner'],
      instanceType: 'Standard_B2s',
    });
  });

  it('maps power states', () => {
    expect(toInstance({ ...row, powerState: 'PowerState/deallocated' }).state).toBe('stopped');
    expect(toInstance({ ...row, powerState: 'PowerState/stopped' }).state).toBe('stopped');
    expect(toInstance({ ...row, powerState: '' }).state).toBe('other');
    expect(toInstance({ ...row, powerState: undefined }).state).toBe('other');
  });

  it('treats empty strings as no address and null tags as none', () => {
    const i = toInstance({ ...row, publicIp: '', privateIp: null, tags: null });
    expect(i.publicIp).toBeNull();
    expect(i.privateIp).toBeNull();
    expect(i.tags).toEqual([]);
  });
});

describe('foldRows', () => {
  it('merges multi-NIC rows for one VM, keeping the public address', () => {
    const folded = foldRows([
      { ...row, publicIp: null, privateIp: '10.1.0.9' },
      { ...row, id: row.id.toUpperCase(), publicIp: '20.1.2.3', privateIp: '10.1.0.4' },
      { ...row, id: '/other', name: 'db-1', publicIp: null },
    ]);
    expect(folded).toHaveLength(2);
    expect(folded[0]).toMatchObject({ name: 'web-1', publicIp: '20.1.2.3', privateIp: '10.1.0.9' });
    expect(folded[1]).toMatchObject({ name: 'db-1', publicIp: null });
  });
});

describe('azure token cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never answers a different client secret from a cached token', async () => {
    const secrets: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes('login.microsoftonline.com')) {
          const secret = new URLSearchParams(String(init.body)).get('client_secret')!;
          secrets.push(secret);
          if (secret !== 'good-secret-value') {
            return new Response(JSON.stringify({ error_description: 'Invalid client secret' }), { status: 401 });
          }
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3599 }));
        }
        return new Response(JSON.stringify({ data: [] }));
      }),
    );
    const creds = {
      kind: 'azure' as const,
      tenantId: 'aaaaaaaa-0000-0000-0000-000000000001',
      clientId: 'bbbbbbbb-0000-0000-0000-000000000001',
      clientSecret: 'good-secret-value',
      subscriptionId: 'cccccccc-0000-0000-0000-000000000001',
    };
    await azure.listInstances(creds, { regions: [], timeoutMs: 1000 });
    await azure.listInstances(creds, { regions: [], timeoutMs: 1000 });
    expect(secrets).toEqual(['good-secret-value']);

    await expect(
      azure.listInstances({ ...creds, clientSecret: 'wrong-secret-value' }, { regions: [], timeoutMs: 1000 }),
    ).rejects.toThrow(/Invalid client secret/);
    expect(secrets).toEqual(['good-secret-value', 'wrong-secret-value']);
  });
});
