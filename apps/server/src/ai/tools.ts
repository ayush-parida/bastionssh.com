import { getDb } from '../db/index.js';
import { servers, sshKeys, savedCommands, cronJobs, auditLog } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { vault } from '../vault/index.js';
import { SSHBroker, execOnServer } from '../ssh/broker.js';
import type { AITool } from '@smt/shared';

// ── Tool definitions ──────────────────────────────────────────────────────────

export const AGENT_TOOLS: AITool[] = [
  {
    name: 'run_command',
    description:
      'Execute a shell command on a server and return stdout/stderr. Use for diagnostics, health checks, log inspection, and server management. Prefer non-destructive read-only commands unless the user explicitly asks to make changes.',
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
    /** Active SSH session ID — exec goes through the existing SSH connection */
    private sessionId?: string,
    /** The server the user is currently looking at / connected to */
    private activeServerId?: string,
  ) {}

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'run_command':
        return this.runCommand(input);
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

  private async runCommand(input: Record<string, unknown>): Promise<string> {
    const command = (input.command as string | undefined)?.trim();
    if (!command) throw new Error('"command" is required');

    const serverId = (input.server_id as string | undefined) || this.activeServerId;

    // Use an active interactive session if we have one (same SSH connection)
    if (this.sessionId) {
      try {
        const result = await SSHBroker.exec(this.sessionId, command);
        return formatExecResult(result);
      } catch {
        // Session may have expired — fall through to direct exec
      }
    }

    if (!serverId) {
      throw new Error('No server specified and no active session available');
    }

    const db = getDb();
    const server = db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.orgId, this.orgId)))
      .get();
    if (!server) throw new Error(`Server ${serverId} not found`);

    const authOptions: { privateKey?: string; password?: string } = {};

    if (server.defaultKeyId) {
      const key = db.select().from(sshKeys).where(eq(sshKeys.id, server.defaultKeyId)).get();
      if (key) {
        authOptions.privateKey = await vault.decrypt(key.encryptedPrivateKey, key.id);
      }
    } else if (server.encryptedPassword) {
      authOptions.password = await vault.decrypt(server.encryptedPassword, server.id);
    }

    const result = await execOnServer(
      { host: server.host, port: server.port, username: server.username },
      authOptions,
      command,
    );

    return formatExecResult(result);
  }

  private listServers(): string {
    const db = getDb();
    const rows = db.select().from(servers).where(eq(servers.orgId, this.orgId)).all();
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

    const rows = db
      .select()
      .from(savedCommands)
      .where(
        serverId
          ? and(eq(savedCommands.orgId, this.orgId), eq(savedCommands.serverId, serverId))
          : eq(savedCommands.orgId, this.orgId),
      )
      .all();

    if (rows.length === 0) return 'No saved commands.';

    return rows.map((c) => `- ${c.name} (id: ${c.id}): \`${c.command}\``).join('\n');
  }

  private getRecentAudit(input: Record<string, unknown>): string {
    const db = getDb();
    const limit = Math.min((input.limit as number | undefined) ?? 10, 50);

    const rows = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, this.orgId))
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
  terminalOutput?: string;
  sessionServerId?: string;
}): string {
  const db = getDb();
  const allServers = db.select().from(servers).where(eq(servers.orgId, opts.orgId)).all();
  const allCommands = db
    .select()
    .from(savedCommands)
    .where(eq(savedCommands.orgId, opts.orgId))
    .all();
  const allCrons = db.select().from(cronJobs).where(eq(cronJobs.orgId, opts.orgId)).all();

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
    'Prefer read-only diagnostic commands first. Ask for confirmation before destructive actions.',
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
