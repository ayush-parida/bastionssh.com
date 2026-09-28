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
