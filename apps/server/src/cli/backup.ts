import { createBackup, pruneBackups } from '../backup/core.js';
import { defaultBackupDir } from '../backup/files.js';
import { cliSettings } from '../backup/restore.js';

/**
 * Take a manual backup of the app database. Safe while the server runs.
 *
 *   pnpm --filter @smt/server run db:backup
 *   node apps/server/dist/cli/backup.js   (Docker image)
 *
 * Reads SMT_DB_URL, SMT_BACKUP_DIR, SMT_BACKUP_GZIP and SMT_BACKUP_KEEP like
 * the server does. Copies to object storage happen only from the server.
 */
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: db:backup\n\nWrites a manual backup of SMT_DB_URL into SMT_BACKUP_DIR (default: backups/ next to the database).',
    );
    return;
  }
  const settings = cliSettings(process.env, defaultBackupDir);
  const backup = await createBackup({
    source: settings.dbPath,
    dir: settings.backupDir,
    reason: 'manual',
    gzip: settings.gzip,
  });
  console.log(`Backup written: ${backup.path} (${backup.size} bytes)`);
  const removed = pruneBackups(settings.backupDir, settings.keep);
  if (removed.length) console.log(`Pruned: ${removed.join(', ')}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`Backup failed: ${(err as Error).message}`);
    process.exit(1);
  },
);
