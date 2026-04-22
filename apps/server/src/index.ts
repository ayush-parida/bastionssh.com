import { buildApp } from './api/app.js';
import { startWorker } from './worker/index.js';
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
    await startWorker();
    logger.info('Worker started in-process');
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`Server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

main();
