import { describe, it, expect } from 'vitest';
import { foldRows, toInstance, type AzureRow } from './azure.js';

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
