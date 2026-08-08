import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

// ── Users & Auth ─────────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash'),
  avatarUrl: text('avatar_url'),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).default(false),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
});

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  hashedToken: text('hashed_token').notNull().unique(),
  prefix: text('prefix').notNull(),
  scopes: text('scopes').notNull().default('[]'), // JSON array
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const oauthAccounts = sqliteTable('oauth_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerUserId: text('provider_user_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  expiresAt: text('expires_at'),
});

// ── Organizations ─────────────────────────────────────────────────────────────

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const memberships = sqliteTable('memberships', {
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('viewer'), // owner | admin | operator | viewer
  joinedAt: text('joined_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull().default('viewer'),
  token: text('token').notNull().unique(),
  invitedBy: text('invited_by').notNull(),
  expiresAt: text('expires_at').notNull(),
  acceptedAt: text('accepted_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── SSH Keys ──────────────────────────────────────────────────────────────────

export const sshKeys = sqliteTable('ssh_keys', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull().default('ed25519'),
  publicKey: text('public_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  encryptedPrivateKey: text('encrypted_private_key').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── Servers ───────────────────────────────────────────────────────────────────

export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull().default(22),
  username: text('username').notNull(),
  defaultKeyId: text('default_key_id').references(() => sshKeys.id),
  encryptedPassword: text('encrypted_password'), // AES-256-GCM encrypted, null = key-based auth
  tags: text('tags').notNull().default('[]'), // JSON array
  notes: text('notes'),
  monitoringEnabled: integer('monitoring_enabled', { mode: 'boolean' }).notNull().default(true),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── Saved Commands ────────────────────────────────────────────────────────────

export const savedCommands = sqliteTable('saved_commands', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  command: text('command').notNull(),
  variables: text('variables').notNull().default('{}'), // JSON
  category: text('category'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const commandRuns = sqliteTable('command_runs', {
  id: text('id').primaryKey(),
  commandId: text('command_id')
    .notNull()
    .references(() => savedCommands.id, { onDelete: 'cascade' }),
  serverId: text('server_id').notNull(),
  triggeredBy: text('triggered_by').notNull(),
  startedAt: text('started_at').$defaultFn(() => new Date().toISOString()),
  finishedAt: text('finished_at'),
  exitCode: integer('exit_code'),
  status: text('status').notNull().default('pending'),
  stdout: text('stdout').notNull().default(''),
  stderr: text('stderr').notNull().default(''),
  durationMs: real('duration_ms'),
});

// ── Cron Jobs ─────────────────────────────────────────────────────────────────

export const cronJobs = sqliteTable('cron_jobs', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  savedCommandId: text('saved_command_id').references(() => savedCommands.id),
  inlineCommand: text('inline_command'),
  name: text('name').notNull(),
  schedule: text('schedule').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  nextRunAt: text('next_run_at'),
  lastRunAt: text('last_run_at'),
  notify: text('notify').notNull().default('{}'), // JSON
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const cronRuns = sqliteTable('cron_runs', {
  id: text('id').primaryKey(),
  cronJobId: text('cron_job_id')
    .notNull()
    .references(() => cronJobs.id, { onDelete: 'cascade' }),
  scheduledAt: text('scheduled_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  exitCode: integer('exit_code'),
  status: text('status').notNull().default('pending'),
  stdout: text('stdout').notNull().default(''),
  stderr: text('stderr').notNull().default(''),
  durationMs: real('duration_ms'),
});

// ── Monitoring ────────────────────────────────────────────────────────────────

/** Append-only time series of polled vitals. Pruned by the monitor's retention sweep. */
export const serverMetrics = sqliteTable(
  'server_metrics',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    collectedAt: text('collected_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    status: text('status').notNull(), // online | offline | error
    latencyMs: real('latency_ms'),
    uptimeSeconds: real('uptime_seconds'),
    load1: real('load_1'),
    load5: real('load_5'),
    load15: real('load_15'),
    cpuCores: integer('cpu_cores'),
    cpuPercent: real('cpu_percent'),
    // Raw /proc/stat counters — CPU percent is the delta against the prior sample.
    cpuTotalJiffies: real('cpu_total_jiffies'),
    cpuIdleJiffies: real('cpu_idle_jiffies'),
    memTotalKb: real('mem_total_kb'),
    memUsedKb: real('mem_used_kb'),
    swapTotalKb: real('swap_total_kb'),
    swapUsedKb: real('swap_used_kb'),
    diskTotalKb: real('disk_total_kb'),
    diskUsedKb: real('disk_used_kb'),
    processCount: integer('process_count'),
    loggedInUsers: integer('logged_in_users'),
    disks: text('disks'), // JSON array of DiskUsage
    error: text('error'),
  },
  (t) => ({
    serverTimeIdx: index('server_metrics_server_time_idx').on(t.serverId, t.collectedAt),
  }),
);

/** Current state of a server — exactly one row per monitored server, updated in place. */
export const serverHealth = sqliteTable('server_health', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  status: text('status').notNull().default('unknown'), // unknown | online | offline | error | paused
  lastCheckedAt: text('last_checked_at'),
  lastOnlineAt: text('last_online_at'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  latencyMs: real('latency_ms'),
  uptimeSeconds: real('uptime_seconds'),
  cpuPercent: real('cpu_percent'),
  memPercent: real('mem_percent'),
  diskPercent: real('disk_percent'),
  load1: real('load_1'),
  cpuCores: integer('cpu_cores'),
  osName: text('os_name'),
  kernel: text('kernel'),
  hostname: text('hostname'),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/** One row per alert occurrence; `resolvedAt` is set when the condition clears. */
export const serverAlerts = sqliteTable(
  'server_alerts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // offline | cpu_high | memory_high | disk_high | load_high
    severity: text('severity').notNull().default('warning'), // warning | critical
    message: text('message').notNull(),
    value: real('value'),
    threshold: real('threshold'),
    openedAt: text('opened_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    resolvedAt: text('resolved_at'),
    acknowledgedAt: text('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by'),
  },
  (t) => ({
    openIdx: index('server_alerts_open_idx').on(t.serverId, t.type, t.resolvedAt),
  }),
);

// ── AI Providers ──────────────────────────────────────────────────────────────

export const aiProviderConfigs = sqliteTable('ai_provider_configs', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  provider: text('provider').notNull(), // openai | anthropic | openai_compatible
  baseUrl: text('base_url'),
  model: text('model').notNull(),
  encryptedApiKey: text('encrypted_api_key').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── Audit Log ─────────────────────────────────────────────────────────────────

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  actorId: text('actor_id').notNull(),
  actorEmail: text('actor_email').notNull(),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  resourceName: text('resource_name'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  metadata: text('metadata'), // JSON
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
