import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { cloudAccounts } from '../db/schema.js';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { syncAccount } from './index.js';

/**
 * Like the health monitor, cloud sync runs in-process on a plain interval so
 * it works in the default single-node deployment with no Redis. Accounts are
 * synced one at a time; one account's failure never stops the next.
 */
let timer: NodeJS.Timeout | null = null;
let syncing = false;

const FIRST_RUN_DELAY_MS = 15_000;

export async function runSyncSweep(): Promise<void> {
  const accounts = getDb()
    .select()
    .from(cloudAccounts)
    .where(eq(cloudAccounts.syncEnabled, true))
    .all();

  for (const account of accounts) {
    try {
      await syncAccount(account);
    } catch {
      // Already recorded on the account row and logged by syncAccount
    }
  }
}

async function tick() {
  if (syncing) {
    logger.warn('Previous cloud sync still running, skipping this interval');
    return;
  }
  syncing = true;
  try {
    await runSyncSweep();
  } catch (err) {
    logger.error({ err }, 'Cloud sync sweep failed');
  } finally {
    syncing = false;
  }
}

export function startCloudSync() {
  if (!config.cloudSync.enabled) {
    logger.info('Cloud inventory sync disabled (SMT_CLOUD_SYNC_ENABLED=false)');
    return;
  }
  if (timer) return;

  timer = setInterval(tick, config.cloudSync.intervalMinutes * 60_000);
  timer.unref?.();
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();

  logger.info({ intervalMinutes: config.cloudSync.intervalMinutes }, 'Cloud inventory sync started');
}

export function stopCloudSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
