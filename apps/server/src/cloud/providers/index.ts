import type { CloudProvider } from '@smt/shared';
import type { CloudProviderAdapter } from '../types.js';
import { aws } from './aws.js';
import { gcp } from './gcp.js';
import { azure } from './azure.js';
import { digitalocean } from './digitalocean.js';
import { hetzner } from './hetzner.js';

const ADAPTERS: Record<CloudProvider, CloudProviderAdapter> = { aws, gcp, azure, digitalocean, hetzner };

export function getProvider(provider: CloudProvider): CloudProviderAdapter {
  return ADAPTERS[provider];
}
