/** A hint for form defaults only — every provider speaks the same S3 API. */
export type StorageProvider = 's3' | 'minio' | 'other';

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
