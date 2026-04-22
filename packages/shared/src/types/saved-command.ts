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

export interface CommandRun {
  id: string;
  commandId: string;
  serverId: string;
  triggeredBy: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  status: 'pending' | 'running' | 'success' | 'failure';
  stdout: string;
  stderr: string;
}

export interface RunCommandRequest {
  /** Override variable values at runtime */
  variables?: Record<string, string>;
}
