import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { commandRuns, cronJobs, resourceGrants, savedCommands, serverAlerts } from '../../db/schema.js';
import { canAccessServer } from '../../auth/server-access.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

/**
 * A restricted operator granted server A only. Server B must be invisible to
 * them on every route that takes or lists servers, and answer 404 as if it
 * did not exist.
 */
describe('per-server access', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let restricted: ReturnType<typeof seedUser>;
  let unrestricted: ReturnType<typeof seedUser>;
  let serverA: string;
  let serverB: string;
  let commandId: string;
  let jobA: string;
  let jobB: string;
  let runB: string;

  const as = (who: { headers: Record<string, string> }) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: who.headers }),
    post: (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, headers: who.headers, payload: payload ?? {} }),
    patch: (url: string, payload: object) =>
      app.inject({ method: 'PATCH', url, headers: who.headers, payload }),
  });

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-access');
    admin = seedUser(orgId, 'admin');
    restricted = seedUser(orgId, 'operator');
    unrestricted = seedUser(orgId, 'operator');
    serverA = seedServer(orgId, admin.userId, 'alpha', ['web']);
    serverB = seedServer(orgId, admin.userId, 'bravo', ['web']);

    const db = getDb();
    commandId = nanoid();
    db.insert(savedCommands).values({ id: commandId, orgId, name: 'uptime', command: 'uptime', createdBy: admin.userId }).run();
    jobA = nanoid();
    jobB = nanoid();
    for (const [id, serverId] of [[jobA, serverA], [jobB, serverB]] as const) {
      db.insert(cronJobs)
        .values({ id, orgId, serverId, name: id, schedule: '0 * * * *', inlineCommand: 'true', createdBy: admin.userId, enabled: false })
        .run();
    }
    runB = nanoid();
    db.insert(commandRuns)
      .values({ id: runB, commandId, serverId: serverB, triggeredBy: admin.userId, status: 'success' })
      .run();
    db.insert(serverAlerts)
      .values({ id: nanoid(), orgId, serverId: serverB, type: 'offline', message: 'bravo down' })
      .run();

    app = await buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/team/members/${restricted.userId}/access`,
      headers: admin.headers,
      payload: { serverAccess: 'restricted', serverIds: [serverA] },
    });
    expect(res.statusCode).toBe(200);
    // Role-scoped members reach no saved command or cron job by default (custom
    // roles spec §8.1); with all of both granted, the servers still narrow them
    for (const resourceType of ['saved_command', 'cron_job'] as const) {
      db.insert(resourceGrants)
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

  describe('servers', () => {
    it('lists only granted servers for a restricted member', async () => {
      const ids = (await as(restricted).get('/api/servers')).json().map((s: { id: string }) => s.id);
      expect(ids).toEqual([serverA]);
    });

    it('lists every server for admins and unrestricted members', async () => {
      for (const who of [admin, unrestricted]) {
        const ids = (await as(who).get('/api/servers')).json().map((s: { id: string }) => s.id);
        expect(ids.sort()).toEqual([serverA, serverB].sort());
      }
    });

    it('404s a server that is not granted', async () => {
      expect((await as(restricted).get(`/api/servers/${serverB}`)).statusCode).toBe(404);
      expect((await as(restricted).get(`/api/servers/${serverA}`)).statusCode).toBe(200);
      expect((await as(admin).get(`/api/servers/${serverB}`)).statusCode).toBe(200);
    });
  });

  it('ssh-sessions: 404 before any connection is attempted', async () => {
    expect((await as(restricted).post('/api/ssh-sessions', { serverId: serverB })).statusCode).toBe(404);
    // Granted server gets past the access check to the credential check
    const res = await as(restricted).post('/api/ssh-sessions', { serverId: serverA });
    expect(res.statusCode).toBe(400);
  });

  it('sftp: 404 on a server that is not granted', async () => {
    expect((await as(restricted).get(`/api/sftp/${serverB}/list`)).statusCode).toBe(404);
    expect((await as(restricted).post(`/api/sftp/${serverB}/mkdir`, { path: '/tmp/x' })).statusCode).toBe(404);
    // Granted: past access, fails on missing credentials instead
    expect((await as(restricted).get(`/api/sftp/${serverA}/list`)).statusCode).toBe(400);
  });

  describe('saved commands', () => {
    it('refuses to run on a server that is not granted', async () => {
      const res = await as(restricted).post(`/api/commands/${commandId}/run`, { serverId: serverB });
      expect(res.statusCode).toBe(404);
    });

    it('fans a tag out only across granted servers', async () => {
      const res = await as(restricted).post(`/api/commands/${commandId}/run`, { tag: 'web' });
      expect(res.statusCode).toBe(202);
      expect(res.json().runs.map((r: { serverId: string }) => r.serverId)).toEqual([serverA]);
    });

    it('refuses a default server that is not granted', async () => {
      const res = await as(restricted).post('/api/commands', { name: 'x', command: 'id', serverId: serverB });
      expect(res.statusCode).toBe(404);
    });

    it('hides runs on servers that are not granted', async () => {
      expect((await as(restricted).get(`/api/commands/runs/${runB}`)).statusCode).toBe(404);
      expect((await as(restricted).get(`/api/commands/runs?ids=${runB}`)).json()).toEqual([]);
      expect((await as(admin).get(`/api/commands/runs/${runB}`)).statusCode).toBe(200);
    });
  });

  describe('cron jobs', () => {
    it('lists only jobs on granted servers', async () => {
      const ids = (await as(restricted).get('/api/cron-jobs')).json().map((j: { id: string }) => j.id);
      expect(ids).toEqual([jobA]);
    });

    it('refuses to create or move a job onto a server that is not granted', async () => {
      const create = await as(restricted).post('/api/cron-jobs', {
        serverId: serverB,
        name: 'x',
        schedule: '0 * * * *',
        inlineCommand: 'true',
        enabled: false,
      });
      expect(create.statusCode).toBe(404);
      const move = await as(restricted).patch(`/api/cron-jobs/${jobA}`, { serverId: serverB });
      expect(move.statusCode).toBe(404);
    });

    it('404s jobs on servers that are not granted', async () => {
      expect((await as(restricted).patch(`/api/cron-jobs/${jobB}`, { name: 'y' })).statusCode).toBe(404);
      expect((await as(restricted).get(`/api/cron-jobs/${jobB}/runs`)).statusCode).toBe(404);
      const del = await app.inject({ method: 'DELETE', url: `/api/cron-jobs/${jobB}`, headers: restricted.headers });
      expect(del.statusCode).toBe(404);
    });
  });

  describe('monitoring', () => {
    it('404s per-server endpoints for servers that are not granted', async () => {
      expect((await as(restricted).get(`/api/monitoring/servers/${serverB}`)).statusCode).toBe(404);
      expect((await as(restricted).get(`/api/monitoring/servers/${serverB}/metrics`)).statusCode).toBe(404);
      expect((await as(restricted).post(`/api/monitoring/servers/${serverB}/check`)).statusCode).toBe(404);
      expect((await as(restricted).get(`/api/monitoring/servers/${serverA}`)).statusCode).toBe(200);
    });

    it('limits the overview and alert feed to granted servers', async () => {
      const overview = (await as(restricted).get('/api/monitoring/overview')).json();
      expect(overview.servers.map((s: { serverId: string }) => s.serverId)).toEqual([serverA]);
      expect(overview.alerts).toEqual([]);
      expect((await as(restricted).get('/api/monitoring/alerts?status=all')).json()).toEqual([]);

      const adminOverview = (await as(admin).get('/api/monitoring/overview')).json();
      expect(adminOverview.servers).toHaveLength(2);
      expect(adminOverview.alerts).toHaveLength(1);
    });
  });

  describe('ai', () => {
    it('limits the AI context to granted servers and their jobs', async () => {
      const res = await as(restricted).get('/api/ai/context');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { servers: { id: string }[]; cronJobs: { id: string }[] };
      expect(body.servers.map((s) => s.id)).toEqual([serverA]);
      expect(body.cronJobs.map((j) => j.id)).toEqual([jobA]);
    });

    it('404s a chat whose context server is not granted', async () => {
      const res = await as(restricted).post('/api/ai/chat', {
        messages: [{ role: 'user', content: 'hi' }],
        context: { serverId: serverB },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('canAccessServer', () => {
    it('accepts a plain subject, as the AI tools call it', () => {
      expect(canAccessServer({ orgId, userId: restricted.userId, role: 'operator' }, serverA)).toBe(true);
      expect(canAccessServer({ orgId, userId: restricted.userId, role: 'operator' }, serverB)).toBe(false);
      expect(canAccessServer({ orgId, userId: admin.userId, role: 'admin' }, serverB)).toBe(true);
    });

    it('never grants a server from another org', () => {
      const otherOrg = seedOrg('org-access-other');
      const outsider = seedUser(otherOrg, 'owner');
      const foreign = seedServer(otherOrg, outsider.userId);
      expect(canAccessServer({ orgId, userId: admin.userId }, foreign)).toBe(false);
    });

    it('drops a grant when its server is deleted', async () => {
      const temp = seedServer(orgId, admin.userId, 'temp');
      await app.inject({
        method: 'PUT',
        url: `/api/team/members/${restricted.userId}/access`,
        headers: admin.headers,
        payload: { serverAccess: 'restricted', serverIds: [serverA, temp] },
      });
      const del = await app.inject({ method: 'DELETE', url: `/api/servers/${temp}`, headers: admin.headers });
      expect(del.statusCode).toBe(204);
      const access = (await as(admin).get(`/api/team/members/${restricted.userId}/access`)).json();
      expect(access.serverIds).toEqual([serverA]);
    });
  });

  describe('access endpoints', () => {
    it('rejects servers from outside the org', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/team/members/${unrestricted.userId}/access`,
        headers: admin.headers,
        payload: { serverAccess: 'restricted', serverIds: ['nope'] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('will not restrict an admin', async () => {
      const otherAdmin = seedUser(orgId, 'admin');
      const res = await app.inject({
        method: 'PUT',
        url: `/api/team/members/${otherAdmin.userId}/access`,
        headers: admin.headers,
        payload: { serverAccess: 'restricted', serverIds: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('is admin-only (Roles & access, off — not there — for everyone else by default)', async () => {
      const res = await as(unrestricted).get(`/api/team/members/${restricted.userId}/access`);
      expect(res.statusCode).toBe(404);
    });

    it('restricted with no grants sees nothing', async () => {
      const empty = seedUser(orgId, 'viewer');
      await app.inject({
        method: 'PUT',
        url: `/api/team/members/${empty.userId}/access`,
        headers: admin.headers,
        payload: { serverAccess: 'restricted', serverIds: [] },
      });
      // Seeing no server, the Servers module is hidden from them (unified roles spec §3.1)
      expect((await as(empty).get('/api/servers')).statusCode).toBe(404);
      const members = (await as(admin).get('/api/team/members')).json();
      const row = members.find((m: { userId: string }) => m.userId === restricted.userId);
      expect(row).toMatchObject({ serverAccess: 'restricted', serverCount: 1 });
    });
  });
});
