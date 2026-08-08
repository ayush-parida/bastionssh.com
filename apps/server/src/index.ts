import { buildApp } from './api/app.js';
import { startWorker } from './worker/index.js';
import { startHealthMonitor } from './monitoring/scheduler.js';
import { config } from './config/index.js';
import { runMigrations } from './db/migrate.js';
import { seedDefaultAdmin } from './db/seed.js';
import logger from './logger.js';

async function main() {
  logger.info('Starting SMT server...');

  await runMigrations();
  logger.info('Database migrations complete');

  await seedDefaultAdmin();

  const app = await buildApp();

  // Start the cron worker in the same process (single-node mode).
  // In production with Redis, this runs as a separate container.
  if (!config.redisUrl || config.workerInProcess) {
    try {
      await startWorker();
      logger.info('Worker started in-process');
    } catch (err) {
      // BullMQ needs Redis. Without it the queue-backed features are degraded,
      // but the API and health monitoring still work — don't take the app down.
      logger.warn(
        { err },
        'Worker not started — cron jobs and queued command runs are unavailable. Set SMT_REDIS_URL to enable them.',
      );
    }
  }

  // Health checks run on a plain interval in-process — no Redis required.
  startHealthMonitor();

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`Server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

main();
