import {
  DescribeRegionsCommand,
  EC2Client,
  paginateDescribeInstances,
  type Instance,
} from '@aws-sdk/client-ec2';
import type { CloudInstance, CloudInstanceState } from '@smt/shared';
import { CloudError, type CloudCredentials, type CloudProviderAdapter } from '../types.js';

const CONNECT_TIMEOUT_MS = 10_000;
const DISCOVERY_REGION = 'us-east-1';

/** Terminated instances are filtered out server-side so they show up as `missing`. */
const LIVE_STATES = ['pending', 'running', 'stopping', 'stopped'];

const CREDENTIAL_ERRORS = new Set([
  'AuthFailure',
  'UnauthorizedOperation',
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'AccessDenied',
]);

function toState(name: string | undefined): CloudInstanceState {
  if (name === 'running') return 'running';
  if (name === 'stopped' || name === 'stopping') return 'stopped';
  return 'other';
}

/** The `Name` tag becomes the server name and is not repeated as a tag. */
export function toInstance(i: Instance, region: string): CloudInstance {
  const tags = i.Tags ?? [];
  const name = tags.find((t) => t.Key === 'Name')?.Value?.trim();
  return {
    id: i.InstanceId ?? '',
    name: name || i.InstanceId || 'unnamed',
    region,
    state: toState(i.State?.Name),
    publicIp: i.PublicIpAddress ?? null,
    privateIp: i.PrivateIpAddress ?? null,
    tags: tags
      .filter((t): t is { Key: string; Value?: string } => !!t.Key && t.Key !== 'Name')
      .map((t) => (t.Value ? `${t.Key}:${t.Value}` : t.Key)),
    instanceType: i.InstanceType ?? null,
  };
}

function toCloudError(err: unknown): CloudError {
  if (err instanceof CloudError) return err;
  const e = (err ?? {}) as { name?: string; code?: string; message?: string };
  const id = e.name ?? e.code ?? '';
  const message = e.message?.trim() || 'AWS request failed';
  if (CREDENTIAL_ERRORS.has(id)) return new CloudError(`AWS rejected the credentials: ${message}`, 403);
  if (id === 'TimeoutError' || id === 'RequestTimeout') {
    return new CloudError(`AWS request timed out: ${message}`, 504);
  }
  return new CloudError(`AWS: ${message}`, 502);
}

function makeClient(creds: Extract<CloudCredentials, { kind: 'aws' }>, region: string, timeoutMs: number) {
  return new EC2Client({
    region,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: timeoutMs },
  });
}

async function discoverRegions(
  creds: Extract<CloudCredentials, { kind: 'aws' }>,
  timeoutMs: number,
): Promise<string[]> {
  const client = makeClient(creds, DISCOVERY_REGION, timeoutMs);
  try {
    const out = await client.send(new DescribeRegionsCommand({}));
    return (out.Regions ?? []).flatMap((r) => (r.RegionName ? [r.RegionName] : []));
  } finally {
    client.destroy();
  }
}

async function listRegion(
  creds: Extract<CloudCredentials, { kind: 'aws' }>,
  region: string,
  timeoutMs: number,
): Promise<CloudInstance[]> {
  const client = makeClient(creds, region, timeoutMs);
  try {
    const out: CloudInstance[] = [];
    const pages = paginateDescribeInstances(
      { client },
      { Filters: [{ Name: 'instance-state-name', Values: LIVE_STATES }] },
    );
    for await (const page of pages) {
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (instance.InstanceId) out.push(toInstance(instance, region));
        }
      }
    }
    return out;
  } finally {
    client.destroy();
  }
}

export const aws: CloudProviderAdapter = {
  async listInstances(creds, opts) {
    if (creds.kind !== 'aws') throw new CloudError('AWS needs an access key pair', 400);
    try {
      const regions = opts.regions.length ? opts.regions : await discoverRegions(creds, opts.timeoutMs);
      const perRegion = await Promise.all(regions.map((r) => listRegion(creds, r, opts.timeoutMs)));
      return perRegion.flat();
    } catch (err) {
      throw toCloudError(err);
    }
  },
};
