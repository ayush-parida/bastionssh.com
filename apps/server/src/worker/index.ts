import { Worker } from 'bullmq';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { runCommandJob } from './processors/command.js';
import { runCronJob } from './processors/cron.js';

const connection = config.redisUrl ? { url: config.redisUrl } : undefined;

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
      await runCronJob(job.data);
    },
    { connection: connection as any, concurrency: 10 },
  );

  commandWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Command job failed');
  });

  cronWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Cron job failed');
  });

  logger.info('Workers started');
}
