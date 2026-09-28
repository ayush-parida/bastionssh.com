import fs from 'fs';
import path from 'path';
import { checkDatabaseFile, createBackup, expandBackup } from './core.js';
import { backupKey, decryptFile, isEncryptedFile } from './crypt.js';
import { compactTimestamp, resolveBackupPath } from './files.js';
import { lockHeldReason, portInUse } from './lock.js';

/**
 * Restoring the app database from a backup, for the db:restore CLI. Every
 * step that can fail runs before the live file is touched: the backup is
 * expanded next to the database and checked there, and the current database
 * is copied aside, so a refused or failed restore leaves things as they were.
 */

export class RestoreError extends Error {}

/** Settings the CLIs read from the same environment variables as the server. */
export interface CliSettings {
  dbPath: string;
  backupDir: string;
  port: number;
  keep: number;
  gzip: boolean;
  /** SMT_ENCRYPTION_KEY, for a backup copied back from object storage (encrypted). */
  encryptionKey?: string;
}

export function cliSettings(env: NodeJS.ProcessEnv, defaultBackupDir: (dbPath: string) => string): CliSettings {
  const dbPath = path.resolve(env.SMT_DB_URL || path.join('/data', 'smt.db'));
  const keep = Number(env.SMT_BACKUP_KEEP || 14);
  const port = Number(env.SMT_PORT || 8080);
  return {
    dbPath,
    backupDir: path.resolve(env.SMT_BACKUP_DIR || defaultBackupDir(dbPath)),
    port: Number.isInteger(port) && port > 0 ? port : 8080,
    keep: Number.isInteger(keep) && keep >= 1 ? keep : 14,
    gzip: env.SMT_BACKUP_GZIP === 'true',
    encryptionKey: env.SMT_ENCRYPTION_KEY || undefined,
  };
}

export interface RestoreArgs {
  file: string | null;
  skipPortCheck: boolean;
  help: boolean;
}

/** `pnpm run x -- file` forwards the `--`; ignore it wherever it lands. */
export function parseRestoreArgs(argv: string[]): RestoreArgs {
  const args: RestoreArgs = { file: null, skipPortCheck: false, help: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--skip-port-check') args.skipPortCheck = true;
    else if (arg.startsWith('-')) throw new RestoreError(`Unknown option: ${arg}`);
    else if (args.file) throw new RestoreError('Give exactly one backup file');
    else args.file = arg;
  }
  return args;
}

/**
 * The backup to restore: a path to a file, or the bare name of one in the
 * backup directory (as listed in Settings → Backups).
 */
export function resolveRestoreSource(input: string, backupDir: string, cwd = process.cwd()): string {
  const candidates: string[] = [];
  const named = resolveBackupPath(backupDir, input);
  if (named) candidates.push(named);
  candidates.push(path.resolve(cwd, input));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next
    }
  }
  throw new RestoreError(`Backup not found: ${input}`);
}

/** Refuse while a server has the database open. */
export async function assertServerStopped(
  dbPath: string,
  opts: { port?: number; skipPortCheck?: boolean; host?: string } = {},
): Promise<void> {
  const held = lockHeldReason(dbPath);
  if (held) {
    throw new RestoreError(`The server looks like it is running: ${held}. Stop it first, then retry.`);
  }
  if (!opts.skipPortCheck && opts.port && (await portInUse(opts.port, opts.host))) {
    throw new RestoreError(
      `Something is listening on port ${opts.port} — stop the server first (or pass --skip-port-check if that is not BastionSSH).`,
    );
  }
}

export interface RestoreResult {
  restoredFrom: string;
  /** The pre-restore copy of the database that was replaced, when there was one. */
  safetyCopy: string | null;
  migrations: number;
}

const SIDECARS = ['-wal', '-shm', '-journal'];

/**
 * Keep the current database before it is replaced: a proper backup when it
 * can be read, else the raw files (a damaged database is often why someone
 * is restoring, and the backup API refuses those).
 */
async function keepSafetyCopy(dbPath: string, backupDir: string, now: Date): Promise<string | null> {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const copy = await createBackup({ source: dbPath, dir: backupDir, reason: 'pre-restore', now });
    return copy.path;
  } catch {
    const target = path.join(backupDir, `pre-restore-raw-${compactTimestamp(now)}`);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const suffix of ['', ...SIDECARS]) {
      const file = `${dbPath}${suffix}`;
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, path.basename(file)));
    }
    return target;
  }
}

/**
 * Replace the database at `dbPath` with backup `source`. The caller must have
 * checked the server is stopped ({@link assertServerStopped}).
 */
export async function restoreDatabase(opts: {
  source: string;
  dbPath: string;
  backupDir: string;
  now?: Date;
  /** Needed only for an encrypted backup (one uploaded to object storage). */
  encryptionKey?: string;
}): Promise<RestoreResult> {
  const now = opts.now ?? new Date();
  const dbPath = path.resolve(opts.dbPath);
  const staging = `${dbPath}.restore-tmp`;
  const decrypted = `${staging}.dec`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.rmSync(staging, { force: true });
  fs.rmSync(decrypted, { force: true });

  try {
    try {
      let source = opts.source;
      if (isEncryptedFile(source)) {
        if (!opts.encryptionKey) {
          throw new Error('it is encrypted (copied from object storage); set SMT_ENCRYPTION_KEY to the server\'s key');
        }
        await decryptFile(source, decrypted, backupKey(opts.encryptionKey));
        source = decrypted;
      }
      await expandBackup(source, staging);
    } catch (err) {
      throw new RestoreError(`Could not read the backup: ${(err as Error).message}`);
    }
    const check = checkDatabaseFile(staging);
    if (!check.ok) throw new RestoreError(`The backup failed validation: ${check.error}`);

    // The restored file takes over the old one's owner and mode, so a server
    // running as another user than this CLI can still open it
    const previous = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
    const safetyCopy = await keepSafetyCopy(dbPath, opts.backupDir, now);

    // A leftover WAL from the old database would be replayed into the new one
    for (const suffix of SIDECARS) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.renameSync(staging, dbPath);
    fs.chmodSync(dbPath, previous ? previous.mode & 0o777 : 0o600);
    if (previous) {
      try {
        fs.chownSync(dbPath, previous.uid, previous.gid);
      } catch {
        // Only root may give a file away; as the same user it is already right
      }
    }

    return { restoredFrom: opts.source, safetyCopy, migrations: check.migrations ?? 0 };
  } finally {
    fs.rmSync(staging, { force: true });
    fs.rmSync(decrypted, { force: true });
  }
}
