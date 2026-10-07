import type { Page, Route } from '@playwright/test';
import { createMember, expect, signInWithPassword, test } from './fixtures.js';

/**
 * Upload image on a server's Docker page, against a stubbed Docker API (like
 * 07-docker-compose-fleet): the build-and-save instructions filled in from
 * the image name and the server's platform, the file checked before it is
 * sent, the upload and what it loaded, then the optional step that recreates
 * the Compose service using the tag and cleans up the image it replaced —
 * and the per-service buttons on the Compose tab.
 */

const SERVER = 'srv-upload-e2e';
const OLD = 'sha256:' + 'a'.repeat(64);
const NEW = 'sha256:' + 'b'.repeat(64);

const permissions = {
  view: true,
  inspect: true,
  control: true,
  exec: true,
  remove: true,
  pull: true,
  prune: true,
  revealEnv: true,
  configure: true,
};

const project = {
  name: 'infra',
  workingDir: '/home/deploy/infra',
  configFiles: ['/home/deploy/infra/compose.yaml'],
  unmanageable: null,
  services: [
    {
      name: 'db',
      running: 1,
      containers: [{ id: 'd'.repeat(64), name: 'infra-db-1', image: 'postgres:16', state: 'running', status: 'Up 3 days', health: null, number: 1 }],
    },
    {
      name: 'website',
      running: 1,
      containers: [{ id: 'c'.repeat(64), name: 'infra-website-1', image: 'knexbi-website:latest', state: 'running', status: 'Up 3 days', health: null, number: 1 }],
    },
  ],
  running: 2,
  total: 2,
  state: 'running',
};

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

function loadedResult(architecture: string) {
  const mismatch = architecture !== 'amd64';
  return {
    images: [
      {
        ref: 'knexbi-website:latest',
        id: NEW,
        os: 'linux',
        architecture,
        variant: null,
        size: 52_428_800,
        replacedId: OLD,
        platformMismatch: mismatch,
      },
    ],
    bytes: 2048,
    format: 'gzip',
    serverPlatform: 'linux/amd64',
    warnings: mismatch
      ? [
          'knexbi-website:latest is built for linux/arm64, but this server is linux/amd64. Containers from it would fail with "exec format error". Rebuild it with docker build --platform linux/amd64 and upload it again.',
        ]
      : [],
  };
}

/** Answer the server's Docker calls; anything not a GET is recorded in `sent`. */
async function stubServer(page: Page, sent: string[], architecture = 'amd64') {
  await page.route(`**/api/docker/servers/${SERVER}**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(`/api/docker/servers/${SERVER}`, '') || '/';
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const stream = (events: unknown[]) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(events) });

    if (req.method() !== 'GET') sent.push(`${req.method()} ${path}${url.search}`);
    if (path === '/') {
      return json({
        serverId: SERVER,
        serverName: 'web-1',
        docker: {
          mode: 'auto',
          socketPath: null,
          transport: 'streamlocal',
          detectedSocketPath: '/var/run/docker.sock',
          detectedAt: new Date().toISOString(),
          version: '27.3.1',
          apiVersion: '1.47',
        },
        permissions,
        imageUploadMaxBytes: 10 * 1024 * 1024,
      });
    }
    if (path === '/containers') return json([]);
    if (path === '/info') {
      return json({
        name: 'web-1',
        serverVersion: '27.3.1',
        apiVersion: '1.47',
        operatingSystem: 'Ubuntu 24.04',
        osType: 'linux',
        architecture: 'x86_64',
        kernelVersion: '6.8',
        ncpu: 2,
        memTotal: 4 * 1024 ** 3,
        storageDriver: 'overlay2',
        rootless: false,
        containers: 2,
        containersRunning: 2,
        containersPaused: 0,
        containersStopped: 0,
        images: 3,
        transport: 'streamlocal',
        socketPath: '/var/run/docker.sock',
        diskUsage: null,
      });
    }
    if (path === '/events') return stream([{ type: 'end' }]);
    if (path === '/compose') return json([project]);
    if (path === '/compose/service-images') {
      return json([
        { project: 'infra', service: 'db', image: 'postgres:16' },
        { project: 'infra', service: 'website', image: 'knexbi-website:latest' },
      ]);
    }
    if (path === '/images/load') {
      return stream([
        { type: 'uploaded', bytes: 2048, format: 'gzip' },
        { type: 'load', progress: { id: 'abc', status: 'Loading layer', current: 1024, total: 2048 } },
        { type: 'load', progress: { id: null, status: 'Loaded image: knexbi-website:latest', current: null, total: null } },
        { type: 'loaded', result: loadedResult(architecture) },
        { type: 'end' },
      ]);
    }
    if (path === '/compose/infra/services/website/up' || path === '/compose/infra/services/website/restart') {
      return stream([
        { type: 'logs', lines: [{ stream: 'stderr', text: ' Container infra-website-1  Recreated' }] },
        { type: 'exit', exitCode: 0, signal: null, durationMs: 2100, timedOut: false },
        { type: 'end' },
      ]);
    }
    if (req.method() === 'DELETE' && path === `/images/${encodeURIComponent(OLD)}`) return json({ untagged: [], deleted: [OLD] });
    return json({ error: `not stubbed: ${req.method()} ${path}` }, 404);
  });
}

test.describe('Docker upload image', () => {
  let admin: { email: string; password: string };
  test.beforeAll(async () => {
    admin = await createMember('admin', 'upload');
  });

  test('shows how to build and save, uploads, then updates the compose service', async ({ page }) => {
    const sent: string[] = [];
    await stubServer(page, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${SERVER}/docker`);
    await expect(page.getByRole('heading', { name: 'Docker' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'How?' })).toHaveAttribute('href', '/docs/docker/upload-image');

    await page.getByRole('button', { name: 'Upload image' }).click();
    const dialog = page.getByRole('dialog', { name: 'Upload image' });
    await expect(dialog).toBeVisible();

    // The instructions: open the first time, filled in from the image name, for the server's platform
    const help = dialog.getByRole('group', { name: 'How to build and save the image' });
    await expect(help).toHaveAttribute('open', '');
    await help.getByLabel('Image name').fill('knexbi-website:latest');
    await help.getByLabel('Build folder').fill('knexbi.com/');
    await expect(help).toContainText('docker build --platform linux/amd64 -t knexbi-website:latest knexbi.com/');
    await expect(help).toContainText('docker save knexbi-website:latest | gzip > knexbi-website.tar.gz');
    await expect(help).toContainText('This server is linux/amd64');
    await expect(help).toContainText('image: knexbi-website:latest');
    await expect(help.getByRole('link', { name: /Full guide/ })).toHaveAttribute('href', '/docs/docker/upload-image');

    // Checked before anything is sent
    const input = dialog.getByLabel('Image archive');
    await input.setInputFiles({ name: 'site.zip', mimeType: 'application/zip', buffer: Buffer.alloc(100) });
    await expect(dialog).toContainText('Pick what docker save wrote');
    await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
    await input.setInputFiles({ name: 'big.tar.gz', mimeType: 'application/gzip', buffer: Buffer.alloc(11 * 1024 * 1024) });
    await expect(dialog).toContainText('this BastionSSH takes image archives up to 10 MB');
    expect(sent).toEqual([]);

    await input.setInputFiles({ name: 'knexbi-website.tar.gz', mimeType: 'application/gzip', buffer: Buffer.alloc(2048, 1) });
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(dialog).toContainText('Loaded one image');
    await expect(dialog).toContainText('Loaded image: knexbi-website:latest');
    await expect(dialog).toContainText(`replaces ${OLD.slice(7, 19)}`);
    await expect(dialog.getByRole('progressbar', { name: 'Upload progress' })).toHaveAttribute('aria-valuenow', '100');
    expect(sent).toEqual(['POST /images/load?name=knexbi-website.tar.gz']);

    // Then update the service whose image: is the uploaded tag (preselected)
    const update = dialog.getByRole('region', { name: 'Then update a Compose service' });
    await expect(update.getByLabel('Project')).toHaveValue('infra');
    await expect(update.getByLabel('Service')).toHaveValue('website');
    await expect(update).toContainText('the tag you uploaded');
    await expect(update.getByRole('checkbox')).toBeChecked();
    await update.getByRole('button', { name: 'Update website' }).click();
    await expect(update).toContainText('docker compose -p infra up --detach --no-deps website');
    await expect(update).toContainText('Container infra-website-1  Recreated');
    await expect(update).toContainText('Finished');
    await expect(update).toContainText(`Removed the old image ${OLD.slice(7, 19)}`);
    expect(sent).toEqual([
      'POST /images/load?name=knexbi-website.tar.gz',
      'POST /compose/infra/services/website/up',
      `DELETE /images/${encodeURIComponent(OLD)}?unused=1`,
    ]);
    await update.getByRole('button', { name: 'Close' }).click();

    // Remembered in this browser: the instructions start folded, with the last image
    await page.getByRole('button', { name: 'Upload image' }).click();
    const again = page.getByRole('dialog', { name: 'Upload image' }).getByRole('group', { name: 'How to build and save the image' });
    await expect(again).not.toHaveAttribute('open', '');
    await expect(again.getByLabel('Image name')).toHaveValue('knexbi-website:latest');
  });

  test('warns when the image was built for another architecture', async ({ page }) => {
    await stubServer(page, [], 'arm64');
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${SERVER}/docker`);
    await page.getByRole('button', { name: 'Upload image' }).click();
    const dialog = page.getByRole('dialog', { name: 'Upload image' });
    await dialog.getByLabel('Image archive').setInputFiles({ name: 'site.tar', mimeType: 'application/x-tar', buffer: Buffer.alloc(2048, 1) });
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('built for linux/arm64, but this server is linux/amd64');
    await expect(dialog.getByRole('alert')).toContainText('--platform linux/amd64');
  });

  test('runs an action on one service from the Compose tab', async ({ page }) => {
    const sent: string[] = [];
    await stubServer(page, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${SERVER}/docker`);
    await page.getByRole('button', { name: /^Compose/ }).click();
    await page.getByRole('button', { name: 'Restart service website' }).click();
    const dialog = page.getByRole('dialog', { name: 'Compose restart website in infra' });
    await expect(dialog).toContainText('docker compose -p infra restart website');
    expect(sent).toEqual([]);
    await dialog.getByRole('button', { name: 'Run restart' }).click();
    await expect(dialog).toContainText('Finished');
    expect(sent).toEqual(['POST /compose/infra/services/website/restart']);
  });
});
