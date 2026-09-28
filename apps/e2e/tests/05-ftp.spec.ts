import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env.js';
import { expect, signInWithPassword, test } from './fixtures.js';

test('the FTP connection form offers SFTP', async ({ page }) => {
  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.getByRole('link', { name: 'FTP', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection' }).click();
  await expect(page.getByRole('heading', { name: 'New connection' })).toBeVisible();

  const form = page.locator('form', { has: page.locator('option[value="sftp"]') });
  const protocol = form.locator('select');
  await expect(protocol.locator('option[value="sftp"]')).toHaveText('SFTP (SSH File Transfer)');
  await expect(form.locator('input[type="number"]')).toHaveValue('21');

  await protocol.selectOption('sftp');
  await expect(protocol).toHaveValue('sftp');
  // An untouched port follows the protocol's default
  await expect(form.locator('input[type="number"]')).toHaveValue('22');
  await expect(form.getByPlaceholder('sftp.example.com')).toBeVisible();
});
