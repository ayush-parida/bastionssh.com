export interface CronJob {
  id: string;
  orgId: string;
  serverId: string;
  /** Reference an existing saved command or use inlineCommand */
  savedCommandId?: string;
  inlineCommand?: string;
  name: string;
  schedule: string; // cron expression e.g. "0 2 * * *"
  timezone: string; // IANA e.g. "America/New_York"
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  notify: CronJobNotifyConfig;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CronJobNotifyConfig {
  onFailure?: boolean;
  webhookUrl?: string;
  email?: string;
}

export interface CreateCronJobRequest {
  serverId: string;
  savedCommandId?: string;
  inlineCommand?: string;
  name: string;
  schedule: string;
  timezone?: string;
  enabled?: boolean;
  notify?: CronJobNotifyConfig;
}

export type CronRunStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped';

export interface CronRun {
  id: string;
  cronJobId: string;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  status: CronRunStatus;
  stdout: string;
  stderr: string;
  durationMs?: number;
}
