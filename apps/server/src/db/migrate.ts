import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getDb } from './index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  const db = getDb();
  migrate(db, { migrationsFolder: path.join(__dirname, 'migrations') });
}

// Allow running directly: tsx src/db/migrate.ts
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  await runMigrations();
  console.log('Migrations complete');
  process.exit(0);
}
