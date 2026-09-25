import { getDb } from '../db/index.js';
import { cronJobs } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { cronQueue } from './queues.js';
import { getNextRun } from '@smt/cron-parser';
import { config } from '../config/index.js';
import logger from '../logger.js';

/**
 * Schedule a cron job's next run in the queue.
 *
 * Each occurrence gets its own job id, so the processor can queue the following
 * run while the current one is still active, and scheduling the same occurrence
 * twice is a no-op. `after` lets the processor ask for the run after the one it
 * just handled even if the queue fired it a little early.
 */
export async function scheduleCronJob(cronJobId: string, after = new Date()) {
  const db = getDb();
  const job = db.select().from(cronJobs).where(eq(cronJobs.id, cronJobId)).get();
  if (!job || !job.enabled) return;

  const next = getNextRun(job.schedule, job.timezone, after);
  if (!next) return;

  db.update(cronJobs)
    .set({ nextRunAt: next.toISOString() })
    .where(eq(cronJobs.id, cronJobId))
    .run();

  // Without Redis there is no queue — BullMQ would retry the connection forever
  // and hang the caller — so the job is saved but not run.
  if (!config.redisUrl) {
    logger.warn({ cronJobId }, 'Cron job not scheduled — set SMT_REDIS_URL to run cron jobs');
    return;
  }

  const delay = Math.max(next.getTime() - Date.now(), 0);
  await cronQueue.add(
    'run-cron',
    { cronJobId, scheduledAt: next.toISOString() },
    {
      delay,
      jobId: `cron-${cronJobId}-${next.getTime()}`,
      // Every occurrence is its own job, so finished ones must not pile up in
      // Redis; run history lives in the cron_runs table.
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  );
}

/** Remove a cron job's scheduled entries from the queue */
export async function unscheduleCronJob(cronJobId: string) {
  if (!config.redisUrl) return;
  const delayed = await cronQueue.getDelayed();
  await Promise.all(
    delayed.filter((j) => j.data?.cronJobId === cronJobId).map((j) => j.remove()),
  );
}

/**
 * Re-queue every enabled job. Runs at worker start so schedules survive a
 * restart or a flushed Redis; clearing first keeps it idempotent.
 */
export async function syncCronSchedules() {
  if (!config.redisUrl) return;
  const db = getDb();
  const enabled = db.select({ id: cronJobs.id }).from(cronJobs).where(eq(cronJobs.enabled, true)).all();
  for (const { id } of enabled) {
    await unscheduleCronJob(id);
    await scheduleCronJob(id);
  }
}
