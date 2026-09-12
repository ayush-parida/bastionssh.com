import type { CloudInstance, CloudInstanceState } from '@smt/shared';
import { httpJson, requireToken, type CloudProviderAdapter } from '../types.js';

const API = 'https://api.hetzner.cloud/v1';
const PAGE_SIZE = 50;

/** The subset of a Hetzner server we read. */
export interface HetznerServer {
  id: number;
  name: string;
  status: string; // running | initializing | starting | stopping | off | deleting | migrating | rebuilding | unknown
  server_type?: { name?: string };
  datacenter?: { location?: { name?: string } };
  public_net?: { ipv4?: { ip: string } | null };
  private_net?: { ip: string }[];
  labels?: Record<string, string>;
}

function toState(status: string): CloudInstanceState {
  if (status === 'running') return 'running';
  if (status === 'off') return 'stopped';
  return 'other';
}

/** `{ env: 'prod', team: '' }` → `['env:prod', 'team']`. */
export function labelsToTags(labels: Record<string, string> | undefined): string[] {
  return Object.entries(labels ?? {}).map(([k, v]) => (v ? `${k}:${v}` : k));
}

export function toInstance(s: HetznerServer): CloudInstance {
  return {
    id: String(s.id),
    name: s.name,
    region: s.datacenter?.location?.name ?? 'unknown',
    state: toState(s.status),
    publicIp: s.public_net?.ipv4?.ip ?? null,
    privateIp: s.private_net?.[0]?.ip ?? null,
    tags: labelsToTags(s.labels),
    instanceType: s.server_type?.name ?? null,
  };
}

interface Page {
  servers: HetznerServer[];
  meta?: { pagination?: { next_page: number | null } };
}

export const hetzner: CloudProviderAdapter = {
  async listInstances(creds, opts) {
    const token = requireToken(creds);
    const out: CloudInstance[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const body: Page = await httpJson<Page>(
        `${API}/servers?per_page=${PAGE_SIZE}&page=${page}`,
        token,
        opts.timeoutMs,
      );
      out.push(...body.servers.map(toInstance));
      page = body.meta?.pagination?.next_page ?? (body.servers.length < PAGE_SIZE ? null : page + 1);
    }
    return out;
  },
};
