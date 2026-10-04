import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Migration 0025 on a copy of a real database (unified roles spec §6.5):
 * every member of every org, before (the 0024 resolver and base roles) and
 * after (the real migrator, then the live engine), on every resource action,
 * level, accessible set, "reaches any", every gate that replaced a
 * `requireRole`, and owner checks — for read-write and read-only tokens.
 *
 * Skipped unless SMT_DRYRUN_DB names the copy. It migrates that file in
 * place, so it refuses anything that is not a copy:
 *
 *   cp ~/smt-backups/<newest>/smt.db* /tmp/dryrun/
 *   SMT_DRYRUN_DB=/tmp/dryrun/smt.db pnpm vitest run src/auth/access/unified-roles.backup-dryrun.test.ts
 */
const target = vi.hoisted(() => {
  const file = process.env.SMT_DRYRUN_DB;
  if (file) {
    process.env.SMT_DB_URL = file;
    // The pre-migration backup the migrator takes goes beside the copy, never to /data
    process.env.SMT_BACKUP_DIR = `${file}.pre-migration`;
  }
  return file;
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { ACCESS_LEVELS, RESOURCE_TYPES, type ResourceType, type Role } from '@smt/shared';
import { getDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';
import { memberships, resourceGrants } from '../../db/schema.js';
import { rank } from '../middleware.js';
import { baseRoleAllows, mayCreate } from '../command-access.js';
import { ACTION_LEVELS, meetsLevel, requiredLevel, type ResourceAction } from './levels.js';
import { levelForAccess } from './authorize.js';
import { accessibleIdsFor, reachesAnyFor, RESOURCE_TABLES } from './filter.js';
import { resolveAccess, type AccessSubject, type ResolvedAccess } from './resolve.js';
import { isOrgOwner, isOwner } from './modules.js';
import { FORMER_GATES, legacyLoad, ROLE_NAMES } from './legacy-0024.test-utils.js';

type Answers = Map<string, unknown>;
interface Member {
  orgId: string;
  userId: string;
  role: string;
  status: string;
}

/** Never a backup itself or a live database: only a file under the temp or scratch directories. */
function isCopy(file: string): boolean {
  const real = fs.realpathSync(file);
  const backups = path.join(os.homedir(), 'smt-backups');
  return !real.startsWith(backups) && !real.startsWith('/data') && (real.startsWith(fs.realpathSync(os.tmpdir())) || real.startsWith('/private/tmp/') || real.startsWith('/tmp/'));
}

describe.skipIf(!target)('migration 0025 on a copy of a real database', () => {
  let members: Member[] = [];
  const resources = new Map<string, Record<ResourceType, string[]>>();
  const namespaces = new Map<string, (string | undefined)[]>();
  const expected = new Map<string, Answers>();

  /** Every decision for one member from a resolved access (resource side). */
  function resourceAnswers(member: Member, access: ResolvedAccess, answers: Answers, prefix: string) {
    const ids = resources.get(member.orgId)!;
    for (const type of RESOURCE_TYPES) {
      for (const id of ids[type]) {
        for (const namespace of type === 'cluster' ? (namespaces.get(member.orgId) ?? [undefined]) : [undefined]) {
          const found = levelForAccess(access, type, id, { namespace });
          answers.set(`${prefix}level ${type}/${id}/${namespace ?? '*'}`, found ? { level: found.level, namespaces: found.namespaces } : null);
          for (const action of Object.keys(ACTION_LEVELS[type]) as ResourceAction[]) {
            const required = requiredLevel(type, action as ResourceAction<typeof type>);
            answers.set(`${prefix}authorize ${type}/${id}/${namespace ?? '*'} ${action}`, !found ? 404 : meetsLevel(found.level, required) ? 200 : 403);
          }
        }
      }
      for (const level of ACCESS_LEVELS) {
        const reached = accessibleIdsFor(access, type, level);
        answers.set(`${prefix}ids ${type} ${level}`, reached.all ? 'all' : [...reached.ids].sort());
        answers.set(`${prefix}reachesAny ${type} ${level}`, reachesAnyFor(access, type, level));
      }
    }
  }

  function before(member: Member): Answers {
    const answers: Answers = new Map();
    const role: Role = (ROLE_NAMES as readonly string[]).includes(member.role) ? (member.role as Role) : 'viewer';
    for (const readOnly of [false, true]) {
      const access = legacyLoad(member.orgId, member.userId, readOnly);
      const prefix = readOnly ? 'ro ' : 'rw ';
      resourceAnswers(member, access, answers, prefix);
      const operatorBase = access.active && access.scope === 'all' && !readOnly && rank(access.role) >= rank('operator');
      for (const type of ['saved_command', 'cron_job'] as const) {
        answers.set(`${prefix}baseRoleAllows ${type}`, operatorBase);
        answers.set(`${prefix}mayCreate ${type}`, operatorBase || accessibleIdsFor(access, type, 'manage').all);
      }
      answers.set(`${prefix}isOwner`, access.active && access.role === 'owner' && !readOnly);
      // requireRole(minimum) read the membership's role, viewer for read-only tokens
      const effective = readOnly ? 'viewer' : role;
      for (const { name, minimum } of FORMER_GATES) {
        answers.set(`${prefix}gate ${name}`, member.status !== 'active' ? 'suspended' : rank(effective) >= rank(minimum));
      }
    }
    answers.set('ssoOwner', member.role === 'owner');
    return answers;
  }

  /** A former gate's answer now: the preHandlers it runs, as Fastify would run them after requireAuth. */
  async function passes(member: Member, readOnly: boolean, gate: (typeof FORMER_GATES)[number]['gate']): Promise<boolean | 'suspended'> {
    // requireAuth refuses a suspended member before any gate
    if (member.status !== 'active') return 'suspended';
    const req = { user: { id: member.userId, email: '', displayName: '' }, orgId: member.orgId, apiTokenReadOnly: readOnly } as unknown as FastifyRequest;
    let status = 200;
    const reply = {
      status(code: number) {
        status = code;
        return reply;
      },
      send() {
        return reply;
      },
    } as unknown as FastifyReply;
    for (const handler of gate) {
      await (handler as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>).call(null, req, reply);
      if (status !== 200) return false;
    }
    return true;
  }

  async function after(member: Member): Promise<Answers> {
    const answers: Answers = new Map();
    for (const readOnly of [false, true]) {
      const who: AccessSubject = readOnly
        ? { orgId: member.orgId, user: { id: member.userId, email: '', displayName: '' }, apiTokenReadOnly: true }
        : { orgId: member.orgId, userId: member.userId };
      const prefix = readOnly ? 'ro ' : 'rw ';
      resourceAnswers(member, resolveAccess(who), answers, prefix);
      for (const type of ['saved_command', 'cron_job'] as const) {
        answers.set(`${prefix}baseRoleAllows ${type}`, baseRoleAllows(who, type));
        answers.set(`${prefix}mayCreate ${type}`, mayCreate(who, type));
      }
      answers.set(`${prefix}isOwner`, isOwner(who));
      for (const { name, gate } of FORMER_GATES) answers.set(`${prefix}gate ${name}`, await passes(member, readOnly, gate));
    }
    answers.set('ssoOwner', isOrgOwner(member.orgId, member.userId));
    return answers;
  }

  beforeAll(() => {
    expect(isCopy(target!), `${target} must be a copy under the temp directory`).toBe(true);
    const db = getDb();
    members = db.select({ orgId: memberships.orgId, userId: memberships.userId, role: memberships.role, status: memberships.status }).from(memberships).all();
    for (const orgId of new Set(members.map((m) => m.orgId))) {
      resources.set(
        orgId,
        Object.fromEntries(
          RESOURCE_TYPES.map((type) => {
            const { table, id, orgId: orgColumn } = RESOURCE_TABLES[type];
            return [type, db.select({ id }).from(table).where(eq(orgColumn, orgId)).all().map((r) => r.id as string)];
          }),
        ) as Record<ResourceType, string[]>,
      );
      // Every namespace a grant names, beside "the whole cluster"
      const named = db
        .select({ namespaces: resourceGrants.namespaces })
        .from(resourceGrants)
        .where(and(eq(resourceGrants.orgId, orgId), inArray(resourceGrants.resourceType, ['cluster'])))
        .all()
        .flatMap((g) => {
          try {
            const list: unknown = JSON.parse(g.namespaces ?? 'null');
            return Array.isArray(list) ? list.filter((ns): ns is string => typeof ns === 'string') : [];
          } catch {
            return [];
          }
        });
      namespaces.set(orgId, [undefined, ...new Set([...named, 'default'])]);
    }
    for (const member of members) expected.set(`${member.orgId}/${member.userId}`, before(member));
  });

  it('migrates with the real migrator and changes nobody’s effective access', async () => {
    await runMigrations();
    expect(members.length).toBeGreaterThan(0);
    const differences: string[] = [];
    let compared = 0;
    for (const member of members) {
      const was = expected.get(`${member.orgId}/${member.userId}`)!;
      const now = await after(member);
      for (const [key, value] of was) {
        compared++;
        if (JSON.stringify(now.get(key)) !== JSON.stringify(value)) {
          differences.push(`${member.userId} (${member.role}) ${key}: ${JSON.stringify(value)} → ${JSON.stringify(now.get(key))}`);
        }
      }
      if (now.size !== was.size) differences.push(`${member.userId}: ${was.size} answers before, ${now.size} after`);
    }
    console.log(`dry run: ${members.length} members in ${resources.size} orgs, ${compared} decisions compared, ${differences.length} differences`);
    expect(differences).toEqual([]);
  });
});
