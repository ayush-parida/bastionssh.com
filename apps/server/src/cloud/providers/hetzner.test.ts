import { describe, it, expect } from 'vitest';
import { labelsToTags, toInstance, type HetznerServer } from './hetzner.js';

const server: HetznerServer = {
  id: 42,
  name: 'db-1',
  status: 'running',
  server_type: { name: 'cx22' },
  datacenter: { location: { name: 'fsn1' } },
  public_net: { ipv4: { ip: '1.2.3.4' } },
  private_net: [{ ip: '10.0.0.2' }],
  labels: { env: 'prod', team: '' },
};

describe('hetzner toInstance', () => {
  it('maps a server and flattens labels', () => {
    expect(toInstance(server)).toEqual({
      id: '42',
      name: 'db-1',
      region: 'fsn1',
      state: 'running',
      publicIp: '1.2.3.4',
      privateIp: '10.0.0.2',
      tags: ['env:prod', 'team'],
      instanceType: 'cx22',
    });
  });

  it('handles a server with no public ip', () => {
    expect(toInstance({ ...server, public_net: { ipv4: null } }).publicIp).toBeNull();
  });

  it('maps off → stopped and starting → other', () => {
    expect(toInstance({ ...server, status: 'off' }).state).toBe('stopped');
    expect(toInstance({ ...server, status: 'starting' }).state).toBe('other');
  });

  it('flattens empty labels to nothing', () => {
    expect(labelsToTags(undefined)).toEqual([]);
  });
});
