import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { gunzipSync } from 'zlib';
import { pipeline } from 'stream/promises';
import { checkDatabaseFile, createBackup, isGzipFile, listBackups, pruneBackups } from './core.js';
import { backupKey, encryptedStream, isEncryptedFile } from './crypt.js';
import { backupFileName, defaultBackupDir, isValidBackupName, parseBackupName, resolveBackupPath } from './files.js';
import { holdServerLock, lockHeldReason, lockPath, LOCK_STALE_MS } from './lock.js';
import {
  assertServerStopped,
  cliSettings,
  parseRestoreArgs,
  resolveRestoreSource,
  restoreDatabase,
  RestoreError,
} from './restore.js';

let tmp: string;
const KEY = Buffer.alloc(32, 3).toString('base64');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-backup-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A WAL database shaped enough like the app's to pass checkDatabaseFile. */
function makeDb(file: string, rows = 0): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);
    INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h0', 1), ('h1', 2);
    CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE webauthn_challenges (id TEXT PRIMARY KEY, challenge TEXT);
    INSERT INTO sessions VALUES ('live-session-secret', 'u1');
    INSERT INTO webauthn_challenges VALUES ('c1', 'pending-challenge');
    CREATE TABLE sso_login_states (state_hash TEXT PRIMARY KEY, nonce TEXT);
    INSERT INTO sso_login_states VALUES ('state-hash', 'pending-sso-nonce');
    CREATE TABLE invites (id TEXT PRIMARY KEY, email TEXT NOT NULL, token TEXT NOT NULL UNIQUE);
    INSERT INTO invites VALUES ('i1', 'new@example.com', 'pending-invite-token');
  `);
  const insert = db.prepare('INSERT INTO items (body) VALUES (?)');
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`row-${i}-${'x'.repeat(200)}`);
  })();
  return db;
}

function count(file: string, table: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function touchBackup(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'x');
}

describe('backup file names', () => {
  it('encode the UTC time and reason, and parse back', () => {
    const at = new Date('2026-09-28T03:15:07.456Z');
    expect(backupFileName(at, 'scheduled', false)).toBe('smt-20260928T031507Z-scheduled.db');
    expect(backupFileName(at, 'pre-migration', true, 2)).toBe('smt-20260928T031507Z-pre-migration-2.db.gz');
    expect(parseBackupName('smt-20260928T031507Z-manual-2.db.gz')).toEqual({
      name: 'smt-20260928T031507Z-manual-2.db.gz',
      reason: 'manual',
      createdAt: new Date('2026-09-28T03:15:07Z'),
      sequence: 2,
      compressed: true,
    });
  });

  it.each([
    '../smt-20260928T031507Z-manual.db',
    'smt-20260928T031507Z-manual.db/../../etc/passwd',
    '..%2Fsmt-20260928T031507Z-manual.db',
    'smt-20260928T031507Z-manual.db\0',
    '/data/backups/smt-20260928T031507Z-manual.db',
    'smt-20260928T031507Z-evil.db',
    'smt-20260928T031507Z-manual.db.partial',
    'smt-20261340T031507Z-manual.db', // month 13
    'smt-20260928T031507Z-manual.sqlite',
    'smt.db',
    '',
  ])('rejects %j', (name) => {
    expect(isValidBackupName(name)).toBe(false);
    expect(resolveBackupPath(tmp, name)).toBeNull();
  });

  it('resolves only inside the backup directory', () => {
    const name = 'smt-20260928T031507Z-manual.db';
    expect(resolveBackupPath(tmp, name)).toBe(path.join(path.resolve(tmp), name));
    expect(defaultBackupDir('/data/smt.db')).toBe('/data/backups');
  });
});

describe('createBackup', () => {
  it('produces a valid, consistent copy while the source keeps being written', async () => {
    const src = path.join(tmp, 'smt.db');
    const db = makeDb(src, 5000);
    const insert = db.prepare('INSERT INTO items (body) VALUES (?)');

    // Keep writing from the event loop while the backup steps through the pages
    let writing = true;
    let written = 0;
    const writer = (async () => {
      while (writing) {
        insert.run(`live-${written++}`);
        await new Promise((r) => setImmediate(r));
      }
    })();
    // A second connection writing too, which makes SQLite restart the copy
    const other = new Database(src);
    const otherInsert = other.prepare('INSERT INTO items (body) VALUES (?)');
    const otherTimer = setInterval(() => otherInsert.run('other'), 20);

    const backup = await createBackup({
      source: db,
      dir: path.join(tmp, 'backups'),
      reason: 'manual',
      pagesPerStep: 10,
    });
    writing = false;
    clearInterval(otherTimer);
    await writer;
    other.close();

    // The copy took many steps, with writes landing between them
    expect(written).toBeGreaterThan(10);
    expect(backup.name).toMatch(/^smt-\d{8}T\d{6}Z-manual\.db$/);
    expect(backup.size).toBe(fs.statSync(backup.path).size);
    expect(checkDatabaseFile(backup.path)).toEqual({ ok: true, migrations: 2 });
    // Every row from before the backup started is in it; nothing half-written
    const copied = count(backup.path, 'items');
    expect(copied).toBeGreaterThanOrEqual(5000);
    expect(copied).toBeLessThanOrEqual(count(src, 'items'));
    // A self-contained file: no WAL beside it
    expect(fs.existsSync(`${backup.path}-wal`)).toBe(false);
    expect(fs.statSync(backup.path).mode & 0o777).toBe(0o600);
    db.close();
  });

  it('strips live sessions and pending passkey challenges from the copy only', async () => {
    const src = path.join(tmp, 'smt.db');
    const db = makeDb(src, 10);
    const backup = await createBackup({ source: db, dir: tmp, reason: 'manual' });
    expect(count(backup.path, 'sessions')).toBe(0);
    expect(count(backup.path, 'webauthn_challenges')).toBe(0);
    expect(count(backup.path, 'sso_login_states')).toBe(0);
    expect(fs.readFileSync(backup.path).includes('live-session-secret')).toBe(false);
    // Invites stay, but their tokens (enough to join, with the email beside them) do not
    expect(count(backup.path, 'invites')).toBe(1);
    expect(fs.readFileSync(backup.path).includes('pending-invite-token')).toBe(false);
    // The live database is untouched
    expect(count(src, 'sessions')).toBe(1);
    const liveToken = db.prepare('SELECT token FROM invites').get() as { token: string };
    expect(liveToken.token).toBe('pending-invite-token');
    db.close();
  });

  it('gzips when asked, from a path, and never reuses a name', async () => {
    const src = path.join(tmp, 'smt.db');
    makeDb(src, 10).close();
    const now = new Date('2026-09-28T03:15:07Z');
    const a = await createBackup({ source: src, dir: tmp, reason: 'scheduled', gzip: true, now });
    const b = await createBackup({ source: src, dir: tmp, reason: 'scheduled', gzip: true, now });
    expect(a.name).toBe('smt-20260928T031507Z-scheduled.db.gz');
    expect(b.name).toBe('smt-20260928T031507Z-scheduled-1.db.gz');
    const plain = path.join(tmp, 'plain.db');
    fs.writeFileSync(plain, gunzipSync(fs.readFileSync(a.path)));
    expect(checkDatabaseFile(plain)).toMatchObject({ ok: true });
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });
});

describe('listBackups / pruneBackups', () => {
  it('lists backups newest first, ignoring anything else in the directory', () => {
    touchBackup(tmp, 'smt-20260101T000000Z-scheduled.db');
    touchBackup(tmp, 'smt-20260301T000000Z-manual.db.gz');
    touchBackup(tmp, 'smt-20260301T000000Z-manual-1.db.gz');
    touchBackup(tmp, 'notes.txt');
    touchBackup(tmp, 'smt-20260401T000000Z-manual.db.partial');
    fs.symlinkSync('/etc/hosts', path.join(tmp, 'smt-20260501T000000Z-manual.db'));
    expect(listBackups(tmp).map((b) => b.name)).toEqual([
      'smt-20260301T000000Z-manual-1.db.gz',
      'smt-20260301T000000Z-manual.db.gz',
      'smt-20260101T000000Z-scheduled.db',
    ]);
    expect(listBackups(path.join(tmp, 'missing'))).toEqual([]);
  });

  it('keeps the newest N of each reason', () => {
    for (let d = 1; d <= 5; d++) touchBackup(tmp, `smt-2026010${d}T000000Z-scheduled.db`);
    touchBackup(tmp, 'smt-20250101T000000Z-pre-migration.db');
    touchBackup(tmp, 'smt-20250102T000000Z-manual.db');
    const removed = pruneBackups(tmp, 3);
    expect(removed.sort()).toEqual(['smt-20260101T000000Z-scheduled.db', 'smt-20260102T000000Z-scheduled.db']);
    expect(listBackups(tmp).map((b) => b.name)).toEqual([
      'smt-20260105T000000Z-scheduled.db',
      'smt-20260104T000000Z-scheduled.db',
      'smt-20260103T000000Z-scheduled.db',
      'smt-20250102T000000Z-manual.db',
      'smt-20250101T000000Z-pre-migration.db',
    ]);
  });

  it('clears stale partial files but not one still being written', () => {
    touchBackup(tmp, 'smt-20260101T000000Z-scheduled.db.partial');
    touchBackup(tmp, 'smt-20260102T000000Z-scheduled.db.gz.partial');
    const old = new Date(Date.now() - 24 * 3_600_000);
    fs.utimesSync(path.join(tmp, 'smt-20260101T000000Z-scheduled.db.partial'), old, old);
    expect(pruneBackups(tmp, 14)).toEqual(['smt-20260101T000000Z-scheduled.db.partial']);
    expect(fs.existsSync(path.join(tmp, 'smt-20260102T000000Z-scheduled.db.gz.partial'))).toBe(true);
  });
});

describe('checkDatabaseFile', () => {
  it('rejects files that are not a sound BastionSSH database', () => {
    const junk = path.join(tmp, 'junk.db');
    fs.writeFileSync(junk, 'hello');
    expect(checkDatabaseFile(junk)).toEqual({ ok: false, error: 'Not a SQLite database' });

    const other = path.join(tmp, 'other.db');
    const db = new Database(other);
    db.exec('CREATE TABLE t (x)');
    db.close();
    expect(checkDatabaseFile(other)).toMatchObject({ ok: false, error: expect.stringMatching(/__drizzle_migrations/) });

    // Damage a page past the header
    const good = path.join(tmp, 'good.db');
    const g = makeDb(good, 2000);
    g.pragma('wal_checkpoint(TRUNCATE)');
    g.close();
    const bytes = fs.readFileSync(good);
    bytes.fill(0xab, 4096 * 3, 4096 * 6);
    fs.writeFileSync(good, bytes);
    expect(checkDatabaseFile(good).ok).toBe(false);
  });
});

describe('server lock', () => {
  it('is held while fresh, stale once the heartbeat stops', () => {
    const dbPath = path.join(tmp, 'smt.db');
    expect(lockHeldReason(dbPath)).toBeNull();
    // Written by a server in another container: a pid we cannot check
    fs.writeFileSync(lockPath(dbPath), JSON.stringify({ pid: 1, hostname: 'elsewhere', startedAt: 'x' }));
    expect(lockHeldReason(dbPath)).toMatch(/pid 1 on elsewhere/);
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    fs.utimesSync(lockPath(dbPath), old, old);
    expect(lockHeldReason(dbPath)).toBeNull();
  });

  it('a stale lock on this host still counts while its process is alive', () => {
    const dbPath = path.join(tmp, 'smt.db');
    fs.writeFileSync(lockPath(dbPath), JSON.stringify({ pid: process.ppid, hostname: os.hostname(), startedAt: 'x' }));
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    fs.utimesSync(lockPath(dbPath), old, old);
    expect(lockHeldReason(dbPath)).toMatch(/still alive/);
  });

  it('holdServerLock writes the lock and removes it on release', () => {
    const dbPath = path.join(tmp, 'sub', 'smt.db');
    const release = holdServerLock(dbPath, 8080);
    try {
      expect(JSON.parse(fs.readFileSync(lockPath(dbPath), 'utf8'))).toMatchObject({ pid: process.pid, port: 8080 });
      expect(lockHeldReason(dbPath)).not.toBeNull();
    } finally {
      release();
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
    }
    expect(fs.existsSync(lockPath(dbPath))).toBe(false);
  });
});

describe('restore CLI', () => {
  it('parses arguments, dropping the -- pnpm forwards', () => {
    expect(parseRestoreArgs(['--', 'x.db'])).toEqual({ file: 'x.db', skipPortCheck: false, help: false });
    expect(parseRestoreArgs(['--skip-port-check', 'x.db']).skipPortCheck).toBe(true);
    expect(parseRestoreArgs(['--help']).help).toBe(true);
    expect(() => parseRestoreArgs(['a.db', 'b.db'])).toThrow(RestoreError);
    expect(() => parseRestoreArgs(['--force', 'a.db'])).toThrow(/Unknown option/);
  });

  it('reads the same settings as the server', () => {
    expect(cliSettings({}, defaultBackupDir)).toEqual({
      dbPath: '/data/smt.db',
      backupDir: '/data/backups',
      port: 8080,
      keep: 14,
      gzip: false,
    });
    expect(
      cliSettings(
        { SMT_DB_URL: '/srv/smt.db', SMT_BACKUP_DIR: '/mnt/b', SMT_PORT: '9000', SMT_BACKUP_GZIP: 'true', SMT_BACKUP_KEEP: '3' },
        defaultBackupDir,
      ),
    ).toEqual({ dbPath: '/srv/smt.db', backupDir: '/mnt/b', port: 9000, keep: 3, gzip: true });
  });

  it('finds a backup by name in the backup directory or by path', () => {
    const name = 'smt-20260101T000000Z-scheduled.db';
    touchBackup(tmp, name);
    expect(resolveRestoreSource(name, tmp, '/')).toBe(path.join(tmp, name));
    expect(resolveRestoreSource(path.join(tmp, name), '/nowhere')).toBe(path.join(tmp, name));
    expect(() => resolveRestoreSource('smt-20260102T000000Z-scheduled.db', tmp, tmp)).toThrow(/not found/);
    expect(() => resolveRestoreSource(tmp, tmp)).toThrow(/not found/); // a directory
  });

  it('refuses while the server holds the lock or the port', async () => {
    const dbPath = path.join(tmp, 'smt.db');
    fs.writeFileSync(lockPath(dbPath), JSON.stringify({ pid: 1, hostname: 'elsewhere', startedAt: 'x' }));
    await expect(assertServerStopped(dbPath)).rejects.toThrow(/looks like it is running/);
    fs.rmSync(lockPath(dbPath));

    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await expect(assertServerStopped(dbPath, { port })).rejects.toThrow(new RegExp(`port ${port}`));
      await expect(assertServerStopped(dbPath, { port, skipPortCheck: true })).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('validates, keeps the current database, and swaps the backup in', async () => {
    const dbPath = path.join(tmp, 'data', 'smt.db');
    fs.mkdirSync(path.dirname(dbPath));
    const backupDir = path.join(tmp, 'data', 'backups');

    const live = makeDb(dbPath, 10);
    const backup = await createBackup({ source: live, dir: backupDir, reason: 'scheduled', gzip: true });
    // Diverge after the backup, and leave a WAL behind as a crashed server would
    live.exec("INSERT INTO items (body) VALUES ('after-backup')");
    live.pragma('wal_autocheckpoint = 0');
    live.exec("INSERT INTO items (body) VALUES ('in-wal')");
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    // Simulate a crash: keep the files as they are now (closing would checkpoint and drop the WAL)
    const crashed = path.join(tmp, 'crashed');
    fs.mkdirSync(crashed);
    for (const f of ['smt.db', 'smt.db-wal']) fs.copyFileSync(path.join(tmp, 'data', f), path.join(crashed, f));
    live.close();
    fs.rmSync(`${dbPath}-shm`, { force: true });
    for (const f of ['smt.db', 'smt.db-wal']) fs.copyFileSync(path.join(crashed, f), path.join(tmp, 'data', f));

    const result = await restoreDatabase({ source: backup.path, dbPath, backupDir, now: new Date('2026-09-28T00:00:00Z') });

    expect(result.migrations).toBe(2);
    expect(result.safetyCopy).toBe(path.join(backupDir, 'smt-20260928T000000Z-pre-restore.db'));
    // The restored database has the backup's rows, not the WAL's
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(count(dbPath, 'items')).toBe(10);
    // The safety copy has everything the old database had, WAL included
    expect(count(result.safetyCopy!, 'items')).toBe(12);
    expect(fs.existsSync(`${dbPath}.restore-tmp`)).toBe(false);
  });

  it('leaves the current database alone when the backup is bad', async () => {
    const dbPath = path.join(tmp, 'smt.db');
    makeDb(dbPath, 3).close();
    const before = fs.readFileSync(dbPath);
    const bad = path.join(tmp, 'bad.db');
    fs.writeFileSync(bad, 'SQLite format 3\0 but not really');

    await expect(restoreDatabase({ source: bad, dbPath, backupDir: path.join(tmp, 'b') })).rejects.toThrow(
      /failed validation/,
    );
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'b'))).toBe(false);
    expect(fs.existsSync(`${dbPath}.restore-tmp`)).toBe(false);
  });

  it('restores an encrypted copy from object storage, given the key', async () => {
    const src = path.join(tmp, 'src.db');
    makeDb(src, 4).close();
    const backup = await createBackup({ source: src, dir: tmp, reason: 'scheduled', gzip: true });
    const sealed = path.join(tmp, `${backup.name}.enc`);
    await pipeline(encryptedStream(backup.path, backupKey(KEY)), fs.createWriteStream(sealed));
    expect(isEncryptedFile(sealed)).toBe(true);
    // Neither the database nor its gzip is readable as-is
    expect(fs.readFileSync(sealed).includes('SQLite format 3')).toBe(false);
    expect(isGzipFile(sealed)).toBe(false);

    const dbPath = path.join(tmp, 'new', 'smt.db');
    await expect(restoreDatabase({ source: sealed, dbPath, backupDir: tmp })).rejects.toThrow(/SMT_ENCRYPTION_KEY/);
    const otherKey = Buffer.alloc(32, 7).toString('base64');
    await expect(restoreDatabase({ source: sealed, dbPath, backupDir: tmp, encryptionKey: otherKey })).rejects.toThrow(
      /wrong SMT_ENCRYPTION_KEY/,
    );
    expect(fs.existsSync(dbPath)).toBe(false);

    // A flipped byte is caught by the GCM tag
    const tampered = path.join(tmp, 'tampered.enc');
    const bytes = fs.readFileSync(sealed);
    bytes[40] = bytes[40]! ^ 1;
    fs.writeFileSync(tampered, bytes);
    await expect(restoreDatabase({ source: tampered, dbPath, backupDir: tmp, encryptionKey: KEY })).rejects.toThrow(
      RestoreError,
    );
    expect(fs.existsSync(dbPath)).toBe(false);

    await restoreDatabase({ source: sealed, dbPath, backupDir: tmp, encryptionKey: KEY });
    expect(count(dbPath, 'items')).toBe(4);
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('restore-tmp'))).toEqual([]);
  });

  it('restores into a location with no database yet', async () => {
    const src = path.join(tmp, 'src.db');
    makeDb(src, 4).close();
    const backup = await createBackup({ source: src, dir: tmp, reason: 'manual' });
    const dbPath = path.join(tmp, 'new', 'smt.db');
    const result = await restoreDatabase({ source: backup.path, dbPath, backupDir: tmp });
    expect(result.safetyCopy).toBeNull();
    expect(count(dbPath, 'items')).toBe(4);
  });
});
