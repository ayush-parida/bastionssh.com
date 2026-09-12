import { describe, it, expect } from 'vitest';
import { toInstance, type Droplet } from './digitalocean.js';

const droplet: Droplet = {
  id: 3164444,
  name: 'web-1',
  status: 'active',
  size_slug: 's-1vcpu-1gb',
  region: { slug: 'nyc3' },
  tags: ['web', 'prod'],
  networks: {
    v4: [
      { ip_address: '10.132.0.5', type: 'private' },
      { ip_address: '104.131.186.241', type: 'public' },
    ],
  },
};

describe('digitalocean toInstance', () => {
  it('maps a droplet', () => {
    expect(toInstance(droplet)).toEqual({
      id: '3164444',
      name: 'web-1',
      region: 'nyc3',
      state: 'running',
      publicIp: '104.131.186.241',
      privateIp: '10.132.0.5',
      tags: ['web', 'prod'],
      instanceType: 's-1vcpu-1gb',
    });
  });

  it('maps off → stopped and new → other', () => {
    expect(toInstance({ ...droplet, status: 'off' }).state).toBe('stopped');
    expect(toInstance({ ...droplet, status: 'new' }).state).toBe('other');
  });

  it('copes with missing networks and tags', () => {
    const bare = toInstance({ id: 1, name: 'x', status: 'active' });
    expect(bare.publicIp).toBeNull();
    expect(bare.privateIp).toBeNull();
    expect(bare.tags).toEqual([]);
    expect(bare.region).toBe('unknown');
  });
});
