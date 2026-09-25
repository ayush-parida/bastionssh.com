import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { cronJobs, savedCommands, servers } from '../../db/schema.js';
import { seedOrg, seedUser } from './test-utils.js';

// SMT_REDIS_URL is unset in tests, which is the no-Redis single-node setup:
// every request here must answer instead of waiting on a queue connection.

function seedServer(orgId: string, createdBy: string) {
  const id = nanoid();
  getDb()
    .insert(servers)
    .values({ id, orgId, name: 'web-1', host: '10.0.0.1', username: 'root', createdBy })
    .run();
  return id;
}

function seedCommand(orgId: string, createdBy: string) {
  const id = nanoid();
  getDb()
    .insert(savedCommands)
    .values({ id, orgId, name: 'backup', command: 'backup.sh', createdBy })
    .run();
  return id;
}

describe('cron job routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  let serverId: string;
  let commandId: string;
  let otherOrgCommandId: string;

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('org-cron');
    admin = seedUser(orgId, 'admin');
    serverId = seedServer(orgId, admin.userId);
    commandId = seedCommand(orgId, admin.userId);

    const otherOrg = seedOrg('org-cron-other');
    const otherAdmin = seedUser(otherOrg, 'admin');
    otherOrgCommandId = seedCommand(otherOrg, otherAdmin.userId);

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function create(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/cron-jobs',
      headers: admin.headers,
      payload: { serverId, name: 'job', schedule: '0 * * * *', ...payload },
    });
  }

  it('creates a job without Redis and records the next run', async () => {
    const res = await create({ inlineCommand: 'uptime' });
    expect(res.statusCode).toBe(201);
    expect(res.json().nextRunAt).toBeTruthy();
  });

  it('rejects a job that names both a saved and an inline command', async () => {
    const res = await create({ savedCommandId: commandId, inlineCommand: 'rm -rf /tmp/x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not both');
  });

  it('refuses a saved command from another org', async () => {
    const res = await create({ savedCommandId: otherOrgCommandId });
    expect(res.statusCode).toBe(404);
    expect(getDb().select().from(cronJobs).all().some((j) => j.savedCommandId === otherOrgCommandId)).toBe(false);
  });

  it('validates a timezone-only PATCH', async () => {
    const id = (await create({ inlineCommand: 'uptime' })).json().id;
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/cron-jobs/${id}`,
      headers: admin.headers,
      payload: { timezone: 'Europe/Londn' },
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'PATCH',
      url: `/api/cron-jobs/${id}`,
      headers: admin.headers,
      payload: { timezone: 'Europe/London' },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().timezone).toBe('Europe/London');
  });

  it('clears the inline command when a PATCH switches to a saved command', async () => {
    const id = (await create({ inlineCommand: 'uptime' })).json().id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/cron-jobs/${id}`,
      headers: admin.headers,
      payload: { savedCommandId: commandId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().savedCommandId).toBe(commandId);
    expect(res.json().inlineCommand).toBeNull();
  });

  it('deletes a job without Redis', async () => {
    const id = (await create({ inlineCommand: 'uptime' })).json().id;
    const res = await app.inject({ method: 'DELETE', url: `/api/cron-jobs/${id}`, headers: admin.headers });
    expect(res.statusCode).toBe(204);
    expect(getDb().select().from(cronJobs).all().some((j) => j.id === id)).toBe(false);
  });

  it('returns 409 when deleting a saved command a cron job uses', async () => {
    const usedId = seedCommand(
      getDb().select().from(servers).all().find((s) => s.id === serverId)!.orgId,
      admin.userId,
    );
    const jobId = (await create({ savedCommandId: usedId })).json().id;

    const blocked = await app.inject({ method: 'DELETE', url: `/api/commands/${usedId}`, headers: admin.headers });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain('cron job');

    await app.inject({ method: 'DELETE', url: `/api/cron-jobs/${jobId}`, headers: admin.headers });
    const ok = await app.inject({ method: 'DELETE', url: `/api/commands/${usedId}`, headers: admin.headers });
    expect(ok.statusCode).toBe(204);
  });
});
