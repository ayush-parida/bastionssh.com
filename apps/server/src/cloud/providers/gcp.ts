import { createSign } from 'node:crypto';
import type { CloudInstance, CloudInstanceState } from '@smt/shared';
import {
  CloudError,
  TokenCache,
  httpJson,
  postForm,
  type CloudCredentials,
  type CloudProviderAdapter,
} from '../types.js';

const SCOPE = 'https://www.googleapis.com/auth/compute.readonly';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const PAGE_SIZE = 500;

type GcpCredentials = Extract<CloudCredentials, { kind: 'gcp' }>;

/** The fields of a downloaded service-account key file we rely on. */
export function parseServiceAccount(json: string): GcpCredentials {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new CloudError('The service account key is not valid JSON', 400);
  }
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '');
  if (raw['type'] !== 'service_account') {
    throw new CloudError('Expected a service account key file ("type": "service_account")', 400);
  }
  const projectId = str('project_id');
  const clientEmail = str('client_email');
  const privateKey = str('private_key');
  if (!projectId || !clientEmail || !privateKey.includes('PRIVATE KEY')) {
    throw new CloudError('The key file is missing project_id, client_email or private_key', 400);
  }
  return {
    kind: 'gcp',
    projectId,
    clientEmail,
    privateKey,
    tokenUri: str('token_uri') || DEFAULT_TOKEN_URI,
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** RS256 JWT for the service-account bearer grant, valid for one hour. */
export function buildJwt(creds: GcpCredentials, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: creds.clientEmail,
      scope: SCOPE,
      aud: creds.tokenUri,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  let signature: Buffer;
  try {
    signature = signer.sign(creds.privateKey);
  } catch {
    throw new CloudError('The service account private key could not be used for signing', 400);
  }
  return `${header}.${claims}.${base64url(signature)}`;
}

const tokens = new TokenCache();

async function getAccessToken(creds: GcpCredentials, timeoutMs: number): Promise<string> {
  return tokens.get(creds.clientEmail, async () => {
    const out = await postForm<{ access_token: string; expires_in: number }>(
      creds.tokenUri,
      { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildJwt(creds) },
      timeoutMs,
      'GCP rejected the service account',
    );
    return { token: out.access_token, expiresInSec: out.expires_in };
  });
}

/** `us-central1-a` → `us-central1`. */
export function zoneToRegion(zone: string): string {
  return zone.replace(/-[a-z]$/, '');
}

/** The subset of a Compute Engine instance we read. */
export interface GcpInstance {
  id: string;
  name: string;
  status: string; // PROVISIONING | STAGING | RUNNING | STOPPING | SUSPENDING | SUSPENDED | REPAIRING | TERMINATED
  machineType?: string;
  networkInterfaces?: { networkIP?: string; accessConfigs?: { natIP?: string }[] }[];
  labels?: Record<string, string>;
  tags?: { items?: string[] };
}

function toState(status: string): CloudInstanceState {
  if (status === 'RUNNING') return 'running';
  if (['TERMINATED', 'STOPPING', 'SUSPENDED', 'SUSPENDING'].includes(status)) return 'stopped';
  return 'other';
}

export function toInstance(i: GcpInstance, zone: string): CloudInstance {
  const nic = i.networkInterfaces?.[0];
  return {
    id: String(i.id),
    name: i.name,
    region: zoneToRegion(zone),
    state: toState(i.status),
    publicIp: nic?.accessConfigs?.find((a) => a.natIP)?.natIP ?? null,
    privateIp: nic?.networkIP ?? null,
    tags: [
      ...Object.entries(i.labels ?? {}).map(([k, v]) => (v ? `${k}:${v}` : k)),
      ...(i.tags?.items ?? []),
    ],
    instanceType: i.machineType ? (i.machineType.split('/').pop() ?? null) : null,
  };
}

interface AggregatedPage {
  items?: Record<string, { instances?: GcpInstance[] }>;
  nextPageToken?: string;
}

export const gcp: CloudProviderAdapter = {
  async listInstances(creds, opts) {
    if (creds.kind !== 'gcp') throw new CloudError('Google Cloud needs a service account key', 400);
    const token = await getAccessToken(creds, opts.timeoutMs);
    const out: CloudInstance[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${COMPUTE}/projects/${encodeURIComponent(creds.projectId)}/aggregated/instances`);
      url.searchParams.set('maxResults', String(PAGE_SIZE));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await httpJson<AggregatedPage>(
        url.toString(),
        token,
        opts.timeoutMs,
        'GCP refused the request — the service account needs the Compute Viewer role',
      );
      for (const [scope, entry] of Object.entries(page.items ?? {})) {
        const zone = scope.replace(/^zones\//, '');
        for (const instance of entry.instances ?? []) out.push(toInstance(instance, zone));
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  },
};
