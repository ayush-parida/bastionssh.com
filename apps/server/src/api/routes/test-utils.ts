import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import { apiTokens, memberships, organizations, users } from '../../db/schema.js';
import { generateApiToken } from '../../auth/token.js';
import type { Role } from '../../auth/middleware.js';

/** Test-only seeding helpers shared by the route suites. */

export function seedOrg(slug: string): string {
  const id = nanoid();
  getDb().insert(organizations).values({ id, name: slug, slug }).run();
  return id;
}

/** A user in `orgId` with a read+write API token, so requests carry their real role. */
export function seedUser(orgId: string, role: Role) {
  const db = getDb();
  const userId = nanoid();
  db.insert(users)
    .values({ id: userId, email: `${userId}@test.local`, displayName: role })
    .run();
  db.insert(memberships).values({ userId, orgId, role }).run();
  const token = generateApiToken();
  db.insert(apiTokens)
    .values({
      id: nanoid(),
      userId,
      name: 'test',
      hashedToken: token.hashedToken,
      prefix: token.prefix,
      scopes: JSON.stringify(['read', 'write']),
    })
    .run();
  return { userId, headers: { authorization: `Bearer ${token.token}` } };
}
