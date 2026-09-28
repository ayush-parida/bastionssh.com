import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env.js';
import { expect, fakeClientIp, signInWithPassword, test } from './fixtures.js';

test('an owner invites a teammate who joins through the link', async ({ page, browser }) => {
  const email = `invitee-${Date.now()}@e2e.example.com`;

  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.getByRole('link', { name: 'Team & Access' }).click();
  await expect(page.getByRole('heading', { name: 'Team & Access' })).toBeVisible();

  await page.getByRole('button', { name: 'Invite person' }).click();
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Create invite' }) });
  await form.getByPlaceholder('teammate@example.com').fill(email);
  await form.locator('select').selectOption('operator');
  await form.getByRole('button', { name: 'Create invite' }).click();

  // Shown once, with the address it is bound to
  await expect(page.getByText("Copy this link now — it won't be shown again")).toBeVisible();
  await expect(page.getByText(`Send it to ${email}.`)).toBeVisible();
  const link = (await page.locator('code', { hasText: '/invite/' }).textContent())!.trim();
  expect(link).toMatch(/\/invite\/[\w-]+$/);

  // The invitee, in a browser of their own
  const inviteeContext = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': fakeClientIp() } });
  const invitee = await inviteeContext.newPage();
  await invitee.goto(link);
  await expect(invitee.getByRole('heading', { name: 'Join Default Organization' })).toBeVisible();
  await expect(invitee.getByText('You were invited as')).toContainText('operator');

  await invitee.getByLabel('Email address').fill(email);
  await invitee.getByLabel('Your name').fill('E2E Invitee');
  await invitee.getByLabel('Password').fill('invitee-password-1');
  await invitee.getByRole('button', { name: 'Accept invite' }).click();

  await expect(invitee.getByText('Welcome to Default Organization')).toBeVisible();
  await expect(invitee.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const me = await (await invitee.request.get('/api/auth/me')).json();
  expect(me.email).toBe(email);

  // A used link is dead
  await invitee.goto(link);
  await expect(invitee.getByText('This invite has already been used.')).toBeVisible();
  await inviteeContext.close();

  // The owner now sees a member, not a pending invite
  await page.reload();
  await expect(page.getByText(email)).toHaveCount(1);
  await expect(page.getByText('Pending invites')).toBeHidden();
});
