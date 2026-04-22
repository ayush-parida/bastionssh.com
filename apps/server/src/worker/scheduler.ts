import { getDb } from '../db/index.js';
import { cronJobs } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { cronQueue } from './queues.js';
import { getNextRun } from '@smt/cron-parser';

/** Schedule a cron job's first/next run in the queue */
export async function scheduleCronJob(cronJobId: string) {
  const db = getDb();
  const job = db.select().from(cronJobs).where(eq(cronJobs.id, cronJobId)).get();
  if (!job || !job.enabled) return;

  const next = getNextRun(job.schedule, job.timezone);
  if (!next) return;

  const delay = Math.max(next.getTime() - Date.now(), 0);
  await cronQueue.add(
    'run-cron',
    { cronJobId, scheduledAt: next.toISOString() },
    { delay, jobId: `cron-${cronJobId}` },
  );

  db.update(cronJobs)
    .set({ nextRunAt: next.toISOString() })
    .where(eq(cronJobs.id, cronJobId))
    .run();
}

/** Remove a cron job's scheduled entry from the queue */
export async function unscheduleCronJob(cronJobId: string) {
  const existing = await cronQueue.getJob(`cron-${cronJobId}`);
  await existing?.remove();
}
