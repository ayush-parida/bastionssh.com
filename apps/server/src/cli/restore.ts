import { defaultBackupDir } from '../backup/files.js';
import {
  assertServerStopped,
  cliSettings,
  parseRestoreArgs,
  resolveRestoreSource,
  restoreDatabase,
  RestoreError,
} from '../backup/restore.js';

/**
 * Restore the app database from a backup. The server must be stopped.
 *
 *   pnpm --filter @smt/server run db:restore -- smt-20260928T031500Z-scheduled.db.gz
 *   node apps/server/dist/cli/restore.js /data/backups/smt-…-scheduled.db   (Docker image)
 *
 * Reads SMT_DB_URL, SMT_BACKUP_DIR and SMT_PORT like the server does, and
 * SMT_ENCRYPTION_KEY for a backup copied back from object storage. Kept
 * clear of src/config, which exits on an incomplete environment.
 */

const USAGE = `Usage: db:restore [--skip-port-check] <backup file or name>

Replaces the database at SMT_DB_URL (default /data/smt.db) with the backup.
The server must be stopped. The current database is kept in the backup
directory as a pre-restore backup first.`;

async function main(): Promise<number> {
  const args = parseRestoreArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  const settings = cliSettings(process.env, defaultBackupDir);
  const source = resolveRestoreSource(args.file, settings.backupDir);

  await assertServerStopped(settings.dbPath, { port: settings.port, skipPortCheck: args.skipPortCheck });

  console.log(`Restoring ${source}\n     into ${settings.dbPath}`);
  const result = await restoreDatabase({
    source,
    dbPath: settings.dbPath,
    backupDir: settings.backupDir,
    encryptionKey: settings.encryptionKey,
  });
  console.log(`Backup passed integrity_check (${result.migrations} migrations recorded).`);
  if (result.safetyCopy) console.log(`The previous database was kept at ${result.safetyCopy}`);
  console.log('Restored. Start the server; it applies any newer migrations on startup. Everyone signs in again.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof RestoreError ? `Restore refused: ${err.message}` : err);
    process.exit(1);
  },
);
