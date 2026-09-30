/**
 * `terminal` is an interactive shell; `exec` a one-shot command (AI agent,
 * saved command); `container` a shell inside a Docker container.
 */
export type RecordingKind = 'terminal' | 'exec' | 'container';

/** What ran a command that was logged against a recording. */
export type RecordingCommandSource = 'ai' | 'saved_command';

/** A recorded session, as listed. The cast itself is fetched separately. */
export interface SessionRecording {
  id: string;
  kind: RecordingKind;
  /** null once the server has been deleted; `serverName` keeps what it was called. */
  serverId: string | null;
  serverName: string | null;
  userId: string;
  /** null when the user no longer exists. */
  userEmail: string | null;
  /** For `exec` recordings: what ran it and the command (a saved command's template, never its variables). */
  source: RecordingCommandSource | null;
  command: string | null;
  /** For `container` recordings: the container the shell ran in. */
  container?: { id: string; name: string } | null;
  startedAt: string;
  /** null while the session is still live. */
  endedAt: string | null;
  /** Size of the uncompressed cast. */
  bytes: number;
  /** Keystrokes were captured too — anything typed, passwords included. */
  inputRecorded: boolean;
  /** The size cap was hit and the rest of the session was not recorded. */
  truncated: boolean;
  cols: number;
  rows: number;
}

/** A command run over a live terminal's connection (e.g. by the AI agent), logged on its recording. */
export interface RecordingCommand {
  id: string;
  /** Seconds from the start of the recording. */
  at: number;
  source: RecordingCommandSource;
  command: string;
  exitCode: number | null;
  createdAt: string;
}

export interface SessionRecordingDetail extends SessionRecording {
  commands: RecordingCommand[];
}

/** Org-wide recording policy, readable by every member; only owners change it. */
export interface RecordingSettings {
  /** Record terminal sessions and one-shot command runs (default on). */
  enabled: boolean;
  /** Also capture keystrokes (default off) — passwords typed at a prompt end up in the recording. */
  recordInput: boolean;
  /** Recordings older than this are deleted by the daily prune. */
  retentionDays: number;
}

/** Returned with a new terminal session when it is being recorded. */
export interface ActiveRecording {
  id: string;
  inputRecorded: boolean;
}
