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
  SMT_AI_REQUEST_TIMEOUT: z.coerce.number().default(60_000),
  SMT_WORKER_IN_PROCESS: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),

  SMT_OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  SMT_OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  SMT_OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  SMT_OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),

  SMT_ADMIN_EMAIL: z.string().email().default('admin@smt.local'),
  SMT_ADMIN_PASSWORD: z.string().min(8).default('admin1234'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

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
  aiRequestTimeout: env.SMT_AI_REQUEST_TIMEOUT,
  workerInProcess: env.SMT_WORKER_IN_PROCESS,
  adminEmail: env.SMT_ADMIN_EMAIL,
  adminPassword: env.SMT_ADMIN_PASSWORD,
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
