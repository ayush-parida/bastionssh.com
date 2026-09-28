import { buildApp } from './api/app.js';
import { startWorker } from './worker/index.js';
import { startHealthMonitor } from './monitoring/scheduler.js';
import { startCloudSync } from './cloud/scheduler.js';
import { startBackupScheduler } from './backup/scheduler.js';
import { holdServerLock } from './backup/lock.js';
import { databasePath } from './db/index.js';
import { startRecordingMaintenance } from './recordings/scheduler.js';
import { startAccessExpiry } from './auth/access-grants.js';
import { config } from './config/index.js';
import { runMigrations } from './db/migrate.js';
import { seedDefaultAdmin } from './db/seed.js';
import logger from './logger.js';

async function main() {
  logger.info('Starting SMT server...');

  // Tells db:restore the database is in use; removed on exit
  if (databasePath() !== ':memory:') holdServerLock(databasePath(), config.port);

  await runMigrations();
  logger.info('Database migrations complete');

  await seedDefaultAdmin();
  // Before the API listens, so no live terminal's recording is mistaken for an orphan
  await startRecordingMaintenance();

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

  // Health checks, cloud inventory sync and database backups run on plain intervals in-process — no Redis required.
  startHealthMonitor();
  startCloudSync();
  startBackupScheduler();
  // Time-bound server grants: removes expired ones and closes what is still open on them
  startAccessExpiry();
  if (config.smtp) logger.info('Email notifications enabled (SMTP configured)');

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`Server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

main();
