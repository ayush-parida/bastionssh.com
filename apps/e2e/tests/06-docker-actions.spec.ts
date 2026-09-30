import type { Page, Route } from '@playwright/test';
import { createMember, expect, signInWithPassword, test } from './fixtures.js';

/**
 * The Docker page's actions (D2) and "Open shell" (D3) against a stubbed
 * Docker API: no daemon or SSH server is involved. What is under test is the
 * browser side — which buttons a role gets, that destructive actions name
 * their target in a confirmation before anything is sent, the prune dry run,
 * and the terminal header for a container shell.
 */

const SERVER = 'srv-docker-e2e';
const WEB = 'a'.repeat(64);
const WORKER = 'b'.repeat(64);

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

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

function container(id: string, name: string, state: string) {
  return {
    id,
    name,
    image: 'nginx:1.27',
    imageId: 'sha256:' + '1'.repeat(64),
    command: 'nginx',
    createdAt: new Date().toISOString(),
    state,
    status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 5 minutes ago',
    health: null,
    ports: [],
    labels: {},
    composeProject: null,
    composeService: null,
  };
}

/** Answer the page's Docker calls; mutating ones are recorded in `sent`. */
async function stubDocker(page: Page, sent: Sent[], perms = permissions) {
  await page.route(`**/api/docker/servers/${SERVER}**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(`/api/docker/servers/${SERVER}`, '') || '/';
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (req.method() !== 'GET') sent.push({ method: req.method(), path: `${path}${url.search}`, body: req.postDataJSON() });
    if (req.method() === 'GET' && path === '/') {
      return json({
        serverId: SERVER,
        serverName: 'alpha',
        docker: {
          mode: 'auto',
          socketPath: null,
          transport: 'streamlocal',
          detectedSocketPath: '/var/run/docker.sock',
          detectedAt: new Date().toISOString(),
          version: '27.3.1',
          apiVersion: '1.47',
        },
        permissions: perms,
      });
    }
    if (path === '/containers') return json([container(WEB, 'web', 'running'), container(WORKER, 'worker', 'exited')]);
    if (path === '/info') return route.fulfill({ status: 500, body: '{}' });
    if (path === '/events') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"end"}\n\n' });
    }
    if (path === '/prune' && req.method() === 'GET') {
      return json({
        containers: { count: 3, size: 1024 },
        danglingImages: { count: 2, size: 5 * 1024 * 1024 },
        unusedImages: { count: 4, size: 50 * 1024 * 1024 },
        volumes: { count: 1, size: 2048 },
        volumesIncludeNamed: false,
        networks: { count: 1, size: null },
      });
    }
    if (path === '/prune') {
      return json({
        containers: { deleted: 3, reclaimed: 1024 },
        images: { deleted: 2, reclaimed: 5 * 1024 * 1024 },
        volumes: null,
        networks: { deleted: 1 },
        reclaimed: 5 * 1024 * 1024 + 1024,
      });
    }
    if (/^\/containers\/[a-f0-9]+\/(stop|start|restart|kill|pause|unpause)$/.test(path)) return json({ changed: true });
    if (req.method() === 'DELETE') return route.fulfill({ status: 204 });
    if (path.endsWith('/exec')) {
      return json(
        {
          sessionId: 'e2e-container-shell',
          wsUrl: 'ws://localhost/api/ssh-sessions/e2e-container-shell/ws',
          container: { id: WEB, name: 'web' },
          cmd: ['/bin/bash'],
          recording: null,
        },
        201,
      );
    }
    return json({ error: `not stubbed: ${req.method()} ${path}` }, 404);
  });
}

test.describe('Docker actions', () => {
  let admin: { email: string; password: string };
  test.beforeAll(async () => {
    admin = await createMember('admin', 'docker');
  });

  test('confirms before stopping and removing, naming the container', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDocker(page, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${SERVER}/docker`);
    await expect(page.getByRole('cell', { name: /^web/ })).toBeVisible();

    await page.getByRole('button', { name: 'Stop web' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Stop container');
    await expect(dialog).toContainText(`web (${WEB.slice(0, 12)})`);
    expect(sent).toEqual([]);
    await dialog.getByRole('button', { name: 'Stop' }).click();
    await expect(dialog).toBeHidden();
    expect(sent).toEqual([{ method: 'POST', path: `/containers/${WEB}/stop`, body: {} }]);

    // Remove, with its volumes: nothing leaves the page until confirmed
    await page.getByRole('button', { name: 'Remove worker' }).click();
    await expect(page.getByRole('alertdialog')).toContainText(`worker (${WORKER.slice(0, 12)})`);
    await page.getByLabel(/anonymous volumes/).check();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('alertdialog')).toBeHidden();
    expect(sent.at(-1)).toMatchObject({ method: 'DELETE', path: `/containers/${WORKER}?force=0&volumes=1` });

    // Start needs no confirmation
    await page.getByRole('button', { name: 'Start worker' }).click();
    await expect.poll(() => sent.at(-1)?.path).toBe(`/containers/${WORKER}/start`);
  });

  test('prunes after a dry run', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDocker(page, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${SERVER}/docker`);

    await page.getByRole('button', { name: /Prune/ }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Dry run');
    await expect(dialog).toContainText('Stopped containers');
    await expect(dialog).toContainText('3 · 1 KB');
    await expect(dialog).toContainText('Named volumes are kept');
    await dialog.getByRole('button', { name: 'Prune' }).click();
    await expect(page.getByText(/Reclaimed 5 MB/)).toBeVisible();
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      path: '/prune',
      body: { containers: true, images: true, volumes: false, networks: true, dangling: true },
    });
  });

  test('opens a shell in the terminal, headed with the container and server', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDocker(page, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${SERVER}/docker`);

    await page.getByRole('button', { name: 'Open shell web' }).click();
    await expect(page).toHaveURL(new RegExp(`/servers/${SERVER}/terminal$`));
    await expect(page.getByTitle(`web (${WEB.slice(0, 12)}) on alpha`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Files' })).toHaveCount(0);
    expect(sent.at(-1)).toMatchObject({ method: 'POST', path: `/containers/${WEB}/exec` });
  });

  test('shows only what the role allows', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDocker(page, sent, { ...permissions, control: false, exec: false, remove: false, prune: false, pull: false });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${SERVER}/docker`);
    await expect(page.getByRole('cell', { name: /^web/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop web' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open shell web' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Prune/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Pull image/ })).toHaveCount(0);
  });
});
