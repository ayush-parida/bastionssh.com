import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type Database from 'better-sqlite3';
import { databasePath, getDb, getRawDb } from './index.js';
import { config } from '../config/index.js';
import { createBackup, pruneBackups } from '../backup/core.js';
import logger from '../logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.join(__dirname, 'migrations');

/**
 * Tags of the migrations drizzle would apply to `raw`, using its own rule (any
 * migration newer than the last one recorded). Empty for a brand-new database
 * — nothing to lose there — and for one that is up to date.
 */
export function pendingMigrations(raw: Database.Database, migrationsFolder = MIGRATIONS_FOLDER): string[] {
  const tables = (
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  if (tables.length === 0) return [];

  let last: number | null = null;
  if (tables.includes('__drizzle_migrations')) {
    const row = raw.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as
      | { created_at: number | string }
      | undefined;
    last = row ? Number(row.created_at) : null;
  }
  // Only the bookkeeping table and nothing recorded in it: still a fresh database
  if (last === null && tables.every((t) => t === '__drizzle_migrations')) return [];

  // The journal's `when` is what drizzle records as created_at
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries.filter((e) => last === null || last < e.when).map((e) => e.tag);
}

/**
 * Before a migration touches an existing database, copy it aside so a failed
 * or unwanted upgrade can be undone with db:restore. Refuses to migrate when
 * that copy cannot be taken; SMT_BACKUP_PRE_MIGRATION=false skips it.
 */
export async function backupBeforeMigrating(
  raw: Database.Database,
  opts: { dbPath: string; dir: string; gzip: boolean; keep: number; enabled: boolean },
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<string | null> {
  if (!opts.enabled || opts.dbPath === ':memory:' || opts.dbPath === '') return null;
  const pending = pendingMigrations(raw, migrationsFolder);
  if (pending.length === 0) return null;

  let name: string;
  try {
    const backup = await createBackup({ source: raw, dir: opts.dir, reason: 'pre-migration', gzip: opts.gzip });
    name = backup.name;
  } catch (err) {
    throw new Error(
      `Could not back up the database before migrating (${(err as Error).message}). ` +
        'Fix the backup directory (SMT_BACKUP_DIR), or set SMT_BACKUP_PRE_MIGRATION=false to migrate without a backup.',
    );
  }
  logger.info({ backup: name, dir: opts.dir, pending }, 'Backed up the database before applying migrations');
  try {
    pruneBackups(opts.dir, opts.keep);
  } catch (err) {
    logger.warn({ err }, 'Could not prune old database backups');
  }
  return name;
}

export async function runMigrations() {
  const db = getDb();
  await backupBeforeMigrating(getRawDb(), {
    dbPath: databasePath(),
    dir: config.backup.dir,
    gzip: config.backup.gzip,
    keep: config.backup.keep,
    enabled: config.backup.preMigration,
  });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

// Allow running directly: tsx src/db/migrate.ts
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  await runMigrations();
  console.log('Migrations complete');
  process.exit(0);
}
