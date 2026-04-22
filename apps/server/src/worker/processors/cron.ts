import { Client } from 'ssh2';
import { getDb } from '../../db/index.js';
import { cronJobs, cronRuns, servers, sshKeys, savedCommands } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { vault } from '../../vault/index.js';
import { getNextRun } from '@smt/cron-parser';
import { cronQueue } from '../queues.js';
import logger from '../../logger.js';
import { nanoid } from 'nanoid';

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

  const server = db.select().from(servers).where(eq(servers.id, job.serverId)).get();
  if (!server?.defaultKeyId) {
    logger.error({ cronJobId: data.cronJobId }, 'Cron job: server or key missing');
    return;
  }

  const key = db.select().from(sshKeys).where(eq(sshKeys.id, server.defaultKeyId)).get();
  if (!key) return;

  let cmd = job.inlineCommand;
  if (!cmd && job.savedCommandId) {
    const saved = db
      .select()
      .from(savedCommands)
      .where(eq(savedCommands.id, job.savedCommandId))
      .get();
    cmd = saved?.command || null;
  }
  if (!cmd) return;

  const privateKey = await vault.decrypt(key.encryptedPrivateKey, key.id);

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

  await new Promise<void>((resolve) => {
    const ssh = new Client();
    let stdout = '';
    let stderr = '';
    let exitCode = -1;

    ssh.on('ready', () => {
      ssh.exec(cmd!, (err, stream) => {
        if (err) {
          ssh.end();
          db.update(cronRuns)
            .set({ status: 'failure', stderr: err.message, finishedAt: new Date().toISOString() })
            .where(eq(cronRuns.id, runId))
            .run();
          resolve();
          return;
        }

        stream.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        stream.on('close', (code: number) => {
          exitCode = code;
          ssh.end();
        });
      });
    });

    ssh.on('close', () => {
      const durationMs = Date.now() - start;
      db.update(cronRuns)
        .set({
          status: exitCode === 0 ? 'success' : 'failure',
          exitCode,
          stdout,
          stderr,
          finishedAt: new Date().toISOString(),
          durationMs,
        })
        .where(eq(cronRuns.id, runId))
        .run();

      db.update(cronJobs)
        .set({ lastRunAt: new Date().toISOString() })
        .where(eq(cronJobs.id, data.cronJobId))
        .run();
      resolve();
    });

    ssh.on('error', (err) => {
      logger.error({ err, cronJobId: data.cronJobId }, 'Cron SSH error');
      db.update(cronRuns)
        .set({ status: 'failure', stderr: err.message, finishedAt: new Date().toISOString() })
        .where(eq(cronRuns.id, runId))
        .run();
      resolve();
    });

    ssh.connect({ host: server!.host, port: server!.port, username: server!.username, privateKey });
  });

  // Schedule the next occurrence
  const next = getNextRun(job.schedule, job.timezone);
  if (next) {
    const delay = next.getTime() - Date.now();
    await cronQueue.add(
      'run-cron',
      { cronJobId: data.cronJobId, scheduledAt: next.toISOString() },
      { delay },
    );
    db.update(cronJobs)
      .set({ nextRunAt: next.toISOString() })
      .where(eq(cronJobs.id, data.cronJobId))
      .run();
  }
}
