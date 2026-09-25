import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
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
