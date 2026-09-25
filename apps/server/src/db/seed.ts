import { getDb } from './index.js';
import { users, organizations, memberships } from './schema.js';
import { hashPassword } from '../auth/password.js';
import { config } from '../config/index.js';
import { nanoid } from 'nanoid';
import { randomBytes } from 'crypto';
import logger from '../logger.js';

/**
 * Ensure a default admin user exists. Idempotent — runs every startup
 * but only inserts when no users are present in the database.
 *
 * A null password (no SMT_ADMIN_PASSWORD outside dev/test) gets a random one,
 * printed exactly once here; it is never stored anywhere else.
 */
export async function seedDefaultAdmin(
  admin: { email: string; password: string | null } = {
    email: config.adminEmail,
    password: config.adminPassword,
  },
): Promise<void> {
  const db = getDb();

  const existing = db.select().from(users).limit(1).all();
  if (existing.length > 0) return;

  logger.info('No users found — seeding default admin account');

  // Login matches emails case-insensitively; store the canonical form.
  const email = admin.email.trim().toLowerCase();
  const generated = admin.password === null;
  const password = admin.password ?? randomBytes(18).toString('base64url');

  const userId = nanoid();
  const orgId = nanoid();
  const passwordHash = await hashPassword(password);

  db.transaction(() => {
    db.insert(users)
      .values({
        id: userId,
        email,
        displayName: 'Admin',
        passwordHash,
      })
      .run();

    db.insert(organizations)
      .values({ id: orgId, name: 'Default Organization', slug: 'default' })
      .run();

    db.insert(memberships).values({ userId, orgId, role: 'owner' }).run();
  });

  logger.info({ email }, 'Default admin user created');
  if (generated) {
    // Straight to stderr rather than the logger: SMT_LOG_LEVEL=error would drop a
    // warn line, and seeding never runs again, leaving no way to learn it.
    process.stderr.write(
      [
        '',
        '================================================================',
        ' Generated a random admin password (SMT_ADMIN_PASSWORD was not set).',
        ` Email:    ${email}`,
        ` Password: ${password}`,
        ' It is shown only once — sign in and change it now.',
        '================================================================',
        '',
      ].join('\n') + '\n',
    );
  }
}
