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
import { applyProxy, CADDY_IMAGE, siteFor } from './proxy.js';
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

function caddyCommands() {
  return fake.execs.filter((e) => e.container === PROXY_CONTAINER && e.cmd[0] === 'caddy').map((e) => e.cmd.slice(0, 2).join(' '));
}

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
  await ops.setup(ctx());
  fake.execs.length = 0;
});

describe('setup', () => {
  it('creates the folders, network and proxy container once, and is safe to repeat', async () => {
    for (const dir of ['bin', 'apps', 'tmp', 'proxy/data', 'proxy/config']) expect(fs.statSync(path.join(root, dir)).isDirectory(), dir).toBe(true);
    expect(fs.statSync(layout.tmp).mode & 0o777).toBe(0o700);
    expect(fake.networks.has('bastion-apps')).toBe(true);
    expect([...fake.internalNetworks]).toEqual(['bastion-live']);
    expect(fake.pulls).toEqual([CADDY_IMAGE]);
    const proxy = fake.containers.get(PROXY_CONTAINER)!;
    expect(proxy.Image).toBe(CADDY_IMAGE);
    expect(proxy.State.Running).toBe(true);
    expect(proxy.HostConfig).toMatchObject({
      Binds: [`${root}/proxy:/bastion-proxy`, `${root}/proxy/data:/data`, `${root}/proxy/config:/config`],
      NetworkMode: 'bastion-apps',
      RestartPolicy: { Name: 'unless-stopped' },
    });
    expect(proxy.Networks).toEqual({ 'bastion-live': { Aliases: [] } });
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toContain('admin localhost:2019');

    const id = proxy.Id;
    const again = await ops.setup(ctx());
    expect(again).toMatchObject({ root, proxy: 'caddy', network: 'bastion-apps', proxyContainer: { state: 'running' } });
    expect(fake.containers.get(PROXY_CONTAINER)!.Id).toBe(id);
    expect(fake.pulls).toHaveLength(1);
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
    expect(fake.requests.indexOf('POST /networks/bastion-live/connect')).toBeGreaterThan(fake.requests.indexOf('POST /exec/' + ''));

    // Health check from the proxy, then validate before reload
    expect(fake.execs[0]).toEqual({ container: PROXY_CONTAINER, cmd: ['wget', '-q', '-O', '/dev/null', '-T', '5', `http://bastion-site1-${id}:3000/health`] });
    expect(caddyCommands()).toEqual(['caddy validate', 'caddy reload']);
    const caddyfile = fs.readFileSync(layout.caddyfile, 'utf8');
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
    expect(caddyCommands()).toEqual(['caddy validate', 'caddy reload']);
    const second = (await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'))).release;
    // Same domains and port: traffic moved over the live alias, Caddy was not reloaded
    expect(caddyCommands()).toEqual(['caddy validate', 'caddy reload']);
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
    fake.exec = ({ cmd }) => (cmd[1] === 'reload' && ++reloads === 1 ? { exitCode: 1, stderr: 'Error: loading new config: bad things' } : { exitCode: 0 });

    const outcome = await ops.deploy(ctx(), 'site1', upload('b.tgz', 'v2'));
    expect(outcome.result).toBe('failed');
    expect(outcome.error).toMatch(/Reloading the proxy failed; the previous config was restored:\nError: loading new config: bad things/);
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toBe(before);
    // validate, reload (refused), reload of the restored file
    expect(caddyCommands().slice(-3)).toEqual(['caddy validate', 'caddy reload', 'caddy reload']);
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
