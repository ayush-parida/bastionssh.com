import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { backupBeforeMigrating, pendingMigrations } from './migrate.js';
import { checkDatabaseFile, listBackups } from '../backup/core.js';

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
  entries: { tag: string }[];
};
const lastTag = journal.entries.at(-1)!.tag;

let tmp: string;
let dbPath: string;
let raw: Database.Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-premig-'));
  dbPath = path.join(tmp, 'smt.db');
  raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
});

afterEach(() => {
  raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function opts(overrides: Partial<Parameters<typeof backupBeforeMigrating>[1]> = {}) {
  return { dbPath, dir: path.join(tmp, 'backups'), gzip: false, keep: 14, enabled: true, ...overrides };
}

/** An existing install that has not yet seen the newest migration. */
function oneBehind() {
  migrate(drizzle(raw), { migrationsFolder });
  raw.exec('DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)');
  raw.exec("INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now')");
}

describe('pre-migration backup', () => {
  it('skips a brand-new database', async () => {
    expect(pendingMigrations(raw, migrationsFolder)).toEqual([]);
    expect(await backupBeforeMigrating(raw, opts(), migrationsFolder)).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'backups'))).toBe(false);
  });

  it('skips a database that is up to date', async () => {
    migrate(drizzle(raw), { migrationsFolder });
    expect(pendingMigrations(raw, migrationsFolder)).toEqual([]);
    expect(await backupBeforeMigrating(raw, opts(), migrationsFolder)).toBeNull();
  });

  it('backs up an existing database before a pending migration is applied', async () => {
    oneBehind();
    expect(pendingMigrations(raw, migrationsFolder)).toEqual([lastTag]);

    const name = await backupBeforeMigrating(raw, opts(), migrationsFolder);

    expect(name).toMatch(/^smt-\d{8}T\d{6}Z-pre-migration\.db$/);
    const [backup] = listBackups(path.join(tmp, 'backups'));
    expect(backup).toMatchObject({ name, reason: 'pre-migration' });
    const file = path.join(tmp, 'backups', name!);
    expect(checkDatabaseFile(file)).toEqual({ ok: true, migrations: journal.entries.length - 1 });
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare('SELECT id FROM organizations').all()).toEqual([{ id: 'o1' }]);
    copy.close();
  });

  it('treats tables without migration bookkeeping as existing data', () => {
    raw.exec('CREATE TABLE users (id TEXT)');
    expect(pendingMigrations(raw, migrationsFolder)).toHaveLength(journal.entries.length);
  });

  it('skips an in-memory database, and when turned off', async () => {
    oneBehind();
    expect(await backupBeforeMigrating(raw, opts({ dbPath: ':memory:' }), migrationsFolder)).toBeNull();
    expect(await backupBeforeMigrating(raw, opts({ enabled: false }), migrationsFolder)).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'backups'))).toBe(false);
  });

  it('refuses to migrate when the backup cannot be written', async () => {
    oneBehind();
    const blocked = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(blocked, '');
    await expect(backupBeforeMigrating(raw, opts({ dir: blocked }), migrationsFolder)).rejects.toThrow(
      /SMT_BACKUP_PRE_MIGRATION=false/,
    );
  });
});
