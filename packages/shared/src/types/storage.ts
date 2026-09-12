/** A hint for form defaults only — every provider speaks the same S3 API. */
export type StorageProvider =
  | 's3'
  | 'minio'
  | 'r2'
  | 'b2'
  | 'wasabi'
  | 'spaces'
  | 'gcs'
  | 'hetzner'
  | 'other';

/**
 * A preset fills the connection form for a known S3-compatible provider. It is
 * data only — the stored connection is the same shape whatever the provider.
 */
export interface StorageProviderPreset {
  provider: StorageProvider;
  label: string;
  /** null = AWS regional endpoint (or user-supplied). `{name}` placeholders are for the user to fill. */
  endpointTemplate: string | null;
  defaultRegion: string;
  /** False when the provider ignores the region (it is fixed to `defaultRegion`). */
  regionEditable: boolean;
  forcePathStyle: boolean;
  /** One-line help rendered under the form. */
  hint: string;
}

export const STORAGE_PROVIDER_PRESETS: readonly StorageProviderPreset[] = [
  {
    provider: 's3',
    label: 'AWS S3',
    endpointTemplate: null,
    defaultRegion: 'us-east-1',
    regionEditable: true,
    forcePathStyle: false,
    hint: 'Leave the endpoint blank to use the AWS regional endpoint for the region.',
  },
  {
    provider: 'minio',
    label: 'MinIO',
    endpointTemplate: 'http://minio.internal:9000',
    defaultRegion: 'us-east-1',
    regionEditable: true,
    forcePathStyle: true,
    hint: 'Use the API port (9000 by default), not the console port.',
  },
  {
    provider: 'r2',
    label: 'Cloudflare R2',
    endpointTemplate: 'https://{account-id}.r2.cloudflarestorage.com',
    defaultRegion: 'auto',
    regionEditable: false,
    forcePathStyle: true,
    hint: 'Create an R2 API token with Object Read & Write; the account ID is in the R2 dashboard URL.',
  },
  {
    provider: 'b2',
    label: 'Backblaze B2',
    endpointTemplate: 'https://s3.{region}.backblazeb2.com',
    defaultRegion: 'us-west-004',
    regionEditable: true,
    forcePathStyle: false,
    hint: 'The endpoint and region are shown on the bucket page (e.g. s3.us-west-004.backblazeb2.com). Use an application key, not the master key.',
  },
  {
    provider: 'wasabi',
    label: 'Wasabi',
    endpointTemplate: 'https://s3.{region}.wasabisys.com',
    defaultRegion: 'us-east-1',
    regionEditable: true,
    forcePathStyle: true,
    hint: 'Pick the region your buckets live in; Wasabi does not redirect across regions.',
  },
  {
    provider: 'spaces',
    label: 'DigitalOcean Spaces',
    endpointTemplate: 'https://{region}.digitaloceanspaces.com',
    defaultRegion: 'nyc3',
    regionEditable: true,
    forcePathStyle: false,
    hint: 'Use a Spaces access key (API → Spaces Keys), not a personal access token.',
  },
  {
    provider: 'gcs',
    label: 'Google Cloud Storage',
    endpointTemplate: 'https://storage.googleapis.com',
    defaultRegion: 'auto',
    regionEditable: false,
    forcePathStyle: true,
    hint: 'Requires an HMAC key (Cloud Storage → Settings → Interoperability).',
  },
  {
    provider: 'hetzner',
    label: 'Hetzner Object Storage',
    endpointTemplate: 'https://{location}.your-objectstorage.com',
    defaultRegion: 'eu-central',
    regionEditable: false,
    forcePathStyle: true,
    hint: 'Location is fsn1, nbg1 or hel1.',
  },
  {
    provider: 'other',
    label: 'Other S3-compatible',
    endpointTemplate: null,
    defaultRegion: 'us-east-1',
    regionEditable: true,
    forcePathStyle: true,
    hint: 'Works with Ceph RGW, Garage, SeaweedFS, Linode, Scaleway, OVH and anything that speaks the S3 API.',
  },
];

/** Provider ids in preset order — the server's accepted enum. */
export const STORAGE_PROVIDERS = STORAGE_PROVIDER_PRESETS.map((p) => p.provider) as [
  StorageProvider,
  ...StorageProvider[],
];

export function storagePreset(provider: StorageProvider): StorageProviderPreset {
  return STORAGE_PROVIDER_PRESETS.find((p) => p.provider === provider) ?? STORAGE_PROVIDER_PRESETS[0]!;
}

/** True when the template still has `{placeholders}` the user must fill. */
export function endpointNeedsInput(template: string | null): boolean {
  return template !== null && /\{[^}]+\}/.test(template);
}

/** Fill `{placeholders}` with example values so a template can be validated or shown. */
export function exampleEndpoint(preset: StorageProviderPreset): string | null {
  if (preset.endpointTemplate === null) return null;
  return preset.endpointTemplate.replace(/\{([^}]+)\}/g, (_m, name: string) =>
    name === 'region' ? preset.defaultRegion : name === 'location' ? 'fsn1' : 'abc123',
  );
}

export type StorageTestStatus = 'ok' | 'failed';

export interface StorageConnection {
  id: string;
  orgId: string;
  name: string;
  provider: StorageProvider;
  /** null means AWS's regional endpoint for `region`. */
  endpoint: string | null;
  region: string;
  accessKeyId: string;
  /** Path-style addressing (`host/bucket/key`); MinIO needs it, AWS prefers virtual-host style. */
  forcePathStyle: boolean;
  /** Result of the last "Test connection", if any. */
  lastStatus: StorageTestStatus | null;
  lastError: string | null;
  lastTestedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** secretAccessKey is never returned to the client */
}

export interface CreateStorageConnectionRequest {
  name: string;
  provider?: StorageProvider;
  /** Required unless provider is `s3`. */
  endpoint?: string | null;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Defaults to true for minio/other, false for s3. */
  forcePathStyle?: boolean;
}

export interface UpdateStorageConnectionRequest {
  name?: string;
  provider?: StorageProvider;
  endpoint?: string | null;
  region?: string;
  accessKeyId?: string;
  /** Omit to keep the stored secret. */
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export interface StorageTestResult {
  ok: boolean;
  error?: string;
  bucketCount?: number;
}

export interface StorageBucket {
  name: string;
  createdAt: string | null;
}

export interface StorageCreateBucketRequest {
  name: string;
}

/** A "folder" is a common prefix — it may or may not have a zero-byte marker object. */
export interface StorageFolder {
  name: string;
  /** Always ends with `/`. */
  prefix: string;
}

export interface StorageObject {
  name: string;
  key: string;
  size: number;
  modifiedAt: string | null;
  etag: string | null;
  storageClass: string | null;
}

export interface StorageListResponse {
  bucket: string;
  /** `''` at the bucket root, otherwise ends with `/`. */
  prefix: string;
  /** Parent prefix, or null at the bucket root. */
  parent: string | null;
  folders: StorageFolder[];
  objects: StorageObject[];
  /** Pass back as `token` to fetch the next page. */
  nextToken: string | null;
  truncated: boolean;
}

export interface StorageCreateFolderRequest {
  /** Trailing slash optional. */
  prefix: string;
}

export interface StorageRenameRequest {
  from: string;
  to: string;
}

export interface StorageUploadResponse {
  bucket: string;
  key: string;
  size: number;
}

export interface StorageDeleteBucketResponse {
  bucket: string;
  /** Objects removed before the bucket itself, when `force` was set. */
  deletedObjects: number;
}
