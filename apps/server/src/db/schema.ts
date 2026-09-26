import { sqliteTable, text, integer, real, blob, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  // Bumped at most once a minute by requireAuth, so it is "last active", not "last request"
  lastSeenAt: text('last_seen_at'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  // The org this browser is working in; null or stale falls back to the first active membership
  activeOrgId: text('active_org_id').references(() => organizations.id, { onDelete: 'set null' }),
  // Signed in (or stepped up) with a passkey. Orgs that require passkeys refuse sessions without it.
  passkeyVerified: integer('passkey_verified', { mode: 'boolean' }).notNull().default(false),
});

/** WebAuthn credentials. Discoverable and user-verifying, so one alone is a full sign-in. */
export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // base64url, as the browser reports it
    credentialId: text('credential_id').notNull().unique(),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports').notNull().default('[]'), // JSON array
    deviceType: text('device_type').notNull(), // singleDevice | multiDevice
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
    name: text('name').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    lastUsedAt: text('last_used_at'),
  },
  (t) => ({
    userIdx: index('passkeys_user_idx').on(t.userId),
  }),
);

/**
 * Outstanding WebAuthn challenges, deleted on use and short-lived. A
 * `second_factor` row is also the pending-login ticket issued after a correct
 * password; only the ticket's hash is kept.
 */
export const webauthnChallenges = sqliteTable(
  'webauthn_challenges',
  {
    id: text('id').primaryKey(),
    challenge: text('challenge').notNull(),
    purpose: text('purpose').notNull(), // register | login | second_factor | step_up
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // publicSessionId() of the session that asked, for register and step_up
    sessionHash: text('session_hash'),
    ticketHash: text('ticket_hash').unique(),
    // Wrong backup codes tried against a `second_factor` ticket; it is dropped at the limit
    attempts: integer('attempts').notNull().default(0),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    expiresIdx: index('webauthn_challenges_expires_idx').on(t.expiresAt),
  }),
);

/**
 * One-time recovery codes that stand in for a passkey after a correct
 * password. Only an HMAC of each code is stored; a set is replaced whole.
 */
export const backupCodes = sqliteTable(
  'backup_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    usedAt: text('used_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    userIdx: index('backup_codes_user_idx').on(t.userId),
  }),
);

/** One-time, admin-issued links that let a user set a new password. Only the hash is stored. */
export const passwordResets = sqliteTable('password_resets', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // The org whose admin issued it — where issuing and redeeming are audited
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
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
  // Minted from a passkey-verified session. Orgs that require passkeys refuse tokens without it.
  passkeyVerified: integer('passkey_verified', { mode: 'boolean' }).notNull().default(false),
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
  // Members must sign in with a passkey before their session may act here
  requirePasskey: integer('require_passkey', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const memberships = sqliteTable(
  'memberships',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('viewer'), // owner | admin | operator | viewer
    status: text('status').notNull().default('active'), // active | suspended
    suspendedAt: text('suspended_at'),
    suspendedBy: text('suspended_by'),
    // 'restricted' limits operators and viewers to the servers in member_server_access;
    // owners and admins always see every server regardless.
    serverAccess: text('server_access').notNull().default('all'), // all | restricted
    joinedAt: text('joined_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    userOrgIdx: uniqueIndex('memberships_user_org_idx').on(t.userId, t.orgId),
  }),
);

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

// ── Cloud Accounts ────────────────────────────────────────────────────────────

/** One provider credential (AWS key pair, DO / Hetzner token) whose instances are synced into `servers`. */
export const cloudAccounts = sqliteTable(
  'cloud_accounts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(), // aws | digitalocean | hetzner
    encryptedCredentials: text('encrypted_credentials').notNull(), // vault-encrypted JSON
    credentialHint: text('credential_hint').notNull(), // masked, safe to show
    regions: text('regions').notNull().default('[]'), // JSON array, aws only; [] = discover
    defaultUsername: text('default_username').notNull().default('root'),
    defaultKeyId: text('default_key_id').references(() => sshKeys.id, { onDelete: 'set null' }),
    autoImport: integer('auto_import', { mode: 'boolean' }).notNull().default(true),
    syncEnabled: integer('sync_enabled', { mode: 'boolean' }).notNull().default(true),
    lastSyncAt: text('last_sync_at'),
    lastStatus: text('last_status'), // ok | failed
    lastError: text('last_error'),
    lastSummary: text('last_summary'), // JSON SyncSummary
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    orgIdx: index('cloud_accounts_org_idx').on(t.orgId),
  }),
);

// ── Servers ───────────────────────────────────────────────────────────────────

export const servers = sqliteTable(
  'servers',
  {
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
    // Set when the row was imported from a cloud account. The account link is
    // dropped when the account is deleted; the server itself stays.
    cloudAccountId: text('cloud_account_id').references(() => cloudAccounts.id, {
      onDelete: 'set null',
    }),
    cloudProvider: text('cloud_provider'), // aws | digitalocean | hetzner
    cloudInstanceId: text('cloud_instance_id'),
    cloudRegion: text('cloud_region'),
    cloudState: text('cloud_state'), // running | stopped | other | missing
    cloudSyncedAt: text('cloud_synced_at'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    cloudInstanceIdx: uniqueIndex('servers_cloud_instance_idx').on(t.cloudAccountId, t.cloudInstanceId),
  }),
);

/** Servers a `restricted` member may use. Meaningless while their membership is `all`. */
export const memberServerAccess = sqliteTable(
  'member_server_access',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    memberServerIdx: uniqueIndex('member_server_access_idx').on(t.orgId, t.userId, t.serverId),
    serverIdx: index('member_server_access_server_idx').on(t.serverId),
  }),
);

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

// ── Notification Channels ─────────────────────────────────────────────────────

export const notificationChannels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // webhook | slack
  // Webhook URLs carry their own auth secret, so they are vaulted like passwords.
  encryptedUrl: text('encrypted_url').notNull(),
  // Host + leading path only, safe to show in the UI
  targetHint: text('target_hint').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  minSeverity: text('min_severity').notNull().default('warning'), // warning | critical
  notifyOnResolve: integer('notify_on_resolve', { mode: 'boolean' }).notNull().default(true),
  lastStatus: text('last_status'), // ok | failed
  lastError: text('last_error'),
  lastSentAt: text('last_sent_at'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── Object Storage ───────────────────────────────────────────────────────────

/** An S3-compatible endpoint plus one access-key pair. Covers AWS S3, MinIO, and friends. */
export const storageConnections = sqliteTable(
  'storage_connections',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull().default('s3'), // s3 | minio | other
    endpoint: text('endpoint'), // null = AWS regional endpoint
    region: text('region').notNull().default('us-east-1'),
    accessKeyId: text('access_key_id').notNull(),
    encryptedSecretAccessKey: text('encrypted_secret_access_key').notNull(),
    forcePathStyle: integer('force_path_style', { mode: 'boolean' }).notNull().default(false),
    lastStatus: text('last_status'), // ok | failed
    lastError: text('last_error'),
    lastTestedAt: text('last_tested_at'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    orgIdx: index('storage_connections_org_idx').on(t.orgId),
  }),
);

export const ftpConnections = sqliteTable(
  'ftp_connections',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(21),
    protocol: text('protocol').notNull().default('ftps'), // ftp | ftps | ftps-implicit
    username: text('username').notNull(),
    encryptedPassword: text('encrypted_password').notNull(),
    verifyTls: integer('verify_tls', { mode: 'boolean' }).notNull().default(true),
    rootPath: text('root_path'), // null = the account's login directory
    lastStatus: text('last_status'), // ok | failed
    lastError: text('last_error'),
    lastTestedAt: text('last_tested_at'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    orgIdx: index('ftp_connections_org_idx').on(t.orgId),
  }),
);

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
