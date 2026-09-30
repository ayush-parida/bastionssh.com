import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

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
  // Signed in through this org's single sign-on. Such a session only works in that org.
  ssoProviderId: text('sso_provider_id').references((): AnySQLiteColumn => ssoProviders.id, { onDelete: 'cascade' }),
  // Signed in with a backup code and not yet stepped up with a passkey. In an org
  // with backupCodeRecoveryOnly it may only enroll a passkey and verify with it.
  recoveryOnly: integer('recovery_only', { mode: 'boolean' }).notNull().default(false),
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

/**
 * Devices an account has signed in from: the browser/OS family plus the
 * client's /24 (IPv6 /48), hashed. A sign-in from a new one emails the owner.
 */
export const userDevices = sqliteTable(
  'user_devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceHash: text('device_hash').notNull(),
    label: text('label').notNull(), // "Firefox on Linux"
    ipPrefix: text('ip_prefix').notNull(), // 203.0.113.0/24
    firstSeenAt: text('first_seen_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    lastSeenAt: text('last_seen_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    userHashIdx: uniqueIndex('user_devices_user_hash_idx').on(t.userId, t.deviceHash),
  }),
);

/**
 * Failed password sign-ins per account. Keyed by an HMAC of the email typed,
 * not the user id, so an address with no account locks the same way.
 */
export const loginFailures = sqliteTable('login_failures', {
  accountKey: text('account_key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStartedAt: text('window_started_at').notNull(),
  // Password sign-in is refused until then; a passkey sign-in still works and clears it
  lockedUntil: text('locked_until'),
  // Locks in a row, for the exponential backoff; forgotten after a quiet day
  lockouts: integer('lockouts').notNull().default(0),
  lastFailureAt: text('last_failure_at').notNull(),
  // Last time the owner was emailed about it
  notifiedAt: text('notified_at'),
});

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
  // Session recording policy: terminals and one-shot command runs are recorded
  // unless switched off; keystrokes only when opted in, since they include passwords.
  recordingEnabled: integer('recording_enabled', { mode: 'boolean' }).notNull().default(true),
  recordingInput: integer('recording_input', { mode: 'boolean' }).notNull().default(false),
  recordingRetentionDays: integer('recording_retention_days').notNull().default(90),
  // Restricted members may see the names (only) of servers they cannot use, to ask for access
  restrictedSeeServerNames: integer('restricted_see_server_names', { mode: 'boolean' }).notNull().default(true),
  // Longest access a member may request, in minutes
  accessRequestMaxMinutes: integer('access_request_max_minutes').notNull().default(480),
  // Audit rows older than this are pruned by the daily maintenance job
  auditRetentionDays: integer('audit_retention_days').notNull().default(365),
  // A backup-code sign-in may only enroll a passkey until it verifies with one
  backupCodeRecoveryOnly: integer('backup_code_recovery_only', { mode: 'boolean' }).notNull().default(true),
  // Docker permissions JSON {operatorsCanExec, operatorsCanRemove, allowPrune, containerAlerts}; null = defaults (docker/settings.ts)
  dockerSettings: text('docker_settings'),
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

// ── Single sign-on (OpenID Connect) ──────────────────────────────────────────

/** An org's OIDC identity provider. One per org; the client secret is vault-encrypted. */
export const ssoProviders = sqliteTable('sso_providers', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('generic'), // google | microsoft | okta | generic — a UI preset only
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  encryptedClientSecret: text('encrypted_client_secret').notNull(),
  allowedDomains: text('allowed_domains').notNull().default('[]'), // JSON array of lower-case domains
  // Role for accounts created on first sign-in; never owner
  defaultRole: text('default_role').notNull().default('viewer'),
  autoProvision: integer('auto_provision', { mode: 'boolean' }).notNull().default(false),
  // Members other than owners must sign in here; password and passkey sign-in stop working for them
  enforceSso: integer('enforce_sso', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // Count phishing-resistant MFA the IdP reports in `amr` as a passkey sign-in
  trustIdpMfa: integer('trust_idp_mfa', { mode: 'boolean' }).notNull().default(false),
  groupsClaim: text('groups_claim'),
  roleMappings: text('role_mappings').notNull().default('[]'), // JSON [{ group, role }]
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/** A user's identity at a provider, keyed by the IdP's stable subject rather than the email. */
export const userIdentities = sqliteTable(
  'user_identities',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => ssoProviders.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The address it was linked with, for display and audit
    email: text('email').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    lastLoginAt: text('last_login_at'),
  },
  (t) => ({
    providerSubjectIdx: uniqueIndex('user_identities_provider_subject_unique').on(t.providerId, t.subject),
    providerUserIdx: uniqueIndex('user_identities_provider_user_unique').on(t.providerId, t.userId),
    userIdx: index('user_identities_user_idx').on(t.userId),
  }),
);

/** Sign-ins handed to a provider and not yet back. Deleted on use; only the state's hash is kept. */
export const ssoLoginStates = sqliteTable(
  'sso_login_states',
  {
    stateHash: text('state_hash').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => ssoProviders.id, { onDelete: 'cascade' }),
    // PKCE verifier, vault-encrypted with the state hash as its resource id
    encryptedCodeVerifier: text('encrypted_code_verifier').notNull(),
    nonce: text('nonce').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    expiresIdx: index('sso_login_states_expires_idx').on(t.expiresAt),
  }),
);

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
  // Set by a key rotation once no server uses the key any more. A retired key
  // cannot be assigned to a server again; it may be deleted.
  retiredAt: text('retired_at'),
  // The key this one replaced, when it was created by a rotation. No FK: the
  // old key may be deleted once retired.
  rotatedFromKeyId: text('rotated_from_key_id'),
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

// ── Connectivity agents ───────────────────────────────────────────────────────

/**
 * Outbound agents installed on hosts the app cannot reach directly. An agent
 * dials in over a WebSocket and tunnels SSH to its own loopback (agents/).
 * Only the token's hash is stored; a revoked agent is kept for the record.
 */
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    lastSeenAt: text('last_seen_at'),
    version: text('version'), // reported by the agent when it connects
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    revokedAt: text('revoked_at'),
  },
  (t) => ({
    orgIdx: index('agents_org_idx').on(t.orgId),
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
    // Pinned SSH host key. All null = nothing pinned, so the next connection
    // trusts what it sees (TOFU). See ssh/host-keys.ts.
    hostKeyFingerprint: text('host_key_fingerprint'), // SHA256:<base64, no padding>
    hostKeyType: text('host_key_type'), // ssh-ed25519 | ssh-rsa | ecdsa-sha2-nistp256 …
    hostKeyTrustedAt: text('host_key_trusted_at'),
    hostKeyTrustedBy: text('host_key_trusted_by'), // user id; null = trust on first use
    // Last different key the host presented; kept until an admin accepts, pins or forgets.
    hostKeyMismatchFingerprint: text('host_key_mismatch_fingerprint'),
    hostKeyMismatchType: text('host_key_mismatch_type'),
    hostKeyMismatchAt: text('host_key_mismatch_at'),
    // Reach this server through another one in the same org (ssh -J). Chains
    // are limited and cycle-free; see ssh/jump.ts. Deleting the jump host
    // makes the servers behind it direct again.
    jumpServerId: text('jump_server_id').references((): AnySQLiteColumn => servers.id, {
      onDelete: 'set null',
    }),
    // Reached through this agent's tunnel (to its loopback, on `port`) instead
    // of a direct TCP connection to `host`.
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    // Docker over the SSH connection (see docker/). 'off' hides it and refuses
    // its routes. The socket path is an admin override; the rest is what the
    // last successful probe found, cleared when the override changes.
    dockerMode: text('docker_mode').notNull().default('auto'), // auto | off
    dockerSocketPath: text('docker_socket_path'),
    dockerTransport: text('docker_transport'), // streamlocal | dial-stdio
    dockerDetectedSocketPath: text('docker_detected_socket_path'),
    dockerDetectedAt: text('docker_detected_at'),
    dockerVersion: text('docker_version'),
    dockerApiVersion: text('docker_api_version'),
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
    jumpServerIdx: index('servers_jump_server_idx').on(t.jumpServerId),
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
    // Null = permanent. Past = no longer counts; the expiry sweep deletes it.
    expiresAt: text('expires_at'),
    grantedBy: text('granted_by'), // user id; null for grants that predate tracking
    reason: text('reason'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    memberServerIdx: uniqueIndex('member_server_access_idx').on(t.orgId, t.userId, t.serverId),
    serverIdx: index('member_server_access_server_idx').on(t.serverId),
    expiresIdx: index('member_server_access_expires_idx').on(t.expiresAt),
  }),
);

/** A restricted member asking for time-bound access to some servers. */
export const accessRequests = sqliteTable(
  'access_requests',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverIds: text('server_ids').notNull(), // JSON array
    reason: text('reason').notNull(),
    durationMinutes: integer('duration_minutes').notNull(), // as requested
    status: text('status').notNull().default('pending'), // pending | approved | denied | expired | cancelled
    approvedMinutes: integer('approved_minutes'), // may be shorter than requested
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    decisionNote: text('decision_note'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    // Pending: when the request lapses undecided. Approved: when the granted access ends.
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({
    orgStatusIdx: index('access_requests_org_status_idx').on(t.orgId, t.status),
    userIdx: index('access_requests_user_idx').on(t.userId),
  }),
);

/**
 * One SSH key rotation on one server (see ssh/key-rotation.ts). Kept after the
 * server is deleted, as history; key ids are not foreign keys for the same reason.
 */
export const keyRotations = sqliteTable(
  'key_rotations',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    batchId: text('batch_id'), // shared by the rotations of one bulk request
    serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
    serverName: text('server_name').notNull(),
    oldKeyId: text('old_key_id').notNull(),
    oldFingerprint: text('old_fingerprint').notNull(),
    newKeyId: text('new_key_id'), // null until the new key is saved; stays null when rolled back
    newFingerprint: text('new_fingerprint'),
    status: text('status').notNull().default('pending'), // pending | running | completed | rolled_back | failed | interrupted
    step: text('step'), // the step reached, or the one that failed
    error: text('error'),
    warnings: text('warnings').notNull().default('[]'), // JSON array of strings
    oldKeyRetired: integer('old_key_retired', { mode: 'boolean' }).notNull().default(false),
    startedBy: text('started_by').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    finishedAt: text('finished_at'),
  },
  (t) => ({
    orgIdx: index('key_rotations_org_idx').on(t.orgId, t.createdAt),
    serverIdx: index('key_rotations_server_idx').on(t.serverId, t.status),
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
    type: text('type').notNull(), // offline | cpu_high | memory_high | disk_high | load_high | host_key_mismatch | container_unhealthy | container_restarting | container_exited
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
    protocol: text('protocol').notNull().default('ftps'), // ftp | ftps | ftps-implicit | sftp
    username: text('username').notNull(),
    encryptedPassword: text('encrypted_password').notNull(), // '' when authMethod = key
    verifyTls: integer('verify_tls', { mode: 'boolean' }).notNull().default(true),
    rootPath: text('root_path'), // null = the account's login directory
    // Confine every path to rootPath (or the login directory). Off for rows that
    // predate the option; the API defaults it on for new connections.
    restrictToRoot: integer('restrict_to_root', { mode: 'boolean' }).notNull().default(false),
    authMethod: text('auth_method').notNull().default('password'), // password | key (SFTP only)
    // The org SSH key used when authMethod = key
    sshKeyId: text('ssh_key_id').references(() => sshKeys.id),
    // SFTP only — pinned SSH host key; null = trust on first use (see ssh/host-keys.ts)
    hostKeyFingerprint: text('host_key_fingerprint'), // SHA256:<base64, no padding>
    hostKeyType: text('host_key_type'),
    hostKeyTrustedAt: text('host_key_trusted_at'),
    // A different key the host presented; connections are refused while set
    hostKeyMismatchFingerprint: text('host_key_mismatch_fingerprint'),
    hostKeyMismatchAt: text('host_key_mismatch_at'),
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

// ── Session Recordings ────────────────────────────────────────────────────────

/**
 * A recorded terminal session or one-shot command run. The cast (asciicast v2)
 * lives on disk under SMT_RECORDINGS_DIR at `file_path`, relative to it; it is
 * gzipped once the session ends. Pruned after the org's retention period.
 */
export const sessionRecordings = sqliteTable(
  'session_recordings',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // Kept when the server is deleted — the recording is the record of what happened
    serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
    serverName: text('server_name'),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull().default('terminal'), // terminal | exec
    source: text('source'), // exec only: ai | saved_command
    command: text('command'), // exec only; a saved command's template, never its variables
    startedAt: text('started_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    endedAt: text('ended_at'), // null while live
    bytes: integer('bytes').notNull().default(0), // uncompressed cast size
    filePath: text('file_path').notNull(),
    inputRecorded: integer('input_recorded', { mode: 'boolean' }).notNull().default(false),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    cols: integer('cols').notNull().default(80),
    rows: integer('rows').notNull().default(24),
  },
  (t) => ({
    orgStartedIdx: index('session_recordings_org_started_idx').on(t.orgId, t.startedAt),
    serverIdx: index('session_recordings_server_idx').on(t.serverId),
    userIdx: index('session_recordings_user_idx').on(t.userId),
  }),
);

/** Commands run over a live terminal's SSH connection (the AI agent), logged against its recording. */
export const sessionRecordingCommands = sqliteTable(
  'session_recording_commands',
  {
    id: text('id').primaryKey(),
    recordingId: text('recording_id')
      .notNull()
      .references(() => sessionRecordings.id, { onDelete: 'cascade' }),
    at: real('at').notNull(), // seconds from the start of the recording
    source: text('source').notNull(), // ai | saved_command
    command: text('command').notNull(),
    exitCode: integer('exit_code'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    recordingIdx: index('session_recording_commands_recording_idx').on(t.recordingId),
  }),
);

// ── Audit Log ─────────────────────────────────────────────────────────────────

export const auditLog = sqliteTable(
  'audit_log',
  {
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
  },
  (t) => ({
    orgCreatedIdx: index('audit_log_org_created_idx').on(t.orgId, t.createdAt),
  }),
);

/**
 * Where an org's new audit rows are copied to: a syslog collector (RFC 5424)
 * or a webhook. The target and any secret live in the vaulted config. The
 * cursor is the last row delivered, by (created_at, rowid).
 */
export const auditForwarders = sqliteTable('audit_forwarders', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // syslog | webhook
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  encryptedConfig: text('encrypted_config').notNull(), // JSON, see audit/forward.ts
  // Protocol + host (or the masked URL) only, safe to show in the UI
  targetHint: text('target_hint').notNull(),
  cursorCreatedAt: text('cursor_created_at').notNull(),
  cursorRowid: integer('cursor_rowid').notNull().default(0),
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
