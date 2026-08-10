import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { commandRuns, savedCommands } from '../db/schema.js';
import { resolveServerAuth } from '../ssh/credentials.js';
import { execOnServer } from '../ssh/broker.js';
import logger from '../logger.js';

/** Maintenance commands (upgrades, backups) run longer than an interactive exec. */
export const COMMAND_TIMEOUT_MS = 300_000;

export interface ExecuteInput {
  runId: string;
  orgId: string;
  commandId: string;
  serverId: string;
  variables?: Record<string, string>;
}

/**
 * Substitute `{{name}}` placeholders. Values are inserted verbatim — a variable
 * is part of the command line, not a quoted argument, so whoever can run a saved
 * command can shape the shell string. That matches the `operator` role, which can
 * already open a terminal and type anything.
 */
export function interpolate(template: string, variables: Record<string, string> = {}): string {
  return Object.entries(variables).reduce(
    (acc, [name, value]) => acc.replaceAll(`{{${name}}}`, value),
    template,
  );
}

/** Placeholder names appearing in a command, in order of first use. */
export function extractVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * Run a saved command against one server and record the outcome on its run row.
 *
 * Never throws: a failure the user should see — bad credentials, unreachable
 * host, non-zero exit — belongs in the run record, not in a queue error the UI
 * has no way to display.
 */
export async function executeSavedCommand(input: ExecuteInput): Promise<void> {
  const db = getDb();
  const started = Date.now();

  const update = (patch: Partial<typeof commandRuns.$inferInsert>) =>
    db.update(commandRuns).set(patch).where(eq(commandRuns.id, input.runId)).run();

  const fail = (stderr: string) =>
    update({
      status: 'failure',
      stderr,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });

  const command = db
    .select()
    .from(savedCommands)
    .where(and(eq(savedCommands.id, input.commandId), eq(savedCommands.orgId, input.orgId)))
    .get();

  if (!command) {
    fail('Saved command no longer exists');
    return;
  }

  update({ status: 'running', startedAt: new Date().toISOString() });

  try {
    // The same resolver the terminal, SFTP and health checks use — so a
    // password-authenticated server works here exactly as it does there.
    const { server, auth } = await resolveServerAuth(input.orgId, input.serverId);
    const cmd = interpolate(command.command, input.variables);

    const result = await execOnServer(
      { host: server.host, port: server.port, username: server.username },
      auth,
      cmd,
      COMMAND_TIMEOUT_MS,
    );

    update({
      status: result.exitCode === 0 ? 'success' : 'failure',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, runId: input.runId, serverId: input.serverId }, 'Saved command run failed');
    fail(message);
  }
}
