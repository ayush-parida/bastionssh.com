import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import { createMember, expect, ownerApi, signInWithPassword, snap, test } from './fixtures.js';

/**
 * Builds on the BastionSSH side (bastion-side builds spec), browser side,
 * against a stubbed `/api/deploy`: the "Build on" choice in the config form,
 * the Deploy dialog's choice of where to build (with the note on emulation
 * when the server's architecture is not the builder's), environment files
 * left out of the upload unless included (with the warning), the build's
 * progress in the log panel, and the builder on the Setup line with Clear
 * build cache. Nothing connects to a server or a builder.
 */

const RELEASE = '20261009-120000-abcdef12';

interface Sent {
  method: string;
  path: string;
  body: unknown;
  raw: Buffer | null;
}

const CONFIG = ['name: site1', 'domains: [site1.example.com]', 'build:', '  type: nextjs', 'run:', '  port: 3000', ''].join('\n');

/** The file names in an uploaded deploy source (a gzipped tar inside one multipart body), sorted. */
function uploadedNames(raw: Buffer): string[] {
  const start = raw.indexOf(Buffer.from([0x1f, 0x8b]));
  const end = raw.lastIndexOf(Buffer.from('\r\n--'));
  const tar = gunzipSync(raw.subarray(start, end));
  const names: string[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = tar.subarray(at, at + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(at + 124, at + 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    names.push(name);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return names.sort();
}

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

interface Stub {
  /** `GET /api/deploy/builder`: none configured, or one on `platform`. */
  builder: { configured: boolean; platform?: string };
  /** The server's Docker platform. */
  serverPlatform: string;
  /** site1's `build.where` in bastion.yml. */
  where?: 'server' | 'bastion';
}

async function stub(page: Page, serverId: string, sent: Sent[], s: Stub) {
  const record = (route: Route, path: string) => {
    const req = route.request();
    if (req.method() === 'GET') return;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    sent.push({ method: req.method(), path, body, raw: req.postDataBuffer() });
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route(`**/api/docker/servers/${serverId}**`, (route) => json(route, { error: 'Not found' }, 404));
  await page.route('**/api/deploy/builder**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/deploy', '');
    record(route, path);
    if (path === '/builder/prune') return json(route, { reclaimedBytes: 3 * 1024 ** 3, records: 42 });
    const on = s.builder.configured;
    return json(route, {
      configured: on,
      reachable: on,
      platform: on ? (s.builder.platform ?? 'linux/arm64') : null,
      platforms: on ? ['linux/arm64', 'linux/amd64'] : [],
      version: on ? 'v0.33.1' : null,
      cacheBytes: on ? 1536 * 1024 ** 2 : null,
      cacheLimitBytes: on ? 10e9 : null,
      running: null,
      queued: 0,
      error: null,
    });
  });
  await page.route(`**/api/deploy/servers/${serverId}**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(`/api/deploy/servers/${serverId}`, '') || '/';
    record(route, `${path}${url.search}`);
    const method = req.method();
    if (path === '/') return json(route, { root: '/opt/bastion', integrity: 'ok', version: '0.1.0' });
    if (path === '/proxy') {
      return json(route, {
        mode: 'caddy',
        nginx: { detected: false, installed: false, running: false, ports: { http: false, https: false }, certbot: false, confInclude: false, helper: 'missing', sudo: false },
        helperPath: '/usr/local/sbin/bastion-nginx',
        instructions: [],
      });
    }
    if (path === '/platform') return json(route, { platform: s.serverPlatform });
    if (path === '/apps') return json(route, []);
    if (path === '/apps/site1' && method === 'GET') {
      return json(route, {
        name: 'site1',
        domains: ['site1.example.com'],
        buildType: 'nextjs',
        currentRelease: null,
        container: null,
        configError: null,
        locked: false,
        permissions: { deploy: 'operate' },
        config: {
          name: 'site1',
          domains: ['site1.example.com'],
          redirect_www: 'none',
          tls: 'auto',
          build: { type: 'nextjs', node: null, dir: '.', output: null, image: null, ...(s.where && { where: s.where }) },
          run: { port: 3000, env_file: '.env', volumes: [], memory: null, cpus: null },
          healthcheck: { path: '/', timeout: '30s' },
          keep_releases: 5,
          proxy: 'caddy',
        },
        previousRelease: null,
        lock: null,
      });
    }
    if (path === '/apps/site1/releases') return json(route, []);
    if (path === '/apps/site1/config' && method === 'GET') return json(route, { text: CONFIG });
    if (path === '/apps/site1/config' && method === 'PUT') return json(route, { app: 'site1', created: false });
    if (path === '/apps/site1/deploy') {
      const bastion = url.searchParams.get('where') === 'bastion' || (!url.searchParams.get('where') && s.where === 'bastion');
      const events = bastion
        ? [
            { type: 'build', state: 'building', platform: s.serverPlatform },
            { type: 'log', lines: [{ stream: 'stderr', text: `Building on BastionSSH for ${s.serverPlatform} (BuildKit v0.33.1 on linux/arm64)` }] },
            { type: 'build', state: 'loading' },
            { type: 'log', lines: [{ stream: 'stderr', text: `Loaded bastion-site1:${RELEASE} into the server's Docker (41.0 MiB sent) in 6 s` }] },
            { type: 'build', state: 'deploying' },
            { type: 'log', lines: [{ stream: 'stderr', text: 'Health check passed' }] },
          ]
        : [{ type: 'log', lines: [{ stream: 'stderr', text: 'Building image bastion-site1' }] }];
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          ...events,
          { type: 'result', outcome: { app: 'site1', release: RELEASE, previous: null, result: 'success', error: null } },
          { type: 'exit', exitCode: 0, signal: null, durationMs: 61000, timedOut: false },
          { type: 'end' },
        ]),
      });
    }
    return json(route, { error: `not stubbed: ${method} ${path}` }, 404);
  });
}

/** A project folder with a .env.local beside its source; returns its path and a cleanup. */
function project(): { dir: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'bsb-e2e-'));
  const dir = join(root, 'my-site');
  mkdirSync(join(dir, 'app'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"my-site","scripts":{"build":"next build"}}');
  writeFileSync(join(dir, 'app/page.js'), 'export default function Page() { return null; }');
  writeFileSync(join(dir, '.env.local'), 'STRIPE_SECRET_KEY=sk_live_never_uploaded');
  writeFileSync(join(dir, '.env.example'), 'STRIPE_SECRET_KEY=');
  return { dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test.describe('Builds on BastionSSH', () => {
  let serverId: string;
  let admin: { email: string; password: string };

  test.beforeAll(async () => {
    const owner = await ownerApi();
    const res = await owner.post('/api/servers', {
      data: { name: `bsb-${Date.now().toString(36)}`, host: '192.0.2.41', username: 'deploy', authType: 'password', password: 'unused', tags: [] },
    });
    expect(res.status(), await res.text()).toBe(201);
    serverId = ((await res.json()) as { id: string }).id;
    await owner.dispose();
    admin = await createMember('admin', 'bsb');
  });

  test('the config form sets build.where and build.args', async ({ page }) => {
    const sent: Sent[] = [];
    await stub(page, serverId, sent, { builder: { configured: true }, serverPlatform: 'linux/arm64' });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await page.getByRole('tab', { name: 'Config' }).click();

    const where = page.getByLabel('Build on', { exact: true });
    await expect(where).toHaveValue('server');
    await where.selectOption('bastion');
    await expect(page.getByText('the server never runs npm or the build')).toBeVisible();
    await page.getByLabel('Build args').fill('SENTRY_RELEASE');
    await snap(page, 'bastion-build-config');
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect(page.getByText('bastion.yml saved')).toBeVisible();

    const put = sent.find((x) => x.method === 'PUT' && x.path === '/apps/site1/config');
    const text = (put?.body as { text: string }).text;
    expect(text).toMatch(/^ {2}where: bastion$/m);
    expect(text).toMatch(/^ {2}args:\n {4}- SENTRY_RELEASE$/m);

    // Back to the default: the key goes away
    await where.selectOption('server');
    await page.getByLabel('Build args').fill('');
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect.poll(() => sent.filter((x) => x.method === 'PUT').length).toBe(2);
    const back = (sent.filter((x) => x.method === 'PUT')[1]!.body as { text: string }).text;
    expect(back).not.toMatch(/where:|args:/);
    expect(back).toContain('build:\n  type: nextjs\n');
  });

  test('the Deploy dialog builds on BastionSSH for another architecture, says it is emulated, and leaves .env.local out', async ({ page }) => {
    const sent: Sent[] = [];
    await stub(page, serverId, sent, { builder: { configured: true, platform: 'linux/arm64' }, serverPlatform: 'linux/amd64' });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await expect(page.getByRole('heading', { name: 'site1' })).toBeVisible();

    const p = project();
    try {
      await page.getByRole('button', { name: 'Deploy', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Deploy site1' });
      const where = dialog.getByRole('group', { name: 'Where to build' });
      await expect(where.getByRole('radio', { name: /The server/ })).toBeChecked();
      await expect(dialog.getByLabel('Emulated build')).toHaveCount(0);
      await where.getByRole('radio', { name: /BastionSSH/ }).check();
      await expect(dialog.getByLabel('Emulated build')).toContainText('The server runs linux/amd64 and the builder is linux/arm64');
      await expect(dialog.getByLabel('Emulated build')).toContainText('several times slower');

      await dialog.getByLabel('Project folder').setInputFiles(p.dir);
      await expect(dialog.getByTestId('env-files-left-out')).toContainText('Left out of the upload: .env.local');
      await expect(dialog.getByLabel('Environment files included')).toHaveCount(0);
      await snap(page, 'bastion-build-deploy-dialog');
      await dialog.getByRole('button', { name: 'Deploy' }).click();
    } finally {
      p.done();
    }

    const log = page.getByRole('region', { name: 'Deploy log' });
    await expect(log).toContainText(`Deployed release ${RELEASE}`);
    await expect(log.getByTestId('deploy-log')).toContainText('Building on BastionSSH for linux/amd64');
    await expect(log.getByTestId('deploy-log')).toContainText(`Loaded bastion-site1:${RELEASE} into the server's Docker`);

    const upload = sent.find((x) => x.path.startsWith('/apps/site1/deploy'));
    expect(upload?.path).toBe('/apps/site1/deploy?where=bastion');
    expect(uploadedNames(upload!.raw!)).toEqual(['.env.example', 'app/page.js', 'package.json']);
  });

  test('including environment files warns first, then uploads them; bastion.yml’s choice needs no query', async ({ page }) => {
    const sent: Sent[] = [];
    await stub(page, serverId, sent, { builder: { configured: true }, serverPlatform: 'linux/arm64', where: 'bastion' });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);

    const p = project();
    try {
      await page.getByRole('button', { name: 'Deploy', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Deploy site1' });
      // Preset from build.where; same platform: nothing about emulation
      await expect(dialog.getByRole('radio', { name: /BastionSSH/ })).toBeChecked();
      await expect(dialog.getByText('(bastion.yml)')).toBeVisible();
      await dialog.getByLabel('Project folder').setInputFiles(p.dir);
      await expect(dialog.getByTestId('env-files-left-out')).toBeVisible();
      await expect(dialog.getByLabel('Emulated build')).toHaveCount(0);

      await dialog.getByLabel('Include environment files').check();
      const warning = dialog.getByLabel('Environment files included');
      await expect(warning).toContainText('(.env.local) go up with the source');
      await expect(warning).toContainText('can end up in the image');
      await expect(dialog.getByTestId('env-files-left-out')).toHaveCount(0);
      await snap(page, 'bastion-build-env-warning');
      await dialog.getByRole('button', { name: 'Deploy' }).click();
    } finally {
      p.done();
    }

    await expect(page.getByRole('region', { name: 'Deploy log' })).toContainText(`Deployed release ${RELEASE}`);
    const upload = sent.find((x) => x.path.startsWith('/apps/site1/deploy'));
    expect(upload?.path).toBe('/apps/site1/deploy?includeEnvFiles=true');
    expect(uploadedNames(upload!.raw!)).toEqual(['.env.example', '.env.local', 'app/page.js', 'package.json']);
  });

  test('without a builder, building on BastionSSH cannot be chosen', async ({ page }) => {
    const sent: Sent[] = [];
    await stub(page, serverId, sent, { builder: { configured: false }, serverPlatform: 'linux/amd64' });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await expect(page.getByLabel('Builder')).toContainText('not set up on this BastionSSH');
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Deploy site1' });
    await expect(dialog.getByRole('radio', { name: /BastionSSH/ })).toBeDisabled();
    await expect(dialog).toContainText('This BastionSSH has no builder (SMT_BUILDKIT_ADDR is not set)');
    expect(sent.filter((x) => x.path === '/platform')).toEqual([]);
  });

  test('the Setup line shows the builder, and a manager clears its cache', async ({ page }) => {
    const sent: Sent[] = [];
    await stub(page, serverId, sent, { builder: { configured: true, platform: 'linux/arm64' }, serverPlatform: 'linux/amd64' });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments`);
    const line = page.getByLabel('Builder');
    await expect(line).toContainText('linux/arm64');
    await expect(line).toContainText('BuildKit v0.33.1');
    await expect(line).toContainText('Cache 1.5 GB');
    await expect(line).toContainText('Idle');
    await snap(page, 'bastion-build-setup-line');
    await line.getByRole('button', { name: 'Clear build cache' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear build cache' }).click();
    await expect(page.getByText('Build cache cleared: 3 GB freed')).toBeVisible();
    expect(sent.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /builder/prune']);
  });
});
