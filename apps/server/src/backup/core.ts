import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createGunzip, createGzip } from 'zlib';
import type { DbBackup, DbBackupReason } from '@smt/shared';
import { backupFileName, parseBackupName } from './files.js';

/**
 * Online backups of the app's SQLite database. Kept free of config, logger
 * and the app's db handle so the db:backup / db:restore CLIs can use it with
 * nothing but a path — including when the server's environment is broken.
 */

/** Pages copied per step; between steps the source stays writable. */
const PAGES_PER_STEP = 1000;

/** A `.partial` older than this is a crashed run and is cleaned up by pruning. */
const STALE_PARTIAL_MS = 6 * 60 * 60 * 1000;

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Bearer secrets that must not leave the instance in a file someone can
 * download: session ids are stored as-is, and a pending passkey challenge or
 * single sign-on round trip is half a sign-in. A restored database simply has
 * everyone sign in again.
 */
const SCRUBBED_TABLES = ['sessions', 'webauthn_challenges', 'sso_login_states'];

/**
 * Invite tokens are stored as-is too, and a token plus the invite's email (in
 * the same row) is enough to join an org at the invited role. Each is replaced
 * with a random value nobody knows, so a restored invite has to be sent again.
 */
const SCRUB_INVITE_TOKENS = 'UPDATE "invites" SET "token" = lower(hex(randomblob(32)))';

export interface CreateBackupOptions {
  /** An open connection (the running app's) or the path of a database file. */
  source: Database.Database | string;
  dir: string;
  reason: DbBackupReason;
  gzip?: boolean;
  now?: Date;
  /** Pages copied between yields to the event loop (tests shrink it). */
  pagesPerStep?: number;
}

export interface CreatedBackupFile extends DbBackup {
  path: string;
}

function ensureDir(dir: string) {
  // Backups hold password hashes and encrypted credentials: owner-only
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** A name not yet taken in `dir`, adding -1, -2… for several backups in one second. */
function freeName(dir: string, now: Date, reason: DbBackupReason, gzip: boolean): string {
  for (let seq = 0; seq < 1000; seq++) {
    const name = backupFileName(now, reason, gzip, seq);
    const plain = name.replace(/\.gz$/, '');
    const taken = [plain, `${plain}.gz`, `${plain}.partial`, `${plain}.gz.partial`].some((n) =>
      fs.existsSync(path.join(dir, n)),
    );
    if (!taken) return name;
  }
  throw new Error('Too many backups in one second');
}

/** Drop scrubbed rows for good (secure_delete zeroes them) and make the copy a single self-contained file. */
function finalizeCopy(file: string) {
  const db = new Database(file);
  try {
    db.pragma('secure_delete = ON');
    const existing = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
    );
    for (const table of SCRUBBED_TABLES) {
      if (existing.has(table)) db.exec(`DELETE FROM "${table}"`);
    }
    if (existing.has('invites')) db.exec(SCRUB_INVITE_TOKENS);
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

/**
 * Take a consistent copy with SQLite's online backup API. Safe while the app
 * keeps writing (WAL or not): SQLite restarts the copy if another connection
 * changes the source mid-way, and folds in changes made on the same one.
 */
export async function createBackup(opts: CreateBackupOptions): Promise<CreatedBackupFile> {
  const now = opts.now ?? new Date();
  const gzip = opts.gzip ?? false;
  const dir = path.resolve(opts.dir);
  ensureDir(dir);

  const name = freeName(dir, now, opts.reason, gzip);
  const finalPath = path.join(dir, name);
  const rawPartial = path.join(dir, `${name.replace(/\.gz$/, '')}.partial`);
  const gzPartial = `${finalPath}.partial`;

  const ownsSource = typeof opts.source === 'string';
  const source =
    typeof opts.source === 'string' ? new Database(opts.source, { fileMustExist: true }) : opts.source;
  try {
    const step = opts.pagesPerStep ?? PAGES_PER_STEP;
    await source.backup(rawPartial, { progress: () => step });
    fs.chmodSync(rawPartial, 0o600);
    finalizeCopy(rawPartial);

    if (gzip) {
      await pipeline(
        fs.createReadStream(rawPartial),
        createGzip(),
        fs.createWriteStream(gzPartial, { mode: 0o600 }),
      );
      fs.rmSync(rawPartial, { force: true });
      fs.renameSync(gzPartial, finalPath);
    } else {
      fs.renameSync(rawPartial, finalPath);
    }
  } catch (err) {
    fs.rmSync(rawPartial, { force: true });
    fs.rmSync(gzPartial, { force: true });
    throw err;
  } finally {
    if (ownsSource) source.close();
  }

  const size = fs.statSync(finalPath).size;
  return {
    name,
    path: finalPath,
    reason: opts.reason,
    createdAt: parseBackupName(name)!.createdAt.toISOString(),
    size,
    compressed: gzip,
  };
}

/** Backups in `dir`, newest first. Anything not named like a backup is ignored. */
export function listBackups(dir: string): DbBackup[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: (DbBackup & { sequence: number })[] = [];
  for (const entry of entries) {
    // Regular files only — a symlink named like a backup is not followed
    if (!entry.isFile()) continue;
    const parsed = parseBackupName(entry.name);
    if (!parsed) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, entry.name)).size;
    } catch {
      continue; // Pruned between readdir and stat
    }
    out.push({
      name: parsed.name,
      reason: parsed.reason,
      createdAt: parsed.createdAt.toISOString(),
      size,
      compressed: parsed.compressed,
      sequence: parsed.sequence,
    });
  }
  // Same second: the higher -N suffix is the later one
  return out
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sequence - a.sequence || a.name.localeCompare(b.name))
    .map(({ sequence: _sequence, ...backup }) => backup);
}

/**
 * Keep the newest `keep` backups of each reason and delete the rest, so a
 * burst of manual backups never pushes out the scheduled ones (or the other
 * way round). Also clears `.partial` leftovers from a crashed run.
 */
export function pruneBackups(dir: string, keep: number, now = new Date()): string[] {
  const removed: string[] = [];
  const seen = new Map<string, number>();
  for (const backup of listBackups(dir)) {
    const n = (seen.get(backup.reason) ?? 0) + 1;
    seen.set(backup.reason, n);
    if (n > Math.max(1, keep)) {
      fs.rmSync(path.join(dir, backup.name), { force: true });
      removed.push(backup.name);
    }
  }
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    if (!entry.isFile() || !entry.name.endsWith('.partial') || !entry.name.startsWith('smt-')) continue;
    const full = path.join(dir, entry.name);
    try {
      if (now.getTime() - fs.statSync(full).mtimeMs > STALE_PARTIAL_MS) {
        fs.rmSync(full, { force: true });
        removed.push(entry.name);
      }
    } catch {
      // Gone already
    }
  }
  return removed;
}

export function isGzipFile(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    return head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    fs.closeSync(fd);
  }
}

/** Copy a backup to `dest` as a plain database file, decompressing a gzip one. */
export async function expandBackup(file: string, dest: string): Promise<void> {
  if (isGzipFile(file)) {
    await pipeline(fs.createReadStream(file), createGunzip(), fs.createWriteStream(dest, { mode: 0o600 }));
  } else {
    fs.copyFileSync(file, dest);
    fs.chmodSync(dest, 0o600);
  }
}

export interface BackupCheck {
  ok: boolean;
  error?: string;
  /** Migrations recorded in the file. */
  migrations?: number;
}

/**
 * Is `file` (uncompressed) a sound BastionSSH database? It must be SQLite,
 * pass PRAGMA integrity_check, and carry the migrations table the app keeps.
 */
export function checkDatabaseFile(file: string): BackupCheck {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    fs.readSync(fd, head, 0, head.length, 0);
    if (!head.equals(SQLITE_MAGIC)) return { ok: false, error: 'Not a SQLite database' };
  } finally {
    fs.closeSync(fd);
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    const problems = rows.map((r) => r.integrity_check).filter((r) => r !== 'ok');
    if (problems.length) return { ok: false, error: `integrity_check failed: ${problems.slice(0, 3).join('; ')}` };
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get();
    if (!table) return { ok: false, error: 'Not a BastionSSH database (no __drizzle_migrations table)' };
    const { n } = db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number };
    return { ok: true, migrations: n };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    db?.close();
  }
}
