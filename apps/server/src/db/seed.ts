import { getDb } from './index.js';
import { users, organizations, memberships } from './schema.js';
import { hashPassword } from '../auth/password.js';
import { config } from '../config/index.js';
import { nanoid } from 'nanoid';
import logger from '../logger.js';

/**
 * Ensure a default admin user exists. Idempotent — runs every startup
 * but only inserts when no users are present in the database.
 */
export async function seedDefaultAdmin(): Promise<void> {
  const db = getDb();

  const existing = db.select().from(users).limit(1).all();
  if (existing.length > 0) return;

  logger.info('No users found — seeding default admin account');

  const userId = nanoid();
  const orgId = nanoid();
  const passwordHash = await hashPassword(config.adminPassword);

  db.transaction(() => {
    db.insert(users)
      .values({
        id: userId,
        email: config.adminEmail,
        displayName: 'Admin',
        passwordHash,
      })
      .run();

    db.insert(organizations)
      .values({ id: orgId, name: 'Default Organization', slug: 'default' })
      .run();

    db.insert(memberships).values({ userId, orgId, role: 'owner' }).run();
  });

  logger.info({ email: config.adminEmail }, 'Default admin user created');
}
