import { crc32, gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import { createMember, expect, ownerApi, signInWithPassword, snap, test } from './fixtures.js';

/**
 * The Deployments tab against a stubbed `/api/deploy`: no SSH server or
 * Docker is involved. Under test is the browser side — Setup, the app list,
 * a deploy with its upload and streamed log (a folder is packed without
 * node_modules, .next and .git), Rollback, bastion.yml validation errors
 * shown next to their fields, the write-only .env editor, and which buttons
 * each role gets. The server under test is real (the Deployments module
 * shows only with a server in sight); nothing connects to it.
 */

const RELEASE = '20261005-120000-abcdef12';
const OLD = '20261004-090000-12345678';

interface Sent {
  method: string;
  path: string;
  body: unknown;
  raw: Buffer | null;
}

const CONFIG = ['# managed by the web e2e', 'name: site1', 'domains: [site1.example.com]', 'build:', '  type: nextjs', 'run:', '  port: 3000', ''].join('\n');

function summary(name: string) {
  return {
    name,
    domains: [`${name}.example.com`],
    buildType: 'nextjs',
    currentRelease: RELEASE,
    container: { name: `bastion-${name}-${RELEASE}`, id: 'c'.repeat(64), state: 'running', status: 'Up 2 hours', health: 'healthy' },
    configError: null,
    locked: false,
    permissions: { deploy: 'operate' },
    // What bastionctl's list reports per app: the certificate expiring first and one stats read
    certificate: name === 'site1' ? { issuer: "Let's Encrypt R11", notAfter: '2099-01-01T00:00:00Z', daysLeft: 45, lastError: null } : null,
    usage: name === 'site1' ? { cpuPercent: 2.5, memoryBytes: 128 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024 } : null,
  };
}

function release(id: string, current: boolean) {
  return {
    id,
    app: 'site1',
    createdAt: '2026-10-05T12:00:00Z',
    finishedAt: '2026-10-05T12:01:00Z',
    actor: 'admin@e2e.example.com',
    checksum: 'f'.repeat(64),
    image: `bastion-site1:${id}`,
    container: `bastion-site1-${id}`,
    port: 3000,
    buildType: 'nextjs',
    result: 'success',
    error: null,
    previous: null,
    current,
    imagePresent: true,
  };
}

/** The file names in an uploaded deploy source: a gzipped tar inside one multipart body, sorted. */
function uploadedNames(raw: Buffer): string[] {
  expect(raw.toString('latin1')).toContain('name="source"; filename="site1.tar.gz"');
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

/** A zip of `files` with stored (uncompressed) entries, as a test fixture. */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/**
 * Answer the tab's calls; everything but GETs is recorded in `sent`. `state.setUp` flips when Setup runs;
 * `state.deployLevel` is site1's bastion.yml `permissions.deploy`; `state.buildType` its build type
 * (static: `output: .`); `state.deployFails` makes a deploy fail its health check.
 */
async function stubDeploy(
  page: Page,
  serverId: string,
  sent: Sent[],
  state: { setUp: boolean; deployLevel?: 'operate' | 'manage'; buildType?: 'nextjs' | 'static'; deployFails?: boolean } = { setUp: true },
) {
  // The app's Runtime section asks Docker; nothing to show here
  await page.route(`**/api/docker/servers/${serverId}**`, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' }));
  await page.route(`**/api/deploy/servers/${serverId}**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(`/api/deploy/servers/${serverId}`, '') || '/';
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const method = req.method();
    if (method !== 'GET') {
      const raw = req.postDataBuffer();
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      sent.push({ method, path: `${path}${url.search}`, body, raw });
    }

    if (method === 'GET' && path === '/') {
      return json({ root: state.setUp ? '/opt/bastion' : null, integrity: state.setUp ? 'ok' : 'missing', version: '0.1.0' });
    }
    if (path === '/setup') {
      state.setUp = true;
      return json({
        root: '/opt/bastion',
        proxy: 'caddy',
        network: 'bastion-apps',
        proxyContainer: { name: 'bastion-caddy', id: 'p'.repeat(64), state: 'running', status: 'Up 1 second', health: null },
        version: '0.1.0',
        sudo: true,
        socket: 'writable',
      });
    }
    if (path === '/proxy') {
      return json({
        mode: state.setUp ? 'caddy' : null,
        nginx: { detected: false, installed: false, running: false, ports: { http: false, https: false }, certbot: false, confInclude: false, helper: 'missing', sudo: false },
        helperPath: '/usr/local/sbin/bastion-nginx',
        instructions: [],
      });
    }
    if (path === '/apps') {
      // What a bastionctl that reports them adds: site1's certificate and its container's usage; blog reports neither
      const site1 = {
        ...summary('site1'),
        certificate: { issuer: "Let's Encrypt R11", notAfter: new Date(Date.now() + 9.5 * 86_400_000).toISOString(), daysLeft: 9, lastError: null },
        usage: { memoryBytes: 128 * 1024 ** 2, memoryLimitBytes: 512 * 1024 ** 2, cpuPercent: 2.5 },
      };
      return json(state.setUp ? [site1, summary('blog')] : []);
    }
    if (path === '/apps/site1/domains') {
      return json({
        app: 'site1',
        proxy: 'caddy',
        tls: 'auto',
        serverAddresses: ['203.0.113.10'],
        addressSource: 'host',
        domains: [
          {
            domain: 'site1.example.com',
            dns: {
              status: 'wrong',
              addresses: ['198.51.100.7'],
              detail: 'site1.example.com points at 198.51.100.7, not this server (203.0.113.10). Set the record below at your DNS provider, replacing the old value.',
              records: [{ type: 'A', name: 'site1.example.com', value: '203.0.113.10' }],
            },
            certificate: {
              domain: 'site1.example.com',
              source: 'acme',
              issuer: "Let's Encrypt R11",
              notBefore: new Date(Date.now() - 30 * 86_400_000).toISOString(),
              notAfter: new Date(Date.now() + 60 * 86_400_000).toISOString(),
              lastError: null,
              state: 'valid',
              daysLeft: 59,
            },
          },
        ],
        ports: [
          { port: 80, status: 'open', detail: 'Connected' },
          { port: 443, status: 'filtered', detail: 'No answer', remediation: 'Allow inbound TCP 443 from anywhere' },
        ],
        certificatesError: null,
        checkedAt: new Date().toISOString(),
      });
    }
    if (path === '/apps/site1' && method === 'GET') {
      return json({
        ...summary('site1'),
        buildType: state.buildType ?? 'nextjs',
        // bastionctl reports the config's permissions at the top level too
        permissions: { deploy: state.deployLevel ?? 'operate' },
        config: {
          name: 'site1',
          domains: ['site1.example.com'],
          redirect_www: 'none',
          tls: 'auto',
          build: state.buildType === 'static' ? { type: 'static', node: null, dir: '.', output: '.' } : { type: 'nextjs', node: null, dir: '.', output: null },
          run: { port: 3000, env_file: '.env', volumes: [], memory: '512m', cpus: 1 },
          healthcheck: { path: '/', timeout: '30s' },
          keep_releases: 5,
          proxy: 'caddy',
          ...(state.deployLevel && { permissions: { deploy: state.deployLevel } }),
        },
        previousRelease: OLD,
        lock: null,
      });
    }
    if (path === '/apps/site1/releases') return json([release(RELEASE, true), release(OLD, false)]);
    if (path === '/apps/site1/config' && method === 'GET') return json({ text: CONFIG });
    if (path === '/apps/site1/config' && method === 'PUT') {
      const { text } = req.postDataJSON() as { text: string };
      if (/port: 70000/.test(text) || /^extra:/m.test(text)) {
        return json(
          {
            error: 'The config is not valid',
            code: 'invalid_config',
            errors: [
              ...(/port: 70000/.test(text) ? [{ path: 'run.port', message: 'A port from 1 to 65535' }] : []),
              ...(/^extra:/m.test(text) ? [{ path: 'extra', message: 'Unknown key' }] : []),
            ],
          },
          422,
        );
      }
      return json({ app: 'site1', created: false });
    }
    if (path === '/apps/site1/deploy' && state.deployFails) {
      const error = 'Health check failed after 30s: wget: server returned error: HTTP/1.1 500 Internal Server Error';
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          { type: 'log', lines: [{ stream: 'stderr', text: 'Health check: http://bastion-site1:3000/ (up to 30s)' }, { stream: 'stderr', text: `Deploy failed: ${error}` }] },
          { type: 'result', outcome: { app: 'site1', release: '20261005-130000-99999999', previous: RELEASE, result: 'failed', error } },
          { type: 'exit', exitCode: 1, signal: null, durationMs: 31000, timedOut: false },
          { type: 'end' },
        ]),
      });
    }
    if (path === '/apps/site1/deploy') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          { type: 'log', lines: [{ stream: 'stderr', text: 'Unpacking the upload' }, { stream: 'stderr', text: 'Building image bastion-site1' }] },
          { type: 'log', lines: [{ stream: 'stderr', text: 'Health check passed' }] },
          { type: 'result', outcome: { app: 'site1', release: '20261005-130000-99999999', previous: RELEASE, result: 'success', error: null } },
          { type: 'exit', exitCode: 0, signal: null, durationMs: 4200, timedOut: false },
          { type: 'end' },
        ]),
      });
    }
    if (path === '/apps/site1/rollback') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          { type: 'log', lines: [{ stream: 'stderr', text: `Starting bastion-site1-${OLD}` }, { stream: 'stderr', text: 'Proxy switched' }] },
          { type: 'result', outcome: { app: 'site1', release: OLD, previous: RELEASE, result: 'success', error: null } },
          { type: 'exit', exitCode: 0, signal: null, durationMs: 1500, timedOut: false },
          { type: 'end' },
        ]),
      });
    }
    if (path === '/apps/site1/env' && method === 'GET') return json({ keys: ['DATABASE_URL', 'SECRET_KEY'] });
    if (path === '/apps/site1/env/DATABASE_URL/reveal') return json({ key: 'DATABASE_URL', value: 'postgres://app:hunter2@db/app' });
    if (/^\/apps\/site1\/env\/[A-Z_]+$/.test(path)) return json({ key: path.split('/').pop(), changed: true });
    if (path === '/apps/site1/restart' || path === '/apps/site1/stop') return json({ app: 'site1', container: `bastion-site1-${RELEASE}` });
    return json({ error: `not stubbed: ${method} ${path}` }, 404);
  });
}

test.describe('Deployments', () => {
  let serverId: string;
  let admin: { email: string; password: string };

  test.beforeAll(async () => {
    const owner = await ownerApi();
    const res = await owner.post('/api/servers', {
      data: { name: `deploy-${Date.now().toString(36)}`, host: '192.0.2.40', username: 'deploy', authType: 'password', password: 'unused', tags: [] },
    });
    expect(res.status(), await res.text()).toBe(201);
    serverId = ((await res.json()) as { id: string }).id;
    await owner.dispose();
    admin = await createMember('admin', 'deploy');
  });

  test('sets a server up from the tab, then lists its apps', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent, { setUp: false });
    await signInWithPassword(page, admin.email, admin.password);

    // Navigation: the module's page lists servers; each opens its tab
    await page.getByRole('link', { name: 'Deployments' }).click();
    await page.locator(`a[href="/servers/${serverId}/deployments"]`).click();

    const setup = page.getByRole('region', { name: 'Setup' });
    await expect(setup).toContainText('Set up deployments');
    await expect(setup).toContainText('Docker Engine installed and running');
    await expect(setup).toContainText('root-equivalent');
    await setup.getByRole('button', { name: 'Set up deployments' }).click();
    await expect(page.getByText('Deployments are set up')).toBeVisible();
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /setup']);

    const apps = page.getByRole('region', { name: 'Apps' });
    await expect(apps.getByRole('row', { name: /site1/ })).toContainText('site1.example.com');
    await expect(apps.getByRole('row', { name: /site1/ })).toContainText('healthy');
    await expect(apps.getByRole('row', { name: /site1/ })).toContainText(RELEASE);
    await expect(apps.getByRole('row', { name: /blog/ })).toBeVisible();
    // Certificate days left as a badge (amber under 14 days) and memory/CPU, where the server reports them
    await expect(apps.getByRole('columnheader', { name: 'Certificate' })).toBeVisible();
    await expect(apps.getByRole('columnheader', { name: 'Memory / CPU' })).toBeVisible();
    const site1Cert = apps.getByRole('row', { name: /site1/ }).getByText('9 days');
    await expect(site1Cert).toHaveClass(/amber/);
    await expect(site1Cert).toHaveAttribute('title', /Expires .*issued by Let's Encrypt R11/);
    await expect(apps.getByRole('row', { name: /site1/ })).toContainText('2.5%');
    await expect(page.getByText('/opt/bastion', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reinstall' })).toBeVisible();
    await expect(apps.getByRole('button', { name: 'New app' })).toBeVisible();
    await snap(page, 'deployments-tab');
  });

  test('deploys a folder without node_modules, .next and .git, and shows the log as it streams', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await expect(page.getByRole('heading', { name: 'site1' })).toBeVisible();

    const dir = mkdtempSync(join(tmpdir(), 'deploy-e2e-'));
    try {
      const project = join(dir, 'my-site');
      for (const sub of ['src', 'node_modules/react', '.next/cache', '.git']) mkdirSync(join(project, sub), { recursive: true });
      writeFileSync(join(project, 'package.json'), '{"name":"my-site"}');
      writeFileSync(join(project, 'src/index.js'), 'export default 1;');
      writeFileSync(join(project, 'node_modules/react/index.js'), 'module.exports = {};');
      writeFileSync(join(project, '.next/cache/x'), 'cache');
      writeFileSync(join(project, '.git/HEAD'), 'ref: refs/heads/main');

      await page.getByRole('button', { name: 'Deploy', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Deploy site1' });
      // Said before anything is sent: the code runs with the app's secrets
      await expect(dialog.getByRole('note')).toContainText("Deploying runs this code on the server with site1's secrets");
      await dialog.getByLabel('Project folder').setInputFiles(project);
      await expect(dialog).toContainText('my-site/');
      await dialog.getByRole('button', { name: 'Deploy' }).click();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const log = page.getByRole('region', { name: 'Deploy log' });
    await expect(log).toContainText('Deployed release 20261005-130000-99999999');
    await expect(log.getByTestId('deploy-log')).toContainText('Unpacking the upload');
    await expect(log.getByTestId('deploy-log')).toContainText('Health check passed');
    await expect(log).toContainText(`Previously serving ${RELEASE}`);
    await snap(page, 'deploy-log');

    // One multipart upload: a gzipped tar of the project root, without the excluded folders
    const upload = sent.find((s) => s.path === '/apps/site1/deploy');
    expect(upload).toBeTruthy();
    expect(uploadedNames(upload!.raw!)).toEqual(['package.json', 'src/index.js']);
  });

  test('deploys a Finder-made zip from its folder, without the __MACOSX metadata', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await expect(page.getByRole('heading', { name: 'site1' })).toBeVisible();

    // What macOS "Compress" makes of a folder: the folder, and AppleDouble files beside it
    const zip = storedZip({
      'my-site/package.json': '{"name":"my-site"}',
      'my-site/src/index.js': 'export default 1;',
      '__MACOSX/my-site/._package.json': 'resource fork',
    });
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Deploy site1' });
    await dialog.getByLabel('Archive file').setInputFiles({ name: 'my-site.zip', mimeType: 'application/zip', buffer: zip });
    await dialog.getByRole('button', { name: 'Deploy' }).click();

    await expect(page.getByRole('region', { name: 'Deploy log' })).toContainText('Deployed release');
    const upload = sent.find((s) => s.path === '/apps/site1/deploy');
    expect(upload).toBeTruthy();
    // The project root is the upload's root, where build.dir `.` finds package.json
    expect(uploadedNames(upload!.raw!)).toEqual(['package.json', 'src/index.js']);
  });

  test('rolls back to a kept release after a confirmation', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await page.getByRole('tab', { name: 'Releases' }).click();

    await expect(page.getByRole('row', { name: `Release ${RELEASE}` })).toContainText('current');
    await expect(page.getByRole('button', { name: `Roll back to ${RELEASE}` })).toHaveCount(0);
    await page.getByRole('button', { name: `Roll back to ${OLD}` }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(OLD);
    await snap(page, 'releases-rollback-confirm');
    expect(sent).toEqual([]);
    await confirm.getByRole('button', { name: 'Roll back' }).click();

    const log = page.getByRole('region', { name: 'Rollback log' });
    await expect(log).toContainText(`Rolled back to release ${OLD}`);
    await expect(log.getByTestId('deploy-log')).toContainText('Proxy switched');
    await snap(page, 'releases-rolled-back');
    expect(sent.map((s) => [s.method, s.path, s.body])).toEqual([['POST', '/apps/site1/rollback', { release: OLD }]]);
  });

  test('shows the server’s validation errors next to their fields, and in the YAML view with their paths', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await page.getByRole('tab', { name: 'Config' }).click();

    const port = page.getByLabel('Port');
    await expect(port).toHaveValue('3000');
    await port.fill('70000');
    await page.getByRole('button', { name: 'Validate and save' }).click();

    await expect(page.getByRole('alert')).toContainText('bastionctl refused this config (1 problem)');
    await expect(page.getByText('A port from 1 to 65535')).toBeVisible();
    await page.getByText('A port from 1 to 65535').scrollIntoViewIfNeeded();
    await snap(page, 'config-editor-errors');
    // The form edits the YAML in place: the comment it does not show survives
    const put = sent.find((s) => s.method === 'PUT')!;
    expect((put.body as { text: string }).text).toContain('# managed by the web e2e');
    expect((put.body as { text: string }).text).toContain('port: 70000');

    // Raw YAML: an unknown key, listed with its path
    await page.getByRole('tab', { name: 'YAML' }).click();
    const yaml = page.getByLabel('bastion.yml');
    await yaml.fill(`${CONFIG}extra: true\n`);
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect(page.getByRole('alert')).toContainText('extra: Unknown key');
    await snap(page, 'config-editor-yaml');

    // Fixed: saved
    await yaml.fill(CONFIG.replace('3000', '8080'));
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect(page.getByText('bastion.yml saved')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Who may deploy: manage writes permissions.deploy, operate (the default) drops the key
    await page.getByRole('tab', { name: 'Form' }).click();
    const who = page.getByLabel('Who may deploy');
    await expect(who).toHaveValue('operate');
    await who.selectOption('manage');
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect.poll(() => (sent.filter((s) => s.method === 'PUT').at(-1)!.body as { text: string }).text).toContain('permissions:\n  deploy: manage');
    await who.selectOption('operate');
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect.poll(() => sent.filter((s) => s.method === 'PUT').length).toBe(5);
    expect((sent.filter((s) => s.method === 'PUT').at(-1)!.body as { text: string }).text).not.toContain('permissions');
  });

  test('.env: names listed, values write-only, reveal on request', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await page.getByRole('tab', { name: 'Environment' }).click();

    const vars = page.getByRole('list', { name: 'Variables' });
    await expect(vars.getByRole('listitem', { name: 'DATABASE_URL' })).toContainText('••••');
    await expect(page.getByText('hunter2')).toHaveCount(0);

    // Reveal: shown until hidden
    await page.getByRole('button', { name: 'Reveal DATABASE_URL' }).click();
    await expect(vars.getByRole('listitem', { name: 'DATABASE_URL' })).toContainText('postgres://app:hunter2@db/app');
    await page.getByRole('button', { name: 'Hide DATABASE_URL' }).click();
    await expect(page.getByText('hunter2')).toHaveCount(0);

    // Change a value: the field starts empty, never prefilled
    await page.getByRole('button', { name: 'Change SECRET_KEY' }).click();
    const value = page.getByLabel('New value for SECRET_KEY');
    await expect(value).toHaveValue('');
    await expect(value).toHaveAttribute('type', 'password');
    await value.fill('s3cret');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('SECRET_KEY saved')).toBeVisible();

    // A value typed and cancelled is gone when the form opens again
    await page.getByRole('button', { name: 'Add variable' }).click();
    const form = page.getByRole('form', { name: 'Add variable' });
    await form.getByLabel('Variable value').fill('abandoned-secret');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Add variable' }).click();
    await expect(form.getByLabel('Variable value')).toHaveValue('');

    // Add one; a bad name is refused before anything is sent
    await form.getByLabel('Variable name').fill('1BAD');
    await expect(form.getByRole('button', { name: 'Add' })).toBeDisabled();
    await form.getByLabel('Variable name').fill('API_TOKEN');
    await form.getByLabel('Variable value').fill('tok-123');
    await form.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText('API_TOKEN saved')).toBeVisible();

    // Remove, after a confirmation
    await page.getByRole('button', { name: 'Remove SECRET_KEY' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('SECRET_KEY removed')).toBeVisible();

    expect(sent.map((s) => [s.method, s.path, s.body])).toEqual([
      ['POST', '/apps/site1/env/DATABASE_URL/reveal', null],
      ['PUT', '/apps/site1/env/SECRET_KEY', { value: 's3cret' }],
      ['PUT', '/apps/site1/env/API_TOKEN', { value: 'tok-123' }],
      ['DELETE', '/apps/site1/env/SECRET_KEY', null],
    ]);
  });

  test('domains: DNS checked by the server, with the record to create, ports and the certificate', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent);
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await page.getByRole('tab', { name: 'Domains' }).click();

    const domain = page.getByRole('list', { name: 'Domains' }).getByRole('listitem', { name: 'site1.example.com' });
    await expect(domain).toContainText('Points elsewhere');
    await expect(domain).toContainText('203.0.113.10');
    await expect(domain).toContainText("Let's Encrypt R11");
    await expect(domain).toContainText('59 d');
    const ports = page.getByRole('list', { name: 'Ports' });
    await expect(ports).toContainText('Port 443: filtered');
    await expect(ports).toContainText('Allow inbound TCP 443');
    await snap(page, 'domains');
    expect(sent).toEqual([]);
  });

  test('an operator cannot deploy or roll back an app whose bastion.yml asks for manage, and is told why', async ({ page }) => {
    const operator = await createMember('operator', 'deploy-operator');
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent, { setUp: true, deployLevel: 'manage' });
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await expect(page.getByRole('heading', { name: 'site1' })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toBeDisabled();
    await expect(page.getByRole('note')).toContainText('needs manage access to deployments on this server');
    await expect(page.getByRole('note')).toContainText('permissions.deploy: manage');
    await expect(page.getByText('Manage access (permissions.deploy)')).toBeVisible();
    // Restart and Stop are not deploys
    await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
    await page.getByRole('tab', { name: 'Releases' }).click();
    await expect(page.getByRole('row', { name: `Release ${OLD}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Roll back to ${OLD}` })).toHaveCount(0);
    await snap(page, 'deploy-needs-manage');
    expect(sent).toEqual([]);
  });

  test('a viewer sees apps and releases, but no actions, config editing or .env', async ({ page }) => {
    const viewer = await createMember('viewer', 'deploy-viewer');
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent);
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto(`/servers/${serverId}/deployments`);
    await expect(page.getByRole('region', { name: 'Apps' }).getByRole('row', { name: /site1/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reinstall' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New app' })).toHaveCount(0);

    await page.getByRole('button', { name: 'site1' }).click();
    await expect(page.getByRole('heading', { name: 'site1' })).toBeVisible();
    for (const name of ['Deploy', 'Restart', 'Stop', 'Delete site1']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('tab', { name: 'Environment' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Releases' }).click();
    await expect(page.getByRole('row', { name: `Release ${OLD}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Roll back to ${OLD}` })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Config' }).click();
    await expect(page.getByLabel('Port')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Validate and save' })).toHaveCount(0);
    expect(sent).toEqual([]);
  });
  test("refuses Next's .next folder for a static app before uploading, with a link to the fix", async ({ page }) => {
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent, { setUp: true, buildType: 'static' });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await expect(page.getByRole('heading', { name: 'site1' })).toBeVisible();

    const dir = mkdtempSync(join(tmpdir(), 'deploy-e2e-'));
    try {
      // What `next build` writes without output: 'export'
      const next = join(dir, '.next');
      for (const sub of ['server/app', 'static/chunks', 'cache']) mkdirSync(join(next, sub), { recursive: true });
      writeFileSync(join(next, 'BUILD_ID'), 'abc123');
      writeFileSync(join(next, 'server/app/index.html'), '<h1>hi</h1>');
      writeFileSync(join(next, 'static/chunks/main.js'), '1');
      // The export: index.html at the top
      const out = join(dir, 'out');
      mkdirSync(join(out, '_next/static'), { recursive: true });
      writeFileSync(join(out, 'index.html'), '<h1>hi</h1>');
      writeFileSync(join(out, '_next/static/main.js'), '1');

      await page.getByRole('button', { name: 'Deploy', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Deploy site1' });
      await expect(dialog.getByTestId('deploy-hint')).toContainText('Static app: pick your out folder (it must contain index.html)');
      await expect(dialog.getByTestId('deploy-hint').getByRole('link', { name: 'How to deploy' })).toHaveAttribute('href', '/docs/deployments/static-site');

      await dialog.getByLabel('Project folder').setInputFiles(next);
      const refusal = dialog.getByRole('alert');
      await expect(refusal).toContainText("This is Next's .next build folder, not a static export. Set output: 'export'");
      await expect(refusal).toContainText('upload the out folder (it contains index.html)');
      await expect(refusal.getByRole('link', { name: 'Read how to fix it' })).toHaveAttribute('href', '/docs/deployments/troubleshooting#uploaded-a-nextjs-build-folder');
      await expect(dialog.getByRole('button', { name: 'Deploy' })).toBeDisabled();
      await snap(page, 'deploy-refuses-next-folder');

      // The out folder is fine with output: .
      await dialog.getByLabel('Project folder').setInputFiles(out);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Deploy' })).toBeEnabled();
      await dialog.getByRole('button', { name: 'Deploy' }).click();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(page.getByRole('region', { name: 'Deploy log' })).toContainText('Deployed release');
    // Nothing went up but the out folder
    const uploads = sent.filter((s) => s.path === '/apps/site1/deploy');
    expect(uploads).toHaveLength(1);
    expect(uploadedNames(uploads[0]!.raw!)).toEqual(['_next/static/main.js', 'index.html']);
  });

  test('links the tab, the build type and a known failure to the docs', async ({ page }) => {
    const sent: Sent[] = [];
    await stubDeploy(page, serverId, sent, { setUp: true, deployFails: true });
    await signInWithPassword(page, admin.email, admin.password);
    await page.goto(`/servers/${serverId}/deployments/site1`);
    await expect(page.getByRole('heading', { name: 'site1' })).toBeVisible();

    // The header's guide opens the docs in a new tab, at the overview
    const [docs] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('link', { name: 'How to deploy' }).click()]);
    await expect(docs).toHaveURL(/\/docs\/deployments\/overview$/);
    await expect(docs.getByRole('heading', { name: 'How deployments work', level: 1 })).toBeVisible();
    await docs.close();

    // The config editor's guide for the app's build type
    await page.getByRole('tab', { name: 'Config' }).click();
    const guide = page.getByRole('group', { name: 'Build guide' });
    await guide.getByText('How to deploy: Next.js (built on the server)').click();
    await expect(guide).toContainText("output: 'standalone'");
    await expect(guide.getByRole('link', { name: 'Full guide' })).toHaveAttribute('href', '/docs/deployments/nextjs-dynamic');

    // A failed health check links its troubleshooting section, which opens at that heading
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Deploy site1' });
    await dialog.getByLabel('Archive file').setInputFiles({ name: 'site1.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from([0x1f, 0x8b, 0, 0]) });
    await dialog.getByRole('button', { name: 'Deploy' }).click();
    const log = page.getByRole('region', { name: 'Deploy log' });
    await expect(log).toContainText('Deploy failed');
    const fix = log.getByRole('link', { name: 'How to fix: Health check failed' });
    await expect(fix).toHaveAttribute('href', '/docs/deployments/troubleshooting#health-check-failed');
    const [help] = await Promise.all([page.context().waitForEvent('page'), fix.click()]);
    await expect(help.getByRole('heading', { name: 'Health check failed' })).toBeInViewport();
    await help.close();
  });
});
