import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { commandRuns, savedCommands } from '../db/schema.js';
import { authorize } from '../auth/access/authorize.js';
import { hasModule } from '../auth/access/modules.js';
import { resolveServerAuth } from '../ssh/credentials.js';
import { execOnServer } from '../ssh/broker.js';
import { startExecRecording, withExecRecording } from '../recordings/index.js';
import logger from '../logger.js';

/** Maintenance commands (upgrades, backups) run longer than an interactive exec. */
export const COMMAND_TIMEOUT_MS = 300_000;

export interface ExecuteInput {
  runId: string;
  orgId: string;
  commandId: string;
  serverId: string;
  variables?: Record<string, string>;
  /** Id to record the run under, chosen up front so the audit entry can link to it. */
  recordingId?: string;
}

/** `{{name}}`, tolerating inner whitespace (`{{ name }}`). */
const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Substitute `{{name}}` placeholders. Values are inserted verbatim — a variable
 * is part of the command line, not a quoted argument, so whoever can run a saved
 * command can shape the shell string. That matches the `operator` role, which can
 * already open a terminal and type anything.
 *
 * The replacer is a function so `$$`, `$&` and friends in a value stay literal.
 */
export function interpolate(template: string, variables: Record<string, string> = {}): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name]! : match,
  );
}

/** Placeholder names appearing in a command, in order of first use. */
export function extractVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * Why `who` may no longer run `command` on `serverId`, or null when they may:
 * what the run route checked — the Saved Commands and Servers modules on
 * (unified roles spec §7), the command visible (with its bound server) and
 * runnable, and `operate` on the target server.
 */
export function runnerRefusal(
  who: { orgId: string; userId: string },
  command: { id: string; serverId: string | null },
  serverId: string,
): string | null {
  if (!hasModule(who, 'saved_commands') || !hasModule(who, 'servers')) {
    return 'Whoever started this run no longer has access to saved commands';
  }
  if (!authorize(who, 'server', serverId, 'run_command').ok) {
    return 'Whoever started this run no longer has access to run commands on this server';
  }
  const visible = !command.serverId || authorize(who, 'server', command.serverId, 'view').ok;
  if (!visible || !authorize(who, 'saved_command', command.id, 'run').ok) {
    return 'Whoever started this run no longer has access to this saved command';
  }
  return null;
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

  const run = db
    .select({ triggeredBy: commandRuns.triggeredBy })
    .from(commandRuns)
    .where(eq(commandRuns.id, input.runId))
    .get();
  // A queued run, or one waiting its turn in a fan-out, may start well after
  // the route checked: whoever started it must still be able to run the
  // command here (custom roles spec §2.7, §2.8), or it does not run
  const refusal = run ? runnerRefusal({ orgId: input.orgId, userId: run.triggeredBy }, command, input.serverId) : null;
  if (refusal) {
    fail(refusal);
    return;
  }

  update({ status: 'running', startedAt: new Date().toISOString() });

  try {
    // The same resolver the terminal, SFTP and health checks use — so a
    // password-authenticated server works here exactly as it does there.
    const { server, auth } = await resolveServerAuth(input.orgId, input.serverId);
    const cmd = interpolate(command.command, input.variables);
    // A jump hop is audited under whoever started the run
    // Stored and shown as the template: variable values are often credentials
    const recording = run
      ? startExecRecording({
          id: input.recordingId,
          orgId: input.orgId,
          serverId: server.id,
          serverName: server.name,
          userId: run.triggeredBy,
          source: 'saved_command',
          command: command.command,
        })
      : null;

    const result = await withExecRecording(recording, (tap) =>
      execOnServer(
        { id: server.id, host: server.host, port: server.port, username: server.username },
        auth,
        cmd,
        COMMAND_TIMEOUT_MS,
        tap,
        { actorUserId: run?.triggeredBy },
      ),
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
