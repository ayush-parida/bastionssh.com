import { describe, it, expect, beforeAll } from 'vitest';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { memberships, resourceGrants, roleMembers, roles, servers } from '../../db/schema.js';
import { seedOrg, seedServer, seedUser } from '../../api/routes/test-utils.js';
import { accessibleFilter, accessibleIds, authorize, resolveAccess } from './index.js';

/**
 * Custom roles spec §9: resolving a member's access adds under ~2 ms to a
 * request in an org with 100 roles and 1 000 grants. The budget asserted is
 * looser (a few ms) so a busy CI machine does not flake; the measured time is
 * printed for comparison.
 */
describe('access engine performance', () => {
  let orgId: string;
  let userId: string;
  const serverIds: string[] = [];

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-bench');
    const admin = seedUser(orgId, 'admin');
    const member = seedUser(orgId, 'viewer');
    userId = member.userId;
    getDb().update(memberships).set({ serverAccess: 'restricted' }).where(eq(memberships.userId, userId)).run();

    for (let i = 0; i < 300; i++) serverIds.push(seedServer(orgId, admin.userId, `bench-${i}`, [`t${i % 20}`]));

    const db = getDb();
    db.transaction(() => {
      for (let r = 0; r < 100; r++) {
        const roleId = nanoid();
        db.insert(roles).values({ id: roleId, orgId, name: `role-${r}`, createdBy: admin.userId }).run();
        // The member holds every other role, so half the grants count
        if (r % 2 === 0) db.insert(roleMembers).values({ roleId, userId, orgId }).run();
        for (let g = 0; g < 10; g++) {
          const n = r * 10 + g;
          db.insert(resourceGrants)
            .values({
              id: nanoid(),
              orgId,
              principalType: 'role',
              principalId: roleId,
              resourceType: n % 7 === 0 ? 'cluster' : 'server',
              selector: g === 9 ? 'tag' : 'id',
              resourceId: g === 9 ? null : serverIds[n % serverIds.length],
              tag: g === 9 ? `t${r % 20}` : null,
              level: (['view', 'operate', 'manage'] as const)[n % 3]!,
            })
            .run();
        }
      }
    });
  });

  it('resolves, authorizes and filters a member with 100 roles and 1 000 grants within a few ms per request', () => {
    const runs = 200;
    // Warm up prepared statements and the JIT
    for (let i = 0; i < 20; i++) resolveAccess({ orgId, userId });

    const started = performance.now();
    let visible = 0;
    for (let i = 0; i < runs; i++) {
      // A fresh request each time, memoized within it as a real one is
      const who = { orgId, user: { id: userId, email: '', displayName: '' }, raw: {} };
      resolveAccess(who);
      authorize(who, 'server', serverIds[i % serverIds.length]!, 'terminal');
      const filter = accessibleFilter(who, 'server', servers.id);
      if (i === 0) {
        visible = getDb().select({ id: servers.id }).from(servers).where(and(eq(servers.orgId, orgId), filter)).all().length;
      }
    }
    const perRequest = (performance.now() - started) / runs;
    console.log(`access engine: ${perRequest.toFixed(3)} ms per request (100 roles, 1 000 grants)`);

    const ids = accessibleIds({ orgId, userId }, 'server');
    expect(ids.all).toBe(false);
    expect(visible).toBe(ids.all ? 0 : ids.ids.length);
    expect(visible).toBeGreaterThan(0);
    expect(perRequest).toBeLessThan(4);
  });
});
