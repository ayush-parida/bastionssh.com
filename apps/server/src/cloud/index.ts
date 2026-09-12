import { and, eq } from 'drizzle-orm';
import type { CloudProvider, CloudTestResult, SyncSummary } from '@smt/shared';
import { getDb } from '../db/index.js';
import { cloudAccounts, servers } from '../db/schema.js';
import { vault } from '../vault/index.js';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { getProvider } from './providers/index.js';
import { applyPlan, planSync, summarize, type CloudAccountRow } from './sync.js';
import { CloudError, type CloudCredentials } from './types.js';

export { CloudError, type CloudCredentials } from './types.js';
export type { CloudAccountRow } from './sync.js';

export function encodeCredentials(creds: CloudCredentials): string {
  return JSON.stringify(creds);
}

export function decodeCredentials(json: string): CloudCredentials {
  const parsed = JSON.parse(json) as CloudCredentials;
  if (parsed.kind !== 'aws' && parsed.kind !== 'token') {
    throw new CloudError('Stored credentials are unreadable', 500);
  }
  return parsed;
}

/** `AKIA…F3Q` for a key pair, `…9c2f` for a token — enough to tell accounts apart. */
export function credentialHint(creds: CloudCredentials): string {
  if (creds.kind === 'aws') {
    const id = creds.accessKeyId;
    return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-3)}` : `${id.slice(0, 2)}…`;
  }
  return `…${creds.token.slice(-4)}`;
}

export function parseRegions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

export function parseSummary(raw: string | null): SyncSummary | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncSummary;
  } catch {
    return null;
  }
}

function toCloudError(err: unknown): CloudError {
  if (err instanceof CloudError) return err;
  return new CloudError(err instanceof Error ? err.message : String(err), 502);
}

/** List once with the given credentials. Used before saving an account and by "Test". */
export async function testCredentials(
  provider: CloudProvider,
  creds: CloudCredentials,
  regions: string[],
): Promise<CloudTestResult> {
  try {
    const instances = await getProvider(provider).listInstances(creds, {
      regions,
      timeoutMs: config.cloudSync.timeoutMs,
    });
    return { ok: true, instanceCount: instances.length };
  } catch (err) {
    return { ok: false, error: toCloudError(err).message };
  }
}

export async function testAccount(row: CloudAccountRow): Promise<CloudTestResult> {
  const creds = decodeCredentials(await vault.decrypt(row.encryptedCredentials, row.id));
  return testCredentials(row.provider as CloudProvider, creds, parseRegions(row.regions));
}

function recordSync(id: string, summary: SyncSummary | null, error: string | null): void {
  const now = new Date().toISOString();
  getDb()
    .update(cloudAccounts)
    .set({
      lastSyncAt: now,
      lastStatus: error ? 'failed' : 'ok',
      lastError: error?.slice(0, 300) ?? null,
      ...(summary && { lastSummary: JSON.stringify(summary) }),
      updatedAt: now,
    })
    .where(eq(cloudAccounts.id, id))
    .run();
}

/**
 * Pull the account's instances and reconcile them into `servers`. The outcome
 * is recorded on the account row either way; a provider failure is rethrown
 * as a CloudError so a route can report it.
 */
export async function syncAccount(row: CloudAccountRow): Promise<SyncSummary> {
  const provider = row.provider as CloudProvider;
  try {
    const creds = decodeCredentials(await vault.decrypt(row.encryptedCredentials, row.id));
    const discovered = await getProvider(provider).listInstances(creds, {
      regions: parseRegions(row.regions),
      timeoutMs: config.cloudSync.timeoutMs,
    });

    const existing = getDb()
      .select({
        id: servers.id,
        cloudInstanceId: servers.cloudInstanceId,
        host: servers.host,
        cloudState: servers.cloudState,
      })
      .from(servers)
      .where(and(eq(servers.orgId, row.orgId), eq(servers.cloudAccountId, row.id)))
      .all()
      .flatMap((s) => (s.cloudInstanceId ? [{ ...s, cloudInstanceId: s.cloudInstanceId }] : []));

    const plan = planSync(existing, discovered, row.autoImport);
    const now = new Date().toISOString();
    applyPlan(row, plan, now);

    const summary = summarize(plan, discovered.length);
    recordSync(row.id, summary, null);
    logger.info({ accountId: row.id, provider, ...summary }, 'Cloud account synced');
    return summary;
  } catch (err) {
    const error = toCloudError(err);
    recordSync(row.id, null, error.message);
    logger.warn({ accountId: row.id, provider, err: error.message }, 'Cloud account sync failed');
    throw error;
  }
}

/** Detach every server imported from an account; the servers themselves stay. */
export function unlinkAccountServers(accountId: string): void {
  getDb()
    .update(servers)
    .set({
      cloudAccountId: null,
      cloudProvider: null,
      cloudInstanceId: null,
      cloudRegion: null,
      cloudState: null,
      cloudSyncedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(servers.cloudAccountId, accountId))
    .run();
}
