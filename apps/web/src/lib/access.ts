import type { AccessLevel, ResourceType } from '@smt/shared';

/** What each resource type is called, one and many. */
export const RESOURCE_TYPE_LABELS: Record<ResourceType, { one: string; many: string }> = {
  server: { one: 'server', many: 'servers' },
  cluster: { one: 'cluster', many: 'clusters' },
  ftp_connection: { one: 'FTP/SFTP connection', many: 'FTP/SFTP connections' },
  storage_connection: { one: 'storage connection', many: 'storage connections' },
  cloud_account: { one: 'cloud account', many: 'cloud accounts' },
  saved_command: { one: 'saved command', many: 'saved commands' },
  cron_job: { one: 'cron job', many: 'cron jobs' },
};

/** Section headings, in the order the editors show them. */
export const RESOURCE_SECTIONS: { type: ResourceType; title: string }[] = [
  { type: 'server', title: 'Servers' },
  { type: 'cluster', title: 'Kubernetes clusters' },
  { type: 'ftp_connection', title: 'FTP/SFTP connections' },
  { type: 'storage_connection', title: 'Object storage' },
  { type: 'cloud_account', title: 'Cloud accounts' },
  { type: 'saved_command', title: 'Saved commands' },
  { type: 'cron_job', title: 'Cron jobs' },
];

export const LEVELS: AccessLevel[] = ['view', 'operate', 'manage'];

export const LEVEL_LABELS: Record<AccessLevel, string> = { view: 'View', operate: 'Operate', manage: 'Manage' };

/**
 * What a level lets someone do on each type, in plain words (spec §5), for
 * the role preview and level pickers: "open terminals on 3 servers".
 */
export const LEVEL_VERBS: Record<ResourceType, Record<AccessLevel, string>> = {
  server: { view: 'see', operate: 'open terminals and files on', manage: 'fully manage' },
  cluster: { view: 'see the workloads of', operate: 'read logs, scale and exec into', manage: 'fully manage' },
  ftp_connection: { view: 'browse and download files on', operate: 'upload and change files on', manage: 'fully manage' },
  storage_connection: { view: 'list and download objects in', operate: 'upload and change objects in', manage: 'fully manage' },
  cloud_account: { view: 'see', operate: 'sync', manage: 'fully manage' },
  saved_command: { view: 'see', operate: 'run', manage: 'edit and delete' },
  cron_job: { view: 'see the history of', operate: 'run and pause', manage: 'edit and delete' },
};

/**
 * The same, as a short phrase that stands on its own, for level pickers:
 * "Operate — terminals, files and commands".
 */
export const LEVEL_HINTS: Record<ResourceType, Record<AccessLevel, string>> = {
  server: { view: 'status and health', operate: 'terminals, files and commands', manage: 'edit, host keys and delete' },
  cluster: { view: 'workloads and events', operate: 'logs, YAML, scale and exec', manage: 'rollback, cordon and settings' },
  ftp_connection: { view: 'browse and download files', operate: 'upload, rename, delete and test', manage: 'edit, host key and delete' },
  storage_connection: { view: 'list and download objects', operate: 'upload, rename, delete and test', manage: 'buckets, edit and delete' },
  cloud_account: { view: 'see it and its last sync', operate: 'sync now', manage: 'edit credentials and delete' },
  saved_command: { view: 'see it', operate: 'run it', manage: 'edit and delete' },
  cron_job: { view: 'see it and its runs', operate: 'run now, pause and resume', manage: 'edit and delete' },
};

/** True when `level` reaches `required` (view < operate < manage). */
export function levelAtLeast(level: AccessLevel | null | undefined, required: AccessLevel): boolean {
  return !!level && LEVELS.indexOf(level) >= LEVELS.indexOf(required);
}

/** Durations offered wherever time-bound access is picked, in minutes. */
export const DURATION_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 480, label: '8 hours' },
  { minutes: 1440, label: '1 day' },
  { minutes: 4320, label: '3 days' },
  { minutes: 10080, label: '7 days' },
];

/** `90` → `1h 30m`, `2880` → `2d`. Mirrors formatMinutes on the server. */
export function formatMinutes(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = Math.round(minutes % 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
}

/** Time left until `expiresAt`, rounded up to the minute; `null` once it has passed. */
export function remaining(expiresAt: string, now = Date.now()): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  // Past a day the minutes are noise
  return formatMinutes(minutes >= 1440 ? Math.round(minutes / 60) * 60 : minutes);
}
