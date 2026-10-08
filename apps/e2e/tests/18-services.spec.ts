import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { createMember, expect, ownerApi, signInWithPassword, snap, test } from './fixtures.js';

/**
 * Quick services (services spec §3.3, §3.4) against a stubbed
 * `/api/deploy`: the catalog (categories, search) and the create form
 * (publish warning, a domain only for UI services) with the create log
 * streaming, then a PostgreSQL service's page — the Connection panel with
 * the password revealed on request, the Backups tab (back up now, download,
 * restore with the name typed, the schedule), Update version within the
 * line, refused across it, and Roll back kept off for a release on another
 * line. SeaweedFS leads object storage, recommended. And what each role is
 * offered.
 */

const PINS = JSON.parse(readFileSync(new URL('../../../packages/shared/src/services/images.json', import.meta.url), 'utf8')) as Record<string, Record<string, { image: string; version: string }>>;
const PG17 = PINS.postgres!['17']!;
const PG17_OLD = PG17.image.replace(/:[^@]+@/, ':17.1-alpine@');
const RELEASE = '20261007-120000-abcdef12';
const BACKUP = '20261007T030000Z.dump';
/** Kept releases: the current one, an older one of the same line, and one of PostgreSQL 16 (refused). */
const SAME_LINE = '20261006-120000-22222222';
const OTHER_LINE = '20261005-120000-33333333';
const REFUSED = `Release ${OTHER_LINE} runs another line: PostgreSQL cannot be moved from PostgreSQL 17 to PostgreSQL 16 in place.`;
const releaseOf = (id: string, ref: string, line: string, extra: Record<string, unknown>) => ({
  id,
  app: 'orders-db',
  createdAt: '2026-10-07T12:00:00.000Z',
  finishedAt: '2026-10-07T12:00:30.000Z',
  actor: 'ann@example.com',
  checksum: 'a'.repeat(64),
  image: `bastion-orders-db:${id}`,
  container: `bastion-orders-db-${id}`,
  port: 5432,
  buildType: 'image',
  result: 'success',
  error: null,
  previous: null,
  digest: ref.split('@')[1],
  ref,
  service: 'postgres',
  line,
  current: false,
  imagePresent: true,
  ...extra,
});
const RELEASES = [
  releaseOf(RELEASE, PG17_OLD, '17', { current: true }),
  releaseOf(SAME_LINE, PG17_OLD, '17', { rollbackRefused: null }),
  releaseOf(OTHER_LINE, PINS.postgres!['16']!.image, '16', { rollbackRefused: REFUSED }),
];

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

/** A Ubuntu 24.04 kernel on AWS: upstream 7.0.14, reported as 7.0.0 — MongoDB 8 refuses it. */
const UBUNTU_AWS = '7.0.0-1012-aws';
const MONGO8_OLD = PINS.mongodb!['8.0']!.image.replace(/:[^@]+@/, ':8.0.30@');
const KERNEL_DOCS = '/docs/deployments/troubleshooting#mongodb-8-wont-start-on-linux-kernel-619';

async function stubServices(page: Page, serverId: string, sent: Sent[], opts: { kernelVersion?: string } = {}) {
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
    if (path === '/') return json({ root: '/opt/bastion', integrity: 'ok', version: '0.1.0', ...(opts.kernelVersion && { kernelVersion: opts.kernelVersion }) });
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
    if (path === '/apps/events-db' && method === 'GET') {
      return json({
        ...ordersDb,
        name: 'events-db',
        service: 'mongodb',
        container: { ...container, name: `bastion-events-db-${RELEASE}` },
        config: {
          name: 'events-db',
          service: 'mongodb',
          domains: [],
          redirect_www: 'none',
          tls: 'auto',
          build: { type: 'image', node: null, dir: '.', output: null, image: MONGO8_OLD },
          run: { port: 27017, env_file: '.env', volumes: [{ name: 'data', path: '/data/db', readonly: false, exclusive: true }], memory: '1g', cpus: null, strategy: 'recreate', publish: { scope: 'none', port: null, target: null } },
          healthcheck: { type: 'command', path: '/', command: ['mongosh', '--eval', 'quit()'], timeout: '120s' },
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
    if (path === '/apps/orders-db/releases') return json(RELEASES);
    if (path === '/apps/orders-db/rollback') {
      const release = (req.postDataJSON() as { release: string }).release;
      return stream([
        { type: 'log', lines: [{ stream: 'stderr', text: `Rolling orders-db back to ${release}` }, { stream: 'stderr', text: 'Health check passed' }] },
        { type: 'result', outcome: { app: 'orders-db', release, previous: RELEASE, result: 'success', error: null } },
        { type: 'exit', exitCode: 0, signal: null, durationMs: 9000, timedOut: false },
        { type: 'end' },
      ]);
    }
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
    // Object storage: SeaweedFS first, recommended; MinIO after it, a community image
    await dialog.getByRole('tab', { name: 'Object storage' }).click();
    const storage = dialog.getByRole('listitem');
    await expect(storage).toHaveCount(2);
    await expect(storage.nth(0)).toContainText('SeaweedFS');
    await expect(storage.nth(0).getByText('Recommended', { exact: true })).toBeVisible();
    await expect(storage.nth(1)).toContainText('MinIO');
    await expect(storage.nth(1).getByText('Community image', { exact: true })).toBeVisible();
    await expect(storage.nth(1).getByText('Recommended', { exact: true })).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'All' }).click();
    await dialog.getByLabel('Search services').fill('s3');
    await expect(dialog.getByRole('button', { name: 'SeaweedFS', exact: true })).toBeVisible();
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

  test('keeps Roll back off for a release on another version line, saying why', async ({ page }) => {
    const sent: Sent[] = [];
    await stubServices(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/orders-db`);
    await page.getByRole('tab', { name: 'Releases' }).click();
    await expect(page.getByRole('row', { name: `Release ${RELEASE}` })).toContainText('line 17');

    const refused = page.getByRole('row', { name: `Release ${OTHER_LINE}` });
    await expect(refused).toContainText('line 16');
    await expect(refused.getByRole('button', { name: `Roll back to ${OTHER_LINE}` })).toBeDisabled();
    await expect(refused.getByTestId('rollback-refused')).toHaveAttribute('title', REFUSED);
    await expect(refused.getByRole('link', { name: 'Another version line' })).toHaveAttribute('href', '/docs/deployments/releases-rollback#version-lines');
    await refused.getByTestId('rollback-refused').hover();
    await snap(page, 'services-rollback-refused');

    // The same line rolls back as usual
    const same = page.getByRole('row', { name: `Release ${SAME_LINE}` });
    await expect(same.getByRole('button', { name: `Roll back to ${SAME_LINE}` })).toBeEnabled();
    await expect(same.getByRole('link', { name: 'Another version line' })).toHaveCount(0);
    await same.getByRole('button', { name: `Roll back to ${SAME_LINE}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Roll back' }).click();
    await expect(page.getByTestId('deploy-log')).toContainText(`Rolling orders-db back to ${SAME_LINE}`);
    expect(sent).toEqual([{ method: 'POST', path: '/apps/orders-db/rollback', body: { release: SAME_LINE } }]);
  });

  test('on a kernel MongoDB 8 refuses, offers 7.0 and keeps 8.0 off, saying why', async ({ page }) => {
    const sent: Sent[] = [];
    await stubServices(page, serverId, sent, { kernelVersion: UBUNTU_AWS });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments`);
    await page.getByRole('region', { name: 'Apps' }).getByRole('button', { name: 'New service' }).click();
    const dialog = page.getByRole('dialog', { name: 'New service' });
    await dialog.getByRole('button', { name: 'MongoDB', exact: true }).click();

    // 7.0 by default; 8.0 listed, disabled, with the reason on hover
    const version = dialog.getByLabel('Version');
    await expect(version).toHaveValue('7.0');
    const m8 = version.locator('option[value="8.0"]');
    // A closed select's options are not "enabled" to Playwright: their property says it
    await expect(m8).toHaveJSProperty('disabled', true);
    await expect(m8).toContainText('won’t start on this server’s kernel');
    await expect(m8).toHaveAttribute('title', /SERVER-121912.*Use MongoDB 7\.0 on this server\./);
    await expect(version.locator('option[value="7.0"]')).toHaveJSProperty('disabled', false);
    const note = dialog.getByTestId('kernel-note');
    await expect(note).toContainText(`MongoDB 8.0 won’t start on this server’s Linux kernel (${UBUNTU_AWS})`);
    await expect(note).toContainText('MongoDB 7.0 is picked instead.');
    await expect(note.getByRole('link', { name: 'Why, and how to check' })).toHaveAttribute('href', KERNEL_DOCS);
    await snap(page, 'services-mongodb-kernel');
    await expect(dialog.getByRole('button', { name: 'Create MongoDB' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Create MongoDB' }).click();
    expect(sent).toEqual([{ method: 'POST', path: '/services', body: { name: 'mongodb', template: 'mongodb', version: '7.0', memory: '1g', publish: { scope: 'none' } } }]);

    // Update version of a MongoDB 8.0 service on the same server: the newer 8.0 release is not offered either
    sent.length = 0;
    await page.goto(`/servers/${serverId}/deployments/events-db`);
    await page.getByRole('button', { name: 'Update version' }).click();
    const update = page.getByRole('dialog', { name: 'Update events-db' });
    await expect(update.getByLabel(/MongoDB 8\.0/)).toBeChecked();
    await expect(update).toContainText('(won’t start on this server’s kernel)');
    await expect(update.getByTestId('kernel-note')).toContainText('Use MongoDB 7.0: delete this service and create it again with version 7.0');
    await expect(update.getByTestId('kernel-note').getByRole('link', { name: 'Why, and how to check' })).toHaveAttribute('href', KERNEL_DOCS);
    await expect(update.getByRole('button', { name: 'Update' })).toBeDisabled();
    expect(sent).toEqual([]);
  });

  test('offers MongoDB 8.0 by default where the kernel is older', async ({ page }) => {
    await stubServices(page, serverId, [], { kernelVersion: '6.8.0-45-generic' });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments`);
    await page.getByRole('region', { name: 'Apps' }).getByRole('button', { name: 'New service' }).click();
    const dialog = page.getByRole('dialog', { name: 'New service' });
    await dialog.getByRole('button', { name: 'MongoDB', exact: true }).click();
    await expect(dialog.getByLabel('Version')).toHaveValue('8.0');
    await expect(dialog.getByLabel('Version').locator('option[value="8.0"]')).toHaveJSProperty('disabled', false);
    await expect(dialog.getByTestId('kernel-note')).toHaveCount(0);
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
