import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { StorageProvider } from '@smt/shared';

export interface StorageTarget {
  provider: StorageProvider;
  /** null = AWS's regional endpoint */
  endpoint: string | null;
  region: string;
  accessKeyId: string;
  forcePathStyle: boolean;
}

export const DEFAULT_REGION = 'us-east-1';
export const CONNECT_TIMEOUT_MS = 10_000;
/** Socket inactivity — a healthy transfer keeps resetting it, a hung request does not. */
export const REQUEST_TIMEOUT_MS = 30_000;

export function buildClientConfig(target: StorageTarget, secretAccessKey: string): S3ClientConfig {
  return {
    region: target.region.trim() || DEFAULT_REGION,
    ...(target.endpoint ? { endpoint: target.endpoint } : {}),
    forcePathStyle: target.forcePathStyle,
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey },
    // SDK ≥ 3.729 defaults to CRC32 trailers on every upload, which older MinIO
    // releases and several third-party providers reject. Only checksum when the
    // operation itself demands it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // A connection pinned to one AWS region can still browse a bucket in another.
    followRegionRedirects: true,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  };
}

export function createClient(target: StorageTarget, secretAccessKey: string): S3Client {
  return new S3Client(buildClientConfig(target, secretAccessKey));
}
