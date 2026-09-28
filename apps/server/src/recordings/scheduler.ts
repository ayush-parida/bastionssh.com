import logger from '../logger.js';
import { pruneRecordings, recoverUnfinishedRecordings } from './index.js';

/**
 * Recording housekeeping runs in-process like the health monitor, so it works
 * without Redis: close out recordings a restart left open, then prune expired
 * ones once a day. The recordings live on this process's disk anyway.
 */
let timer: NodeJS.Timeout | null = null;
let pruning = false;

export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_PRUNE_DELAY_MS = 60_000;

async function tick() {
  if (pruning) return;
  pruning = true;
  try {
    const removed = await pruneRecordings();
    if (removed > 0) logger.info({ removed }, 'Pruned expired session recordings');
  } catch (err) {
    logger.error({ err }, 'Session recording prune failed');
  } finally {
    pruning = false;
  }
}

export async function startRecordingMaintenance() {
  if (timer) return;
  // Before any terminal opens: every open recording now belongs to a dead session
  try {
    const recovered = await recoverUnfinishedRecordings();
    if (recovered > 0) logger.info({ recovered }, 'Closed out recordings left open by a restart');
  } catch (err) {
    logger.error({ err }, 'Could not recover unfinished session recordings');
  }

  timer = setInterval(tick, PRUNE_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, FIRST_PRUNE_DELAY_MS).unref?.();
}

export function stopRecordingMaintenance() {
  if (timer) clearInterval(timer);
  timer = null;
}
