import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import {
  test as base,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type CDPSession,
  type Page,
} from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL } from './env.js';

/**
 * A client address of its own. The server trusts X-Forwarded-For in this suite
 * (SMT_TRUST_PROXY=true), so each test lands in its own rate-limit bucket
 * instead of every sign-in sharing 127.0.0.1's.
 */
export function fakeClientIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

export const test = base.extend<{ clientIp: string }>({
  // Playwright reads a fixture's dependencies from its destructuring pattern
  // eslint-disable-next-line no-empty-pattern
  clientIp: async ({}, use) => use(fakeClientIp()),
  extraHTTPHeaders: async ({ clientIp }, use) => use({ 'X-Forwarded-For': clientIp }),
});

export { expect };

export type Role = 'viewer' | 'operator' | 'admin';

/** An API client signed in as the seeded owner. Dispose it when done. */
export async function ownerApi(): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { 'X-Forwarded-For': fakeClientIp() },
  });
  const res = await api.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return api;
}

/** Add a member to the owner's org through an invite, as the invitee would. */
export async function createMember(
  role: Role,
  name = 'member',
): Promise<{ email: string; password: string; displayName: string }> {
  const email = `${name}-${Date.now()}-${randomInt(1e6)}@e2e.example.com`;
  const password = `pw-${randomInt(1e9)}-${randomInt(1e9)}`;
  const displayName = `E2E ${name}`;

  const owner = await ownerApi();
  const invite = await owner.post('/api/team/invites', { data: { email, role } });
  expect(invite.status(), await invite.text()).toBe(201);
  const { link } = (await invite.json()) as { link: string };
  await owner.dispose();

  // A fresh client: a session cookie would make the accept "join as me"
  const guest = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { 'X-Forwarded-For': fakeClientIp() },
  });
  const token = new URL(link).pathname.split('/').pop();
  const accepted = await guest.post(`/api/invites/${token}/accept`, { data: { email, displayName, password } });
  expect(accepted.ok(), await accepted.text()).toBeTruthy();
  await guest.dispose();

  return { email, password, displayName };
}

/** Sign in through the login form with just a password (no passkey on the account). */
export async function signInWithPassword(page: Page, email: string, password: string): Promise<void> {
  // Headless Chromium has no passkey support of its own, so the login page's
  // autofill request fails with an error toast that sits over the top of the
  // next pages and swallows clicks there until it fades
  await disablePasskeyAutofill(page);
  await page.goto('/login');
  await fillPasswordForm(page, email, password);
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}

export async function fillPasswordForm(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** A credential as WebAuthn.getCredentials returns it and WebAuthn.addCredential takes it. */
export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

/**
 * A CDP virtual authenticator on this page: a platform authenticator with
 * user verification that answers every ceremony without a prompt.
 */
export async function addVirtualAuthenticator(
  page: Page,
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/**
 * Report no autofill (conditional mediation) support, so the login page does
 * not start a passkey request on load. With the credential present, the
 * virtual authenticator sometimes answers that request by itself and signs in
 * before the test acts, so tests that drive a specific path turn it off.
 */
export async function disablePasskeyAutofill(page: Page): Promise<void> {
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  });
}

/**
 * With `E2E_SCREENSHOTS` set to a directory, save what the page shows there
 * as `<name>.png` (the pictures in the docs); otherwise do nothing.
 */
export async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  // Finish CSS transitions (a tab's underline) that headless Chromium can leave half-way
  await page.screenshot({ path: resolve(dir, `${name}.png`), animations: 'disabled' });
}
