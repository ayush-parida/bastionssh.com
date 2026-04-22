import { Client } from 'ssh2';
import { getDb } from '../../db/index.js';
import { servers, sshKeys, commandRuns, savedCommands } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { vault } from '../../vault/index.js';
import logger from '../../logger.js';

interface CommandJobData {
  runId: string;
  commandId: string;
  serverId: string;
  variables?: Record<string, string>;
}

export async function runCommandJob(data: CommandJobData) {
  const db = getDb();
  const start = Date.now();

  const command = db.select().from(savedCommands).where(eq(savedCommands.id, data.commandId)).get();
  const server = db.select().from(servers).where(eq(servers.id, data.serverId)).get();

  if (!command || !server?.defaultKeyId) {
    db.update(commandRuns)
      .set({
        status: 'failure',
        stderr: 'Missing command or server key',
        finishedAt: new Date().toISOString(),
      })
      .where(eq(commandRuns.id, data.runId))
      .run();
    return;
  }

  const key = db.select().from(sshKeys).where(eq(sshKeys.id, server.defaultKeyId)).get();
  if (!key) throw new Error('SSH key not found');

  const privateKey = await vault.decrypt(key.encryptedPrivateKey, key.id);

  // Interpolate variables
  let cmd = command.command;
  for (const [k, v] of Object.entries(data.variables ?? {})) {
    cmd = cmd.replaceAll(`{{${k}}}`, v);
  }

  db.update(commandRuns)
    .set({ status: 'running', startedAt: new Date().toISOString() })
    .where(eq(commandRuns.id, data.runId))
    .run();

  await new Promise<void>((resolve, reject) => {
    const ssh = new Client();
    let stdout = '';
    let stderr = '';

    ssh.on('ready', () => {
      ssh.exec(cmd, (err, stream) => {
        if (err) return reject(err);

        stream.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });

        stream.on('close', (code: number) => {
          ssh.end();
          const durationMs = Date.now() - start;
          db.update(commandRuns)
            .set({
              status: code === 0 ? 'success' : 'failure',
              exitCode: code,
              stdout,
              stderr,
              finishedAt: new Date().toISOString(),
              durationMs,
            })
            .where(eq(commandRuns.id, data.runId))
            .run();
          resolve();
        });
      });
    });

    ssh.on('error', (err) => {
      logger.error({ err, runId: data.runId }, 'SSH exec error');
      db.update(commandRuns)
        .set({ status: 'failure', stderr: err.message, finishedAt: new Date().toISOString() })
        .where(eq(commandRuns.id, data.runId))
        .run();
      reject(err);
    });

    ssh.connect({ host: server.host, port: server.port, username: server.username, privateKey });
  });
}
