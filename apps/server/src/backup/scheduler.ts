import { config } from '../config/index.js';
import { databasePath } from '../db/index.js';
import logger from '../logger.js';
import { auditSystem } from '../audit/index.js';
import { backupNow, instanceOrgId, listAppBackups } from './index.js';

/**
 * Scheduled backups of the app database, in-process on a plain interval like
 * the health monitor and cloud sync. The timer only checks whether a backup is
 * due — the age of the newest scheduled one decides — so restarting the
 * server neither skips a backup nor takes an extra one.
 */
let timer: NodeJS.Timeout | null = null;
let running = false;

const CHECK_EVERY_MS = 10 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;

/** Is a scheduled backup due, given the newest one's time? */
export function backupDue(lastScheduledAt: Date | null, intervalHours: number, now = new Date()): boolean {
  if (intervalHours <= 0) return false;
  if (!lastScheduledAt) return true;
  // A minute of slack so a check that lands just short of the interval does not wait another ten
  return now.getTime() - lastScheduledAt.getTime() >= intervalHours * 3_600_000 - 60_000;
}

function lastScheduled(): Date | null {
  const newest = listAppBackups().find((b) => b.reason === 'scheduled');
  return newest ? new Date(newest.createdAt) : null;
}

export async function runScheduledBackup(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!backupDue(lastScheduled(), config.backup.intervalHours)) return;
    const { backup, uploaded } = await backupNow('scheduled');
    const orgId = instanceOrgId();
    if (orgId) {
      auditSystem(orgId, 'backup.create', 'backup', backup.name, backup.name, {
        reason: backup.reason,
        size: backup.size,
        ...(uploaded !== null && { uploaded }),
      });
    }
  } catch (err) {
    logger.error({ err }, 'Scheduled database backup failed');
    const orgId = instanceOrgId();
    if (orgId) {
      auditSystem(orgId, 'backup.failed', 'backup', undefined, undefined, {
        reason: 'scheduled',
        error: (err as Error).message,
      });
    }
  } finally {
    running = false;
  }
}

export function startBackupScheduler() {
  if (config.backup.intervalHours <= 0) {
    logger.info('Scheduled database backups disabled (SMT_BACKUP_INTERVAL_HOURS=0)');
    return;
  }
  if (databasePath() === ':memory:') {
    logger.info('Scheduled database backups skipped: the database is in memory');
    return;
  }
  if (timer) return;

  const every = Math.min(CHECK_EVERY_MS, Math.max(60_000, config.backup.intervalHours * 3_600_000));
  timer = setInterval(() => void runScheduledBackup(), every);
  timer.unref?.();
  setTimeout(() => void runScheduledBackup(), FIRST_CHECK_DELAY_MS).unref?.();

  logger.info(
    { intervalHours: config.backup.intervalHours, keep: config.backup.keep, dir: config.backup.dir },
    'Scheduled database backups started',
  );
}

export function stopBackupScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
