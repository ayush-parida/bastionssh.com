import { getDb } from '../db/index.js';
import { servers, savedCommands, cronJobs, auditLog, memberships } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { SSHBroker, execOnServer } from '../ssh/broker.js';
import { resolveServerAuth } from '../ssh/credentials.js';
import {
  accessibleSavedCommandFilter,
  accessibleServerFilter,
  canAccessServer,
} from '../auth/server-access.js';
import { rank } from '../auth/middleware.js';
import { hostKeyStatus } from '../ssh/host-keys.js';
import type { AITool, HostKeyStatus } from '@smt/shared';

// ── Tool definitions ──────────────────────────────────────────────────────────

export const AGENT_TOOLS: AITool[] = [
  {
    name: 'run_command',
    description:
      'Execute a shell command on a server and return stdout/stderr. Use for diagnostics, health checks, log inspection, and server management. Read-only commands run immediately; anything that could change the server waits for the user to approve it. Prefer non-destructive read-only commands unless the user explicitly asks to make changes.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (e.g. "df -h", "ps aux | head -20")',
        },
        server_id: {
          type: 'string',
          description:
            'ID of the server to run the command on. Omit to use the current session server.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'list_servers',
    description: 'List all servers registered in this organization.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_saved_commands',
    description: 'List saved command templates, optionally filtered to a specific server.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: {
          type: 'string',
          description: 'Filter by server ID (optional)',
        },
      },
    },
  },
  {
    name: 'get_recent_audit',
    description:
      'Retrieve recent audit log entries to understand what actions have been performed.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of entries to return (default 10, max 50)',
        },
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

export class ToolExecutor {
  constructor(
    private orgId: string,
    /** The user the agent acts for — an SSH session is only reused if it is theirs */
    private userId: string,
    /** Active SSH session ID — exec goes through the existing SSH connection */
    private sessionId?: string,
    /** The server the user is currently looking at / connected to */
    private activeServerId?: string,
  ) {}

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'run_command':
        return (await this.runCommand(input)).output;
      case 'list_servers':
        return this.listServers();
      case 'list_saved_commands':
        return this.listSavedCommands(input);
      case 'get_recent_audit':
        return this.getRecentAudit(input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Work out which server `run_command` would target for this input, without
   * running anything — used to show the target on an approval card and in the
   * audit log. The name is looked up within the org only. `sshUser` is the
   * account the command runs as: the open session's login when it will reuse
   * that session, else the server's configured user.
   */
  resolveTarget(input: Record<string, unknown>): {
    serverId?: string;
    serverName?: string;
    sshUser?: string;
    hostKeyStatus?: HostKeyStatus;
  } {
    const { session, sessionServerId, serverId } = this.target(input);
    if (!serverId || !this.canUse(serverId)) return {};
    const row = getDb()
      .select({
        name: servers.name,
        username: servers.username,
        hostKeyFingerprint: servers.hostKeyFingerprint,
        hostKeyMismatchFingerprint: servers.hostKeyMismatchFingerprint,
      })
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.orgId, this.orgId)))
      .get();
    if (!row) return { serverId };
    const viaSession = session && sessionServerId === serverId;
    return {
      serverId,
      serverName: row.name,
      sshUser: (viaSession && (session.server as { username?: string }).username) || row.username,
      hostKeyStatus: hostKeyStatus(row),
    };
  }

  /** Run a command and keep the exit code, which the formatted output only mentions. */
  async runCommand(
    input: Record<string, unknown>,
  ): Promise<{ output: string; exitCode: number; serverId: string | undefined }> {
    const command = (input.command as string | undefined)?.trim();
    if (!command) throw new Error('"command" is required');

    const owner = { userId: this.userId, orgId: this.orgId };
    const { session, sessionServerId, serverId } = this.target(input);
    // Same answer as a server that does not exist, so restricted members learn nothing
    if (serverId && !this.canUse(serverId)) throw new Error('Server not found');

    if (session && sessionServerId && serverId === sessionServerId) {
      try {
        const result = await SSHBroker.exec(session.id, command, undefined, owner);
        return { output: formatExecResult(result), exitCode: result.exitCode, serverId };
      } catch {
        // Session may have expired — fall through to direct exec
      }
    }

    if (!serverId) {
      throw new Error('No server specified and no active session available');
    }

    // Org-scoped server and key lookup, same as the terminal and saved commands
    const { server, auth } = await resolveServerAuth(this.orgId, serverId);

    const result = await execOnServer(
      { id: server.id, host: server.host, port: server.port, username: server.username },
      auth,
      command,
    );

    return { output: formatExecResult(result), exitCode: result.exitCode, serverId };
  }

  private canUse(serverId: string): boolean {
    return canAccessServer({ orgId: this.orgId, userId: this.userId }, serverId);
  }

  private target(input: Record<string, unknown>) {
    const requestedServerId = (input.server_id as string | undefined) || this.activeServerId;

    // Reuse the interactive session only if it is the caller's and is connected
    // to the server the command targets — never run on some other host.
    const session = this.sessionId
      ? SSHBroker.getSessionForUser(this.sessionId, this.userId, this.orgId)
      : undefined;
    const sessionServerId = session
      ? (session.server as { id?: string }).id
      : undefined;
    return { session, sessionServerId, serverId: requestedServerId ?? sessionServerId };
  }

  private listServers(): string {
    const db = getDb();
    const who = { orgId: this.orgId, userId: this.userId };
    const rows = db
      .select()
      .from(servers)
      .where(and(eq(servers.orgId, this.orgId), accessibleServerFilter(who, servers.id)))
      .all();
    if (rows.length === 0) return 'No servers registered.';

    return rows
      .map((s) => {
        const tags = s.tags ? (JSON.parse(s.tags) as string[]).join(', ') : '';
        return `- ${s.name} (id: ${s.id}) — ${s.username}@${s.host}:${s.port}${tags ? ` [${tags}]` : ''}`;
      })
      .join('\n');
  }

  private listSavedCommands(input: Record<string, unknown>): string {
    const db = getDb();
    const serverId = input.server_id as string | undefined;

    const who = { orgId: this.orgId, userId: this.userId };

    // Commands bound to a server the user cannot access stay hidden
    const rows = db
      .select()
      .from(savedCommands)
      .where(
        and(
          eq(savedCommands.orgId, this.orgId),
          serverId ? eq(savedCommands.serverId, serverId) : undefined,
          accessibleSavedCommandFilter(who),
        ),
      )
      .all();

    if (rows.length === 0) return 'No saved commands.';

    return rows.map((c) => `- ${c.name} (id: ${c.id}): \`${c.command}\``).join('\n');
  }

  private getRecentAudit(input: Record<string, unknown>): string {
    const db = getDb();
    const limit = Math.min((input.limit as number | undefined) ?? 10, 50);

    // The audit log route is admin-only; below that, the agent only sees the caller's own actions
    const membership = db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, this.userId), eq(memberships.orgId, this.orgId)))
      .get();
    const ownOnly = rank(membership?.role ?? 'viewer') < rank('admin');

    const rows = db
      .select()
      .from(auditLog)
      .where(
        ownOnly
          ? and(eq(auditLog.orgId, this.orgId), eq(auditLog.actorId, this.userId))
          : eq(auditLog.orgId, this.orgId),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .all();

    if (rows.length === 0) return 'No audit log entries.';

    return rows
      .map(
        (e) =>
          `[${e.createdAt}] ${e.actorEmail} performed ${e.action} on ${e.resourceType}/${e.resourceName ?? e.resourceId ?? '?'}`,
      )
      .join('\n');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatExecResult(result: { stdout: string; stderr: string; exitCode: number }): string {
  const parts: string[] = [];
  const out = result.stdout.trim();
  const err = result.stderr.trim();

  if (out) parts.push(out);
  if (err) parts.push(`STDERR:\n${err}`);
  if (result.exitCode !== 0) parts.push(`Exit code: ${result.exitCode}`);

  return parts.join('\n') || '(no output)';
}

// ── Context builder ───────────────────────────────────────────────────────────

/** Build the system prompt injected into every AI chat request */
export function buildSystemPrompt(opts: {
  orgId: string;
  userId: string;
  terminalOutput?: string;
  sessionServerId?: string;
}): string {
  const db = getDb();
  const who = { orgId: opts.orgId, userId: opts.userId };
  const allServers = db
    .select()
    .from(servers)
    .where(and(eq(servers.orgId, opts.orgId), accessibleServerFilter(who, servers.id)))
    .all();
  const allCommands = db
    .select()
    .from(savedCommands)
    .where(and(eq(savedCommands.orgId, opts.orgId), accessibleSavedCommandFilter(who)))
    .all();
  const allCrons = db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.orgId, opts.orgId), accessibleServerFilter(who, cronJobs.serverId)))
    .all();

  const serverList =
    allServers.length > 0
      ? allServers
          .map((s) => {
            const tags = s.tags ? (JSON.parse(s.tags) as string[]).join(', ') : '';
            const active = s.id === opts.sessionServerId ? ' ← CURRENTLY CONNECTED' : '';
            return `  - ${s.name} (id: ${s.id}): ${s.username}@${s.host}:${s.port}${tags ? ` [${tags}]` : ''}${active}`;
          })
          .join('\n')
      : '  (none)';

  const commandList =
    allCommands.length > 0
      ? allCommands.map((c) => `  - ${c.name}: \`${c.command}\``).join('\n')
      : '  (none)';

  const cronList =
    allCrons.length > 0
      ? allCrons
          .map(
            (j) =>
              `  - ${j.name}: schedule "${j.schedule}" — ${j.enabled ? 'enabled' : 'disabled'}`,
          )
          .join('\n')
      : '  (none)';

  const lines = [
    'You are BastionSSH AI Assistant, an expert DevOps engineer helping manage Linux servers.',
    'You have access to tools that let you run commands on servers and inspect the infrastructure.',
    'Always explain what you are doing before executing commands.',
    'Prefer read-only diagnostic commands first.',
    'Read-only commands run immediately. Any command that could change a server (restarts, installs, edits, deletes, writes to files, sudo, and anything not recognised as read-only) is shown to the user, who must approve it before it runs — you do not need to ask for confirmation in chat first, but do say what the change will do.',
    'Repository config can make git run programs, so most git commands need approval. To inspect a repository without it, use `git diff --no-ext-diff --no-textconv …`, or put `--no-ext-diff --no-textconv --no-show-signature` plus an explicit format such as `--oneline` right after `git log` / `git show`.',
    'If the user declines a command, or the approval expires, do not retry the same command or a variation of it. Explain what you would have done and ask how they want to proceed.',
    '',
    '## Registered Servers',
    serverList,
    '',
    '## Saved Commands',
    commandList,
    '',
    '## Cron Jobs',
    cronList,
  ];

  if (opts.terminalOutput) {
    lines.push('', '## Recent Terminal Output', '```', opts.terminalOutput.slice(-4000), '```');
  }

  return lines.join('\n');
}
