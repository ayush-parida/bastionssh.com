import { describe, it, expect, beforeAll, vi } from 'vitest';

const ssh = vi.hoisted(() => ({
  execOnServer: vi.fn(async (_target: unknown, _auth: unknown, _cmd: string) => ({
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
  })),
}));
vi.mock('../../ssh/broker.js', () => ({ execOnServer: ssh.execOnServer }));
vi.mock('../../ssh/credentials.js', () => ({
  resolveServerAuth: async () => ({
    server: { host: '10.0.0.3', port: 22, username: 'root' },
    auth: { password: 'x' },
  }),
}));

import { nanoid } from 'nanoid';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { cronJobs, cronRuns, memberships, savedCommands, servers } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { seedOrg, seedUser } from '../../api/routes/test-utils.js';
import { runCronJob } from './cron.js';

describe('runCronJob', () => {
  let orgId: string;
  let userId: string;
  let serverId: string;

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-cron-proc');
    userId = seedUser(orgId, 'admin').userId;
    serverId = nanoid();
    getDb()
      .insert(servers)
      .values({ id: serverId, orgId, name: 's', host: '10.0.0.3', username: 'root', createdBy: userId })
      .run();
  });

  function seedSavedJob(commandOrgId: string) {
    const db = getDb();
    const commandId = nanoid();
    db.insert(savedCommands)
      .values({ id: commandId, orgId: commandOrgId, name: 'c', command: 'secret-cmd', createdBy: userId })
      .run();
    const jobId = nanoid();
    db.insert(cronJobs)
      .values({ id: jobId, orgId, serverId, name: 'j', schedule: '0 * * * *', savedCommandId: commandId, createdBy: userId })
      .run();
    return jobId;
  }

  it("runs the job's own saved command", async () => {
    ssh.execOnServer.mockClear();
    const jobId = seedSavedJob(orgId);
    await runCronJob({ cronJobId: jobId, scheduledAt: new Date().toISOString() });
    expect(ssh.execOnServer).toHaveBeenCalledTimes(1);
    expect(ssh.execOnServer.mock.calls[0]![2]).toBe('secret-cmd');
  });

  it("never runs another org's saved command", async () => {
    ssh.execOnServer.mockClear();
    const jobId = seedSavedJob(seedOrg('org-cron-proc-other'));
    await runCronJob({ cronJobId: jobId, scheduledAt: new Date().toISOString() });
    expect(ssh.execOnServer).not.toHaveBeenCalled();
    expect(getDb().select().from(cronRuns).all().some((r) => r.cronJobId === jobId)).toBe(false);
  });

  it('records a failure instead of running once the creator loses access', async () => {
    const db = getDb();
    const operator = seedUser(orgId, 'operator').userId;
    const jobId = nanoid();
    db.insert(cronJobs)
      .values({ id: jobId, orgId, serverId, name: 'r', schedule: '0 * * * *', inlineCommand: 'uptime', createdBy: operator })
      .run();
    db.update(memberships)
      .set({ serverAccess: 'restricted' })
      .where(and(eq(memberships.userId, operator), eq(memberships.orgId, orgId)))
      .run();

    ssh.execOnServer.mockClear();
    await runCronJob({ cronJobId: jobId, scheduledAt: new Date().toISOString() });

    expect(ssh.execOnServer).not.toHaveBeenCalled();
    const run = db.select().from(cronRuns).where(eq(cronRuns.cronJobId, jobId)).get();
    expect(run?.status).toBe('failure');
    expect(run?.stderr).toMatch(/no longer has access/);
  });
});
