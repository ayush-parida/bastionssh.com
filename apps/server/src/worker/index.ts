import { Worker } from 'bullmq';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { runCommandJob } from './processors/command.js';
import { runCronJob } from './processors/cron.js';
import { scheduleCronJob, syncCronSchedules } from './scheduler.js';

const connection = config.redisUrl ? { url: config.redisUrl } : undefined;

/** Handle one cron queue entry: run the occurrence, then queue the next one */
export async function processCronQueueJob(data: { cronJobId: string; scheduledAt: string }) {
  try {
    await runCronJob(data);
  } finally {
    // Each queue entry is a single occurrence; queue the next one so the
    // schedule keeps recurring. Skipped for disabled or deleted jobs.
    const after = new Date(Math.max(Date.now(), Date.parse(data.scheduledAt) || 0));
    // A failure here must not fail the job, or BullMQ would retry the command.
    await scheduleCronJob(data.cronJobId, after).catch((err) => {
      logger.error({ err, cronJobId: data.cronJobId }, 'Failed to queue next cron run');
    });
  }
}

export async function startWorker() {
  const commandWorker = new Worker(
    'commands',
    async (job) => {
      logger.info({ jobId: job.id, name: job.name }, 'Processing command job');
      await runCommandJob(job.data);
    },
    { connection: connection as any, concurrency: 5 },
  );

  const cronWorker = new Worker(
    'cron',
    async (job) => {
      logger.info({ jobId: job.id, name: job.name }, 'Processing cron job');
      await processCronQueueJob(job.data);
    },
    { connection: connection as any, concurrency: 10 },
  );

  commandWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Command job failed');
  });

  cronWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Cron job failed');
  });

  void syncCronSchedules().catch((err) => {
    logger.error({ err }, 'Failed to re-queue cron jobs at startup');
  });

  logger.info('Workers started');
}
