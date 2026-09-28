import { defineConfig, devices } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL, PORT } from './tests/env.js';

export default defineConfig({
  testDir: './tests',
  // One server, one database: specs share state (the seeded owner, the org),
  // so they run one at a time in file order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    // localhost, not 127.0.0.1: passkeys need a secure context, and the RP ID
    // is SMT_BASE_URL's hostname
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/start-server.mjs',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    // Let scripts/start-server.mjs remove its temp database on the way out
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      SMT_PORT: String(PORT),
      SMT_HOST: '127.0.0.1',
      SMT_BASE_URL: BASE_URL,
      // Throwaway secrets for a throwaway database
      SMT_ENCRYPTION_KEY: 'ZTJlLW9ubHkta2V5LTMyLWJ5dGVzLWxvbmctYmFzZTY0LWVuYw==',
      SMT_SESSION_SECRET: 'e2e-only-session-secret-at-least-32-characters',
      SMT_ADMIN_EMAIL: ADMIN_EMAIL,
      SMT_ADMIN_PASSWORD: ADMIN_PASSWORD,
      SMT_LOG_LEVEL: process.env.SMT_LOG_LEVEL ?? 'warn',
      // Every test gets its own X-Forwarded-For (see tests/fixtures.ts) so the
      // per-IP sign-in rate limits do not trip across the suite
      SMT_TRUST_PROXY: 'true',
      SMT_MONITORING_ENABLED: 'false',
      SMT_CLOUD_SYNC_ENABLED: 'false',
      // Without Redis the in-process worker just logs connection errors; CI
      // provides one so queue-backed routes behave as in production
      ...(process.env.SMT_REDIS_URL && { SMT_REDIS_URL: process.env.SMT_REDIS_URL }),
    },
  },
});
