import type { Page, Route } from '@playwright/test';
import { createMember, expect, signInWithPassword, test } from './fixtures.js';

/**
 * The Docker page's Compose tab (D4) and the cross-server Containers page
 * (D5) against a stubbed Docker API, like 06-docker-actions: what is under
 * test is the browser side — the Docker tab renders, a compose action is
 * confirmed with its project before anything is sent and shows the CLI's
 * output, and the fleet view lists, filters and links containers to their
 * server's container drawer.
 */

const ALPHA = 'srv-compose-e2e';
const BETA = 'srv-fleet-e2e';
const WEB = 'c'.repeat(64);
const DB = 'd'.repeat(64);

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

function container(id: string, name: string, state: string, image: string, health: string | null = null) {
  return {
    id,
    name,
    image,
    imageId: 'sha256:' + '2'.repeat(64),
    command: image,
    createdAt: new Date().toISOString(),
    state,
    status: state === 'running' ? 'Up 3 hours' : 'Exited (1) 2 minutes ago',
    health,
    ports: [],
    labels: {},
    composeProject: 'shop',
    composeService: name.replace(/^shop-|-1$/g, ''),
  };
}

const project = {
  name: 'shop',
  workingDir: '/srv/shop',
  configFiles: ['/srv/shop/compose.yaml'],
  unmanageable: null,
  services: [
    {
      name: 'web',
      running: 1,
      containers: [{ id: WEB, name: 'shop-web-1', image: 'nginx:1.27', state: 'running', status: 'Up 3 hours', health: null, number: 1 }],
    },
    {
      name: 'db',
      running: 0,
      containers: [{ id: DB, name: 'shop-db-1', image: 'postgres:16', state: 'exited', status: 'Exited (1) 2 minutes ago', health: null, number: 1 }],
    },
  ],
  running: 1,
  total: 2,
  state: 'partial',
};

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** Answer one server's Docker calls; POSTs are recorded in `sent`. */
async function stubServer(page: Page, serverId: string, name: string, sent: string[]) {
  await page.route(`**/api/docker/servers/${serverId}**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(`/api/docker/servers/${serverId}`, '') || '/';
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (req.method() !== 'GET') sent.push(`${req.method()} ${path}`);
    if (path === '/') {
      return json({
        serverId,
        serverName: name,
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
      });
    }
    if (path === '/containers') {
      return json([container(WEB, 'shop-web-1', 'running', 'nginx:1.27'), container(DB, 'shop-db-1', 'exited', 'postgres:16')]);
    }
    if (path === '/info') return route.fulfill({ status: 500, body: '{}' });
    if (path === '/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse([{ type: 'end' }]) });
    if (path === '/compose') return json([project]);
    if (path === '/compose/shop/up') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          { type: 'logs', lines: [{ stream: 'stderr', text: ' Container shop-db-1  Started' }] },
          { type: 'exit', exitCode: 0, signal: null, durationMs: 1200, timedOut: false },
        ]),
      });
    }
    return json({ error: `not stubbed: ${req.method()} ${path}` }, 404);
  });
}

test.describe('Docker compose and fleet', () => {
  let admin: { email: string; password: string };
  test.beforeAll(async () => {
    admin = await createMember('admin', 'compose');
  });

  test('renders the Docker tab and runs compose up after a confirmation', async ({ page }) => {
    const sent: string[] = [];
    await stubServer(page, ALPHA, 'alpha', sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${ALPHA}/docker`);

    // The Docker tab: engine header and the container list
    await expect(page.getByRole('heading', { name: 'Docker' })).toBeVisible();
    await expect(page.getByRole('cell', { name: /^shop-web-1/ })).toBeVisible();

    await page.getByRole('button', { name: /^Compose/ }).click();
    await expect(page.getByText('1/2 running')).toBeVisible();
    await expect(page.getByText('/srv/shop', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Up', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Compose up shop' });
    await expect(dialog).toContainText('docker compose -p shop up --detach');
    await expect(dialog).toContainText('2 services: web, db');
    expect(sent).toEqual([]);

    await dialog.getByRole('button', { name: 'Run up' }).click();
    await expect(dialog).toContainText('Container shop-db-1  Started');
    await expect(dialog).toContainText('Finished');
    expect(sent).toEqual(['POST /compose/shop/up']);
  });

  test('lists containers across servers and opens one in its drawer', async ({ page }) => {
    await stubServer(page, ALPHA, 'alpha', []);
    await page.route('**/api/docker/containers?**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          servers: [
            {
              serverId: ALPHA,
              serverName: 'alpha',
              ok: true,
              containers: [
                container(WEB, 'shop-web-1', 'running', 'nginx:1.27'),
                container(DB, 'shop-db-1', 'exited', 'postgres:16'),
              ],
              durationMs: 40,
            },
            { serverId: BETA, serverName: 'beta', ok: false, containers: [], error: 'Timed out after 10 s', durationMs: 10_000 },
          ],
          skipped: [{ serverId: 'srv-gamma', serverName: 'gamma', reason: 'not_detected' }],
        }),
      }),
    );
    await signInWithPassword(page, admin.email, admin.password);
    await page.getByRole('link', { name: 'Containers' }).click();
    await expect(page).toHaveURL(/\/containers$/);

    await expect(page.getByRole('cell', { name: /shop-web-1/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: /shop-db-1/ })).toBeVisible();
    await expect(page.getByText('One server did not answer')).toBeVisible();
    await expect(page.getByText('Timed out after 10 s')).toBeVisible();
    await expect(page.getByText('Not checked for Docker yet: gamma')).toBeVisible();

    await page.getByLabel('State').selectOption('stopped');
    await expect(page.getByRole('cell', { name: /shop-web-1/ })).toHaveCount(0);
    await page.getByLabel('State').selectOption('all');
    await page.getByPlaceholder('Filter by name, image or project').fill('nginx');
    await expect(page.getByRole('cell', { name: /shop-db-1/ })).toHaveCount(0);

    await page.getByRole('cell', { name: /shop-web-1/ }).click();
    await expect(page).toHaveURL(new RegExp(`/servers/${ALPHA}/docker\\?container=${WEB}$`));
    const drawer = page.getByRole('dialog', { name: 'Container shop-web-1' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Logs' })).toBeVisible();
  });
});
