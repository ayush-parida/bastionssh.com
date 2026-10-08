import type { Page, Route } from '@playwright/test';
import { createMember, expect, signInWithPassword, test } from './fixtures.js';

/**
 * FTP → a connection → Download folder, against a stubbed FTP API: the
 * button on folder rows and for the current folder, the format select
 * (remembered), the request it makes, the saved archive (named by the
 * server's Content-Disposition) and the server's refusal shown as a toast.
 */

const CONN = 'ftp-folder-e2e';
const ARCHIVE = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(50_000, 7)]);

const entry = (name: string, type: 'directory' | 'file', size = 0) => ({
  name,
  path: `/home/deploy/${name}`,
  type,
  size,
  permissions: type === 'directory' ? 'rwxr-xr-x' : 'rw-r--r--',
  modifiedAt: '2026-10-01T10:00:00.000Z',
  rawModifiedAt: 'Oct  1 10:00',
  link: null,
  targetType: null,
});

async function stubConnection(page: Page, requested: string[], folderStatus = 200) {
  await page.route(`**/api/ftp/connections/${CONN}`, (route: Route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: CONN,
        orgId: 'org',
        name: 'shared host',
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftp',
        username: 'deploy',
        verifyTls: true,
        rootPath: null,
        restrictToRoot: false,
        authMethod: 'password',
        sshKeyId: null,
        hostKeyFingerprint: null,
        hostKeyStatus: 'none',
        lastStatus: null,
      }),
    }),
  );
  await page.route(`**/api/ftp/connections/${CONN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/list')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          path: '/home/deploy',
          parent: '/home',
          root: null,
          entries: [entry('www', 'directory'), entry('notes.txt', 'file', 12)],
        }),
      });
    }
    if (url.pathname.endsWith('/folder')) {
      requested.push(`${url.searchParams.get('path')} ${url.searchParams.get('format')}`);
      if (folderStatus !== 200) {
        return route.fulfill({
          status: folderStatus,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Path is outside the connection’s start directory' }),
        });
      }
      const format = url.searchParams.get('format')!;
      const base = url.searchParams.get('path')!.split('/').filter(Boolean).pop()!;
      return route.fulfill({
        status: 200,
        contentType: format === 'zip' ? 'application/zip' : 'application/gzip',
        headers: { 'Content-Disposition': `attachment; filename="${base}.${format}"; filename*=UTF-8''${base}.${format}` },
        body: ARCHIVE,
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not stubbed"}' });
  });
}

test.describe('FTP Download folder', () => {
  let admin: { email: string; password: string };
  test.beforeAll(async () => {
    admin = await createMember('admin', 'ftpfolderdl');
  });

  test('downloads a folder row and the current folder, in the chosen format', async ({ page }) => {
    const requested: string[] = [];
    await stubConnection(page, requested);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/ftp/${CONN}`);
    const row = page.getByRole('row', { name: /www/ });
    await expect(row).toBeVisible();

    // zip by default
    await expect(page.getByLabel('Archive format')).toHaveValue('zip');
    let downloading = page.waitForEvent('download');
    await row.getByTitle('Download folder (.zip)').click();
    let download = await downloading;
    expect(download.suggestedFilename()).toBe('www.zip');
    await expect(page.getByText(`Downloaded www.zip`)).toBeVisible();

    // tar.gz for the current folder, and the choice survives a reload
    await page.getByLabel('Archive format').selectOption('tar.gz');
    downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download folder', exact: true }).click();
    download = await downloading;
    expect(download.suggestedFilename()).toBe('deploy.tar.gz');
    expect(requested).toEqual(['/home/deploy/www zip', '/home/deploy tar.gz']);

    await page.reload();
    await expect(page.getByLabel('Archive format')).toHaveValue('tar.gz');
    await expect(row.getByTitle('Download folder (.tar.gz)')).toBeVisible();
  });

  test('shows the server’s refusal and saves nothing', async ({ page }) => {
    const requested: string[] = [];
    await stubConnection(page, requested, 403);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/ftp/${CONN}`);
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.getByRole('row', { name: /www/ }).getByTitle(/Download folder/).click();
    await expect(page.getByText('Path is outside the connection’s start directory')).toBeVisible();
    expect(requested).toHaveLength(1);
    expect(downloads).toBe(0);
    // The buttons come back once it has ended
    await expect(page.getByRole('button', { name: 'Download folder', exact: true })).toBeEnabled();
  });
});
