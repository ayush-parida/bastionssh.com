import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

// An in-memory stand-in for the BullMQ cron queue. Plain closures, no class
// fields, so the mock factory keeps the import working.
const queue = vi.hoisted(() => {
  const jobs = new Map<string, { id: string; data: { cronJobId: string; scheduledAt: string } }>();
  return {
    jobs,
    add: vi.fn(async (_name: string, data: { cronJobId: string; scheduledAt: string }, opts: { jobId: string }) => {
      // BullMQ ignores an add whose jobId already exists.
      if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, { id: opts.jobId, data });
    }),
    getDelayed: vi.fn(async () =>
      [...jobs.values()].map((j) => ({ ...j, remove: async () => void jobs.delete(j.id) })),
    ),
  };
});
vi.mock('./queues.js', () => ({
  cronQueue: { add: queue.add, getDelayed: queue.getDelayed },
  commandQueue: {},
}));

import { nanoid } from 'nanoid';
import { config as appConfig } from '../config/index.js';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { cronJobs, servers } from '../db/schema.js';
import { seedOrg, seedUser } from '../api/routes/test-utils.js';
import { scheduleCronJob, unscheduleCronJob, syncCronSchedules } from './scheduler.js';

// Flipped per test; the scheduler reads it on every call.
const config = appConfig as { redisUrl?: string };

describe('cron scheduler', () => {
  let orgId: string;
  let userId: string;
  let serverId: string;
  const originalRedis = config.redisUrl;

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-scheduler');
    userId = seedUser(orgId, 'admin').userId;
    serverId = nanoid();
    getDb()
      .insert(servers)
      .values({ id: serverId, orgId, name: 's', host: '10.0.0.2', username: 'root', createdBy: userId })
      .run();
  });

  beforeEach(() => {
    queue.jobs.clear();
    queue.add.mockClear();
    config.redisUrl = 'redis://test';
  });

  afterAll(() => {
    config.redisUrl = originalRedis;
  });

  function seedJob(schedule = '0 * * * *', enabled = true) {
    const id = nanoid();
    getDb()
      .insert(cronJobs)
      .values({ id, orgId, serverId, name: 'j', schedule, enabled, inlineCommand: 'uptime', createdBy: userId })
      .run();
    return id;
  }

  it('queues the following occurrence after a run, so the job recurs', async () => {
    const id = seedJob('0 * * * *');
    await scheduleCronJob(id);
    const [first] = [...queue.jobs.values()];
    expect(first).toBeDefined();

    // The worker calls this after running the first occurrence (still active in the queue).
    await scheduleCronJob(id, new Date(first!.data.scheduledAt));
    const scheduled = [...queue.jobs.values()].map((j) => j.data.scheduledAt).sort();
    expect(scheduled).toHaveLength(2);
    expect(Date.parse(scheduled[1]!) - Date.parse(scheduled[0]!)).toBe(60 * 60 * 1000);
  });

  it('drops finished queue entries so per-run job ids do not pile up in Redis', async () => {
    const id = seedJob();
    await scheduleCronJob(id);
    const opts = queue.add.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.removeOnComplete).toBeTruthy();
    expect(opts.removeOnFail).toBeTruthy();
  });

  it('does not double-queue the same occurrence', async () => {
    const id = seedJob();
    await scheduleCronJob(id);
    await scheduleCronJob(id);
    expect(queue.jobs.size).toBe(1);
  });

  it('does not queue a disabled job', async () => {
    const id = seedJob('0 * * * *', false);
    await scheduleCronJob(id);
    expect(queue.jobs.size).toBe(0);
  });

  it('unschedules only the given job', async () => {
    const a = seedJob();
    const b = seedJob();
    await scheduleCronJob(a);
    await scheduleCronJob(b);
    await unscheduleCronJob(a);
    expect([...queue.jobs.values()].map((j) => j.data.cronJobId)).toEqual([b]);
  });

  it('re-queues enabled jobs at startup', async () => {
    const id = seedJob();
    await syncCronSchedules();
    expect([...queue.jobs.values()].some((j) => j.data.cronJobId === id)).toBe(true);
  });

  it('skips the queue entirely without Redis', async () => {
    config.redisUrl = undefined;
    const id = seedJob();
    await scheduleCronJob(id);
    await unscheduleCronJob(id);
    expect(queue.add).not.toHaveBeenCalled();
    expect(getDb().select().from(cronJobs).all().find((j) => j.id === id)?.nextRunAt).toBeTruthy();
  });
});
