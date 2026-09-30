import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const journal = JSON.parse(fs.readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
  entries: { tag: string }[];
};

/** Apply migration files the way drizzle does: one statement per breakpoint. */
function apply(db: Database.Database, tags: string[]) {
  for (const tag of tags) {
    const sql = fs.readFileSync(path.join(dir, `${tag}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  }
}

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

const ACCESS_TAG = '0007_user_access_management';
const before = journal.entries.map((e) => e.tag).filter((t) => t < ACCESS_TAG);

describe('migration 0007 (user & access management)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(ACCESS_TAG);
  });

  it('applies to a fresh database', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['member_server_access', 'password_resets']));
  });

  it('upgrades existing data: memberships become active/all, duplicates collapse, sessions survive', () => {
    const db = freshDb();
    apply(db, before);

    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u2', 'b@x.test', 'B', 'now', 'now');
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u3', 'c@x.test', 'C', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      -- u1: an older viewer row and a newer owner row — the owner must win
      INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u1', 'o1', 'viewer', '2024-01-01');
      INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u1', 'o1', 'owner', '2024-02-01');
      INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u1', 'o1', 'admin', '2024-03-01');
      -- u2: two operator rows — the oldest wins
      INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u2', 'o1', 'operator', '2024-05-01');
      INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u2', 'o1', 'operator', '2024-04-01');
      INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u2', 'o1', 'viewer', '2023-01-01');
      -- u3: no duplicate, untouched
      INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u3', 'o1', 'viewer', '2024-01-01');
      INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', 'u1', '2999-01-01');
    `);

    apply(db, [ACCESS_TAG]);

    const rows = db.prepare('SELECT * FROM memberships ORDER BY user_id').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    // The highest-ranked row is kept, even when it is not the oldest
    expect(rows[0]).toMatchObject({
      user_id: 'u1',
      role: 'owner',
      joined_at: '2024-02-01',
      status: 'active',
      server_access: 'all',
      suspended_at: null,
    });
    // Among equal ranks, the oldest
    expect(rows[1]).toMatchObject({ user_id: 'u2', role: 'operator', joined_at: '2024-04-01' });
    expect(rows[2]).toMatchObject({ user_id: 'u3', role: 'viewer' });

    const session = db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    expect(session.id).toBe('s1');
    expect(session.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(session.active_org_id).toBeNull();

    // The unique index now holds
    expect(() =>
      db.exec("INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u1', 'o1', 'viewer', 'now')"),
    ).toThrow(/UNIQUE/);
  });

  it('drops server grants with their server', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO servers (id, org_id, name, host, username, created_by, created_at, updated_at)
        VALUES ('srv', 'o1', 's', 'h', 'root', 'u1', 'now', 'now');
      INSERT INTO member_server_access (org_id, user_id, server_id, created_at) VALUES ('o1', 'u1', 'srv', 'now');
      DELETE FROM servers WHERE id = 'srv';
    `);
    expect(db.prepare('SELECT count(*) AS n FROM member_server_access').get()).toEqual({ n: 0 });
  });
});

const PASSKEYS_TAG = '0008_passkeys';

describe('migration 0008 (passkeys)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(PASSKEYS_TAG);
  });

  it('upgrades existing data: orgs do not require passkeys, sessions and tokens start unverified', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < PASSKEYS_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u1', 'o1', 'owner', 'now');
      INSERT INTO sessions (id, user_id, expires_at, active_org_id) VALUES ('s1', 'u1', '2999-01-01', 'o1');
      INSERT INTO api_tokens (id, user_id, name, hashed_token, prefix, created_at) VALUES ('t1', 'u1', 'ci', 'h', 'p', 'now');
    `);

    apply(db, [PASSKEYS_TAG]);

    // Tokens minted before passkeys existed do not count as passkey-verified
    expect(db.prepare('SELECT id, passkey_verified FROM api_tokens').get()).toEqual({ id: 't1', passkey_verified: 0 });

    expect(db.prepare('SELECT require_passkey FROM organizations').get()).toEqual({ require_passkey: 0 });
    expect(db.prepare('SELECT id, passkey_verified FROM sessions').get()).toEqual({ id: 's1', passkey_verified: 0 });
  });

  it('keeps credential ids unique and drops passkeys and challenges with their user', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO passkeys (id, user_id, credential_id, public_key, device_type, name, created_at)
        VALUES ('p1', 'u1', 'cred', x'0102', 'multiDevice', 'Laptop', 'now');
      INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, ticket_hash, expires_at, created_at)
        VALUES ('c1', 'ch', 'second_factor', 'u1', 'hash', '2999-01-01', 'now');
      -- Challenges without a ticket may share the (null) ticket hash
      INSERT INTO webauthn_challenges (id, challenge, purpose, expires_at, created_at) VALUES ('c2', 'ch', 'login', '2999-01-01', 'now');
      INSERT INTO webauthn_challenges (id, challenge, purpose, expires_at, created_at) VALUES ('c3', 'ch', 'login', '2999-01-01', 'now');
    `);
    expect(db.prepare('SELECT counter, transports, backed_up FROM passkeys').get()).toEqual({
      counter: 0,
      transports: '[]',
      backed_up: 0,
    });
    expect(() =>
      db.exec(`INSERT INTO passkeys (id, user_id, credential_id, public_key, device_type, name, created_at)
        VALUES ('p2', 'u1', 'cred', x'01', 'singleDevice', 'Key', 'now')`),
    ).toThrow(/UNIQUE/);

    db.exec("DELETE FROM users WHERE id = 'u1'");
    expect(db.prepare('SELECT count(*) AS n FROM passkeys').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT id FROM webauthn_challenges ORDER BY id').all()).toEqual([{ id: 'c2' }, { id: 'c3' }]);
  });
});

const BACKUP_CODES_TAG = '0009_backup_codes';

describe('migration 0009 (backup codes)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(BACKUP_CODES_TAG);
  });

  it('upgrades existing data: passkeys and pending sign-ins survive, tickets start with no attempts', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < BACKUP_CODES_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO passkeys (id, user_id, credential_id, public_key, device_type, name, created_at)
        VALUES ('p1', 'u1', 'cred', x'0102', 'multiDevice', 'Laptop', 'now');
      INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, ticket_hash, expires_at, created_at)
        VALUES ('c1', 'ch', 'second_factor', 'u1', 'hash', '2999-01-01', 'now');
    `);

    apply(db, [BACKUP_CODES_TAG]);

    expect(db.prepare('SELECT id, attempts FROM webauthn_challenges').get()).toEqual({ id: 'c1', attempts: 0 });
    expect(db.prepare('SELECT id FROM passkeys').get()).toEqual({ id: 'p1' });
    expect(db.prepare('SELECT count(*) AS n FROM backup_codes').get()).toEqual({ n: 0 });
  });

  it('keeps code hashes unique and drops codes with their user', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u2', 'b@x.test', 'B', 'now', 'now');
      INSERT INTO backup_codes (id, user_id, code_hash, created_at) VALUES ('b1', 'u1', 'h1', 'now');
      INSERT INTO backup_codes (id, user_id, code_hash, created_at) VALUES ('b2', 'u2', 'h2', 'now');
    `);
    expect(db.prepare("SELECT used_at FROM backup_codes WHERE id = 'b1'").get()).toEqual({ used_at: null });
    expect(() =>
      db.exec("INSERT INTO backup_codes (id, user_id, code_hash, created_at) VALUES ('b3', 'u2', 'h1', 'now')"),
    ).toThrow(/UNIQUE/);

    db.exec("DELETE FROM users WHERE id = 'u1'");
    expect(db.prepare('SELECT id FROM backup_codes').all()).toEqual([{ id: 'b2' }]);
  });
});

const HOST_KEYS_TAG = '0010_host_keys';

describe('migration 0010 (host keys)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(HOST_KEYS_TAG);
  });

  it('upgrades existing servers to "nothing pinned", so the next connect is TOFU', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < HOST_KEYS_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO servers (id, org_id, name, host, username, created_by, created_at, updated_at)
        VALUES ('srv', 'o1', 's', 'h', 'root', 'u1', 'now', 'now');
    `);

    apply(db, [HOST_KEYS_TAG]);

    expect(
      db
        .prepare(
          `SELECT id, host_key_fingerprint, host_key_type, host_key_trusted_at, host_key_trusted_by,
             host_key_mismatch_fingerprint, host_key_mismatch_type, host_key_mismatch_at FROM servers`,
        )
        .get(),
    ).toEqual({
      id: 'srv',
      host_key_fingerprint: null,
      host_key_type: null,
      host_key_trusted_at: null,
      host_key_trusted_by: null,
      host_key_mismatch_fingerprint: null,
      host_key_mismatch_type: null,
      host_key_mismatch_at: null,
    });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const columns = (sqlite.prepare('PRAGMA table_info(servers)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual(
      expect.arrayContaining(['host_key_fingerprint', 'host_key_trusted_by', 'host_key_mismatch_at']),
    );
    expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: journal.entries.length,
    });
  });
});

const FTP_HOST_KEYS_TAG = '0011_ftp_host_keys';

describe('migration 0011 (ftp connection host keys)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(FTP_HOST_KEYS_TAG);
  });

  it('keeps existing connections and starts them with nothing pinned', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < FTP_HOST_KEYS_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO ftp_connections (id, org_id, name, host, port, protocol, username, encrypted_password, verify_tls, root_path, last_status, created_by, created_at, updated_at)
        VALUES ('f1', 'o1', 'site', 'ftp.example.com', 21, 'ftps', 'deploy', 'enc', 1, '/public_html', 'ok', 'u1', 'now', 'now');
    `);

    apply(db, [FTP_HOST_KEYS_TAG]);

    expect(
      db
        .prepare(
          `SELECT id, host, protocol, encrypted_password, root_path, last_status, host_key_fingerprint,
             host_key_type, host_key_trusted_at, host_key_mismatch_fingerprint, host_key_mismatch_at
           FROM ftp_connections`,
        )
        .get(),
    ).toEqual({
      id: 'f1',
      host: 'ftp.example.com',
      protocol: 'ftps',
      encrypted_password: 'enc',
      root_path: '/public_html',
      last_status: 'ok',
      host_key_fingerprint: null,
      host_key_type: null,
      host_key_trusted_at: null,
      host_key_mismatch_fingerprint: null,
      host_key_mismatch_at: null,
    });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const columns = (
      sqlite.prepare('PRAGMA table_info(ftp_connections)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'host_key_fingerprint',
        'host_key_type',
        'host_key_trusted_at',
        'host_key_mismatch_fingerprint',
        'host_key_mismatch_at',
      ]),
    );
  });
});

const RECORDINGS_TAG = '0012_session_recordings';

describe('migration 0012 (session recordings)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(RECORDINGS_TAG);
  });

  it('upgrades existing orgs to recording on, keystrokes off, 90-day retention', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < RECORDINGS_TAG));
    db.exec(`
      INSERT INTO organizations (id, name, slug, require_passkey, created_at, updated_at) VALUES ('o1', 'Org', 'org', 1, 'now', 'now');
    `);

    apply(db, [RECORDINGS_TAG]);

    expect(
      db
        .prepare('SELECT id, require_passkey, recording_enabled, recording_input, recording_retention_days FROM organizations')
        .get(),
    ).toEqual({ id: 'o1', require_passkey: 1, recording_enabled: 1, recording_input: 0, recording_retention_days: 90 });
    expect(db.prepare('SELECT count(*) AS n FROM session_recordings').get()).toEqual({ n: 0 });
  });

  it('keeps recordings when their server goes, and drops them and their command log with the org', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO servers (id, org_id, name, host, username, created_by, created_at, updated_at)
        VALUES ('srv', 'o1', 's', 'h', 'root', 'u1', 'now', 'now');
      INSERT INTO session_recordings (id, org_id, server_id, server_name, user_id, started_at, file_path)
        VALUES ('r1', 'o1', 'srv', 's', 'u1', 'now', 'o1/r1.cast');
      INSERT INTO session_recording_commands (id, recording_id, at, source, command, created_at)
        VALUES ('c1', 'r1', 1.5, 'ai', 'df -h', 'now');
    `);
    expect(
      db.prepare('SELECT kind, bytes, input_recorded, truncated, cols, rows, ended_at FROM session_recordings').get(),
    ).toEqual({ kind: 'terminal', bytes: 0, input_recorded: 0, truncated: 0, cols: 80, rows: 24, ended_at: null });

    db.exec("DELETE FROM servers WHERE id = 'srv'");
    expect(db.prepare('SELECT server_id, server_name FROM session_recordings').get()).toEqual({
      server_id: null,
      server_name: 's',
    });

    db.exec("DELETE FROM organizations WHERE id = 'o1'");
    expect(db.prepare('SELECT count(*) AS n FROM session_recordings').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM session_recording_commands').get()).toEqual({ n: 0 });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const columns = (sqlite.prepare('PRAGMA table_info(organizations)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual(
      expect.arrayContaining(['recording_enabled', 'recording_input', 'recording_retention_days']),
    );
    expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: journal.entries.length,
    });
  });
});

const ACCESS_REQUESTS_TAG = '0013_access_requests';

describe('migration 0013 (access requests)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(ACCESS_REQUESTS_TAG);
  });

  it('keeps existing grants permanent and gives orgs the default request policy', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < ACCESS_REQUESTS_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO memberships (user_id, org_id, role, joined_at, server_access) VALUES ('u1', 'o1', 'operator', 'now', 'restricted');
      INSERT INTO servers (id, org_id, name, host, username, created_by, created_at, updated_at)
        VALUES ('srv', 'o1', 's', 'h', 'root', 'u1', 'now', 'now');
      INSERT INTO member_server_access (org_id, user_id, server_id, created_at) VALUES ('o1', 'u1', 'srv', '2024-01-01');
    `);

    apply(db, [ACCESS_REQUESTS_TAG]);

    expect(db.prepare('SELECT * FROM member_server_access').get()).toEqual({
      org_id: 'o1',
      user_id: 'u1',
      server_id: 'srv',
      created_at: '2024-01-01',
      expires_at: null,
      granted_by: null,
      reason: null,
    });
    expect(
      db.prepare('SELECT restricted_see_server_names, access_request_max_minutes FROM organizations').get(),
    ).toEqual({ restricted_see_server_names: 1, access_request_max_minutes: 480 });
    expect(db.prepare('SELECT count(*) AS n FROM access_requests').get()).toEqual({ n: 0 });
  });

  it('starts requests pending and drops them with their requester', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO access_requests (id, org_id, user_id, server_ids, reason, duration_minutes, created_at, expires_at)
        VALUES ('r1', 'o1', 'u1', '["srv"]', 'why', 60, 'now', '2999-01-01');
    `);
    expect(db.prepare('SELECT status, decided_by, approved_minutes FROM access_requests').get()).toEqual({
      status: 'pending',
      decided_by: null,
      approved_minutes: null,
    });
    db.exec("DELETE FROM users WHERE id = 'u1'");
    expect(db.prepare('SELECT count(*) AS n FROM access_requests').get()).toEqual({ n: 0 });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const columns = (
      sqlite.prepare('PRAGMA table_info(member_server_access)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['expires_at', 'granted_by', 'reason']));
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'access_requests'").get()).toBeTruthy();
  });
});

const JUMP_HOSTS_TAG = '0014_jump_hosts';

describe('migration 0014 (jump hosts)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(JUMP_HOSTS_TAG);
  });

  it('keeps existing servers direct and lets a deleted jump host fall back to direct', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < JUMP_HOSTS_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO servers (id, org_id, name, host, username, created_by, created_at, updated_at, host_key_fingerprint)
        VALUES ('bastion', 'o1', 'b', 'b.example', 'root', 'u1', 'now', 'now', 'SHA256:x');
      INSERT INTO servers (id, org_id, name, host, username, created_by, created_at, updated_at)
        VALUES ('db', 'o1', 'd', '10.0.0.5', 'root', 'u1', 'now', 'now');
    `);

    apply(db, [JUMP_HOSTS_TAG]);

    expect(db.prepare('SELECT id, host_key_fingerprint, jump_server_id FROM servers ORDER BY id').all()).toEqual([
      { id: 'bastion', host_key_fingerprint: 'SHA256:x', jump_server_id: null },
      { id: 'db', host_key_fingerprint: null, jump_server_id: null },
    ]);

    db.exec(`UPDATE servers SET jump_server_id = 'bastion' WHERE id = 'db'`);
    expect(() => db.exec(`UPDATE servers SET jump_server_id = 'missing' WHERE id = 'db'`)).toThrow(/FOREIGN KEY/);
    db.exec(`DELETE FROM servers WHERE id = 'bastion'`);
    expect(db.prepare('SELECT id, jump_server_id FROM servers').all()).toEqual([{ id: 'db', jump_server_id: null }]);
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const columns = (sqlite.prepare('PRAGMA table_info(servers)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('jump_server_id');
    const indexes = (sqlite.prepare('PRAGMA index_list(servers)').all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain('servers_jump_server_idx');
  });
});

const AGENTS_TAG = '0015_agents';

describe('migration 0015 (connectivity agents)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(AGENTS_TAG);
  });

  it('keeps existing servers connecting directly, pinned keys intact', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < AGENTS_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO servers (id, org_id, name, host, port, username, host_key_fingerprint, created_by, created_at, updated_at)
        VALUES ('srv', 'o1', 's', 'h', 2222, 'root', 'SHA256:x', 'u1', 'now', 'now');
    `);

    apply(db, [AGENTS_TAG]);

    expect(db.prepare('SELECT id, host, port, host_key_fingerprint, agent_id FROM servers').get()).toEqual({
      id: 'srv',
      host: 'h',
      port: 2222,
      host_key_fingerprint: 'SHA256:x',
      agent_id: null,
    });
  });

  it('keeps token hashes unique, unassigns servers of a deleted agent and drops agents with their org', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO agents (id, org_id, name, token_hash, created_by, created_at) VALUES ('a1', 'o1', 'dc', 'h1', 'u1', 'now');
      INSERT INTO servers (id, org_id, name, host, username, agent_id, created_by, created_at, updated_at)
        VALUES ('srv', 'o1', 's', 'h', 'root', 'a1', 'u1', 'now', 'now');
    `);
    expect(() =>
      db.exec(
        `INSERT INTO agents (id, org_id, name, token_hash, created_by, created_at) VALUES ('a2', 'o1', 'x', 'h1', 'u1', 'now')`,
      ),
    ).toThrow(/UNIQUE/);

    db.exec(`DELETE FROM agents WHERE id = 'a1'`);
    expect(db.prepare('SELECT agent_id FROM servers').get()).toEqual({ agent_id: null });

    db.exec(`INSERT INTO agents (id, org_id, name, token_hash, created_by, created_at) VALUES ('a3', 'o1', 'y', 'h3', 'u1', 'now')`);
    db.exec(`DELETE FROM organizations WHERE id = 'o1'`);
    expect(db.prepare('SELECT count(*) AS n FROM agents').get()).toEqual({ n: 0 });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const columns = (sqlite.prepare('PRAGMA table_info(servers)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('agent_id');
    const agentColumns = (sqlite.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(agentColumns).toEqual(
      expect.arrayContaining(['id', 'org_id', 'name', 'token_hash', 'last_seen_at', 'version', 'created_by', 'revoked_at']),
    );
  });
});

const SSO_TAG = '0016_sso';

describe('migration 0016 (single sign-on)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(SSO_TAG);
  });

  it('keeps existing sessions, which were not SSO sign-ins', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < SSO_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO memberships (user_id, org_id, role, joined_at) VALUES ('u1', 'o1', 'owner', 'now');
      INSERT INTO sessions (id, user_id, expires_at, active_org_id, passkey_verified) VALUES ('s1', 'u1', '2999-01-01', 'o1', 1);
    `);

    apply(db, [SSO_TAG]);

    expect(db.prepare('SELECT id, user_id, active_org_id, passkey_verified, sso_provider_id FROM sessions').get()).toEqual({
      id: 's1',
      user_id: 'u1',
      active_org_id: 'o1',
      passkey_verified: 1,
      sso_provider_id: null,
    });
    expect(db.prepare('SELECT count(*) AS n FROM sso_providers').get()).toEqual({ n: 0 });
  });

  it('allows one provider per org, one link per subject and per user, and cleans up with the provider', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u2', 'b@x.test', 'B', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO sso_providers (id, org_id, issuer, client_id, encrypted_client_secret, created_by, created_at, updated_at)
        VALUES ('p1', 'o1', 'https://idp.test', 'c', 'enc', 'u1', 'now', 'now');
      INSERT INTO user_identities (id, provider_id, subject, user_id, email, created_at) VALUES ('i1', 'p1', 'sub', 'u1', 'a@x.test', 'now');
      INSERT INTO sso_login_states (state_hash, provider_id, encrypted_code_verifier, nonce, expires_at, created_at)
        VALUES ('h', 'p1', 'enc', 'n', '2999-01-01', 'now');
      INSERT INTO sessions (id, user_id, expires_at, active_org_id, sso_provider_id) VALUES ('s1', 'u1', '2999-01-01', 'o1', 'p1');
      INSERT INTO sessions (id, user_id, expires_at, active_org_id) VALUES ('s2', 'u1', '2999-01-01', 'o1');
    `);
    expect(
      db
        .prepare(
          'SELECT allowed_domains, default_role, auto_provision, enforce_sso, enabled, trust_idp_mfa, role_mappings FROM sso_providers',
        )
        .get(),
    ).toEqual({
      allowed_domains: '[]',
      default_role: 'viewer',
      auto_provision: 0,
      enforce_sso: 0,
      enabled: 1,
      trust_idp_mfa: 0,
      role_mappings: '[]',
    });

    expect(() =>
      db.exec(`INSERT INTO sso_providers (id, org_id, issuer, client_id, encrypted_client_secret, created_by, created_at, updated_at)
        VALUES ('p2', 'o1', 'https://other.test', 'c', 'enc', 'u1', 'now', 'now')`),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.exec(`INSERT INTO user_identities (id, provider_id, subject, user_id, email, created_at)
        VALUES ('i2', 'p1', 'sub', 'u2', 'b@x.test', 'now')`),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.exec(`INSERT INTO user_identities (id, provider_id, subject, user_id, email, created_at)
        VALUES ('i3', 'p1', 'sub2', 'u1', 'a@x.test', 'now')`),
    ).toThrow(/UNIQUE/);

    db.exec("DELETE FROM sso_providers WHERE id = 'p1'");
    expect(db.prepare('SELECT count(*) AS n FROM user_identities').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM sso_login_states').get()).toEqual({ n: 0 });
    // The SSO session goes with its provider; the password session stays
    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 's2' }]);
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const tables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['sso_providers', 'user_identities', 'sso_login_states']));
    const columns = (sqlite.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('sso_provider_id');
  });
});

const KEY_ROTATION_TAG = '0017_key_rotation';

describe('migration 0017 (key rotation)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(KEY_ROTATION_TAG);
  });

  it('keeps existing keys active and their servers on them', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < KEY_ROTATION_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO ssh_keys (id, org_id, name, type, public_key, fingerprint, encrypted_private_key, key_version, created_by, created_at, updated_at)
        VALUES ('k1', 'o1', 'deploy', 'ed25519', 'ssh-ed25519 AAAA', 'SHA256:x', 'enc', 1, 'u1', '2024-01-01', '2024-01-01');
      INSERT INTO servers (id, org_id, name, host, username, default_key_id, created_by, created_at, updated_at)
        VALUES ('srv', 'o1', 's', 'h', 'root', 'k1', 'u1', 'now', 'now');
    `);

    apply(db, [KEY_ROTATION_TAG]);

    expect(
      db.prepare('SELECT id, name, encrypted_private_key, created_at, retired_at, rotated_from_key_id FROM ssh_keys').get(),
    ).toEqual({
      id: 'k1',
      name: 'deploy',
      encrypted_private_key: 'enc',
      created_at: '2024-01-01',
      retired_at: null,
      rotated_from_key_id: null,
    });
    expect(db.prepare('SELECT default_key_id FROM servers').get()).toEqual({ default_key_id: 'k1' });
    expect(db.prepare('SELECT count(*) AS n FROM key_rotations').get()).toEqual({ n: 0 });
  });

  it('keeps history when a server is deleted and drops it with the org', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO servers (id, org_id, name, host, username, created_by, created_at, updated_at)
        VALUES ('srv', 'o1', 's', 'h', 'root', 'u1', 'now', 'now');
      INSERT INTO key_rotations (id, org_id, server_id, server_name, old_key_id, old_fingerprint, started_by, created_at)
        VALUES ('r1', 'o1', 'srv', 's', 'k-gone', 'SHA256:x', 'u1', 'now');
    `);
    expect(db.prepare('SELECT status, warnings, old_key_retired FROM key_rotations').get()).toEqual({
      status: 'pending',
      warnings: '[]',
      old_key_retired: 0,
    });

    db.exec(`DELETE FROM servers WHERE id = 'srv'`);
    expect(db.prepare('SELECT server_id, server_name FROM key_rotations').get()).toEqual({ server_id: null, server_name: 's' });

    db.exec(`DELETE FROM organizations WHERE id = 'o1'`);
    expect(db.prepare('SELECT count(*) AS n FROM key_rotations').get()).toEqual({ n: 0 });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const keyColumns = (sqlite.prepare('PRAGMA table_info(ssh_keys)').all() as { name: string }[]).map((c) => c.name);
    expect(keyColumns).toEqual(expect.arrayContaining(['retired_at', 'rotated_from_key_id']));
    const rotationColumns = (sqlite.prepare('PRAGMA table_info(key_rotations)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(rotationColumns).toEqual(expect.arrayContaining(['batch_id', 'status', 'step', 'warnings', 'finished_at']));
  });
});

const LOGIN_SECURITY_TAG = '0018_login_security_audit_retention';

describe('migration 0018 (login security, audit retention and forwarding)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(LOGIN_SECURITY_TAG);
  });

  it('keeps existing orgs and audit rows, gives orgs a year of retention and nothing forwarded', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < LOGIN_SECURITY_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO audit_log (id, org_id, actor_id, actor_email, action, resource_type, created_at)
        VALUES ('a1', 'o1', 'u1', 'a@x.test', 'server.create', 'server', '2026-01-01T00:00:00.000Z');
      INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', 'u1', '2999-01-01');
    `);

    apply(db, [LOGIN_SECURITY_TAG]);

    expect(db.prepare('SELECT id, audit_retention_days FROM organizations').get()).toEqual({
      id: 'o1',
      audit_retention_days: 365,
    });
    expect(db.prepare('SELECT id, action FROM audit_log').all()).toEqual([{ id: 'a1', action: 'server.create' }]);
    expect(db.prepare('SELECT count(*) AS n FROM audit_forwarders').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM user_devices').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM login_failures').get()).toEqual({ n: 0 });
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(indexes).toEqual(expect.arrayContaining(['audit_log_org_created_idx', 'user_devices_user_hash_idx']));
  });

  it('keeps one row per device and drops devices and forwarders with their owner', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO user_devices (id, user_id, device_hash, label, ip_prefix, first_seen_at, last_seen_at)
        VALUES ('d1', 'u1', 'h', 'Firefox on Linux', '203.0.113.0/24', 'now', 'now');
      INSERT INTO audit_forwarders (org_id, type, encrypted_config, target_hint, cursor_created_at, created_by, created_at, updated_at)
        VALUES ('o1', 'syslog', 'enc', 'udp://x:514', '', 'u1', 'now', 'now');
    `);
    expect(() =>
      db.exec(
        "INSERT INTO user_devices (id, user_id, device_hash, label, ip_prefix, first_seen_at, last_seen_at) VALUES ('d2', 'u1', 'h', 'x', 'y', 'now', 'now')",
      ),
    ).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT enabled, cursor_rowid FROM audit_forwarders').get()).toEqual({ enabled: 1, cursor_rowid: 0 });
    db.exec("DELETE FROM users WHERE id = 'u1'; DELETE FROM organizations WHERE id = 'o1';");
    expect(db.prepare('SELECT count(*) AS n FROM user_devices').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM audit_forwarders').get()).toEqual({ n: 0 });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toEqual(expect.arrayContaining(['user_devices', 'login_failures', 'audit_forwarders']));
  });
});

const FTP_OPTIONS_TAG = '0019_ftp_connection_options';

describe('migration 0019 (ftp connection options)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(FTP_OPTIONS_TAG);
  });

  it('keeps existing connections unrestricted and on password auth', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < FTP_OPTIONS_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO ftp_connections (id, org_id, name, host, port, protocol, username, encrypted_password, verify_tls, root_path, host_key_fingerprint, created_by, created_at, updated_at)
        VALUES ('f1', 'o1', 'site', 'sftp.example.com', 22, 'sftp', 'deploy', 'enc', 1, '/var/www', 'SHA256:x', 'u1', 'now', 'now');
    `);

    apply(db, [FTP_OPTIONS_TAG]);

    expect(
      db
        .prepare(
          `SELECT id, protocol, encrypted_password, root_path, host_key_fingerprint,
             restrict_to_root, auth_method, ssh_key_id
           FROM ftp_connections`,
        )
        .get(),
    ).toEqual({
      id: 'f1',
      protocol: 'sftp',
      encrypted_password: 'enc',
      root_path: '/var/www',
      host_key_fingerprint: 'SHA256:x',
      restrict_to_root: 0,
      auth_method: 'password',
      ssh_key_id: null,
    });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const columns = (
      sqlite.prepare('PRAGMA table_info(ftp_connections)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['restrict_to_root', 'auth_method', 'ssh_key_id']));
  });
});

const RECOVERY_TAG = '0020_backup_code_recovery';

describe('migration 0020 (backup-code recovery sessions)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(RECOVERY_TAG);
  });

  it('turns the rule on for existing orgs and leaves existing sessions with full access', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < RECOVERY_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, require_passkey, created_at, updated_at) VALUES ('o1', 'Org', 'org', 1, 'now', 'now');
      INSERT INTO sessions (id, user_id, expires_at, created_at, active_org_id, passkey_verified) VALUES ('s1', 'u1', 'later', 'now', 'o1', 1);
    `);

    apply(db, [RECOVERY_TAG]);

    expect(db.prepare('SELECT id, require_passkey, backup_code_recovery_only FROM organizations').get()).toEqual({
      id: 'o1',
      require_passkey: 1,
      backup_code_recovery_only: 1,
    });
    expect(db.prepare('SELECT id, active_org_id, passkey_verified, recovery_only FROM sessions').get()).toEqual({
      id: 's1',
      active_org_id: 'o1',
      passkey_verified: 1,
      recovery_only: 0,
    });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const columns = (table: string) =>
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns('organizations')).toContain('backup_code_recovery_only');
    expect(columns('sessions')).toContain('recovery_only');
  });
});

const DOCKER_TAG = '0021_docker';

describe('migration 0021 (docker)', () => {
  it('is registered in the journal', () => {
    expect(journal.entries.map((e) => e.tag)).toContain(DOCKER_TAG);
  });

  it('leaves existing servers on auto with nothing detected, and orgs on the default settings', () => {
    const db = freshDb();
    apply(db, journal.entries.map((e) => e.tag).filter((t) => t < DOCKER_TAG));
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@x.test', 'A', 'now', 'now');
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('o1', 'Org', 'org', 'now', 'now');
      INSERT INTO servers (id, org_id, name, host, port, username, tags, host_key_fingerprint, created_by, created_at, updated_at)
        VALUES ('s1', 'o1', 'web', '10.0.0.1', 22, 'root', '[]', 'SHA256:x', 'u1', 'now', 'now');
    `);

    apply(db, [DOCKER_TAG]);

    expect(
      db
        .prepare(
          `SELECT id, host_key_fingerprint, docker_mode, docker_socket_path, docker_transport,
             docker_detected_socket_path, docker_detected_at, docker_version, docker_api_version
           FROM servers`,
        )
        .get(),
    ).toEqual({
      id: 's1',
      host_key_fingerprint: 'SHA256:x',
      docker_mode: 'auto',
      docker_socket_path: null,
      docker_transport: null,
      docker_detected_socket_path: null,
      docker_detected_at: null,
      docker_version: null,
      docker_api_version: null,
    });
    expect(db.prepare('SELECT id, docker_settings FROM organizations').get()).toEqual({ id: 'o1', docker_settings: null });
  });

  it("applies through drizzle's migrator on a fresh database", () => {
    const sqlite = freshDb();
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const columns = (table: string) =>
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns('servers')).toEqual(
      expect.arrayContaining([
        'docker_mode',
        'docker_socket_path',
        'docker_transport',
        'docker_detected_socket_path',
        'docker_detected_at',
        'docker_version',
        'docker_api_version',
      ]),
    );
    expect(columns('organizations')).toContain('docker_settings');
  });
});
