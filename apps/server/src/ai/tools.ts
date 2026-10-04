import { getDb } from '../db/index.js';
import { servers, savedCommands, cronJobs, auditLog, memberships, users, kubeClusters } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { SSHBroker, execOnServer } from '../ssh/broker.js';
import { resolveServerAuth } from '../ssh/credentials.js';
import { startExecRecording, withExecRecording } from '../recordings/index.js';
import {
  accessibleSavedCommandFilter,
  accessibleServerFilter,
  canAccessServer,
} from '../auth/server-access.js';
import { rank } from '../auth/middleware.js';
import { hostKeyStatus } from '../ssh/host-keys.js';
import { permissionsFor } from '../docker/permissions.js';
import { aiContainerLogs, aiInspect, aiListContainers } from '../docker/ai-tools.js';
import { filterAccessibleClusters } from '../auth/cluster-access.js';
import { aiDescribe, aiEvents, aiListWorkloads, aiPodLogs } from '../kube/ai-tools.js';
import { type AITool, type DockerCapability, type HostKeyStatus, type Role } from '@smt/shared';

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
    name: 'docker_list_containers',
    description:
      'List the Docker containers on a server: name, short id, image, state and health, status, published ports and Compose project. Read-only. Running containers only unless "all" is true. Use this before reading logs or inspecting a container, to get its exact name.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: {
          type: 'string',
          description: 'ID of the server. Omit to use the server the user is looking at.',
        },
        all: {
          type: 'boolean',
          description: 'Include stopped and exited containers (default false).',
        },
      },
    },
  },
  {
    name: 'docker_container_logs',
    description:
      'Read the most recent log lines of a Docker container (stdout and stderr; stderr lines start with "[stderr]"). Read-only. At most 500 lines, and long output is truncated from the oldest end, like run_command.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: {
          type: 'string',
          description: 'ID of the server. Omit to use the server the user is looking at.',
        },
        container: {
          type: 'string',
          description: 'Container name or id, as docker_list_containers shows it.',
        },
        tail: {
          type: 'number',
          description: 'Number of lines from the end (default 100, max 500).',
        },
        since: {
          type: 'string',
          description: 'Only lines after this time: unix seconds or an ISO date (optional).',
        },
      },
      required: ['container'],
    },
  },
  {
    name: 'docker_inspect',
    description:
      'Inspect a Docker container: configuration, state (exit code, health, restart count), restart policy, mounts, networks and labels, as JSON. Read-only. Environment variable values are always redacted (KEY=••••); do not ask for them.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: {
          type: 'string',
          description: 'ID of the server. Omit to use the server the user is looking at.',
        },
        container: {
          type: 'string',
          description: 'Container name or id, as docker_list_containers shows it.',
        },
      },
      required: ['container'],
    },
  },
  {
    name: 'kube_list_workloads',
    description:
      'List the workloads of a Kubernetes cluster (Deployments, StatefulSets, DaemonSets, Jobs, CronJobs) with their health ("2 of 3 ready"), and the pods that are failing or pending with their reason (CrashLoopBackOff, ImagePullBackOff, Unschedulable…). Read-only. Start here to find the exact names to describe or read logs of.',
    inputSchema: {
      type: 'object',
      properties: {
        cluster_id: {
          type: 'string',
          description: 'ID of the cluster, from the Kubernetes Clusters list in the system prompt.',
        },
        namespace: {
          type: 'string',
          description: 'Only this namespace (optional; default every namespace you may see).',
        },
      },
      required: ['cluster_id'],
    },
  },
  {
    name: 'kube_describe',
    description:
      'Read one Kubernetes object as YAML with its health on top: spec, status, conditions, container states and restart reasons. Read-only. Secret values are always removed (shown as ••••); do not ask for them.',
    inputSchema: {
      type: 'object',
      properties: {
        cluster_id: {
          type: 'string',
          description: 'ID of the cluster.',
        },
        resource: {
          type: 'string',
          description:
            'The resource, plural: pods, deployments, statefulsets, daemonsets, replicasets, jobs, cronjobs, services, endpoints, ingresses, configmaps, secrets, persistentvolumeclaims, persistentvolumes, storageclasses, horizontalpodautoscalers, nodes, namespaces.',
        },
        namespace: {
          type: 'string',
          description: 'The namespace; leave out for nodes, namespaces, persistentvolumes and storageclasses.',
        },
        name: {
          type: 'string',
          description: 'The object name.',
        },
      },
      required: ['cluster_id', 'resource', 'name'],
    },
  },
  {
    name: 'kube_events',
    description:
      'Recent Kubernetes events, newest first (scheduling failures, image pull errors, back-offs, probe failures, OOM kills…): for a namespace, or for one object when resource and name are given. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        cluster_id: {
          type: 'string',
          description: 'ID of the cluster.',
        },
        namespace: {
          type: 'string',
          description: 'The namespace (optional; default every namespace you may see).',
        },
        resource: {
          type: 'string',
          description: 'With name: only events about this object (plural resource, e.g. pods).',
        },
        name: {
          type: 'string',
          description: 'The object name (optional).',
        },
        limit: {
          type: 'number',
          description: 'Most events to return (default 50, max 200).',
        },
      },
      required: ['cluster_id'],
    },
  },
  {
    name: 'kube_pod_logs',
    description:
      'Read the most recent log lines of a container in a Kubernetes pod. Read-only. At most 500 lines, and long output is truncated from the oldest end. Set previous to true to read the run before the last restart (why a crash-looping container died).',
    inputSchema: {
      type: 'object',
      properties: {
        cluster_id: {
          type: 'string',
          description: 'ID of the cluster.',
        },
        namespace: {
          type: 'string',
          description: 'The pod’s namespace.',
        },
        pod: {
          type: 'string',
          description: 'The pod name, as kube_list_workloads shows it.',
        },
        container: {
          type: 'string',
          description: 'The container (optional when the pod has only one).',
        },
        tail: {
          type: 'number',
          description: 'Number of lines from the end (default 100, max 500).',
        },
        previous: {
          type: 'boolean',
          description: 'Read the previous, crashed run instead of the current one (default false).',
        },
      },
      required: ['cluster_id', 'namespace', 'pod'],
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
      case 'docker_list_containers':
        return aiListContainers(this.requester(), this.dockerTarget(input, 'view'), input.all === true);
      case 'docker_container_logs':
        return aiContainerLogs(this.requester(), this.dockerTarget(input, 'inspect'), input.container, {
          tail: input.tail,
          since: input.since,
        });
      case 'docker_inspect':
        return aiInspect(this.requester(), this.dockerTarget(input, 'inspect'), input.container);
      case 'kube_list_workloads':
        return aiListWorkloads(this.kubeRequester(), this.kubeTarget(input), input.namespace);
      case 'kube_describe':
        return aiDescribe(this.kubeRequester(), this.kubeTarget(input), input.resource, input.namespace, input.name);
      case 'kube_events':
        return aiEvents(this.kubeRequester(), this.kubeTarget(input), {
          namespace: input.namespace,
          resource: input.resource,
          name: input.name,
          limit: input.limit,
        });
      case 'kube_pod_logs':
        return aiPodLogs(this.kubeRequester(), this.kubeTarget(input), input.namespace, input.pod, {
          container: input.container,
          previous: input.previous,
          tail: input.tail,
        });
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

  /**
   * Run a command and keep the exit code, which the formatted output only
   * mentions, and the recording it was logged on (for the audit entry).
   */
  async runCommand(
    input: Record<string, unknown>,
  ): Promise<{ output: string; exitCode: number; serverId: string | undefined; recordingId?: string }> {
    const command = (input.command as string | undefined)?.trim();
    if (!command) throw new Error('"command" is required');

    const owner = { userId: this.userId, orgId: this.orgId };
    const { session, sessionServerId, serverId } = this.target(input);
    // Same answer as a server that does not exist, so restricted members learn nothing
    if (serverId && !this.canUse(serverId)) throw new Error('Server not found');

    if (session && sessionServerId && serverId === sessionServerId) {
      try {
        const result = await SSHBroker.exec(session.id, command, undefined, owner, 'ai');
        return {
          output: formatExecResult(result),
          exitCode: result.exitCode,
          serverId,
          recordingId: result.recordingId,
        };
      } catch {
        // Session may have expired — fall through to direct exec
      }
    }

    if (!serverId) {
      throw new Error('No server specified and no active session available');
    }

    // Org-scoped server and key lookup, same as the terminal and saved commands
    const { server, auth } = await resolveServerAuth(this.orgId, serverId);

    const recording = startExecRecording({
      orgId: this.orgId,
      serverId: server.id,
      serverName: server.name,
      userId: this.userId,
      source: 'ai',
      command,
    });
    const result = await withExecRecording(recording, (tap) =>
      execOnServer(
        { id: server.id, host: server.host, port: server.port, username: server.username },
        auth,
        command,
        undefined,
        tap,
        { actorUserId: this.userId },
      ),
    );

    return {
      output: formatExecResult(result),
      exitCode: result.exitCode,
      serverId,
      recordingId: result.recordingId,
    };
  }

  /** The user the agent acts for, in the shape the Docker service takes. */
  private requester() {
    return { orgId: this.orgId, user: { id: this.userId } } as Parameters<typeof aiListContainers>[0];
  }

  /**
   * The server a Docker tool reads from: `server_id`, else the one the user is
   * looking at or connected to (as for run_command). The caller's level there must allow `capability` under the org's
   * Docker settings — logs and inspect need an operator, like the Docker tab.
   * A server they cannot access reads as not found (withDockerClient again).
   */
  private dockerTarget(input: Record<string, unknown>, capability: DockerCapability): string {
    const { serverId } = this.target(input);
    if (!serverId) throw new Error('No server specified: pass server_id');
    if (!this.canUse(serverId)) throw new Error('Server not found');
    // The matrix at the user's level on this server, as the Docker tab reads it
    const role = (this.memberRole() ?? 'viewer') as Role;
    const caller = { orgId: this.orgId, role, user: { id: this.userId, email: '', displayName: '' } };
    if (!permissionsFor(caller, serverId)[capability]) {
      throw new Error('Your role does not allow reading container logs or details');
    }
    return serverId;
  }

  /**
   * The user the agent acts for, as the Kubernetes service takes them: their
   * role (the §7 matrix; read from the membership on every call) and email
   * (a cluster with impersonation on is told who is asking).
   */
  private kubeRequester() {
    const email = getDb().select({ email: users.email }).from(users).where(eq(users.id, this.userId)).get()?.email ?? '';
    const role = (this.memberRole() ?? 'viewer') as Role;
    return { orgId: this.orgId, user: { id: this.userId, email }, role } as Parameters<typeof aiListWorkloads>[0];
  }

  /**
   * The cluster a Kubernetes tool reads from. There is no "current" cluster,
   * so `cluster_id` is required; cluster access, the namespace allowlist and
   * the role checks are the Kubernetes service's own (a cluster the user
   * cannot use is "not found").
   */
  private kubeTarget(input: Record<string, unknown>): string {
    const clusterId = input.cluster_id;
    if (typeof clusterId !== 'string' || !clusterId) throw new Error('No cluster specified: pass cluster_id');
    return clusterId;
  }

  private memberRole(): string | undefined {
    return getDb()
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, this.userId), eq(memberships.orgId, this.orgId)))
      .get()?.role;
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
    const ownOnly = rank(this.memberRole() ?? 'viewer') < rank('admin');

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

  const clusters = filterAccessibleClusters(
    who,
    db
      .select({ id: kubeClusters.id, name: kubeClusters.name, serverVersion: kubeClusters.serverVersion })
      .from(kubeClusters)
      .where(eq(kubeClusters.orgId, opts.orgId))
      .all(),
    (c) => c.id,
  );
  const clusterList =
    clusters.length > 0
      ? clusters
          .map((c) => `  - ${c.name} (id: ${c.id})${c.serverVersion ? ` — Kubernetes ${c.serverVersion}` : ''}`)
          .join('\n')
      : '  (none)';

  const lines = [
    'You are BastionSSH AI Assistant, an expert DevOps engineer helping manage Linux servers.',
    'You have access to tools that let you run commands on servers and inspect the infrastructure.',
    'Always explain what you are doing before executing commands.',
    'Prefer read-only diagnostic commands first.',
    'Read-only commands run immediately. Any command that could change a server (restarts, installs, edits, deletes, writes to files, sudo, and anything not recognised as read-only) is shown to the user, who must approve it before it runs — you do not need to ask for confirmation in chat first, but do say what the change will do.',
    'Repository config can make git run programs, so most git commands need approval. To inspect a repository without it, use `git diff --no-ext-diff --no-textconv …`, or put `--no-ext-diff --no-textconv --no-show-signature` plus an explicit format such as `--oneline` right after `git log` / `git show`.',
    'For Docker, read with docker_list_containers, docker_container_logs and docker_inspect (environment values stay redacted). Changes such as `docker restart <name>` go through run_command and need approval like any other change.',
    'For Kubernetes, read with kube_list_workloads, kube_describe, kube_events and kube_pod_logs (Secret values stay redacted). You cannot change a cluster: point the user to the guided buttons on the cluster page (scale, restart rollout, roll back, delete pod, cordon) instead.',
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
    '',
    '## Kubernetes Clusters',
    clusterList,
  ];

  if (opts.terminalOutput) {
    lines.push('', '## Recent Terminal Output', '```', opts.terminalOutput.slice(-4000), '```');
  }

  return lines.join('\n');
}
