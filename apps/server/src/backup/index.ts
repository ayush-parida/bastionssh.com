import fs from 'fs';
import type { CreatedDbBackup, DbBackup, DbBackupReason, DbBackupSettings } from '@smt/shared';
import { config } from '../config/index.js';
import { getRawDb } from '../db/index.js';
import logger from '../logger.js';
import { auditSystem } from '../audit/index.js';
import { createBackup, listBackups, pruneBackups, type CreatedBackupFile } from './core.js';
import { resolveBackupPath } from './files.js';
import { uploadBackup } from './upload.js';

/**
 * The running server's side of app database backups: one at a time, pruned
 * after each, copied to object storage when configured. Scheduled runs are
 * in scheduler.ts; the pre-migration one in db/migrate.ts.
 */

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after any backup already in progress — two at once would only compete for the disk. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function backupSettings(): DbBackupSettings {
  const { dir, intervalHours, keep, gzip, preMigration, storage } = config.backup;
  return {
    directory: dir,
    intervalHours,
    keep,
    gzip,
    preMigration,
    upload: storage ? { bucket: storage.bucket, prefix: storage.prefix } : null,
  };
}

export function listAppBackups(): DbBackup[] {
  return listBackups(config.backup.dir);
}

/** The file behind backup `name`, or null for a bad name or a missing / non-regular file. */
export function backupFile(name: string): { path: string; size: number } | null {
  const full = resolveBackupPath(config.backup.dir, name);
  if (!full) return null;
  try {
    // lstat: a symlink planted in the directory is not followed out of it
    const stat = fs.lstatSync(full);
    return stat.isFile() ? { path: full, size: stat.size } : null;
  } catch {
    return null;
  }
}

function toDbBackup(file: CreatedBackupFile): DbBackup {
  const { path: _path, ...backup } = file;
  return backup;
}

/** Back up the live database now, prune, and upload when configured. */
export function backupNow(reason: Extract<DbBackupReason, 'scheduled' | 'manual'>): Promise<CreatedDbBackup> {
  return serialized(async () => {
    const started = Date.now();
    const file = await createBackup({
      source: getRawDb(),
      dir: config.backup.dir,
      reason,
      gzip: config.backup.gzip,
    });
    logger.info({ name: file.name, size: file.size, ms: Date.now() - started }, 'Database backup written');

    try {
      const removed = pruneBackups(config.backup.dir, config.backup.keep);
      if (removed.length) logger.info({ removed }, 'Pruned old database backups');
    } catch (err) {
      logger.warn({ err }, 'Could not prune old database backups');
    }

    let uploaded: boolean | null = null;
    if (config.backup.storage) {
      try {
        await uploadBackup(file.path, file.name, config.backup.storage);
        uploaded = true;
        logger.info({ name: file.name, bucket: config.backup.storage.bucket }, 'Database backup uploaded');
      } catch (err) {
        uploaded = false;
        logger.warn({ err, name: file.name }, 'Could not upload database backup');
        const orgId = instanceOrgId();
        if (orgId) {
          auditSystem(orgId, 'backup.upload_failed', 'backup', file.name, file.name, {
            bucket: config.backup.storage.bucket,
            error: (err as Error).message,
          });
        }
      }
    }
    return { backup: toDbBackup(file), uploaded };
  });
}

/**
 * The organization that owns the instance: the first one, created when the
 * server seeded its owner. A backup holds every organization's data, so only
 * its owners may see or take one, and system backup events are audited there.
 */
export function instanceOrgId(): string | null {
  try {
    const row = getRawDb()
      .prepare('SELECT id FROM organizations ORDER BY created_at ASC, rowid ASC LIMIT 1')
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}
