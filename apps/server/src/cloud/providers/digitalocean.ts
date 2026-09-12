import type { CloudInstance, CloudInstanceState } from '@smt/shared';
import { httpJson, requireToken, type CloudProviderAdapter } from '../types.js';

const API = 'https://api.digitalocean.com/v2';
const PAGE_SIZE = 200;

/** The subset of a Droplet we read. */
export interface Droplet {
  id: number;
  name: string;
  status: string; // new | active | off | archive
  size_slug?: string;
  region?: { slug?: string };
  tags?: string[];
  networks?: { v4?: { ip_address: string; type: 'public' | 'private' }[] };
}

function toState(status: string): CloudInstanceState {
  if (status === 'active') return 'running';
  if (status === 'off') return 'stopped';
  return 'other';
}

export function toInstance(d: Droplet): CloudInstance {
  const v4 = d.networks?.v4 ?? [];
  return {
    id: String(d.id),
    name: d.name,
    region: d.region?.slug ?? 'unknown',
    state: toState(d.status),
    publicIp: v4.find((n) => n.type === 'public')?.ip_address ?? null,
    privateIp: v4.find((n) => n.type === 'private')?.ip_address ?? null,
    tags: d.tags ?? [],
    instanceType: d.size_slug ?? null,
  };
}

export const digitalocean: CloudProviderAdapter = {
  async listInstances(creds, opts) {
    const token = requireToken(creds);
    const out: CloudInstance[] = [];
    for (let page = 1; ; page++) {
      const body = await httpJson<{ droplets: Droplet[] }>(
        `${API}/droplets?per_page=${PAGE_SIZE}&page=${page}`,
        token,
        opts.timeoutMs,
      );
      out.push(...body.droplets.map(toInstance));
      if (body.droplets.length < PAGE_SIZE) break;
    }
    return out;
  },
};
