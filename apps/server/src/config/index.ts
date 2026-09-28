import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SMT_BASE_URL: z.string().url(),
  SMT_ENCRYPTION_KEY: z.string().min(32),
  SMT_SESSION_SECRET: z.string().min(32),
  SMT_PORT: z.coerce.number().default(8080),
  SMT_HOST: z.string().default('0.0.0.0'),
  SMT_DB_URL: z.string().optional(),
  SMT_REDIS_URL: z.string().optional(),
  SMT_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SMT_MAX_SSH_SESSIONS: z.coerce.number().default(5),
  SMT_SFTP_MAX_UPLOAD_BYTES: z.coerce.number().default(1_073_741_824), // 1 GiB
  SMT_STORAGE_MAX_UPLOAD_BYTES: z.coerce.number().default(5_368_709_120), // 5 GiB
  SMT_FTP_MAX_UPLOAD_BYTES: z.coerce.number().default(1_073_741_824), // 1 GiB
  // One SFTP request on a file connection (or a stalled transfer) may take this long
  SMT_SFTP_OP_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  SMT_AI_REQUEST_TIMEOUT: z.coerce.number().default(60_000),

  // ── Outbound email (alert notifications) ──
  SMT_SMTP_URL: z.string().url().optional(), // smtp://user:pass@host:587 or smtps://…:465
  SMT_SMTP_FROM: z.string().min(3).optional(), // "BastionSSH <alerts@example.com>"

  // ── Health monitoring ──
  SMT_MONITORING_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  SMT_MONITORING_INTERVAL: z.coerce.number().min(15).default(60), // seconds between sweeps
  SMT_MONITORING_CONCURRENCY: z.coerce.number().min(1).default(5),
  SMT_MONITORING_TIMEOUT: z.coerce.number().default(20_000),
  SMT_MONITORING_RETENTION_HOURS: z.coerce.number().min(1).default(168), // 7 days
  SMT_ALERT_CPU_PERCENT: z.coerce.number().min(1).max(100).default(90),
  SMT_ALERT_MEMORY_PERCENT: z.coerce.number().min(1).max(100).default(90),
  SMT_ALERT_DISK_PERCENT: z.coerce.number().min(1).max(100).default(90),
  SMT_ALERT_LOAD_PER_CORE: z.coerce.number().min(0.1).default(2),
  /** Consecutive failed checks before a server is alerted as down. */
  SMT_ALERT_OFFLINE_FAILURES: z.coerce.number().min(1).default(2),
  // ── Cloud inventory sync ──
  SMT_CLOUD_SYNC_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  SMT_CLOUD_SYNC_INTERVAL: z.coerce.number().min(5).default(15), // minutes between syncs
  SMT_CLOUD_REQUEST_TIMEOUT: z.coerce.number().default(30_000),
  SMT_WORKER_IN_PROCESS: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),

  SMT_OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  SMT_OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  SMT_OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  SMT_OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),

  SMT_ADMIN_EMAIL: z.string().email().default('ayush.parida@fgshq.com'),
  /** Unset (outside NODE_ENV=development/test) means a random password is generated on first seed. */
  SMT_ADMIN_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  /** Fastify `trustProxy`: false (default), true, a hop count, or a comma-separated IP/CIDR list. */
  SMT_TRUST_PROXY: z.string().optional(),
  SMT_STATIC_DIR: z.string().optional(),

  // ── Passkeys (WebAuthn) ──
  /** Defaults to the hostname of SMT_BASE_URL. Passkeys are bound to it — changing it orphans them. */
  SMT_WEBAUTHN_RP_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  SMT_WEBAUTHN_RP_NAME: z.string().min(1).default('BastionSSH'),
  /** Comma-separated origins allowed to complete a ceremony; defaults to SMT_BASE_URL's origin. */
  SMT_WEBAUTHN_ORIGINS: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

/** The development password; published in docs, so never acceptable in production. */
export const DEV_ADMIN_PASSWORD = 'admin1234';

/**
 * Password for the seeded admin, or null when one must be generated. Only an
 * explicit NODE_ENV=development/test (set by `pnpm dev` and vitest) gets the
 * well-known dev password; anything else — production, or a bare `node
 * dist/index.js` with NODE_ENV unset — would hand out an owner account with it.
 */
export function resolveAdminPassword(
  rawNodeEnv: string | undefined,
  password: string | undefined,
): string | null {
  if (rawNodeEnv === 'development' || rawNodeEnv === 'test') {
    return password ?? DEV_ADMIN_PASSWORD;
  }
  if (!password || password === DEV_ADMIN_PASSWORD) return null;
  return password;
}

/**
 * Parse SMT_TRUST_PROXY into what Fastify's `trustProxy` accepts. Trusting every
 * hop lets any client pick its own req.ip through X-Forwarded-For, which defeats
 * per-IP rate limits and forges audit IPs, so the default trusts none.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/** The Vite dev server (apps/web/vite.config.ts), which proxies /api to this server. */
export const DEV_WEB_ORIGINS = ['http://localhost:5173'];

/**
 * Where passkeys may be created and used. The RP ID is a hostname every
 * allowed origin must sit under; browsers only offer WebAuthn over HTTPS or on
 * localhost.
 */
export function resolveWebauthn(opts: {
  nodeEnv: string | undefined;
  baseUrl: string;
  rpId?: string;
  rpName: string;
  origins?: string;
}): { rpId: string; rpName: string; origins: string[] } {
  const base = new URL(opts.baseUrl);
  const listed = opts.origins
    ?.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    // Compare as origins: a trailing slash or path must not make a valid origin miss
    .map((o) => {
      let url: URL | null = null;
      try {
        url = new URL(o);
      } catch {
        /* reported below */
      }
      if (!url || url.origin === 'null') {
        throw new Error(`SMT_WEBAUTHN_ORIGINS: "${o}" is not an origin (expected e.g. https://ssh.example.com)`);
      }
      return url.origin;
    });
  const origins = listed?.length ? listed : [base.origin];
  if (!listed?.length && opts.nodeEnv === 'development') origins.push(...DEV_WEB_ORIGINS);
  return {
    rpId: opts.rpId?.trim() || base.hostname,
    rpName: opts.rpName,
    origins: [...new Set(origins)],
  };
}

let webauthn: ReturnType<typeof resolveWebauthn>;
try {
  webauthn = resolveWebauthn({
    nodeEnv: env.NODE_ENV,
    baseUrl: env.SMT_BASE_URL,
    rpId: env.SMT_WEBAUTHN_RP_ID,
    rpName: env.SMT_WEBAUTHN_RP_NAME,
    origins: env.SMT_WEBAUTHN_ORIGINS,
  });
} catch (err) {
  console.error(`Invalid environment variables: ${(err as Error).message}`);
  process.exit(1);
}

if (env.SMT_SMTP_URL && !env.SMT_SMTP_FROM) {
  console.error('Invalid environment variables: SMT_SMTP_FROM is required when SMT_SMTP_URL is set');
  process.exit(1);
}

export const config = {
  env: env.NODE_ENV,
  baseUrl: env.SMT_BASE_URL,
  encryptionKey: env.SMT_ENCRYPTION_KEY,
  sessionSecret: env.SMT_SESSION_SECRET,
  port: env.SMT_PORT,
  host: env.SMT_HOST,
  dbUrl: env.SMT_DB_URL,
  redisUrl: env.SMT_REDIS_URL,
  logLevel: env.SMT_LOG_LEVEL,
  maxSshSessions: env.SMT_MAX_SSH_SESSIONS,
  sftpMaxUploadBytes: env.SMT_SFTP_MAX_UPLOAD_BYTES,
  storageMaxUploadBytes: env.SMT_STORAGE_MAX_UPLOAD_BYTES,
  ftpMaxUploadBytes: env.SMT_FTP_MAX_UPLOAD_BYTES,
  sftpOpTimeoutMs: env.SMT_SFTP_OP_TIMEOUT_MS,
  aiRequestTimeout: env.SMT_AI_REQUEST_TIMEOUT,
  /** null = email delivery unavailable; the notifications UI says so. */
  smtp: env.SMT_SMTP_URL ? { url: env.SMT_SMTP_URL, from: env.SMT_SMTP_FROM ?? '' } : null,
  monitoring: {
    enabled: env.SMT_MONITORING_ENABLED,
    intervalSeconds: env.SMT_MONITORING_INTERVAL,
    concurrency: env.SMT_MONITORING_CONCURRENCY,
    timeoutMs: env.SMT_MONITORING_TIMEOUT,
    retentionHours: env.SMT_MONITORING_RETENTION_HOURS,
    thresholds: {
      cpuPercent: env.SMT_ALERT_CPU_PERCENT,
      memoryPercent: env.SMT_ALERT_MEMORY_PERCENT,
      diskPercent: env.SMT_ALERT_DISK_PERCENT,
      loadPerCore: env.SMT_ALERT_LOAD_PER_CORE,
      offlineFailures: env.SMT_ALERT_OFFLINE_FAILURES,
    },
  },
  cloudSync: {
    enabled: env.SMT_CLOUD_SYNC_ENABLED,
    intervalMinutes: env.SMT_CLOUD_SYNC_INTERVAL,
    timeoutMs: env.SMT_CLOUD_REQUEST_TIMEOUT,
  },
  workerInProcess: env.SMT_WORKER_IN_PROCESS,
  staticDir: env.SMT_STATIC_DIR,
  adminEmail: env.SMT_ADMIN_EMAIL,
  // The raw value: the schema defaults NODE_ENV to development, which must not
  // unlock the dev password for an install that simply never set it.
  adminPassword: resolveAdminPassword(process.env.NODE_ENV, env.SMT_ADMIN_PASSWORD),
  trustProxy: parseTrustProxy(env.SMT_TRUST_PROXY),
  webauthn,
  oauth: {
    google:
      env.SMT_OAUTH_GOOGLE_CLIENT_ID && env.SMT_OAUTH_GOOGLE_CLIENT_SECRET
        ? {
            clientId: env.SMT_OAUTH_GOOGLE_CLIENT_ID,
            clientSecret: env.SMT_OAUTH_GOOGLE_CLIENT_SECRET,
          }
        : null,
    github:
      env.SMT_OAUTH_GITHUB_CLIENT_ID && env.SMT_OAUTH_GITHUB_CLIENT_SECRET
        ? {
            clientId: env.SMT_OAUTH_GITHUB_CLIENT_ID,
            clientSecret: env.SMT_OAUTH_GITHUB_CLIENT_SECRET,
          }
        : null,
  },
} as const;

export type Config = typeof config;
