import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getDb } from './index.js';
import { runMigrations } from './migrate.js';
import { users } from './schema.js';
import { seedDefaultAdmin } from './seed.js';
import { verifyPassword } from '../auth/password.js';

describe('seedDefaultAdmin', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it('generates a random password when none is configured, and lowercases the email', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await seedDefaultAdmin({ email: ' Ops@Corp.COM ', password: null });
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    stderr.mockRestore();

    const rows = getDb().select().from(users).all();
    expect(rows).toHaveLength(1);
    const admin = rows[0]!;
    expect(admin.email).toBe('ops@corp.com');
    expect(admin.passwordHash).toBeTruthy();
    expect(await verifyPassword('admin1234', admin.passwordHash!)).toBe(false);

    // Printed regardless of SMT_LOG_LEVEL, and it is the password that was stored.
    const shown = /Password: (\S+)/.exec(printed)?.[1];
    expect(shown).toBeTruthy();
    expect(await verifyPassword(shown!, admin.passwordHash!)).toBe(true);
  });

  it('does nothing once a user exists', async () => {
    await seedDefaultAdmin({ email: 'other@corp.com', password: 'whatever-pass' });
    expect(getDb().select().from(users).all()).toHaveLength(1);
  });
});
