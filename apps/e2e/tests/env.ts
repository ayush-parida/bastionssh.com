/** Shared by playwright.config.ts (to start the server) and the specs (to sign in). */
export const PORT = Number(process.env.E2E_PORT ?? 18473);
export const BASE_URL = `http://localhost:${PORT}`;
export const ADMIN_EMAIL = 'owner@e2e.example.com';
export const ADMIN_PASSWORD = 'e2e-owner-password';
