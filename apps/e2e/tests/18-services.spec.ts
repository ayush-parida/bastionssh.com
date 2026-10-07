import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { createMember, expect, ownerApi, signInWithPassword, snap, test } from './fixtures.js';

/**
 * Quick services (services spec §3.3, §3.4) against a stubbed
 * `/api/deploy`: the catalog (categories, search) and the create form
 * (publish warning, a domain only for UI services) with the create log
 * streaming, then a PostgreSQL service's page — the Connection panel with
 * the password revealed on request, the Backups tab (back up now, download,
 * restore with the name typed, the schedule) and Update version within the
 * line, refused across it. And what each role is offered.
 */

const PINS = JSON.parse(readFileSync(new URL('../../../packages/shared/src/services/images.json', import.meta.url), 'utf8')) as Record<string, Record<string, { image: string; version: string }>>;
const PG17 = PINS.postgres!['17']!;
const PG17_OLD = PG17.image.replace(/:[^@]+@/, ':17.1-alpine@');
const RELEASE = '20261007-120000-abcdef12';
const BACKUP = '20261007T030000Z.dump';

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

const container = { name: `bastion-orders-db-${RELEASE}`, id: 'd'.repeat(64), state: 'running', status: 'Up 1 hour', health: null };
const ordersDb = {
  name: 'orders-db',
  domains: [],
  buildType: 'image',
  service: 'postgres',
  currentRelease: RELEASE,
  container,
  configError: null,
  locked: false,
  permissions: { deploy: 'operate' },
};

async function stubServices(page: Page, serverId: string, sent: Sent[]) {
  await page.route(`**/api/docker/servers/${serverId}**`, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' }));
  await page.route(`**/api/deploy/servers/${serverId}**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(`/api/deploy/servers/${serverId}`, '') || '/';
    const method = req.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const stream = (events: unknown[]) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(events) });
    if (method !== 'GET') {
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      sent.push({ method, path, body });
    }
    if (path === '/') return json({ root: '/opt/bastion', integrity: 'ok', version: '0.1.0' });
    if (path === '/proxy') {
      return json({
        mode: 'caddy',
        nginx: { detected: false, installed: false, running: false, ports: { http: false, https: false }, certbot: false, confInclude: false, helper: 'missing', sudo: false },
        helperPath: '/usr/local/sbin/bastion-nginx',
        instructions: [],
      });
    }
    if (path === '/apps') return json([ordersDb]);
    if (path === '/services' && method === 'POST') {
      const name = (req.postDataJSON() as { name: string }).name;
      return stream([
        { type: 'log', lines: [{ stream: 'stderr', text: `Created ${name} from the PostgreSQL template: ${PG17.image}` }, { stream: 'stderr', text: 'Generated POSTGRES_PASSWORD on the server (24 random bytes)' }] },
        { type: 'log', lines: [{ stream: 'stderr', text: `Pulling ${PG17.image}` }, { stream: 'stderr', text: 'Health check passed' }] },
        { type: 'result', outcome: { app: name, release: RELEASE, previous: null, result: 'success', error: null } },
        { type: 'exit', exitCode: 0, signal: null, durationMs: 9000, timedOut: false },
        { type: 'end' },
      ]);
    }
    if (path === '/apps/orders-db' && method === 'GET') {
      return json({
        ...ordersDb,
        config: {
          name: 'orders-db',
          service: 'postgres',
          domains: [],
          redirect_www: 'none',
          tls: 'auto',
          build: { type: 'image', node: null, dir: '.', output: null, image: PG17_OLD },
          run: { port: 5432, env_file: '.env', volumes: [{ name: 'data', path: '/var/lib/postgresql/data', readonly: false, exclusive: true }], memory: '512m', cpus: null, strategy: 'recreate', publish: { scope: 'localhost', port: 15432, target: null } },
          healthcheck: { type: 'command', path: '/', command: ['sh', '-c', 'pg_isready'], timeout: '120s' },
          keep_releases: 3,
          proxy: 'caddy',
          permissions: { deploy: 'operate' },
          backups: { schedule: 'off', keep: 7 },
        },
        previousRelease: null,
        lock: null,
      });
    }
    if (path === '/apps/orders-db/connection') {
      return json({
        app: 'orders-db',
        service: 'postgres',
        name: 'PostgreSQL',
        host: 'orders-db',
        port: 5432,
        ports: [{ port: 5432, label: 'PostgreSQL' }],
        published: { scope: 'localhost', host: '127.0.0.1', port: 15432, target: 5432 },
        fields: [
          { label: 'Host', value: 'orders-db', secret: null },
          { label: 'Port', value: '5432', secret: null },
          { label: 'User', value: 'app', secret: null },
          { label: 'Password', value: null, secret: 'POSTGRES_PASSWORD' },
          { label: 'Database', value: 'app', secret: null },
        ],
        strings: [{ label: 'URL', internal: 'postgres://app:{POSTGRES_PASSWORD}@orders-db:5432/app', published: 'postgres://app:{POSTGRES_PASSWORD}@127.0.0.1:15432/app' }],
        secrets: ['POSTGRES_PASSWORD'],
        ui: null,
        docs: '/docs/deployments/services-postgres',
      });
    }
    if (path === '/apps/orders-db/env/POSTGRES_PASSWORD/reveal') return json({ key: 'POSTGRES_PASSWORD', value: 'Gen3rated-Pa55word' });
    if (path === '/apps/orders-db/backups' && method === 'GET') {
      return json({
        app: 'orders-db',
        service: 'postgres',
        supported: true,
        backups: [
          { file: BACKUP, bytes: 2_400_000, createdAt: '2026-10-07T03:00:00.000Z', kind: 'scheduled' },
          { file: '20261006T030000Z-pre-restore.dump', bytes: 2_300_000, createdAt: '2026-10-06T03:00:00.000Z', kind: 'pre-restore' },
        ],
        settings: { schedule: 'daily', keep: 7 },
        lastScheduled: { at: '2026-10-07T03:00:00.000Z', result: 'success', file: BACKUP, error: null },
        cron: { name: 'bastion-cron', id: 'c'.repeat(12), state: 'running', status: 'running', health: null },
      });
    }
    if (path === '/apps/orders-db/backups' && method === 'POST') {
      return json({ app: 'orders-db', backup: { file: '20261007T120000Z.dump', bytes: 2_500_000, createdAt: '2026-10-07T12:00:00.000Z', kind: 'manual' }, pruned: [] });
    }
    if (path === `/apps/orders-db/backups/${BACKUP}` && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'PGDMP custom dump', headers: { 'content-disposition': `attachment; filename="orders-db-${BACKUP}"` } });
    }
    if (path === `/apps/orders-db/backups/${BACKUP}/restore`) {
      return json({ app: 'orders-db', file: BACKUP, safety: { file: '20261007T121500Z-pre-restore.dump', bytes: 2_500_000, createdAt: '2026-10-07T12:15:00.000Z', kind: 'pre-restore' }, method: 'exec' });
    }
    if (path === '/apps/orders-db/backups/schedule') {
      const body = req.postDataJSON() as { schedule: string; keep: number };
      return json({ app: 'orders-db', settings: body });
    }
    if (path === '/apps/orders-db/service/version') {
      return stream([
        { type: 'log', lines: [{ stream: 'stderr', text: `Updating orders-db from ${PG17_OLD} to ${PG17.image}` }] },
        { type: 'log', lines: [{ stream: 'stderr', text: 'Stopping bastion-orders-db before the new container starts (volume data is exclusive)' }, { stream: 'stderr', text: 'Health check passed' }] },
        { type: 'result', outcome: { app: 'orders-db', release: '20261007-130000-11111111', previous: RELEASE, result: 'success', error: null } },
        { type: 'exit', exitCode: 0, signal: null, durationMs: 12000, timedOut: false },
        { type: 'end' },
      ]);
    }
    if (path === '/apps/orders-db/releases') return json([]);
    return json({ error: `not stubbed: ${method} ${path}` }, 404);
  });
}

test.describe('Quick services', () => {
  let serverId: string;
  let admin: { email: string; password: string };
  let operator: { email: string; password: string };
  let viewer: { email: string; password: string };

  test.beforeAll(async () => {
    const owner = await ownerApi();
    const res = await owner.post('/api/servers', {
      data: { name: `services-${Date.now().toString(36)}`, host: '192.0.2.41', username: 'deploy', authType: 'password', password: 'unused', tags: [] },
    });
    expect(res.status(), await res.text()).toBe(201);
    serverId = ((await res.json()) as { id: string }).id;
    await owner.dispose();
    admin = await createMember('admin', 'services');
    operator = await createMember('operator', 'services');
    viewer = await createMember('viewer', 'services');
  });

  test('picks a template from the catalog, fills the form and follows the create log', async ({ page }) => {
    const sent: Sent[] = [];
    await stubServices(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments`);
    const apps = page.getByRole('region', { name: 'Apps' });
    // A service in the list: its template, and that it is one
    await expect(apps.getByRole('row', { name: /orders-db/ })).toContainText('PostgreSQL · service');
    await apps.getByRole('button', { name: 'New service' }).click();

    const dialog = page.getByRole('dialog', { name: 'New service' });
    for (const name of ['PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'MinIO', 'RabbitMQ', 'Grafana', 'Uptime Kuma']) await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible();
    await dialog.getByRole('tab', { name: 'Caches' }).click();
    await expect(dialog.getByRole('button', { name: 'Redis', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'PostgreSQL', exact: true })).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'All' }).click();
    await dialog.getByLabel('Search services').fill('s3');
    await expect(dialog.getByRole('button', { name: 'MinIO', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Redis', exact: true })).toHaveCount(0);
    await dialog.getByLabel('Search services').fill('');
    await snap(page, 'services-catalog');

    // MinIO has a console: the form offers a domain; PostgreSQL does not
    await dialog.getByRole('button', { name: 'MinIO', exact: true }).click();
    await expect(dialog.getByLabel('Domain')).toBeVisible();
    await expect(dialog).toContainText('pgsty/minio');
    await dialog.getByTitle('Back to the catalog').click();
    await dialog.getByRole('button', { name: 'PostgreSQL', exact: true }).click();
    await expect(dialog.getByLabel('Domain')).toHaveCount(0);
    // A free name (orders-db is taken, postgres is not), the default line, the template's memory
    await expect(dialog.getByLabel('Name')).toHaveValue('postgres');
    await expect(dialog.getByLabel('Version')).toHaveValue('17');
    await expect(dialog.getByLabel('Memory')).toHaveValue('512m');
    await dialog.getByLabel('Name').fill('orders-db');
    await expect(dialog.getByText('orders-db exists on this server already')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create PostgreSQL' })).toBeDisabled();
    await dialog.getByLabel('Name').fill('billing-db');
    await dialog.getByLabel('Memory').fill('64m');
    await expect(dialog.getByText('At least 128m')).toBeVisible();
    await dialog.getByLabel('Memory').fill('1g');

    // Public: a warning, and a port is needed
    await dialog.getByLabel('The internet').check();
    await expect(dialog.getByRole('alert')).toContainText('Anyone on the internet can try to connect to PostgreSQL on port 15432');
    await dialog.getByLabel('This server’s localhost').check();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByLabel('Host port').fill('25432');
    await snap(page, 'services-create-form');
    await dialog.getByRole('button', { name: 'Create PostgreSQL' }).click();

    const log = dialog.getByTestId('deploy-log');
    await expect(log).toContainText('Generated POSTGRES_PASSWORD on the server');
    await expect(log).toContainText('Health check passed');
    await expect(dialog).toContainText(`Created billing-db: release ${RELEASE} is running`);
    expect(sent).toEqual([{ method: 'POST', path: '/services', body: { name: 'billing-db', template: 'postgres', version: '17', memory: '1g', publish: { scope: 'localhost', port: 25432 } } }]);
    await dialog.getByRole('button', { name: 'Open billing-db' }).click();
    await expect(page).toHaveURL(new RegExp(`/servers/${serverId}/deployments/billing-db$`));
  });

  test('shows how to connect, the password revealed on request', async ({ page }) => {
    const sent: Sent[] = [];
    await stubServices(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/orders-db`);
    await expect(page.getByText(`PostgreSQL 17.1-alpine`)).toBeVisible();
    const panel = page.getByRole('region', { name: 'Connection' });
    await expect(panel.getByTestId('connection-string')).toHaveText('postgres://app:••••••••@orders-db:5432/app');
    await expect(panel).toContainText('ssh -L 15432:127.0.0.1:15432');
    await expect(panel.getByRole('button', { name: 'Copy URL', exact: true })).toBeDisabled();
    await expect(page.getByText('Gen3rated-Pa55word')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Reveal password' }).click();
    await expect(panel.getByTestId('connection-string')).toHaveText('postgres://app:Gen3rated-Pa55word@orders-db:5432/app');
    await expect(panel).toContainText('postgres://app:Gen3rated-Pa55word@127.0.0.1:15432/app');
    await expect(panel.getByRole('button', { name: 'Copy URL', exact: true })).toBeEnabled();
    await snap(page, 'services-connection');
    await panel.getByRole('button', { name: 'Hide password' }).click();
    await expect(page.getByText('Gen3rated-Pa55word')).toHaveCount(0);
    await expect(panel.getByRole('link', { name: /Connecting from Node.js/ })).toHaveAttribute('href', '/docs/deployments/services-postgres');
    expect(sent).toEqual([{ method: 'POST', path: '/apps/orders-db/env/POSTGRES_PASSWORD/reveal', body: null }]);
  });

  test('backs up, downloads, restores with the name typed, and changes the schedule', async ({ page }) => {
    const sent: Sent[] = [];
    await stubServices(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/orders-db`);
    await page.getByRole('tab', { name: 'Backups' }).click();
    const backups = page.getByRole('region', { name: 'Backups' });
    await expect(backups.getByRole('row', { name: new RegExp(BACKUP) })).toContainText('Scheduled');
    await expect(backups.getByRole('row', { name: /pre-restore/ })).toContainText('Before a restore');
    await expect(page.getByRole('region', { name: 'Schedule' })).toContainText('bastion-cron container on the server runs it (running)');
    await snap(page, 'services-backups');

    await backups.getByRole('button', { name: 'Back up now' }).click();
    await expect(page.getByText(/Backed up orders-db: 20261007T120000Z\.dump/)).toBeVisible();

    const download = page.waitForEvent('download');
    await backups.getByRole('button', { name: `Download ${BACKUP}` }).click();
    expect((await download).suggestedFilename()).toBe(`orders-db-${BACKUP}`);

    await backups.getByRole('button', { name: `Restore ${BACKUP}` }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Restore orders-db' });
    await expect(confirm).toContainText('A backup of the data as it is now is made first');
    await expect(confirm.getByRole('button', { name: 'Restore' })).toBeDisabled();
    await confirm.getByLabel('Service name').fill('orders');
    await expect(confirm.getByRole('button', { name: 'Restore' })).toBeDisabled();
    await confirm.getByLabel('Service name').fill('orders-db');
    await confirm.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('Restored orders-db from 20261007T030000Z.dump; the data before is in 20261007T121500Z-pre-restore.dump')).toBeVisible();

    const schedule = page.getByRole('region', { name: 'Schedule' });
    await schedule.getByLabel('Backup schedule').selectOption('hourly');
    await schedule.getByLabel('Backups kept').fill('24');
    await schedule.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Backing up hourly, keeping 24')).toBeVisible();

    expect(sent.map((s) => [s.method, s.path, s.body])).toEqual([
      ['POST', '/apps/orders-db/backups', null],
      ['POST', `/apps/orders-db/backups/${BACKUP}/restore`, { confirm: 'orders-db' }],
      ['PUT', '/apps/orders-db/backups/schedule', { schedule: 'hourly', keep: 24 }],
    ]);
  });

  test('updates within the line and refuses another major', async ({ page }) => {
    const sent: Sent[] = [];
    await stubServices(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/orders-db`);
    await page.getByRole('button', { name: 'Update version' }).click();
    const dialog = page.getByRole('dialog', { name: 'Update orders-db' });
    await expect(dialog).toContainText('update available');
    await dialog.getByLabel(/PostgreSQL 16/).check();
    await expect(dialog.getByRole('alert')).toContainText('PostgreSQL cannot be moved from PostgreSQL 17 to PostgreSQL 16 in place');
    await expect(dialog.getByRole('button', { name: 'Update' })).toBeDisabled();
    await dialog.getByLabel(/PostgreSQL 17/).check();
    await expect(dialog).toContainText('stops, then starts on');
    await dialog.getByRole('button', { name: 'Update' }).click();
    const log = page.getByTestId('deploy-log');
    await expect(log).toContainText(`to ${PG17.image}`);
    await expect(page.getByText(`Updated to PostgreSQL 17 (${PG17.version}): release 20261007-130000-11111111`)).toBeVisible();
    expect(sent).toEqual([{ method: 'POST', path: '/apps/orders-db/service/version', body: { version: '17' } }]);
  });

  test('offers each role what it may do', async ({ page }) => {
    const sent: Sent[] = [];
    await stubServices(page, serverId, sent);
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(`/servers/${serverId}/deployments`);
    await expect(page.getByRole('button', { name: 'New service' })).toHaveCount(0);
    await page.goto(`/servers/${serverId}/deployments/orders-db`);
    await expect(page.getByRole('region', { name: 'Connection' })).toContainText('Revealing the password needs manage access');
    await expect(page.getByRole('button', { name: 'Reveal password' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Update version' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Backups' }).click();
    await expect(page.getByRole('button', { name: 'Back up now' })).toBeVisible();
    await expect(page.getByRole('button', { name: `Download ${BACKUP}` })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Restore ${BACKUP}` })).toHaveCount(0);

    await page.context().clearCookies();
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto(`/servers/${serverId}/deployments/orders-db`);
    await page.getByRole('tab', { name: 'Backups' }).click();
    await expect(page.getByRole('region', { name: 'Backups' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back up now' })).toHaveCount(0);
    expect(sent).toEqual([]);
  });
});
