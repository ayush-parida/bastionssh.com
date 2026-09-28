import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env.js';
import { expect, fillPasswordForm, signInWithPassword, test } from './fixtures.js';

test.describe('password sign-in', () => {
  test('signs the seeded owner in and out', async ({ page }) => {
    await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);

    // The session is gone on the server, not just in the client's state
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  });

  test('rejects a wrong password', async ({ page }) => {
    await page.goto('/login');
    await fillPasswordForm(page, ADMIN_EMAIL, 'not-the-password');
    await expect(page.getByText('Invalid credentials')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
