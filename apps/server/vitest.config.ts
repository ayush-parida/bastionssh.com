import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // src/config validates the environment at import time and exits the process
    // if it is incomplete, so every module that transitively imports it needs
    // these present. Values are throwaway and never touch a real host.
    env: {
      NODE_ENV: 'test',
      SMT_BASE_URL: 'http://localhost:8080',
      SMT_ENCRYPTION_KEY: 'dGVzdC1vbmx5LWtleS0zMi1ieXRlcy1sb25nLWJhc2U2NC0x',
      SMT_SESSION_SECRET: 'test-only-session-secret-at-least-32-chars',
      SMT_DB_URL: ':memory:',
    },
  },
});
