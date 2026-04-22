import { Queue } from 'bullmq';
import { config } from '../config/index.js';

const connection = config.redisUrl ? { url: config.redisUrl } : undefined;

export const commandQueue = new Queue('commands', {
  connection: connection as any,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
});

export const cronQueue = new Queue('cron', {
  connection: connection as any,
  defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 5000 } },
});
