import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { run } from './cli.js';
import type { Ctx } from './context.js';
import { DockerApi } from './docker.js';
import { startFakeDocker, type FakeDocker } from './fake-docker.test-helper.js';
import { Layout, PROXY_CONTAINER } from './names.js';
import { loadConfig } from './config.js';
import * as ops from './ops.js';
import { CADDY_IMAGE, NODE_IMAGE } from './images.js';
import { applyProxy, siteFor } from './proxy.js';
import { CADDY_ID, CADDY_PATH, caddyBinary, FRONT_PATH, PROXY_IMAGE } from './proxy-image.js';
import { BASTIONCTL_VERSION } from './version.js';
import { currentRelease, previousRelease, readRelease, releaseIds, setCurrent, writeRelease } from './releases.js';
import { tarBuffer } from './tar.js';

/**
 * The commands end to end on a temp root and the fake Docker API: setup,
 * deploy (build, container, health check, proxy validate + reload, current,
 * release.json, pruning), failures that must leave the old release serving,
 * rollback, delete, .env, and the CLI's JSON contract.
 */

let fake: FakeDocker;
let root: string;
let layout: Layout;
let logs: string[];
let clock: number;

beforeAll(async () => {
  fake = await startFakeDocker();
});
afterAll(() => fake.close());

function ctx(): Ctx {
  return {
    layout,
    docker: new DockerApi(fake.socket),
    log: (line) => logs.push(line),
    actor: 'ann@example.com',
    // A second apart, so every deploy gets its own release id
    now: () => new Date((clock += 1000)),
    drainMs: 0,
    healthIntervalMs: 1,
  };
}

const SITE1 = 'name: site1\ndomains: [site1.com, www.site1.com]\nredirect_www: apex\nbuild: { type: dockerfile }\nrun: { port: 3000, volumes: ["data:/data"], memory: 256m, cpus: 0.5 }\nhealthcheck: { path: /health, timeout: 2s }\nkeep_releases: 2\n';

function upload(name: string, version: string): string {
  const file = path.join(layout.tmp, name);
  fs.writeFileSync(file, zlib.gzipSync(tarBuffer([{ name: 'Dockerfile', content: `FROM busybox\nRUN echo ${version}\n` }])));
  return file;
}

/** What ran in the proxy container: `caddy validate`, and `proxy reload` (the front switching to a new Caddy). */
function caddyCommands() {
  return fake.execs
    .filter((e) => e.container === PROXY_CONTAINER && (e.cmd[0] === caddyBinary(CADDY_ID) || e.cmd[0] === 'caddy' || (e.cmd[0] === 'node' && e.cmd[1] === FRONT_PATH && e.cmd[2] !== '-e')))
    .map((e) => (e.cmd[0] === caddyBinary(CADDY_ID) || e.cmd[0] === 'caddy' ? `caddy ${e.cmd[1]}` : `proxy ${e.cmd[2]}`));
}

const isReload = (cmd: string[]) => cmd[0] === 'node' && cmd[1] === FRONT_PATH && cmd[2] === 'reload';

/** What setup built (the proxy image), before beforeEach clears the list for the test. */
let setupBuilds: Array<{ query: URLSearchParams; tar: Buffer }> = [];

async function app(name = 'site1', config = SITE1) {
  fs.writeFileSync(path.join(layout.tmp, `${name}.yml`), config);
  await ops.init(ctx(), name, { config: `tmp/${name}.yml` });
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-root-')));
  layout = new Layout(root);
  logs = [];
  clock = Date.parse('2026-10-05T12:00:00Z');
  fake.containers.clear();
  fake.images.clear();
  fake.networks.clear();
  fake.execs.length = 0;
  fake.builds.length = 0;
  fake.pulls.length = 0;
  fake.volumesRemoved.length = 0;
  fake.exec = () => ({ exitCode: 0 });
  fake.buildError = null;
  fake.crashOnStart = () => false;
  fake.buildOutput = [];
  await ops.setup(ctx());
  setupBuilds = [...fake.builds];
  fake.builds.length = 0;
  fake.execs.length = 0;
});

describe('setup', () => {
  it('creates the folders, network and proxy container once, and is safe to repeat', async () => {
    for (const dir of ['bin', 'apps', 'tmp', 'proxy/data', 'proxy/config']) expect(fs.statSync(path.join(root, dir)).isDirectory(), dir).toBe(true);
    expect(fs.statSync(layout.tmp).mode & 0o777).toBe(0o700);
    expect(fake.networks.has('bastion-apps')).toBe(true);
    expect([...fake.internalNetworks]).toEqual(['bastion-live']);
    // The proxy image, built from the pinned Node.js image: the front owns the ports, Caddy runs behind it
    expect(fake.pulls).toEqual([NODE_IMAGE, CADDY_IMAGE]);
    expect(setupBuilds.map((b) => b.query.get('t'))).toEqual([PROXY_IMAGE]);
    const dockerfile = setupBuilds[0]!.tar.toString('latin1');
    expect(dockerfile).toContain(`FROM ${NODE_IMAGE}\nCOPY bastion-proxy.mjs ${FRONT_PATH}\n`);
    expect(dockerfile).toContain(`BASTION_CADDY=${CADDY_PATH}`);
    expect(dockerfile).toContain('startFront');
    // Caddy's binary, copied out of the pinned Caddy image (never started), behind a link the front starts every Caddy through
    expect(fs.readFileSync(path.join(layout.proxy, 'caddy', CADDY_ID, 'caddy'), 'utf8')).toBe('#!/bin/sh\n# caddy\n');
    expect(fs.statSync(path.join(layout.proxy, 'caddy', CADDY_ID, 'caddy')).mode & 0o111).toBe(0o111);
    expect(fs.readlinkSync(path.join(layout.proxy, 'caddy', 'caddy'))).toBe(`${CADDY_ID}/caddy`);
    expect([...fake.containers.keys()].filter((n) => n.startsWith('bastion-caddy-copy'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(layout.proxy, 'state.json'), 'utf8'))).toEqual({ build: BASTIONCTL_VERSION, caddy: CADDY_ID });
    const proxy = fake.containers.get(PROXY_CONTAINER)!;
    expect(proxy.Image).toBe(PROXY_IMAGE);
    expect(proxy.State.Running).toBe(true);
    expect(proxy.Labels).toMatchObject({ 'bastion.managed': 'proxy', 'bastion.proxy-mode': 'caddy', 'bastion.build': BASTIONCTL_VERSION, 'bastion.proxy-spec': expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(proxy.Env).toEqual(['BASTION_PROXY_LISTEN=80:http,443:https', 'BASTION_PROXY_CONFIG=/bastion-proxy/Caddyfile']);
    expect(proxy.HostConfig.PortBindings).toEqual({ '80/tcp': [{ HostPort: '80' }], '443/tcp': [{ HostPort: '443' }] });
    expect(proxy.HostConfig).toMatchObject({
      Binds: [`${root}/proxy:/bastion-proxy`, `${root}/proxy/data:/data`, `${root}/proxy/config:/config`],
      NetworkMode: 'bastion-apps',
      RestartPolicy: { Name: 'unless-stopped' },
    });
    expect(proxy.Networks).toEqual({ 'bastion-live': { Aliases: [] } });
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toContain('admin localhost:{$BASTION_ADMIN_PORT:2019}');

    const id = proxy.Id;
    const again = await ops.setup(ctx());
    expect(again).toMatchObject({ root, proxy: 'caddy', network: 'bastion-apps', proxyContainer: { state: 'running' } });
    expect(fake.containers.get(PROXY_CONTAINER)!.Id).toBe(id);
    expect(fake.pulls).toHaveLength(2);
    expect(fake.builds).toHaveLength(0);
  });

  it('replaces a proxy container of an older bastionctl, with a Caddyfile for the front, and removes old proxy images', async () => {
    await app();
    await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    const proxy = fake.containers.get(PROXY_CONTAINER)!;
    // Before the front: Caddy itself on the ports, with the old global block
    proxy.Image = CADDY_IMAGE;
    proxy.Labels = { 'bastion.managed': 'proxy' };
    fake.images.set('bastion-proxy:0123456789abcdef', { Id: 'sha256:oldproxy', Labels: { 'bastion.proxy-image': '1' } });
    fs.writeFileSync(layout.caddyfile, '{\n\tadmin localhost:2019\n}\n');

    await ops.setup(ctx());
    expect(fake.containers.get(PROXY_CONTAINER)!.Image).toBe(PROXY_IMAGE);
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toContain('https_port {$BASTION_HTTPS_PORT:443}');
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toContain('site1.com');
    expect(fake.images.has('bastion-proxy:0123456789abcdef')).toBe(false);
    expect(fake.images.has(PROXY_IMAGE)).toBe(true);
  });

  it('runs two setups at once in turn, both successfully', async () => {
    fake.networks.clear();
    fake.internalNetworks.clear();
    fake.containers.delete(PROXY_CONTAINER);
    const results = await Promise.all([ops.setup(ctx()), ops.setup(ctx())]);
    for (const r of results) expect(r).toMatchObject({ proxy: 'caddy', proxyContainer: { state: 'running' } });
    expect(fake.networks.has('bastion-apps')).toBe(true);
    expect(fs.existsSync(layout.setupLock)).toBe(false);
  });

  it('takes a network created by someone else meanwhile as there', async () => {
    const docker = new DockerApi(fake.socket);
    fake.networks.delete('bastion-test-race');
    // Both inspect before either creates: the second create answers 409
    const created = await Promise.all([docker.ensureNetwork('bastion-test-race', {}), docker.ensureNetwork('bastion-test-race', {})]);
    expect(created.sort()).toEqual([false, true]);
    fake.networks.delete('bastion-test-race');
  });

  it('puts a live container from before bastion-live under its alias', async () => {
    await app();
    const id = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    const c = fake.containers.get(`bastion-site1-${id}`)!;
    c.Networks = {};
    await ops.setup(ctx());
    expect(c.Networks).toEqual({ 'bastion-live': { Aliases: ['bastion-site1-live-3000'] } });
    expect(logs).toContain('Put site1 on bastion-live');
  });
});

describe('deploy', () => {
  it('builds, starts, checks health, switches the proxy, then records and serves the release', async () => {
    await app();
    fs.writeFileSync(layout.env('site1'), 'API_KEY="s3cret"\n', { mode: 0o600 });
    const mark = fake.requests.length;
    const outcome = await ops.deploy(ctx(), 'site1', upload('up.tgz', 'v1'));
    expect(outcome).toEqual({ app: 'site1', release: expect.stringMatching(/^20261005-1200\d\d-[0-9a-f]{8}$/), previous: null, result: 'success', error: null });
    const id = outcome.release;

    // Build: labelled image from a tar context
    expect(fake.builds).toHaveLength(1);
    const q = fake.builds[0]!.query;
    expect(q.get('t')).toBe(`bastion-site1:${id}`);
    expect(q.get('dockerfile')).toBe('Dockerfile');
    expect(JSON.parse(q.get('labels')!)).toEqual({ 'bastion.app': 'site1', 'bastion.release': id, 'bastion.managed': 'app' });

    // Container: env from .env, named volume, limits, private network
    const c = fake.containers.get(`bastion-site1-${id}`)!;
    expect(c.State.Running).toBe(true);
    expect(c.Env).toEqual(['API_KEY=s3cret']);
    expect(c.Labels).toEqual({ 'bastion.app': 'site1', 'bastion.release': id, 'bastion.managed': 'app' });
    expect(c.HostConfig).toMatchObject({
      NetworkMode: 'bastion-apps',
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: 256 * 1024 * 1024,
      NanoCpus: 5e8,
      Mounts: [{ Type: 'volume', Source: 'bastion-site1.data', Target: '/data', ReadOnly: false }],
    });
    expect(c.HostConfig).not.toHaveProperty('PortBindings');
    // In the proxy's rotation under the app's live alias, joined after the health check
    expect(c.Networks).toEqual({ 'bastion-live': { Aliases: ['bastion-site1-live-3000'] } });
    const requests = fake.requests.slice(mark);
    const firstExec = requests.findIndex((r) => /^POST \/exec\/[^/]+\/start$/.test(r));
    expect(firstExec).toBeGreaterThan(-1);
    expect(requests.indexOf('POST /networks/bastion-live/connect')).toBeGreaterThan(firstExec);

    // Health check from the proxy by the container's address on bastion-apps, then validate before reload
    expect(fake.execs[0]).toEqual({ container: PROXY_CONTAINER, cmd: ['wget', '-q', '-O', '/dev/null', '-T', '5', `http://${c.IPAddress}:3000/health`] });
    expect(logs).toContain(`Health check: http://bastion-site1-${id}:3000/health (up to 2s)`);
    expect(caddyCommands()).toEqual(['caddy validate', 'proxy reload']);
    const caddyfile = fs.readFileSync(layout.caddyfile, 'utf8');
    // The front starts exactly the text validated, and checks the names it serves before switching
    // …running the Caddy it validated with (the one the link names), named explicitly
    expect(fake.execs.find((e) => isReload(e.cmd))!.cmd.slice(3)).toEqual(['--sha256', createHash('sha256').update(caddyfile).digest('hex'), '--caddy', caddyBinary(CADDY_ID), 'site1.com', 'www.site1.com']);
    expect(caddyfile).toContain('site1.com {\n\tencode zstd gzip\n\treverse_proxy bastion-site1-live-3000:3000 {\n\t\tlb_try_duration 5s\n\t}\n}');
    expect(caddyfile).toContain('www.site1.com {\n\tredir https://site1.com{uri} permanent\n}');
    expect(fs.existsSync(`${layout.caddyfile}.next`)).toBe(false);

    // On disk: current, release.json, source kept, build log, upload moved, lock gone
    expect(currentRelease(layout, 'site1')).toBe(id);
    expect(readRelease(layout, 'site1', id)).toMatchObject({ actor: 'ann@example.com', result: 'success', image: `bastion-site1:${id}`, port: 3000, previous: null });
    expect(fs.existsSync(path.join(layout.release('site1', id), 'source.tar.gz'))).toBe(true);
    expect(fs.readFileSync(path.join(layout.release('site1', id), 'build.log'), 'utf8')).toContain('Successfully built');
    expect(fs.existsSync(path.join(layout.tmp, 'up.tgz'))).toBe(false);
    expect(fs.readdirSync(layout.tmp).filter((f) => f.startsWith('build-'))).toEqual([]);
    expect(fs.existsSync(layout.lock('site1'))).toBe(false);
    expect(fs.existsSync(layout.buildLock)).toBe(false);
  });

  it('replaces the old container only after the new one serves, and prunes beyond keep_releases', async () => {
    await app();
    const first = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    expect(caddyCommands()).toEqual(['caddy validate', 'proxy reload']);
    const second = (await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'))).release;
    // Same domains and port: traffic moved over the live alias, Caddy was not reloaded
    expect(caddyCommands()).toEqual(['caddy validate', 'proxy reload']);
    expect(logs).toContain('Proxy config unchanged; traffic moves over the live network');
    expect(fake.containers.has(`bastion-site1-${first}`)).toBe(false);
    expect(fake.containers.get(`bastion-site1-${second}`)!.State.Running).toBe(true);
    expect([currentRelease(layout, 'site1'), previousRelease(layout, 'site1')]).toEqual([second, first]);

    const third = (await ops.deploy(ctx(), 'site1', upload('c.tgz', 'v3'))).release;
    // keep_releases: 2 — the first goes, with its image
    expect(releaseIds(layout, 'site1')).toEqual([second, third]);
    expect(fake.images.has(`bastion-site1:${first}`)).toBe(false);
    expect(fake.images.has(`bastion-site1:${second}`)).toBe(true);
  });

  it('removes labelled images no kept release names, and nothing of other apps', async () => {
    await app();
    const first = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    // A release folder deleted by hand, and another app's image
    const stray = '20260101-000000-deadbeef';
    fake.images.set(`bastion-site1:${stray}`, { Id: 'sha256:stray', Labels: { 'bastion.app': 'site1', 'bastion.release': stray } });
    fake.images.set(`bastion-site2:${stray}`, { Id: 'sha256:other', Labels: { 'bastion.app': 'site2', 'bastion.release': stray } });
    const second = (await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'))).release;
    expect(fake.images.has(`bastion-site1:${stray}`)).toBe(false);
    expect(fake.images.has(`bastion-site2:${stray}`)).toBe(true);
    expect([first, second].map((id) => fake.images.has(`bastion-site1:${id}`))).toEqual([true, true]);
    expect(logs).toContain('Removed 1 image of releases no longer kept');
  });

  it('switches to a new Caddy when a custom certificate changed though the config did not', async () => {
    await app('site1', SITE1.replace('redirect_www: apex\n', 'redirect_www: apex\ntls: { cert: tls/cert.pem, key: tls/key.pem }\n'));
    fs.mkdirSync(path.join(layout.app('site1'), 'tls'));
    fs.writeFileSync(path.join(layout.app('site1'), 'tls/cert.pem'), 'CERT 1');
    fs.writeFileSync(path.join(layout.app('site1'), 'tls/key.pem'), 'KEY 1');
    await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'));
    // Same file, same certificate: no reload
    expect(caddyCommands()).toEqual(['caddy validate', 'proxy reload']);

    // A renewed certificate under the same path is only read by a forced reload
    fs.writeFileSync(path.join(layout.app('site1'), 'tls/cert.pem'), 'CERT 2');
    await ops.deploy(ctx(), 'site1', upload('c.tgz', 'v3'));
    // A new Caddy reads the files; it takes traffic once it serves both names (the first deploy copied them first)
    const reloads = fake.execs.filter((e) => isReload(e.cmd)).map((e) => e.cmd.slice(7));
    expect(reloads).toEqual(Array(2).fill(['site1.com', 'www.site1.com']));
    expect(fs.readFileSync(path.join(layout.proxy, 'certs/site1/cert.pem'), 'utf8')).toBe('CERT 2');
  });

  it('health-checks by address, so an app name too long for a DNS label still deploys', async () => {
    const name = 'a'.repeat(41);
    await app(name, SITE1.replace('name: site1', `name: ${name}`).replace('[site1.com, www.site1.com]', '[long.example.com]'));
    const outcome = await ops.deploy(ctx(), name, upload('a.tgz', 'v1'));
    expect(outcome.result).toBe('success');
    // The container name is 74 characters: no resolver looks it up as one label
    expect(`bastion-${name}-${outcome.release}`.length).toBeGreaterThan(63);
    const c = fake.containers.get(`bastion-${name}-${outcome.release}`)!;
    expect(fake.execs[0]!.cmd.at(-1)).toBe(`http://${c.IPAddress}:3000/health`);
    // The live alias the proxy resolves stays a valid label
    expect(c.Networks['bastion-live']!.Aliases[0]!.length).toBeLessThanOrEqual(63);
  });

  it('leaves the old release serving when the new one fails its health check', async () => {
    await app();
    const good = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    const before = fs.readFileSync(layout.caddyfile, 'utf8');
    fake.exec = ({ cmd }) => (cmd[0] === 'wget' ? { exitCode: 1, stderr: 'wget: server returned error: HTTP/1.1 500' } : { exitCode: 0 });

    const outcome = await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'));
    expect(outcome.result).toBe('failed');
    expect(outcome.error).toMatch(/Health check failed after 2s: wget: server returned error/);
    expect(fake.containers.has(`bastion-site1-${outcome.release}`)).toBe(false);
    expect(fake.containers.get(`bastion-site1-${good}`)!.State.Running).toBe(true);
    expect(fake.images.has(`bastion-site1:${outcome.release}`)).toBe(false);
    expect(currentRelease(layout, 'site1')).toBe(good);
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toBe(before);
    expect(readRelease(layout, 'site1', outcome.release)).toMatchObject({ result: 'failed', error: expect.stringMatching(/Health check failed/) });
  });

  it('fails at once, with the app’s log, when the new container crashes', async () => {
    await app();
    const started = Date.now();
    fake.crashOnStart = (name) => name.startsWith('bastion-site1-');
    const outcome = await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    expect(outcome.result).toBe('failed');
    expect(outcome.error).toMatch(/The new container stopped \(exit 1\):\nboom: app crashed/);
    // Not the 2s health check timeout
    expect(Date.now() - started).toBeLessThan(1500);
    expect(currentRelease(layout, 'site1')).toBeNull();
  });

  it('restores the previous proxy config when Caddy refuses to reload', async () => {
    await app();
    const good = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    // Another port: the next release needs a new upstream, so a reload
    fs.writeFileSync(path.join(layout.tmp, 'port.yml'), SITE1.replace('port: 3000', 'port: 4000'));
    await ops.init(ctx(), 'site1', { config: 'tmp/port.yml', force: true });
    const before = fs.readFileSync(layout.caddyfile, 'utf8');
    let reloads = 0;
    fake.exec = ({ cmd }) => (isReload(cmd) && ++reloads === 1 ? { exitCode: 1, stderr: 'Caddy did not start with the new config:\nError: loading new config: bad things' } : { exitCode: 0 });

    const outcome = await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'));
    expect(outcome.result).toBe('failed');
    expect(outcome.error).toMatch(/Reloading the proxy failed; the previous config was restored:\nCaddy did not start with the new config:\nError: loading new config: bad things/);
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toBe(before);
    // validate, then the front refused the new Caddy: the running one never stopped, so only the file goes back
    expect(caddyCommands().slice(-2)).toEqual(['caddy validate', 'proxy reload']);
    expect(reloads).toBe(1);
    expect(currentRelease(layout, 'site1')).toBe(good);
    expect(fake.containers.has(`bastion-site1-${outcome.release}`)).toBe(false);
  });

  it('changes nothing when Caddy refuses to validate the new config', async () => {
    await app();
    fake.exec = ({ cmd }) => (cmd[1] === 'validate' ? { exitCode: 1, stderr: 'Error: ambiguous site definition: site1.com' } : { exitCode: 0 });
    const outcome = await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    expect(outcome.error).toMatch(/refused; nothing changed:\nError: ambiguous site definition/);
    expect(caddyCommands()).toEqual(['caddy validate']);
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).not.toContain('site1.com');
  });

  it('records a failed build and keeps nothing of it', async () => {
    await app();
    fake.buildError = 'The command /bin/sh -c npm ci returned a non-zero code: 1';
    const outcome = await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    expect(outcome).toMatchObject({ result: 'failed', error: 'Build failed: The command /bin/sh -c npm ci returned a non-zero code: 1' });
    expect(fake.containers.size).toBe(1); // the proxy only
    expect(fs.existsSync(layout.buildLock)).toBe(false);
  });

  it('refuses an unsafe upload before building anything', async () => {
    await app();
    const file = path.join(layout.tmp, 'evil.tgz');
    fs.writeFileSync(file, zlib.gzipSync(tarBuffer([{ name: 'Dockerfile', content: 'FROM x' }, { name: 'env', type: '2', linkname: '../../../apps/other/.env' }])));
    const outcome = await ops.deploy(ctx(), 'site1', file);
    expect(outcome).toMatchObject({ result: 'failed', error: expect.stringMatching(/outside the upload/) });
    expect(fake.builds).toHaveLength(0);
  });

  it('refuses while another deploy of the app holds the lock, and sources outside the root', async () => {
    await app();
    fs.writeFileSync(layout.lock('site1'), JSON.stringify({ holder: 'bob', host: os.hostname(), pid: process.pid, since: new Date().toISOString() }));
    await expect(ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).rejects.toMatchObject({ exitCode: 4, message: expect.stringMatching(/locked by bob/) });
    fs.rmSync(layout.lock('site1'));
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.tgz`);
    fs.writeFileSync(outside, 'x');
    await expect(ops.deploy(ctx(), 'site1', outside)).rejects.toThrow(/must be a file inside/);
    fs.rmSync(outside);
  });

  it('deploys two apps at once: the second build waits its turn and both stay in the proxy', async () => {
    // Each switch rebuilds the config from every app's `current`: without one
    // proxy lock, the second writer dropped the first app's new release (its
    // old container then stopped after the drain) or validated the other's file
    await app();
    await app('blog', 'name: blog\ndomains: [blog.com]\nbuild: { type: dockerfile }\n');
    const [a, b] = await Promise.all([ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1')), ops.deploy(ctx(), 'blog', upload('b.tgz', 'v1'))]);
    expect([a.result, b.result]).toEqual(['success', 'success']);
    const caddyfile = fs.readFileSync(layout.caddyfile, 'utf8');
    expect(caddyfile).toContain('reverse_proxy bastion-site1-live-3000:3000 {');
    expect(caddyfile).toContain('reverse_proxy bastion-blog-live-3000:3000 {');
    expect([currentRelease(layout, 'site1'), currentRelease(layout, 'blog')]).toEqual([a.release, b.release]);

    const [a2, b2] = await Promise.all([ops.deploy(ctx(), 'site1', upload('c.tgz', 'v2')), ops.deploy(ctx(), 'blog', upload('d.tgz', 'v2'))]);
    expect([a2.result, b2.result]).toEqual(['success', 'success']);
    // Same ports: the config stands and only the live containers changed
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toBe(caddyfile);
    expect(fake.containers.get(`bastion-site1-${a2.release}`)!.State.Running).toBe(true);
    expect(fake.containers.get(`bastion-blog-${b2.release}`)!.State.Running).toBe(true);
    expect(fs.existsSync(layout.proxyLock)).toBe(false);
    expect(fs.existsSync(layout.buildLock)).toBe(false);
  });

  it('takes proxy switches in turn, each built on the last one’s `current`', async () => {
    await app();
    await app('blog', 'name: blog\ndomains: [blog.com]\nbuild: { type: dockerfile }\n');
    const a = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    const b = (await ops.deploy(ctx(), 'blog', upload('b.tgz', 'v1'))).release;
    // Two switches at once, as two deploys' activations would run them
    // On new ports, so each switch changes the config
    const next = (name: string, from: string, port: number) => {
      const id = `${from.slice(0, -8)}ffffffff`;
      const old = readRelease(layout, name, from)!;
      fs.mkdirSync(layout.release(name, id));
      writeRelease(layout, { ...old, id, container: `bastion-${name}-${id}`, port });
      return id;
    };
    const a2 = next('site1', a, 3001);
    const b2 = next('blog', b, 3002);
    const config = (name: string) => loadConfig(layout, name);
    await Promise.all([
      applyProxy(ctx(), new Map([['site1', siteFor(config('site1'), a2, 3001)]]), () => setCurrent(layout, 'site1', a2)),
      applyProxy(ctx(), new Map([['blog', siteFor(config('blog'), b2, 3002)]]), () => setCurrent(layout, 'blog', b2)),
    ]);
    const caddyfile = fs.readFileSync(layout.caddyfile, 'utf8');
    expect(caddyfile).toContain('reverse_proxy bastion-site1-live-3001:3001 {');
    expect(caddyfile).toContain('reverse_proxy bastion-blog-live-3002:3002 {');
    expect(fs.existsSync(layout.proxyLock)).toBe(false);
  });

  it('puts only its own container name in the proxy config, whatever release.json says', async () => {
    await app();
    const id = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    writeRelease(layout, { ...readRelease(layout, 'site1', id)!, container: 'x:1\n}\nevil.com {\n\treverse_proxy attacker' });
    await ops.proxyApply(ctx());
    const caddyfile = fs.readFileSync(layout.caddyfile, 'utf8');
    expect(caddyfile).not.toContain('evil.com');
    expect(caddyfile).not.toContain('site1.com');
    expect(logs.join('\n')).toMatch(/site1 is left out of the proxy: release.json of .* names another container/);
  });

  it('needs the proxy running', async () => {
    await app();
    await new DockerApi(fake.socket).stop(PROXY_CONTAINER);
    await expect(ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).rejects.toThrow(/run bastionctl setup/);
  });
});

describe('secrets in what bastionctl prints and keeps', () => {
  it('masks .env values in the deploy log, build.log, release.json and the outcome', async () => {
    await app();
    fs.writeFileSync(layout.env('site1'), 'API_KEY="sk-live-0123456789"\nDB_PASSWORD=hunter2hunter2\nMODE=prod\n', { mode: 0o600 });
    const good = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    // The app answers its health check with its config, and its log prints it too
    fake.exec = ({ cmd }) =>
      cmd[0] === 'wget' ? { exitCode: 1, stderr: 'wget: server returned error: HTTP/1.1 500 key=sk-live-0123456789 pw=hunter2hunter2 mode=prod' } : { exitCode: 0 };
    const out: string[] = [];
    const outcome = await ops.deploy({ ...ctx(), log: (line) => out.push(line) }, 'site1', upload('b.tgz', 'v2'));
    expect(outcome.result).toBe('failed');
    const kept = [
      outcome.error!,
      out.join('\n'),
      fs.readFileSync(path.join(layout.release('site1', outcome.release), 'build.log'), 'utf8'),
      fs.readFileSync(path.join(layout.release('site1', outcome.release), 'release.json'), 'utf8'),
    ];
    for (const text of kept) {
      expect(text).toContain('key=•••• pw=••••');
      expect(text).not.toContain('sk-live-0123456789');
      expect(text).not.toContain('hunter2hunter2');
      // Values under 6 characters would mask ordinary words
      expect(text).toContain('mode=prod');
    }
    expect(currentRelease(layout, 'site1')).toBe(good);
  });

  it('masks them in a rollback that fails, and the CLI prints the masked outcome', async () => {
    await app();
    fs.writeFileSync(layout.env('site1'), 'TOKEN=abcdef123456\n', { mode: 0o600 });
    const first = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'));
    fake.exec = ({ cmd }) => (cmd[0] === 'wget' ? { exitCode: 1, stderr: 'boom TOKEN=abcdef123456' } : { exitCode: 0 });
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['rollback', 'site1', first, '--json'], {
      env: { BASTION_ROOT: root },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      readStdin: async () => '',
      ctx: { docker: new DockerApi(fake.socket), drainMs: 0, healthIntervalMs: 1, now: () => new Date((clock += 1000)) },
    });
    expect(code).toBe(1);
    expect(JSON.parse(out.join('')).error).toContain('TOKEN=••••');
    expect(out.join('') + err.join('')).not.toContain('abcdef123456');
  });

  it('answers a Docker failure during a rollback as a failed outcome, the current release serving', async () => {
    await app();
    const first = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    const second = (await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'))).release;
    fake.networks.delete('bastion-live');
    const outcome = await ops.rollback(ctx(), 'site1', first);
    expect(outcome).toMatchObject({ release: first, previous: second, result: 'failed', error: expect.stringMatching(/network/) });
    expect(currentRelease(layout, 'site1')).toBe(second);
    expect(fake.containers.has(`bastion-site1-${first}`)).toBe(false);
  });

  it('masks each line of a multi-line value the app logs, and errors kept before masking existed', async () => {
    await app();
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n-----END PRIVATE KEY-----';
    fs.writeFileSync(layout.env('site1'), `TLS_KEY="${pem.replace(/\n/g, '\\n')}"\n`, { mode: 0o600 });
    // A build that prints it reaches bastionctl line by line
    fake.buildOutput = [`config:\n${pem}\nbye\n`];
    fake.crashOnStart = () => true;
    const out: string[] = [];
    const failed = await ops.deploy({ ...ctx(), log: (line) => out.push(line) }, 'site1', upload('a.tgz', 'v1'));
    expect(failed.result).toBe('failed');
    for (const text of [out.join('\n'), fs.readFileSync(path.join(layout.release('site1', failed.release), 'build.log'), 'utf8')]) {
      expect(text).toContain('••••\n••••\n••••\nbye');
      expect(text).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw');
    }
    // A release.json written by an older bastionctl, unmasked: `releases` masks it as it reads it
    const record = readRelease(layout, 'site1', failed.release)!;
    writeRelease(layout, { ...record, error: `crashed: ${pem}` });
    const [listed] = await ops.releases(ctx(), 'site1');
    expect(listed!.error).toBe('crashed: ••••');
  });
});

describe('environment files, build args and images built on the BastionSSH side', () => {
  /** An upload with a Dockerfile, environment files at the top and deeper, and the template that may stay. */
  function uploadWithEnv(name: string): string {
    const file = path.join(layout.tmp, name);
    fs.writeFileSync(
      file,
      zlib.gzipSync(
        tarBuffer([
          { name: 'Dockerfile', content: 'FROM busybox\nCOPY . /app\n' },
          { name: '.env', content: 'SECRET=top\n' },
          { name: '.env.local', content: 'SECRET=local\n' },
          { name: '.env.example', content: 'SECRET=\n' },
          { name: 'apps/web/.env.production', content: 'NEXT_PUBLIC_X=1\n' },
          { name: 'src/environment.ts', content: 'export {};\n' },
        ]),
      ),
    );
    return file;
  }

  /** The names in a build context (the fake keeps the tar Docker got). */
  const contextNames = (tar: Buffer) => {
    const names: string[] = [];
    for (let at = 0; at + 512 <= tar.length; ) {
      const name = tar.subarray(at, at + 100).toString('utf8').replace(/\0.*$/s, '');
      if (!name) break;
      const size = parseInt(tar.subarray(at + 124, at + 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
      names.push(name);
      at += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
  };

  it('leaves .env and .env.* files of the upload out of the build (not .env.example), and says which', async () => {
    await app();
    const outcome = await ops.deploy(ctx(), 'site1', uploadWithEnv('a.tgz'));
    expect(outcome.result).toBe('success');
    const names = contextNames(fake.builds[0]!.tar);
    expect(names).toEqual(expect.arrayContaining(['Dockerfile', '.env.example', 'src/environment.ts']));
    for (const name of ['.env', '.env.local', 'apps/web/.env.production']) expect(names).not.toContain(name);
    const note = logs.find((l) => l.startsWith('Left out 3 environment files'))!;
    expect(note).toContain('.env, .env.local, apps/web/.env.production');
    expect(note).toContain('Include environment files');
    expect(readRelease(layout, 'site1', outcome.release)).toMatchObject({ builtOn: 'server' });
  });

  it('keeps them when asked (--include-env-files), and says so', async () => {
    await app();
    uploadWithEnv('b.tgz');
    const out: string[] = [];
    const code = await run(['deploy', 'site1', '--source', 'tmp/b.tgz', '--include-env-files', '--json'], {
      env: { BASTION_ROOT: root },
      stdout: (t) => out.push(t),
      stderr: () => {},
      readStdin: async () => '',
      ctx: { docker: new DockerApi(fake.socket), drainMs: 0, healthIntervalMs: 1, now: () => new Date((clock += 1000)), log: (l) => logs.push(l) },
    });
    expect(code, out.join('')).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ result: 'success' });
    expect(contextNames(fake.builds.at(-1)!.tar)).toEqual(expect.arrayContaining(['.env', '.env.local', 'apps/web/.env.production']));
    expect(logs.some((l) => l.startsWith('Environment files in the upload were kept'))).toBe(true);
  });

  it('gives a build the NEXT_PUBLIC_* and build.args values of .env as build args, declared in the generated Dockerfile, values masked', async () => {
    await app('web', 'name: web\ndomains: [web.com]\nbuild:\n  type: static\n  output: dist\n  args: [VITE_API_URL]\n');
    fs.writeFileSync(
      layout.env('web'),
      'NEXT_PUBLIC_SITE_URL=https://web.example.com\nVITE_API_URL=https://api.example.com\nDATABASE_URL=postgres://u:p@db/x\n',
      { mode: 0o600 },
    );
    const file = path.join(layout.tmp, 'web.tgz');
    fs.writeFileSync(file, zlib.gzipSync(tarBuffer([{ name: 'package.json', content: '{"scripts":{"build":"node b.mjs"}}' }])));
    fake.buildOutput = ['building for https://api.example.com\n'];
    const outcome = await ops.deploy(ctx(), 'web', file);
    expect(outcome.result).toBe('success');
    const q = fake.builds[0]!.query;
    // Only the public prefix and the allowlist: nothing else from .env reaches the build
    expect(JSON.parse(q.get('buildargs')!)).toEqual({ NEXT_PUBLIC_SITE_URL: 'https://web.example.com', VITE_API_URL: 'https://api.example.com' });
    const dockerfile = fake.builds[0]!.tar.toString('latin1');
    expect(dockerfile).toContain('ARG NEXT_PUBLIC_SITE_URL\nARG VITE_API_URL\nRUN npm run build');
    expect(dockerfile).not.toContain('DATABASE_URL');
    expect(logs).toContain('Build args from .env: NEXT_PUBLIC_SITE_URL, VITE_API_URL');
    expect(logs.join('\n')).toContain('building for ••••');
    expect(logs.join('\n')).not.toContain('https://api.example.com');
  });

  it('prints only the build args for a build on the BastionSSH side (env build-args)', async () => {
    await app('web', 'name: web\ndomains: [web.com]\nbuild: { type: nextjs, where: bastion, args: [SENTRY_RELEASE] }\n');
    fs.writeFileSync(layout.env('web'), 'NEXT_PUBLIC_A=1\nSENTRY_RELEASE=abc\nSECRET_KEY=hunter2hunter2\n', { mode: 0o600 });
    expect(ops.envBuildArgs(ctx(), 'web')).toEqual({ args: { NEXT_PUBLIC_A: '1', SENTRY_RELEASE: 'abc' } });
    const out: string[] = [];
    await run(['env', 'build-args', 'web', '--json'], {
      env: { BASTION_ROOT: root },
      stdout: (t) => out.push(t),
      stderr: () => {},
      readStdin: async () => '',
      ctx: { docker: new DockerApi(fake.socket) },
    });
    expect(JSON.parse(out.join(''))).toEqual({ args: { NEXT_PUBLIC_A: '1', SENTRY_RELEASE: 'abc' } });
    expect(out.join('')).not.toContain('hunter2hunter2');
  });

  it('serves an image BastionSSH built and loaded (--prebuilt), recording where, the platform, image id and build time', async () => {
    await app();
    const id = '20261005-130000-0123abcd';
    fake.images.set(`bastion-site1:${id}`, {
      Id: `sha256:${'a'.repeat(64)}`,
      Labels: { 'bastion.app': 'site1', 'bastion.release': id, 'bastion.managed': 'app' },
      Architecture: 'arm64',
    });
    const outcome = await ops.deploy(ctx(), 'site1', { prebuilt: `bastion-site1:${id}`, checksum: 'b'.repeat(64), buildMs: 61_000 });
    expect(outcome).toMatchObject({ release: id, result: 'success' });
    // Nothing was built here
    expect(fake.builds).toEqual([]);
    expect(fake.containers.get(`bastion-site1-${id}`)!.State.Running).toBe(true);
    expect(readRelease(layout, 'site1', id)).toMatchObject({
      builtOn: 'bastion',
      platform: 'linux/arm64',
      digest: `sha256:${'a'.repeat(64)}`,
      buildMs: 61_000,
      checksum: 'b'.repeat(64),
      image: `bastion-site1:${id}`,
      result: 'success',
    });
    expect(logs.some((l) => l.startsWith(`Built on BastionSSH in 61 s: bastion-site1:${id} (linux/arm64`))).toBe(true);
    const [listed] = await ops.releases(ctx(), 'site1');
    expect(listed).toMatchObject({ builtOn: 'bastion', platform: 'linux/arm64', buildMs: 61_000, imagePresent: true });
  });

  it('refuses --prebuilt when the image is missing, made for another app or release, or named otherwise', async () => {
    await app();
    const id = '20261005-130000-0123abcd';
    await expect(ops.deploy(ctx(), 'site1', { prebuilt: `bastion-site1:${id}` })).rejects.toThrow(/is not on this server.*Nothing was changed/);
    fake.images.set(`bastion-site1:${id}`, { Id: `sha256:${'c'.repeat(64)}`, Labels: { 'bastion.app': 'other', 'bastion.release': id } });
    await expect(ops.deploy(ctx(), 'site1', { prebuilt: `bastion-site1:${id}` })).rejects.toThrow(/was not built for site1/);
    await expect(ops.deploy(ctx(), 'site1', { prebuilt: 'nginx:latest' })).rejects.toThrow(/--prebuilt takes bastion-site1:<release>/);
    await expect(ops.deploy(ctx(), 'site1', { prebuilt: `bastion-site1:${id}`, source: 'tmp/x.tgz' })).rejects.toThrow(/not both/);
    await expect(ops.deploy(ctx(), 'site1', { source: 'tmp/x.tgz', buildMs: 5 })).rejects.toThrow(/go with --prebuilt/);
    expect(releaseIds(layout, 'site1')).toEqual([]);
  });

  it('removes a loaded image whose release fails its health check; the previous release keeps serving', async () => {
    await app();
    const good = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    const id = '20261005-130000-0123abcd';
    fake.images.set(`bastion-site1:${id}`, { Id: `sha256:${'d'.repeat(64)}`, Labels: { 'bastion.app': 'site1', 'bastion.release': id, 'bastion.managed': 'app' } });
    fake.exec = ({ cmd }) => (cmd[0] === 'wget' ? { exitCode: 1, stderr: 'refused' } : { exitCode: 0 });
    const outcome = await ops.deploy(ctx(), 'site1', { prebuilt: `bastion-site1:${id}` });
    expect(outcome).toMatchObject({ release: id, result: 'failed' });
    expect(fake.images.has(`bastion-site1:${id}`)).toBe(false);
    expect(currentRelease(layout, 'site1')).toBe(good);
    expect(readRelease(layout, 'site1', id)).toMatchObject({ builtOn: 'bastion', result: 'failed' });
  });
});

describe('the app list', () => {
  /** Self-signed for list.test, valid 2026-10-05 to 2027-01-03 (certs.test.ts has the same). */
  const PEM = fs.readFileSync(path.join(import.meta.dirname, 'certs.test.ts'), 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n/)![0];

  it('reports each app’s certificate, its usage and who may deploy, from a few reads', async () => {
    await app();
    await app('blog', 'name: blog\ndomains: [blog.com]\nbuild: { type: dockerfile }\npermissions: { deploy: manage }\n');
    await app('idle', 'name: idle\ndomains: [idle.com]\nbuild: { type: dockerfile }\n');
    await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    await ops.deploy(ctx(), 'blog', upload('b.tgz', 'v1'));
    const dir = '/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory';
    fake.exec = ({ cmd }) => {
      if (cmd[0] === 'find') return { exitCode: 0, stdout: `${dir}/site1.com/site1.com.crt\n${dir}/www.site1.com/www.site1.com.crt\n${dir}/other.com/other.com.crt\n` };
      if (cmd[0] === 'sh') return { exitCode: 0, stdout: cmd.slice(4).map((f) => `\n==> ${f}\n${PEM}`).join('') };
      return { exitCode: 0 };
    };
    fake.execs.length = 0;
    const list = await ops.list(ctx());
    // One listing and one read of every certificate file of the apps' domains, never of others'
    expect(fake.execs.map((e) => e.cmd[0])).toEqual(['find', 'sh']);
    expect(fake.execs[1]!.cmd.slice(0, 4)).toEqual(['sh', '-c', 'for f in "$@"; do printf "\\n==> %s\\n" "$f"; cat -- "$f"; done', 'sh']);
    expect(fake.execs[1]!.cmd.slice(4)).toEqual([`${dir}/site1.com/site1.com.crt`, `${dir}/www.site1.com/www.site1.com.crt`]);

    const byName = new Map(list.map((a) => [a.name, a]));
    expect(byName.get('site1')).toMatchObject({
      permissions: { deploy: 'operate' },
      certificate: { issuer: 'Test Issuer T1', notAfter: '2027-01-03T14:36:30.000Z', daysLeft: expect.any(Number), lastError: null },
      // 0.5 s of CPU over 2 s of 2 CPUs; 64 MiB less 4 MiB page cache, of the 256m limit
      usage: { cpuPercent: 50, memoryBytes: 60 * 1024 ** 2, memoryLimitBytes: 256 * 1024 ** 2 },
    });
    expect(byName.get('site1')!.certificate!.daysLeft).toBe(Math.floor((Date.parse('2027-01-03T14:36:30Z') - clock) / 86_400_000));
    // No certificate yet; no memory limit configured
    expect(byName.get('blog')).toMatchObject({ permissions: { deploy: 'manage' }, certificate: { issuer: null, notAfter: null, daysLeft: null, lastError: null }, usage: { memoryLimitBytes: null } });
    // Not deployed: nothing to read
    expect(byName.get('idle')).toMatchObject({ certificate: null, usage: null });
    expect((await ops.status(ctx(), 'blog')).permissions).toEqual({ deploy: 'manage' });
  });

  it('reads certificate files of tls: { cert, key } apps, and certbot’s in nginx mode', async () => {
    await app('site1', SITE1.replace('redirect_www: apex\n', 'redirect_www: apex\ntls: { cert: tls/cert.pem, key: tls/key.pem }\n'));
    fs.mkdirSync(path.join(layout.app('site1'), 'tls'));
    fs.writeFileSync(path.join(layout.app('site1'), 'tls/cert.pem'), PEM);
    fs.writeFileSync(path.join(layout.app('site1'), 'tls/key.pem'), 'KEY');
    await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    fake.execs.length = 0;
    expect((await ops.list(ctx()))[0]!.certificate).toMatchObject({ issuer: 'Test Issuer T1', notAfter: '2027-01-03T14:36:30.000Z' });
    expect(fake.execs).toEqual([]);

    // nginx mode: the helper's public copy and certbot's last error
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-nginx-state-'));
    fs.writeFileSync(path.join(layout.proxy, 'mode'), 'nginx\n');
    fs.writeFileSync(layout.config('site1'), 'name: site1\ndomains: [site1.com]\nbuild: { type: dockerfile }\nproxy: nginx\n');
    fs.mkdirSync(path.join(state, 'certs'));
    fs.writeFileSync(path.join(state, 'certs/bastion-site1.pem'), PEM);
    fs.writeFileSync(path.join(state, 'bastion-site1.error'), '2026-10-05T11:00:00Z\ncertbot: Some challenges have failed.\n');
    expect((await ops.list({ ...ctx(), nginxStateDir: state }))[0]!.certificate).toEqual({
      issuer: 'Test Issuer T1',
      notAfter: '2027-01-03T14:36:30.000Z',
      daysLeft: expect.any(Number),
      lastError: 'certbot: Some challenges have failed.',
    });
    fs.rmSync(state, { recursive: true, force: true });
  });

  it('lists apps when the proxy cannot be read, without certificates', async () => {
    await app();
    await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    await new DockerApi(fake.socket).stop(PROXY_CONTAINER);
    expect((await ops.list(ctx()))[0]).toMatchObject({ name: 'site1', certificate: null });
  });
});

describe('config changes during a deploy', () => {
  it('serves the domains bastion.yml has at switch time, not those it had when the deploy began', async () => {
    await app();
    const first = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    // Another port, so the switch rebuilds the proxy config; the domains change while the new release is checked
    fs.writeFileSync(layout.config('site1'), SITE1.replace('port: 3000', 'port: 4000'));
    let changed = false;
    fake.exec = ({ cmd }) => {
      if (cmd[0] === 'wget' && !changed) {
        changed = true;
        fs.writeFileSync(layout.config('site1'), SITE1.replace('port: 3000', 'port: 4000').replace('[site1.com, www.site1.com]', '[site1.org]'));
      }
      return { exitCode: 0 };
    };
    const outcome = await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'));
    expect(outcome).toMatchObject({ result: 'success', previous: first });
    const caddyfile = fs.readFileSync(layout.caddyfile, 'utf8');
    expect(caddyfile).toContain('site1.org {\n\tencode zstd gzip\n\treverse_proxy bastion-site1-live-4000:4000 {');
    expect(caddyfile).not.toContain('site1.com');
    // redirect_www: apex brings www.site1.org along, redirected to site1.org
    expect(caddyfile).toContain('www.site1.org {');
    // The new Caddy is checked for the names it will serve
    expect(fake.execs.filter((e) => isReload(e.cmd)).at(-1)!.cmd.slice(7)).toEqual(['site1.org', 'www.site1.org']);
  });

  it('fails the deploy, the old release serving, when bastion.yml became invalid meanwhile', async () => {
    await app();
    const first = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    fake.exec = ({ cmd }) => {
      if (cmd[0] === 'wget') fs.writeFileSync(layout.config('site1'), 'name: site1\n');
      return { exitCode: 0 };
    };
    const outcome = await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'));
    expect(outcome).toMatchObject({ result: 'failed', error: expect.stringMatching(/bastion.yml of site1 is invalid/) });
    expect(currentRelease(layout, 'site1')).toBe(first);
    expect(fake.containers.has(`bastion-site1-${outcome.release}`)).toBe(false);
  });
});

describe('rollback, restart, stop and delete', () => {
  it('serves a kept release again without building', async () => {
    await app();
    const first = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    const second = (await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'))).release;
    const builds = fake.builds.length;

    const outcome = await ops.rollback(ctx(), 'site1', first);
    expect(outcome).toEqual({ app: 'site1', release: first, previous: second, result: 'success', error: null });
    expect(fake.builds).toHaveLength(builds);
    expect(fake.containers.get(`bastion-site1-${first}`)!.State.Running).toBe(true);
    expect(fake.containers.has(`bastion-site1-${second}`)).toBe(false);
    expect(fake.containers.get(`bastion-site1-${first}`)!.Networks).toEqual({ 'bastion-live': { Aliases: ['bastion-site1-live-3000'] } });
    expect([currentRelease(layout, 'site1'), previousRelease(layout, 'site1')]).toEqual([first, second]);

    await expect(ops.rollback(ctx(), 'site1', first)).rejects.toThrow(/already the current release/);
    await expect(ops.rollback(ctx(), 'site1', '20990101-000000-deadbeef')).rejects.toThrow(/has no release/);
    fake.images.delete(`bastion-site1:${second}`);
    await expect(ops.rollback(ctx(), 'site1', second)).rejects.toThrow(/pruned/);
  });

  it('restarts and stops the live container', async () => {
    await app();
    const id = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    expect(await ops.stop(ctx(), 'site1')).toEqual({ app: 'site1', container: `bastion-site1-${id}` });
    expect(fake.containers.get(`bastion-site1-${id}`)!.State.Running).toBe(false);
    await ops.restart(ctx(), 'site1');
    expect(fake.containers.get(`bastion-site1-${id}`)!.State.Running).toBe(true);
    expect((await ops.status(ctx(), 'site1')).container).toMatchObject({ state: 'running' });
  });

  it('restarts into a fresh container that picks up a changed .env, without a build', async () => {
    await app();
    const id = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    const before = fake.containers.get(`bastion-site1-${id}`)!;
    const builds = fake.builds.length;
    ops.envSet(ctx(), 'site1', 'GREETING', 'hello-new');

    expect(await ops.restart(ctx(), 'site1')).toEqual({ app: 'site1', container: `bastion-site1-${id}` });
    const after = fake.containers.get(`bastion-site1-${id}`)!;
    expect(after.Id).not.toBe(before.Id);
    expect(after.Env).toContain('GREETING=hello-new');
    expect(after.State.Running).toBe(true);
    expect(after.Networks).toEqual({ 'bastion-live': { Aliases: ['bastion-site1-live-3000'] } });
    expect([...fake.containers.keys()].filter((n) => n.startsWith('bastion-site1'))).toEqual([`bastion-site1-${id}`]);
    expect(fake.builds).toHaveLength(builds);
    expect(currentRelease(layout, 'site1')).toBe(id);
  });

  it('keeps the old container serving when the restarted one is unhealthy', async () => {
    await app();
    const id = (await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'))).release;
    const before = fake.containers.get(`bastion-site1-${id}`)!;
    fake.crashOnStart = (name) => name.endsWith('-next');

    await expect(ops.restart(ctx(), 'site1')).rejects.toThrow();
    expect(fake.containers.get(`bastion-site1-${id}`)).toBe(before);
    expect(before.State.Running).toBe(true);
    expect(fake.containers.has(`bastion-site1-${id}-next`)).toBe(false);
  });

  it('deletes an app: out of the proxy, containers and images gone, data kept unless purged', async () => {
    await app();
    await app('blog', 'name: blog\ndomains: [blog.com]\nbuild: { type: dockerfile }\n');
    await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    await ops.deploy(ctx(), 'blog', upload('b.tgz', 'v1'));
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toContain('site1.com');

    await ops.remove(ctx(), 'site1');
    const caddyfile = fs.readFileSync(layout.caddyfile, 'utf8');
    expect(caddyfile).not.toContain('site1.com');
    expect(caddyfile).toContain('blog.com');
    expect([...fake.containers.keys()].filter((n) => n.startsWith('bastion-site1'))).toEqual([]);
    expect([...fake.images.keys()].filter((n) => n.startsWith('bastion-site1'))).toEqual([]);
    expect(fs.existsSync(layout.config('site1'))).toBe(true);
    expect(fs.existsSync(layout.releases('site1'))).toBe(false);
    expect(currentRelease(layout, 'site1')).toBeNull();

    await ops.remove(ctx(), 'site1', { purge: true });
    expect(fs.existsSync(layout.app('site1'))).toBe(false);
    expect(fake.volumesRemoved).toEqual(['bastion-site1.data']);
    expect((await ops.list(ctx())).map((a) => a.name)).toEqual(['blog']);
  });
});

describe('init and validate', () => {
  it('writes the template or a validated config, never over an existing one without --force', async () => {
    expect(await ops.init(ctx(), 'fresh')).toEqual({ app: 'fresh', created: true });
    expect(fs.readFileSync(layout.config('fresh'), 'utf8')).toContain('name: fresh');
    expect(fs.statSync(layout.env('fresh')).mode & 0o777).toBe(0o600);
    await expect(ops.init(ctx(), 'fresh')).rejects.toThrow(/--force/);

    fs.writeFileSync(path.join(layout.tmp, 'bad.yml'), 'name: fresh\ndomains: [fresh.example.com]\nbuild: { type: dockerfile }\nrun: { port: 99999 }\n');
    await expect(ops.init(ctx(), 'fresh', { config: 'tmp/bad.yml', force: true })).rejects.toMatchObject({ exitCode: 3, message: expect.stringMatching(/run.port/) });
    expect(fs.readFileSync(layout.config('fresh'), 'utf8')).toContain('[fresh.example.com]');

    fs.writeFileSync(path.join(layout.tmp, 'dup.yml'), 'name: other\ndomains: [fresh.example.com]\nbuild: { type: dockerfile }\n');
    expect(ops.validate(ctx(), 'other', 'tmp/dup.yml')).toEqual({ ok: false, errors: [{ path: 'domains.0', message: 'fresh.example.com is already used by app fresh' }] });
    expect(ops.validate(ctx(), 'fresh')).toEqual({ ok: true, errors: [] });
  });

  it('puts the old config back when the proxy refuses a changed one', async () => {
    await app();
    await ops.deploy(ctx(), 'site1', upload('a.tgz', 'v1'));
    const before = fs.readFileSync(layout.config('site1'), 'utf8');
    fake.exec = ({ cmd }) => (cmd[1] === 'validate' ? { exitCode: 1, stderr: 'no' } : { exitCode: 0 });
    fs.writeFileSync(path.join(layout.tmp, 'next.yml'), before.replace('site1.com, www.site1.com', 'site1.org'));
    await expect(ops.init(ctx(), 'site1', { config: 'tmp/next.yml', force: true })).rejects.toThrow(/refused/);
    expect(fs.readFileSync(layout.config('site1'), 'utf8')).toBe(before);
  });
});

describe('the command line', () => {
  async function cli(args: string[], stdin = '') {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(args, {
      env: { BASTION_ROOT: root, BASTION_ACTOR: 'cli-user' },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      readStdin: async () => stdin,
      ctx: { docker: new DockerApi(fake.socket), drainMs: 0, healthIntervalMs: 1, now: () => new Date((clock += 1000)) },
    });
    return { code, out: out.join(''), err: err.join('') };
  }

  it('prints one JSON result line with --json and logs to stderr', async () => {
    await app();
    upload('up.tgz', 'v1');
    const res = await cli(['deploy', 'site1', '--source', 'tmp/up.tgz', '--json']);
    expect(res.code).toBe(0);
    expect(res.out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(res.out)).toMatchObject({ app: 'site1', result: 'success' });
    expect(res.err).toContain('Health check passed');
    expect(readRelease(layout, 'site1', JSON.parse(res.out).release)?.actor).toBe('cli-user');

    const list = await cli(['list', '--json']);
    expect(JSON.parse(list.out)).toEqual([expect.objectContaining({ name: 'site1', domains: ['site1.com', 'www.site1.com'], container: expect.objectContaining({ state: 'running' }) })]);
  });

  it('answers errors as { error, code } with the exit code', async () => {
    expect(await cli(['status', 'Bad_Name', '--json'])).toMatchObject({ code: 2, out: expect.stringContaining('"code":2') });
    expect(await cli(['deploy', 'site1', '--sauce', 'x', '--json'])).toMatchObject({ code: 2, out: expect.stringContaining('Unknown option --sauce') });
    expect(await cli(['rm', '-rf', '/'])).toMatchObject({ code: 2, err: expect.stringContaining('Unknown command rm') });
    expect(await cli(['status', 'nope', '--json'])).toMatchObject({ code: 1, out: expect.stringContaining('No app named nope') });
    fs.writeFileSync(path.join(layout.tmp, 'bad.yml'), 'name: x\n');
    expect(await cli(['validate', 'x', '--file', 'tmp/bad.yml', '--json'])).toMatchObject({ code: 3 });
  });

  it('reads env values from stdin and prints them only for env get', async () => {
    await app();
    const set = await cli(['env', 'set', 'site1', 'DB_URL', '--json'], 'postgres://u:p@db/x');
    expect(JSON.parse(set.out)).toEqual({ key: 'DB_URL', changed: true });
    expect(set.out + set.err).not.toContain('postgres://');
    expect(JSON.parse((await cli(['env', 'keys', 'site1', '--json'])).out)).toEqual({ keys: ['DB_URL'] });
    expect(JSON.parse((await cli(['env', 'get', 'site1', 'DB_URL', '--json'])).out)).toEqual({ key: 'DB_URL', value: 'postgres://u:p@db/x' });
    expect(JSON.parse((await cli(['env', 'unset', 'site1', 'DB_URL', '--json'])).out)).toEqual({ key: 'DB_URL', changed: true });
    expect((await cli(['env', 'set', 'site1', 'BAD-KEY', '--json'], 'x')).code).toBe(2);
    expect(fs.statSync(layout.env('site1')).mode & 0o777).toBe(0o600);
  });
});
