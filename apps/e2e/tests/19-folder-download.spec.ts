import type { Page, Route } from '@playwright/test';
import { createMember, expect, signInWithPassword, test } from './fixtures.js';

/**
 * Servers → Files → Download folder, against a stubbed SFTP API: the button
 * on folder rows and for the current folder, the format choice (remembered),
 * the request it makes, progress and the saved archive — streamed into a
 * picked file where the browser can (a stand-in for showSaveFilePicker), or
 * as a normal download where it cannot — and the server's error shown when
 * the download is refused.
 */

const SERVER = 'srv-folder-e2e';
const ARCHIVE = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200_000, 7)]);

const entry = (name: string, type: 'directory' | 'file', size = 0) => ({
  name,
  path: `/srv/app/${name}`,
  type,
  size,
  mode: type === 'directory' ? 0o40755 : 0o100644,
  permissions: type === 'directory' ? 'rwxr-xr-x' : 'rw-r--r--',
  uid: 1000,
  gid: 1000,
  modifiedAt: '2026-10-01T10:00:00.000Z',
  targetType: null,
});

async function stubServer(page: Page, requested: string[], folderStatus = 200) {
  await page.route(`**/api/servers/${SERVER}`, (route: Route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id: SERVER, name: 'web-1', host: '10.0.0.5', port: 22, username: 'deploy', tags: [] }),
    }),
  );
  await page.route(`**/api/sftp/${SERVER}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/list')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          path: '/srv/app',
          parent: '/srv',
          entries: [entry('releases', 'directory'), entry('README.md', 'file', 12)],
        }),
      });
    }
    if (url.pathname.endsWith('/folder')) {
      requested.push(`${url.searchParams.get('path')} ${url.searchParams.get('format')}`);
      if (folderStatus !== 200) {
        return route.fulfill({ status: folderStatus, contentType: 'application/json', body: JSON.stringify({ error: 'Not a folder; download a single file instead' }) });
      }
      const format = url.searchParams.get('format');
      return route.fulfill({
        status: 200,
        contentType: format === 'zip' ? 'application/zip' : 'application/gzip',
        headers: { 'Content-Disposition': `attachment; filename="x.${format}"` },
        body: ARCHIVE,
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not stubbed"}' });
  });
}

test.describe('Download folder', () => {
  let admin: { email: string; password: string };
  test.beforeAll(async () => {
    admin = await createMember('admin', 'folderdl');
  });

  test('streams a folder row into the picked file, in the chosen format', async ({ page }) => {
    // A stand-in for the save picker: what is written is kept on the page
    await page.addInitScript(() => {
      const w = window as unknown as { __saved: { name: string; bytes: number; closed: boolean }[]; showSaveFilePicker: unknown };
      w.__saved = [];
      w.showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => ({
        createWritable: async () => {
          const file = { name: suggestedName, bytes: 0, closed: false };
          w.__saved.push(file);
          return {
            write: async (chunk: Uint8Array) => {
              file.bytes += chunk.byteLength;
            },
            close: async () => {
              file.closed = true;
            },
            abort: async () => {},
          };
        },
      });
    });
    const requested: string[] = [];
    await stubServer(page, requested);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${SERVER}/files`);
    await expect(page.getByText('releases')).toBeVisible();

    await page.getByRole('button', { name: 'Download folder releases' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download folder' });
    await expect(dialog).toContainText('/srv/app/releases');
    await expect(dialog.getByLabel('.zip')).toBeChecked();
    await dialog.getByLabel('.tar.gz').check();
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(dialog).toContainText(`Saved releases.tar.gz (195.32 KB)`);
    expect(requested).toEqual(['/srv/app/releases tar.gz']);
    const saved = await page.evaluate(() => (window as unknown as { __saved: unknown[] }).__saved);
    expect(saved).toEqual([{ name: 'releases.tar.gz', bytes: ARCHIVE.length, closed: true }]);

    // The format is remembered next time
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await page.getByRole('button', { name: 'Download folder', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Download folder' }).getByLabel('.tar.gz')).toBeChecked();
    await expect(page.getByRole('dialog', { name: 'Download folder' })).toContainText('/srv/app');
  });

  test('saves through the browser where it cannot write files, and shows a refusal', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const requested: string[] = [];
    await stubServer(page, requested);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${SERVER}/files`);
    await page.getByRole('button', { name: 'Download folder', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Download folder' });
    await expect(dialog.getByRole('link', { name: 'let the browser download it directly' })).toHaveAttribute(
      'href',
      `/api/sftp/${SERVER}/folder?path=%2Fsrv%2Fapp&format=zip`,
    );
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('app.zip');
    await expect(dialog).toContainText('Saved app.zip');
    expect(requested).toEqual(['/srv/app zip']);

    await page.unroute(`**/api/sftp/${SERVER}/**`);
    await stubServer(page, requested, 400);
    await dialog.getByRole('button', { name: 'Download again' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Not a folder; download a single file instead');
  });
});
