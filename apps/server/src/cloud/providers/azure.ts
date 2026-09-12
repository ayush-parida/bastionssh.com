import type { CloudInstance, CloudInstanceState } from '@smt/shared';
import {
  CloudError,
  TokenCache,
  postForm,
  postJson,
  type CloudCredentials,
  type CloudProviderAdapter,
} from '../types.js';

const GRAPH = 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01';
const SCOPE = 'https://management.azure.com/.default';
const PAGE_SIZE = 1000;

type AzureCredentials = Extract<CloudCredentials, { kind: 'azure' }>;

/**
 * One Resource Graph query joins VMs to their NICs and public IPs, so a sync
 * is a single paged call instead of two ARM calls per machine. Power state
 * comes from the extended instance view Resource Graph already indexes.
 */
export const QUERY = `
Resources
| where type =~ 'microsoft.compute/virtualmachines'
| mv-expand nic = properties.networkProfile.networkInterfaces
| extend nicId = tolower(tostring(nic.id))
| join kind=leftouter (
    Resources
    | where type =~ 'microsoft.network/networkinterfaces'
    | mv-expand ipconfig = properties.ipConfigurations
    | project nicId = tolower(id),
              privateIp = tostring(ipconfig.properties.privateIPAddress),
              publicIpId = tolower(tostring(ipconfig.properties.publicIPAddress.id))
  ) on nicId
| join kind=leftouter (
    Resources
    | where type =~ 'microsoft.network/publicipaddresses'
    | project publicIpId = tolower(id), publicIp = tostring(properties.ipAddress)
  ) on publicIpId
| project id, name, location, tags,
          vmSize = tostring(properties.hardwareProfile.vmSize),
          powerState = tostring(properties.extended.instanceView.powerState.code),
          privateIp, publicIp
`.trim();

/** One row per VM ip-configuration, as the query above returns it. */
export interface AzureRow {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string> | null;
  vmSize?: string;
  powerState?: string; // PowerState/running | PowerState/deallocated | PowerState/stopped | …
  privateIp?: string | null;
  publicIp?: string | null;
}

function toState(code: string | undefined): CloudInstanceState {
  if (code === 'PowerState/running') return 'running';
  if (code === 'PowerState/deallocated' || code === 'PowerState/stopped') return 'stopped';
  return 'other';
}

export function toInstance(row: AzureRow): CloudInstance {
  return {
    id: row.id.toLowerCase(),
    name: row.name,
    region: row.location,
    state: toState(row.powerState),
    publicIp: row.publicIp || null,
    privateIp: row.privateIp || null,
    tags: Object.entries(row.tags ?? {}).map(([k, v]) => (v ? `${k}:${v}` : k)),
    instanceType: row.vmSize || null,
  };
}

/** A VM with several NICs or ip-configs yields several rows; keep one, preferring a public address. */
export function foldRows(rows: AzureRow[]): CloudInstance[] {
  const byId = new Map<string, CloudInstance>();
  for (const row of rows) {
    const instance = toInstance(row);
    const current = byId.get(instance.id);
    if (!current) {
      byId.set(instance.id, instance);
      continue;
    }
    if (!current.publicIp && instance.publicIp) current.publicIp = instance.publicIp;
    if (!current.privateIp && instance.privateIp) current.privateIp = instance.privateIp;
  }
  return [...byId.values()];
}

const tokens = new TokenCache();

async function getAccessToken(creds: AzureCredentials, timeoutMs: number): Promise<string> {
  return tokens.get(`${creds.tenantId}/${creds.clientId}`, async () => {
    const out = await postForm<{ access_token: string; expires_in: number | string }>(
      `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`,
      {
        grant_type: 'client_credentials',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: SCOPE,
      },
      timeoutMs,
      'Azure rejected the service principal',
    );
    return { token: out.access_token, expiresInSec: Number(out.expires_in) };
  });
}

interface GraphPage {
  data?: AzureRow[];
  $skipToken?: string;
}

export const azure: CloudProviderAdapter = {
  async listInstances(creds, opts) {
    if (creds.kind !== 'azure') throw new CloudError('Azure needs a service principal', 400);
    const token = await getAccessToken(creds, opts.timeoutMs);
    const rows: AzureRow[] = [];
    let skipToken: string | undefined;
    do {
      const page = await postJson<GraphPage>(
        GRAPH,
        token,
        {
          subscriptions: [creds.subscriptionId],
          query: QUERY,
          options: { $top: PAGE_SIZE, resultFormat: 'objectArray', ...(skipToken && { $skipToken: skipToken }) },
        },
        opts.timeoutMs,
        'Azure refused the query — the service principal needs the Reader role on the subscription',
      );
      rows.push(...(page.data ?? []));
      skipToken = page.$skipToken;
    } while (skipToken);
    return foldRows(rows);
  },
};
