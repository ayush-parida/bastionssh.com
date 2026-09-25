import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
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

/** Same pool settings the SDK would pick; built here so a retired client can see when it is idle. */
const MAX_SOCKETS = 50;
const RETIRE_POLL_MS = 15_000;

const clientAgents = new WeakMap<S3Client, Array<HttpAgent | HttpsAgent>>();

export function createClient(target: StorageTarget, secretAccessKey: string): S3Client {
  const config = buildClientConfig(target, secretAccessKey);
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: MAX_SOCKETS });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: MAX_SOCKETS });
  const client = new S3Client({
    ...config,
    requestHandler: { ...(config.requestHandler as object), httpAgent, httpsAgent },
  });
  clientAgents.set(client, [httpAgent, httpsAgent]);
  return client;
}

function isIdle(agent: HttpAgent | HttpsAgent): boolean {
  const busy = (pool: NodeJS.ReadOnlyDict<unknown[]>) =>
    Object.values(pool).some((list) => (list?.length ?? 0) > 0);
  return !busy(agent.sockets) && !busy(agent.requests);
}

/**
 * Destroy a client that is no longer handed out — but only once nothing is
 * running on it. `S3Client.destroy()` destroys its agents' in-use sockets too,
 * which would cut off a download or upload still streaming through it.
 */
export function retireClient(client: S3Client): void {
  const agents = clientAgents.get(client) ?? [];
  const tryDestroy = (): boolean => {
    if (!agents.every(isIdle)) return false;
    client.destroy();
    return true;
  };
  if (tryDestroy()) return;
  const timer = setInterval(() => {
    if (tryDestroy()) clearInterval(timer);
  }, RETIRE_POLL_MS);
  timer.unref();
}
