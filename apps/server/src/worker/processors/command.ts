import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { commandRuns, savedCommands } from '../../db/schema.js';
import { executeSavedCommand } from '../../commands/run.js';

interface CommandJobData {
  runId: string;
  commandId: string;
  serverId: string;
  variables?: Record<string, string>;
  /** Older queued jobs predate org scoping; look it up when absent. */
  orgId?: string;
}

export async function runCommandJob(data: CommandJobData) {
  const orgId =
    data.orgId ??
    getDb()
      .select({ orgId: savedCommands.orgId })
      .from(savedCommands)
      .where(eq(savedCommands.id, data.commandId))
      .get()?.orgId;

  if (!orgId) {
    getDb()
      .update(commandRuns)
      .set({
        status: 'failure',
        stderr: 'Saved command no longer exists',
        finishedAt: new Date().toISOString(),
      })
      .where(eq(commandRuns.id, data.runId))
      .run();
    return;
  }

  await executeSavedCommand({
    runId: data.runId,
    orgId,
    commandId: data.commandId,
    serverId: data.serverId,
    variables: data.variables,
  });
}
