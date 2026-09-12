export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'digitalocean' | 'hetzner';

export const CLOUD_PROVIDERS = [
  'aws',
  'gcp',
  'azure',
  'digitalocean',
  'hetzner',
] as const satisfies readonly CloudProvider[];

export const CLOUD_PROVIDER_LABEL: Record<CloudProvider, string> = {
  aws: 'AWS',
  gcp: 'Google Cloud',
  azure: 'Microsoft Azure',
  digitalocean: 'DigitalOcean',
  hetzner: 'Hetzner Cloud',
};

/** Normalised lifecycle state across providers. */
export type CloudInstanceState = 'running' | 'stopped' | 'other';

/** A server's cloud state; `missing` = no longer returned by the provider. */
export type CloudServerState = CloudInstanceState | 'missing';

/** One compute instance as every provider adapter reports it. */
export interface CloudInstance {
  /** Provider id: `i-0abc…`, a droplet id, a Hetzner server id (always a string). */
  id: string;
  name: string;
  /** `us-east-1`, `nyc3`, `fsn1`. */
  region: string;
  state: CloudInstanceState;
  publicIp: string | null;
  privateIp: string | null;
  /** Normalised `key:value` or plain tags. */
  tags: string[];
  instanceType: string | null;
}

export type CloudSyncStatus = 'ok' | 'failed';

export interface SyncSummary {
  discovered: number;
  created: number;
  updated: number;
  missing: number;
  /** Discovered but not importable (no usable IP). */
  skipped: number;
}

export interface CloudAccount {
  id: string;
  orgId: string;
  name: string;
  provider: CloudProvider;
  /** Masked credential for display — the secret is stored encrypted and never returned. */
  credentialHint: string;
  /** AWS only. Empty = every region the account can see. */
  regions: string[];
  /** SSH username given to imported servers. */
  defaultUsername: string;
  /** SSH key given to imported servers, if any. */
  defaultKeyId: string | null;
  /** Create servers for instances that are not known yet. */
  autoImport: boolean;
  /** Include this account in the periodic sync. */
  syncEnabled: boolean;
  lastSyncAt: string | null;
  lastStatus: CloudSyncStatus | null;
  lastError: string | null;
  lastSummary: SyncSummary | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AwsCredentialsInput {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface GcpCredentialsInput {
  /** The downloaded service-account key file, pasted as-is. */
  serviceAccountJson: string;
}

export interface AzureCredentialsInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

export interface CreateCloudAccountRequest {
  name: string;
  provider: CloudProvider;
  /** Required for aws. */
  aws?: AwsCredentialsInput;
  /** Required for gcp. */
  gcp?: GcpCredentialsInput;
  /** Required for azure. */
  azure?: AzureCredentialsInput;
  /** Required for digitalocean and hetzner. */
  token?: string;
  regions?: string[];
  defaultUsername?: string;
  defaultKeyId?: string | null;
  autoImport?: boolean;
  syncEnabled?: boolean;
}

export interface UpdateCloudAccountRequest {
  name?: string;
  /** Omit to keep the stored credentials. */
  aws?: AwsCredentialsInput;
  gcp?: GcpCredentialsInput;
  azure?: AzureCredentialsInput;
  token?: string;
  regions?: string[];
  defaultUsername?: string;
  defaultKeyId?: string | null;
  autoImport?: boolean;
  syncEnabled?: boolean;
}

export interface CloudTestResult {
  ok: boolean;
  error?: string;
  instanceCount?: number;
}

/** Attached to a `Server` that was imported from (or linked to) a cloud account. */
export interface ServerCloudInfo {
  /** null once the account has been deleted. */
  accountId: string | null;
  provider: CloudProvider;
  instanceId: string;
  region: string | null;
  state: CloudServerState;
  syncedAt: string | null;
}
