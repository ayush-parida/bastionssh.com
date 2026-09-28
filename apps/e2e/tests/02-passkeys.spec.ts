import type { Page } from '@playwright/test';
import {
  addVirtualAuthenticator,
  createMember,
  disablePasskeyAutofill,
  expect,
  fillPasswordForm,
  signInWithPassword,
  test,
  type VirtualCredential,
} from './fixtures.js';

/**
 * One member goes through the whole passkey lifecycle, so the tests share
 * state and run in order: register a passkey and backup codes, then sign in
 * with the passkey alone, with password + passkey, and with a backup code.
 */
test.describe.configure({ mode: 'serial' });

let member: { email: string; password: string; displayName: string };
/** The passkey the first test created, carried into later tests' authenticators. */
let credential: VirtualCredential;
let backupCodes: string[];

test.beforeAll(async () => {
  member = await createMember('operator', 'passkey');
});

test('registers a passkey and generates backup codes', async ({ page }) => {
  const { cdp, authenticatorId } = await addVirtualAuthenticator(page);
  await signInWithPassword(page, member.email, member.password);

  await page.goto('/settings');
  const section = page.locator('section#passkeys');
  await expect(section.getByText('No passkeys yet.')).toBeVisible();

  await section.getByRole('button', { name: 'Add passkey' }).click();
  await section.getByPlaceholder('e.g. MacBook Touch ID, YubiKey').fill('E2E virtual key');
  // The first passkey asks for the password again
  await section.locator('input[type="password"]').fill(member.password);
  await section.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByText('Passkey added')).toBeVisible();
  await expect(section.getByText('E2E virtual key')).toBeVisible();

  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);
  // Discoverable, so it can sign in without an email first
  expect(credentials[0]!.isResidentCredential).toBe(true);

  // Backup codes: shown once, in a dialog that stays until they are saved
  await section.getByRole('button', { name: 'Generate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Your backup codes' });
  await expect(dialog).toBeVisible();
  backupCodes = (await dialog.locator('ol li').allTextContents()).map((c) => c.trim());
  expect(backupCodes).toHaveLength(10);
  expect(new Set(backupCodes).size).toBe(10);

  const done = dialog.getByRole('button', { name: 'Done' });
  await expect(done).toBeDisabled();
  await dialog.getByLabel('I have saved these codes').check();
  await done.click();
  await expect(dialog).toBeHidden();
  await expect(section.getByText(/10 of 10 left/)).toBeVisible();

  // Keep it for the later tests, taken now in case a step-up above moved its counter
  credential = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0]!;
});

/**
 * Put the passkey on this page's authenticator. Call the returned function
 * once it has been used: the server rejects a signature counter that does not
 * go up, so the next test must start from the new one.
 */
async function carryPasskey(page: Page): Promise<() => Promise<void>> {
  const { cdp, authenticatorId } = await addVirtualAuthenticator(page);
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  return async () => {
    credential = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0]!;
  };
}

test('signs in with the passkey alone', async ({ page }) => {
  await disablePasskeyAutofill(page);
  const keepCounter = await carryPasskey(page);

  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();

  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  expect(me.email).toBe(member.email);
  expect(me.passkeyVerified).toBe(true);
  await keepCounter();
});

test('asks for the passkey after the password', async ({ page }) => {
  await disablePasskeyAutofill(page);
  const keepCounter = await carryPasskey(page);

  await page.goto('/login');
  await fillPasswordForm(page, member.email, member.password);
  // The authenticator answers the second-factor prompt by itself
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  expect(me.passkeyVerified).toBe(true);
  await keepCounter();
});

test('signs in with a backup code when the passkey is lost', async ({ page }) => {
  // An authenticator without the credential, which never answers on its own:
  // the passkey prompt stays open like it would with the device missing
  const { cdp, authenticatorId } = await addVirtualAuthenticator(page);
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });

  await page.goto('/login');
  await fillPasswordForm(page, member.email, member.password);
  await expect(page.getByText('Your account uses a passkey.')).toBeVisible();

  await page.getByRole('button', { name: 'Lost your passkey? Use a backup code instead' }).click();
  await page.getByLabel('Backup code').fill(backupCodes[0]!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByText('Signed in with a backup code. 9 codes left.')).toBeVisible();
  // Lands on the passkey settings to replace the lost device
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText('You signed in with a backup code.')).toBeVisible();
  // The org holds a backup-code session to adding a passkey (the default), so
  // the rest of the account, backup codes included, waits until one verifies
  await expect(page.getByText(/This organization only lets that add a new passkey/)).toBeVisible();
  await expect(page.locator('section#passkeys').getByText(/of 10 left/)).toHaveCount(0);

  // Each code works once
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await fillPasswordForm(page, member.email, member.password);
  await page.getByRole('button', { name: 'Lost your passkey? Use a backup code instead' }).click();
  await page.getByLabel('Backup code').fill(backupCodes[0]!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('That backup code is not valid or has already been used')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});
