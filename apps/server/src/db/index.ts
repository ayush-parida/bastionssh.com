import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { config } from '../config/index.js';
import path from 'path';
import fs from 'fs';

let db: ReturnType<typeof drizzle> | null = null;
let rawDb: Database.Database | null = null;

export function getDb() {
  if (db) return db;

  const dbPath = config.dbUrl ?? path.join('/data', 'smt.db');
  const dir = path.dirname(dbPath);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  rawDb = new Database(dbPath);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');

  db = drizzle(rawDb, { schema });
  return db;
}

export function getRawDb() {
  if (!rawDb) getDb();
  return rawDb!;
}
