import { Queue } from 'bullmq';
import { config } from '../config/index.js';

// bullmq types `connection` as required ioredis options; without Redis it is
// left undefined (the queues then fail on use), hence the casts below.
const connection = config.redisUrl ? { url: config.redisUrl } : undefined;

export const commandQueue = new Queue('commands', {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: connection as any,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
});

export const cronQueue = new Queue('cron', {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: connection as any,
  defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 5000 } },
});
