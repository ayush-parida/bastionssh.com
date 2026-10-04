import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getNextRun } from '@smt/cron-parser';
import { getDb } from '../../db/index.js';
import { cronJobs, cronRuns, savedCommands } from '../../db/schema.js';
import { resolveServerAuth } from '../../ssh/credentials.js';
import { execOnServer } from '../../ssh/broker.js';
import { authorize, hasModule } from '../../auth/access/index.js';
import { COMMAND_TIMEOUT_MS, interpolate } from '../../commands/run.js';
import logger from '../../logger.js';

interface CronJobData {
  cronJobId: string;
  scheduledAt: string;
  /** "Run now": runs even while the job is disabled. */
  manual?: boolean;
}

/**
 * Why the job's creator may not run it now, or null when they may. A job runs
 * as its creator, so they need `operate` on the job, on its server and on the
 * saved command it runs (custom roles spec §2.7), and must still see the
 * server that command is bound to, if any (a command is hidden with its
 * server), with the Cron Jobs and Servers modules (and Saved Commands, for a
 * saved command) on — checked before every run, so losing any of them (a
 * role, a module, a grant, the membership) stops the job (unified roles
 * spec §7).
 */
export function creatorRefusal(job: {
  id: string;
  orgId: string;
  createdBy: string;
  serverId: string;
  savedCommandId: string | null;
  inlineCommand: string | null;
}): string | null {
  const creator = { orgId: job.orgId, userId: job.createdBy };
  if (!hasModule(creator, 'cron_jobs') || !hasModule(creator, 'servers')) {
    return 'The job creator no longer has access to cron jobs';
  }
  if (!authorize(creator, 'server', job.serverId, 'run_command').ok) {
    return 'The job creator no longer has access to this server';
  }
  if (!authorize(creator, 'cron_job', job.id, 'run').ok) {
    return 'The job creator no longer has access to this cron job';
  }
  if (!job.inlineCommand && job.savedCommandId) {
    if (!hasModule(creator, 'saved_commands')) return 'The job creator no longer has access to its saved command';
    const command = getDb()
      .select({ serverId: savedCommands.serverId })
      .from(savedCommands)
      .where(and(eq(savedCommands.id, job.savedCommandId), eq(savedCommands.orgId, job.orgId)))
      .get();
    const visible = !command?.serverId || authorize(creator, 'server', command.serverId, 'view').ok;
    if (!visible || !authorize(creator, 'saved_command', job.savedCommandId, 'run').ok) {
      return 'The job creator no longer has access to its saved command';
    }
  }
  return null;
}

export async function runCronJob(data: CronJobData) {
  const db = getDb();
  const start = Date.now();
  const runId = nanoid();

  const job = db.select().from(cronJobs).where(eq(cronJobs.id, data.cronJobId)).get();
  if (!job || (!job.enabled && !data.manual)) return;

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
    // A job runs as its creator: once they are suspended, removed or can no
    // longer operate it, it records a failure instead of running.
    const refusal = creatorRefusal(job);
    if (refusal) throw new Error(refusal);
    // Shares the resolver used everywhere else, so a password-authenticated
    // server runs its schedule instead of silently doing nothing.
    const { server, auth } = await resolveServerAuth(job.orgId, job.serverId);
    const result = await execOnServer(
      { id: server.id, host: server.host, port: server.port, username: server.username },
      auth,
      interpolate(cmd),
      COMMAND_TIMEOUT_MS,
      undefined,
      { actorUserId: job.createdBy },
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
