export interface SavedCommand {
  id: string;
  orgId: string;
  /** null = org-wide command not tied to a specific server */
  serverId?: string;
  name: string;
  command: string;
  /** Variable definitions: { varName: { label, defaultValue } } */
  variables: Record<string, { label: string; defaultValue?: string }>;
  category?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSavedCommandRequest {
  serverId?: string;
  name: string;
  command: string;
  variables?: Record<string, { label: string; defaultValue?: string }>;
  category?: string;
}

export interface UpdateSavedCommandRequest {
  /** null clears the default server, making the command runnable anywhere */
  serverId?: string | null;
  name?: string;
  command?: string;
  variables?: Record<string, { label: string; defaultValue?: string }>;
  category?: string | null;
}

export type CommandRunStatus = 'pending' | 'running' | 'success' | 'failure';

export interface CommandRun {
  id: string;
  commandId: string;
  serverId: string;
  triggeredBy: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  status: CommandRunStatus;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export interface RunCommandRequest {
  /** Override variable values at runtime */
  variables?: Record<string, string>;
  /** Target this server instead of the command's default */
  serverId?: string;
}

export interface RunCommandResponse {
  runId: string;
  /** 'inline' means it ran in-process because no queue was configured */
  mode: 'queued' | 'inline';
}
