import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getNextRun } from '@smt/cron-parser';
import { getDb } from '../../db/index.js';
import { cronJobs, cronRuns, savedCommands } from '../../db/schema.js';
import { resolveServerAuth } from '../../ssh/credentials.js';
import { execOnServer } from '../../ssh/broker.js';
import { canAccessServer } from '../../auth/server-access.js';
import { COMMAND_TIMEOUT_MS, interpolate } from '../../commands/run.js';
import logger from '../../logger.js';

interface CronJobData {
  cronJobId: string;
  scheduledAt: string;
}

export async function runCronJob(data: CronJobData) {
  const db = getDb();
  const start = Date.now();
  const runId = nanoid();

  const job = db.select().from(cronJobs).where(eq(cronJobs.id, data.cronJobId)).get();
  if (!job || !job.enabled) return;

  let cmd = job.inlineCommand;
  if (!cmd && job.savedCommandId) {
    const saved = db
      .select()
      .from(savedCommands)
      .where(and(eq(savedCommands.id, job.savedCommandId), eq(savedCommands.orgId, job.orgId)))
      .get();
    cmd = saved?.command ?? null;
  }
  if (!cmd) {
    logger.error({ cronJobId: data.cronJobId }, 'Cron job has no command to run');
    return;
  }

  db.insert(cronRuns)
    .values({
      id: runId,
      cronJobId: data.cronJobId,
      scheduledAt: data.scheduledAt,
      startedAt: new Date().toISOString(),
      status: 'running',
      stdout: '',
      stderr: '',
    })
    .run();

  const finish = (patch: Partial<typeof cronRuns.$inferInsert>) => {
    db.update(cronRuns)
      .set({ ...patch, finishedAt: new Date().toISOString(), durationMs: Date.now() - start })
      .where(eq(cronRuns.id, runId))
      .run();
    db.update(cronJobs)
      .set({
        lastRunAt: new Date().toISOString(),
        nextRunAt: nextRunFor(job.schedule, job.timezone),
      })
      .where(eq(cronJobs.id, data.cronJobId))
      .run();
  };

  try {
    // A job runs as its creator: once they are suspended, removed or no longer
    // granted the server, it records a failure instead of running.
    if (!canAccessServer({ orgId: job.orgId, userId: job.createdBy }, job.serverId)) {
      throw new Error('The job creator no longer has access to this server');
    }
    // Shares the resolver used everywhere else, so a password-authenticated
    // server runs its schedule instead of silently doing nothing.
    const { server, auth } = await resolveServerAuth(job.orgId, job.serverId);
    const result = await execOnServer(
      { id: server.id, host: server.host, port: server.port, username: server.username },
      auth,
      interpolate(cmd),
      COMMAND_TIMEOUT_MS,
    );
    finish({
      status: result.exitCode === 0 ? 'success' : 'failure',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, cronJobId: data.cronJobId }, 'Cron job failed');
    finish({ status: 'failure', stderr: message });
  }
}

/** Keep `nextRunAt` moving so the schedule list stays accurate after a run. */
function nextRunFor(schedule: string, timezone: string): string | null {
  return getNextRun(schedule, timezone, new Date())?.toISOString() ?? null;
}
