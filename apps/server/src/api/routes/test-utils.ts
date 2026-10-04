import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import { apiTokens, memberships, organizations, roleMembers, roles, servers, users } from '../../db/schema.js';
import { generateApiToken } from '../../auth/token.js';
import { createSession } from '../../auth/session.js';
import type { ModulePermissions } from '@smt/shared';
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

/** Add an existing user to another org. */
export function addMembership(userId: string, orgId: string, role: Role) {
  getDb().insert(memberships).values({ userId, orgId, role }).run();
}

/** A signed-in browser session for `userId`, as the cookie header to send. */
export async function seedSession(userId: string) {
  const session = await createSession(userId, { ipAddress: '127.0.0.1', userAgent: 'vitest' });
  return { sessionId: session.id, headers: { cookie: `smt_session=${session.id}` } };
}

export function seedServer(orgId: string, createdBy: string, name = 'web-1', tags: string[] = []) {
  const id = nanoid();
  getDb()
    .insert(servers)
    .values({ id, orgId, name, host: '10.0.0.1', username: 'root', createdBy, tags: JSON.stringify(tags) })
    .run();
  return id;
}

/**
 * Give `userId` a custom role holding these module levels (unified roles), on
 * top of what they have; returns the role's id.
 */
export function addModuleRole(orgId: string, userId: string, modules: ModulePermissions, name = `modules-${nanoid(6)}`) {
  const id = nanoid();
  const db = getDb();
  db.insert(roles).values({ id, orgId, name, createdBy: userId, modulePermissions: JSON.stringify(modules) }).run();
  db.insert(roleMembers).values({ roleId: id, userId, orgId }).run();
  return id;
}
