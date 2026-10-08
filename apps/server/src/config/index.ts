import { isIP } from 'node:net';
import { z } from 'zod';
import path from 'path';
import { defaultBackupDir } from '../backup/files.js';

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
  // Largest image archive (`docker save`, plain or compressed) Docker → Upload image takes
  SMT_DOCKER_IMAGE_UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).default(5_368_709_120), // 5 GiB
  // One SFTP request on a file connection (or a stalled transfer) may take this long
  SMT_SFTP_OP_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  // A folder download (zip / tar.gz from any file viewer) stops here and ends with _TRUNCATED.txt
  SMT_FOLDER_DOWNLOAD_MAX_BYTES: z.coerce.number().int().min(1).default(10_737_418_240), // 10 GiB
  SMT_FOLDER_DOWNLOAD_MAX_FILES: z.coerce.number().int().min(1).default(100_000),
  SMT_AI_REQUEST_TIMEOUT: z.coerce.number().default(60_000),

  // ── Outbound email (alert notifications) ──
  // Blank counts as unset, so docker compose can pass them through as `${SMT_SMTP_URL:-}`
  SMT_SMTP_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()), // smtp://user:pass@host:587 or smtps://…:465
  SMT_SMTP_FROM: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(3).optional()), // "BastionSSH <alerts@example.com>"

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
  // ── App database backups ──
  /** Default: backups/ next to the database (/data/backups). */
  SMT_BACKUP_DIR: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  SMT_BACKUP_INTERVAL_HOURS: z.coerce.number().min(0).default(24), // 0 = no scheduled backups
  SMT_BACKUP_KEEP: z.coerce.number().int().min(1).default(14), // newest kept per reason
  SMT_BACKUP_GZIP: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  SMT_BACKUP_PRE_MIGRATION: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  /** Copy each scheduled/manual backup to this object-storage connection too. */
  SMT_BACKUP_STORAGE_CONNECTION_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  SMT_BACKUP_STORAGE_BUCKET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  SMT_BACKUP_STORAGE_PREFIX: z.string().default('bastionssh-backups/'),
  // ── Session recording ──
  /** Where terminal recordings (asciicast v2, gzipped once a session ends) are kept. */
  SMT_RECORDINGS_DIR: z.string().min(1).default('/data/recordings'),
  /** Per-recording cap on the uncompressed cast; the rest of a longer session is not recorded. */
  SMT_RECORDING_MAX_BYTES: z.coerce.number().min(4096).default(52_428_800), // 50 MiB
  SMT_WORKER_IN_PROCESS: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),

  SMT_ADMIN_EMAIL: z.string().email().default('ayush.parida@fgshq.com'),
  /** Unset (outside NODE_ENV=development/test) means a random password is generated on first seed. */
  SMT_ADMIN_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  /** Fastify `trustProxy`: false (default), true, a hop count, or a comma-separated IP/CIDR list. */
  SMT_TRUST_PROXY: z.string().optional(),
  SMT_STATIC_DIR: z.string().optional(),
  /**
   * This app's public IP, shown in connectivity diagnostics as the source a
   * firewall must allow. Unset = look it up; an IP = use it; `off` = never look up.
   */
  SMT_EGRESS_IP: z.string().optional(),
  /** Comma-separated https URLs that answer with the caller's IP as plain text. */
  SMT_EGRESS_IP_SERVICES: z.string().optional(),

  // ── Passkeys (WebAuthn) ──
  /** Defaults to the hostname of SMT_BASE_URL. Passkeys are bound to it — changing it orphans them. */
  SMT_WEBAUTHN_RP_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  SMT_WEBAUTHN_RP_NAME: z.string().min(1).default('BastionSSH'),
  /** Comma-separated origins allowed to complete a ceremony; defaults to SMT_BASE_URL's origin. */
  SMT_WEBAUTHN_ORIGINS: z.string().optional(),

  // ── Builds on the BastionSSH side (build.where: bastion) ──
  /** The BuildKit daemon (`tcp://buildkit:1234` in docker-compose.yml). Unset: builds happen on the servers only. */
  SMT_BUILDKIT_ADDR: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^(tcp|unix):\/\/\S+$/).optional()),
  /** A folder with ca.pem, cert.pem and key.pem when the builder takes mTLS (optional: its network is private to BastionSSH). */
  SMT_BUILDKIT_TLS_DIR: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** The pinned buildctl binary (in the image: /usr/local/bin/buildctl). */
  SMT_BUILDCTL_PATH: z.string().min(1).default('buildctl'),
  /** Largest unpacked upload a build takes. */
  SMT_BUILD_MAX_CONTEXT_BYTES: z.coerce.number().int().min(1).default(1_073_741_824), // 1 GiB
  /** A build (with the image's transfer) is cut off after this. */
  SMT_BUILD_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30 * 60_000),
  /** Where uploads are unpacked for the length of their build (default: a folder in the OS temp dir). */
  SMT_BUILD_WORK_DIR: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Builds waiting their turn beyond this are refused (one runs at a time). */
  SMT_BUILD_QUEUE_MAX: z.coerce.number().int().min(1).default(20),

  // ── Audit log forwarding ──
  /**
   * Comma-separated IPs/CIDRs a syslog or webhook target may resolve to even
   * though they are private or loopback (e.g. a collector on the LAN). Empty
   * means only public addresses.
   */
  SMT_AUDIT_FORWARD_ALLOW_NETS: z.string().optional(),
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

export const DEFAULT_EGRESS_IP_SERVICES = ['https://api.ipify.org', 'https://ifconfig.me/ip'];

export type EgressIpConfig =
  | { mode: 'lookup'; services: string[] }
  | { mode: 'fixed'; ip: string }
  | { mode: 'disabled' };

/**
 * Parse SMT_EGRESS_IP / SMT_EGRESS_IP_SERVICES. Anything but an IP address or
 * an explicit off switch is a configuration mistake worth refusing at startup
 * rather than a remediation hint that tells users to allow the wrong address.
 */
export function parseEgressIp(raw: string | undefined, rawServices: string | undefined): EgressIpConfig {
  const value = raw?.trim();
  if (value && ['off', 'false', 'none', 'disabled'].includes(value.toLowerCase())) {
    return { mode: 'disabled' };
  }
  if (value) {
    if (isIP(value) === 0) throw new Error(`SMT_EGRESS_IP: "${value}" is not an IP address (or "off")`);
    return { mode: 'fixed', ip: value };
  }
  const services = rawServices
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let url: URL | null = null;
      try {
        url = new URL(s);
      } catch {
        /* reported below */
      }
      if (!url || url.protocol !== 'https:') {
        throw new Error(`SMT_EGRESS_IP_SERVICES: "${s}" is not an https URL`);
      }
      return url.toString();
    });
  return { mode: 'lookup', services: services?.length ? services : DEFAULT_EGRESS_IP_SERVICES };
}

/**
 * Parse SMT_AUDIT_FORWARD_ALLOW_NETS into [address, prefix length] pairs. A bare
 * address is a single host. Throws on anything that is not an IP or CIDR.
 */
export function parseAllowNets(raw: string | undefined): { address: string; prefix: number; family: 4 | 6 }[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [address = '', bits] = entry.split('/');
      const family = isIP(address);
      const max = family === 6 ? 128 : 32;
      const prefix = bits === undefined ? max : Number(bits);
      if (!family || !/^\d+$/.test(bits ?? String(max)) || prefix < 0 || prefix > max) {
        throw new Error(`SMT_AUDIT_FORWARD_ALLOW_NETS: "${entry}" is not an IP address or CIDR`);
      }
      return { address, prefix, family: family as 4 | 6 };
    });
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

let egressIp: EgressIpConfig;
try {
  egressIp = parseEgressIp(env.SMT_EGRESS_IP, env.SMT_EGRESS_IP_SERVICES);
} catch (err) {
  console.error(`Invalid environment variables: ${(err as Error).message}`);
  process.exit(1);
}

let auditForwardAllowNets: ReturnType<typeof parseAllowNets>;
try {
  auditForwardAllowNets = parseAllowNets(env.SMT_AUDIT_FORWARD_ALLOW_NETS);
} catch (err) {
  console.error(`Invalid environment variables: ${(err as Error).message}`);
  process.exit(1);
}

if (env.SMT_BACKUP_STORAGE_CONNECTION_ID && !env.SMT_BACKUP_STORAGE_BUCKET) {
  console.error('Invalid environment variables: SMT_BACKUP_STORAGE_BUCKET is required when SMT_BACKUP_STORAGE_CONNECTION_ID is set');
  process.exit(1);
}

const dbPath = env.SMT_DB_URL ?? path.join('/data', 'smt.db');

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
  dockerImageUploadMaxBytes: env.SMT_DOCKER_IMAGE_UPLOAD_MAX_BYTES,
  sftpOpTimeoutMs: env.SMT_SFTP_OP_TIMEOUT_MS,
  folderDownload: {
    maxBytes: env.SMT_FOLDER_DOWNLOAD_MAX_BYTES,
    maxFiles: env.SMT_FOLDER_DOWNLOAD_MAX_FILES,
  },
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
  backup: {
    dir: env.SMT_BACKUP_DIR ?? defaultBackupDir(dbPath),
    intervalHours: env.SMT_BACKUP_INTERVAL_HOURS,
    keep: env.SMT_BACKUP_KEEP,
    gzip: env.SMT_BACKUP_GZIP,
    preMigration: env.SMT_BACKUP_PRE_MIGRATION,
    storage:
      env.SMT_BACKUP_STORAGE_CONNECTION_ID && env.SMT_BACKUP_STORAGE_BUCKET
        ? {
            connectionId: env.SMT_BACKUP_STORAGE_CONNECTION_ID,
            bucket: env.SMT_BACKUP_STORAGE_BUCKET,
            prefix: env.SMT_BACKUP_STORAGE_PREFIX,
          }
        : null,
  },
  recordings: {
    dir: env.SMT_RECORDINGS_DIR,
    maxBytes: env.SMT_RECORDING_MAX_BYTES,
  },
  auditForward: { allowNets: auditForwardAllowNets },
  builder: {
    addr: env.SMT_BUILDKIT_ADDR ?? null,
    tlsDir: env.SMT_BUILDKIT_TLS_DIR ?? null,
    buildctl: env.SMT_BUILDCTL_PATH,
    maxContextBytes: env.SMT_BUILD_MAX_CONTEXT_BYTES,
    timeoutMs: env.SMT_BUILD_TIMEOUT_MS,
    workDir: env.SMT_BUILD_WORK_DIR ?? null,
    queueMax: env.SMT_BUILD_QUEUE_MAX,
  },
  workerInProcess: env.SMT_WORKER_IN_PROCESS,
  staticDir: env.SMT_STATIC_DIR,
  adminEmail: env.SMT_ADMIN_EMAIL,
  // The raw value: the schema defaults NODE_ENV to development, which must not
  // unlock the dev password for an install that simply never set it.
  adminPassword: resolveAdminPassword(process.env.NODE_ENV, env.SMT_ADMIN_PASSWORD),
  trustProxy: parseTrustProxy(env.SMT_TRUST_PROXY),
  webauthn,
  egressIp,
} as const;

export type Config = typeof config;
