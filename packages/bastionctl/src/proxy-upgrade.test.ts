import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeployProxyUpgrade } from '@smt/shared';
import { run } from './cli.js';
import type { Ctx } from './context.js';
import { DockerApi } from './docker.js';
import { startFakeDocker, type FakeDocker } from './fake-docker.test-helper.js';
import { Layout, PROXY_CONTAINER } from './names.js';
import * as ops from './ops.js';
import { CADDY_ID, FRONT_PATH, PROXY_IMAGE } from './proxy-image.js';
import { PROXY_PREVIOUS, proxyStatus } from './proxy-upgrade.js';
import { LABEL_BUILD, LABEL_PROXY_SPEC } from './proxy.js';
import { tarBuffer } from './tar.js';
import { BASTIONCTL_VERSION } from './version.js';

/**
 * Automatic proxy upgrades (services spec §2) on a temp root and the fake
 * Docker API: what counts as outdated, Caddy replaced behind the running
 * front (the container stays), the front replaced with the old container
 * kept until the new one answers and put back when it does not, pinned
 * servers left alone, which commands upgrade (and which never do), and what
 * bastionctl reports for BastionSSH's audit.
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

function ctx(extra: Partial<Ctx> = {}): Ctx {
  return {
    layout,
    docker: new DockerApi(fake.socket),
    log: (line) => logs.push(line),
    actor: 'ann@example.com',
    now: () => new Date((clock += 1000)),
    drainMs: 0,
    healthIntervalMs: 1,
    proxyReadyMs: 200,
    report: {},
    ...extra,
  };
}

const SITE = 'name: site1\ndomains: [site1.com]\nbuild: { type: dockerfile }\nrun: { port: 3000 }\nhealthcheck: { path: /, timeout: 2s }\n';

function upload(name: string): string {
  const file = path.join(layout.tmp, name);
  fs.writeFileSync(file, zlib.gzipSync(tarBuffer([{ name: 'Dockerfile', content: `FROM busybox\nRUN echo ${name}\n` }])));
  return file;
}

const caddyDir = () => path.join(layout.proxy, 'caddy');
const OLD_CADDY = '0123456789abcdef';
const OLD_BUILD = '0.1.0+1111111';

/** As an older bastionctl left it: another Caddy linked, and its build recorded. */
function olderCaddy() {
  fs.mkdirSync(path.join(caddyDir(), OLD_CADDY), { recursive: true });
  fs.writeFileSync(path.join(caddyDir(), OLD_CADDY, 'caddy'), 'old caddy', { mode: 0o755 });
  fs.rmSync(path.join(caddyDir(), 'caddy'));
  fs.symlinkSync(`${OLD_CADDY}/caddy`, path.join(caddyDir(), 'caddy'));
  fs.writeFileSync(path.join(layout.proxy, 'state.json'), JSON.stringify({ build: OLD_BUILD, caddy: OLD_CADDY }));
}

/** A proxy container another build created with another spec (or before labels: the image of an older front). */
function olderFront(opts: { unlabelled?: boolean } = {}) {
  const proxy = fake.containers.get(PROXY_CONTAINER)!;
  fake.images.set('bastion-proxy:00000000000000ff', { Id: 'sha256:oldfront', Labels: { 'bastion.proxy-image': '1' } });
  proxy.Image = 'bastion-proxy:00000000000000ff';
  if (opts.unlabelled) proxy.Labels = { 'bastion.managed': 'proxy', 'bastion.proxy-mode': 'caddy' };
  else proxy.Labels = { ...proxy.Labels, [LABEL_BUILD]: OLD_BUILD, [LABEL_PROXY_SPEC]: 'ffffffffffffffff' };
  fs.writeFileSync(path.join(layout.proxy, 'state.json'), JSON.stringify({ build: OLD_BUILD, caddy: CADDY_ID }));
  return proxy;
}

const proxyExecs = () => fake.execs.filter((e) => e.container === PROXY_CONTAINER).map((e) => e.cmd);
const reloads = () => proxyExecs().filter((c) => c[0] === 'node' && c[1] === FRONT_PATH && c[2] === 'reload');

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-upgrade-')));
  layout = new Layout(root);
  logs = [];
  clock = Date.parse('2026-10-07T12:00:00Z');
  fake.containers.clear();
  fake.images.clear();
  fake.networks.clear();
  fake.execs.length = 0;
  fake.events.length = 0;
  fake.exec = () => ({ exitCode: 0 });
  fake.crashOnStart = () => false;
  fake.afterChange = null;
  await ops.setup(ctx());
  fs.writeFileSync(path.join(layout.tmp, 'site1.yml'), SITE);
  await ops.init(ctx(), 'site1', { config: 'tmp/site1.yml' });
  await ops.deploy(ctx(), 'site1', upload('a.tgz'));
  fake.execs.length = 0;
  fake.events.length = 0;
  logs = [];
});

describe('proxy status', () => {
  it('is ok right after setup, and tells an older Caddy from an older front', async () => {
    expect(await proxyStatus(ctx())).toEqual({ state: 'ok', build: BASTIONCTL_VERSION, target: BASTIONCTL_VERSION, outdated: [], pinned: false });
    olderCaddy();
    expect(await proxyStatus(ctx())).toMatchObject({ state: 'outdated', build: OLD_BUILD, outdated: ['caddy'] });
    olderFront();
    // The link still names the older Caddy
    expect(await proxyStatus(ctx())).toMatchObject({ state: 'outdated', outdated: ['caddy', 'front'] });
    fake.containers.get(PROXY_CONTAINER)!.State.Running = false;
    expect((await proxyStatus(ctx())).state).toBe('stopped');
    fake.containers.delete(PROXY_CONTAINER);
    expect(await proxyStatus(ctx())).toMatchObject({ state: 'missing', build: null });
  });

  it('is read-only: proxy status, list and status never upgrade', async () => {
    olderCaddy();
    olderFront();
    const before = fake.containers.get(PROXY_CONTAINER)!.Id;
    await ops.list(ctx());
    await ops.status(ctx(), 'site1');
    await ops.releases(ctx(), 'site1');
    const out: string[] = [];
    const code = await run(['proxy', 'status', '--json'], {
      env: { BASTION_ROOT: root },
      stdout: (t) => out.push(t),
      stderr: () => {},
      readStdin: async () => '',
      ctx: { docker: new DockerApi(fake.socket) },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ state: 'outdated', outdated: ['caddy', 'front'], pinned: false });
    expect(fake.containers.get(PROXY_CONTAINER)!.Id).toBe(before);
    expect(reloads()).toEqual([]);
    expect(fs.readlinkSync(path.join(caddyDir(), 'caddy'))).toBe(`${OLD_CADDY}/caddy`);
  });
});

describe('a newer Caddy only', () => {
  it('is started behind the running front on the next deploy: the container stays, nothing is dropped', async () => {
    olderCaddy();
    const proxy = fake.containers.get(PROXY_CONTAINER)!;
    const c = ctx();
    const outcome = await ops.deploy(c, 'site1', upload('b.tgz'));
    expect(outcome.result).toBe('success');
    expect(c.report!.proxyUpgrade).toEqual({ from: OLD_BUILD, to: BASTIONCTL_VERSION, trigger: 'deploy', result: 'success', replaced: ['caddy'] });
    // The same container: the front started a new Caddy generation with the new binary
    expect(fake.containers.get(PROXY_CONTAINER)).toBe(proxy);
    expect(fake.events.filter((e) => e.endsWith(PROXY_CONTAINER))).toEqual([]);
    expect(fs.readlinkSync(path.join(caddyDir(), 'caddy'))).toBe(`${CADDY_ID}/caddy`);
    expect(reloads()).toHaveLength(1);
    // Validated with, and started from, the new binary by its own path
    expect(proxyExecs()[0]).toEqual([`/bastion-proxy/caddy/${CADDY_ID}/caddy`, 'validate', '--config', '/bastion-proxy/Caddyfile', '--adapter', 'caddyfile']);
    expect(reloads()[0]!.slice(5, 7)).toEqual(['--caddy', `/bastion-proxy/caddy/${CADDY_ID}/caddy`]);
    expect(JSON.parse(fs.readFileSync(path.join(layout.proxy, 'state.json'), 'utf8'))).toEqual({ build: BASTIONCTL_VERSION, caddy: CADDY_ID });
    // The old binary stays while its generation may still drain; one before it would go
    expect(fs.existsSync(path.join(caddyDir(), OLD_CADDY, 'caddy'))).toBe(true);
    expect(logs).toContain(`Upgrading the proxy from bastionctl ${OLD_BUILD} to ${BASTIONCTL_VERSION} (caddy)`);
    expect(logs).toContain(`Starting Caddy ${CADDY_ID} behind the running proxy front (no connection is dropped)`);
    // Up to date now: the next command does nothing to the proxy
    const next = ctx();
    await ops.restart(next, 'site1');
    expect(next.report!.proxyUpgrade).toBeUndefined();
  });

  it('puts the link back when the new Caddy refuses the config, and the command goes on with the running one', async () => {
    olderCaddy();
    fake.exec = ({ cmd }) => (cmd[0] === `/bastion-proxy/caddy/${CADDY_ID}/caddy` && cmd[1] === 'validate' && cmd[3] === '/bastion-proxy/Caddyfile' ? { exitCode: 1, stderr: 'Error: adapting config: unknown directive' } : { exitCode: 0 });
    const c = ctx();
    const outcome = await ops.deploy(c, 'site1', upload('b.tgz'));
    expect(outcome.result).toBe('success');
    expect(c.report!.proxyUpgrade).toMatchObject({ result: 'failed', replaced: ['caddy'], error: expect.stringMatching(/The new Caddy refuses the proxy config/) });
    expect(fs.readlinkSync(path.join(caddyDir(), 'caddy'))).toBe(`${OLD_CADDY}/caddy`);
    expect(JSON.parse(fs.readFileSync(path.join(layout.proxy, 'state.json'), 'utf8')).build).toBe(OLD_BUILD);
    expect(reloads()).toEqual([]);
    expect(logs.some((l) => l.startsWith('warning: the proxy upgrade failed; the previous proxy serves and deploy goes on with it'))).toBe(true);
  });
});

describe('a newer front', () => {
  it('replaces the container, keeping the old one until the new one accepts connections', async () => {
    const again = olderFront();
    const r = ctx();
    await ops.restart(r, 'site1');
    expect(r.report!.proxyUpgrade).toEqual({ from: OLD_BUILD, to: BASTIONCTL_VERSION, trigger: 'restart', result: 'success', replaced: ['front'] });
    const proxy = fake.containers.get(PROXY_CONTAINER)!;
    expect(proxy).not.toBe(again);
    expect(proxy.Image).toBe(PROXY_IMAGE);
    expect(proxy.Labels[LABEL_BUILD]).toBe(BASTIONCTL_VERSION);
    expect(proxy.State.Running).toBe(true);
    expect(proxy.Networks).toEqual({ 'bastion-live': { Aliases: [] } });
    expect(fake.containers.has(PROXY_PREVIOUS)).toBe(false);
    // Moved aside and stopped, the new one started and answering, only then removed
    const order = fake.events.filter((e) => e.includes('bastion-caddy'));
    expect(order).toEqual([`stop ${PROXY_PREVIOUS}`, `start ${PROXY_CONTAINER}`, `remove ${PROXY_PREVIOUS}`]);
    expect(proxyExecs().some((cmd) => cmd[0] === 'node' && cmd[1] === '-e')).toBe(true);
    // The old front's image goes; the warning about connections in flight is logged
    expect(fake.images.has('bastion-proxy:00000000000000ff')).toBe(false);
    expect(logs).toContain('Connections in flight may drop for about a second while the ports move to the new container; the previous one is kept until the new one answers');
  });

  it('upgrades a proxy from before labels (an older bastionctl’s), reporting its build as unknown', async () => {
    olderFront({ unlabelled: true });
    fs.rmSync(path.join(layout.proxy, 'state.json'));
    const c = ctx();
    await ops.proxyApply(c);
    expect(c.report!.proxyUpgrade).toMatchObject({ from: 'unknown', trigger: 'proxy_apply', result: 'success', replaced: ['front'] });
  });

  it('puts the old container back and starts it when the new one does not come up', async () => {
    const old = olderFront();
    fake.crashOnStart = (name) => name === PROXY_CONTAINER && fake.containers.get(name) !== old;
    const c = ctx();
    const outcome = await ops.deploy(c, 'site1', upload('b.tgz'));
    // The deploy itself went on with the previous proxy
    expect(outcome.result).toBe('success');
    expect(c.report!.proxyUpgrade).toMatchObject({ from: OLD_BUILD, result: 'failed', replaced: ['front'], error: expect.stringMatching(/The new proxy container stopped/) });
    expect(fake.containers.get(PROXY_CONTAINER)).toBe(old);
    expect(old.State.Running).toBe(true);
    expect(fake.containers.has(PROXY_PREVIOUS)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(layout.proxy, 'state.json'), 'utf8')).build).toBe(OLD_BUILD);
    expect(logs.some((l) => l.startsWith('The new proxy did not come up; restoring the previous one'))).toBe(true);
  });

  it('gives up waiting for a new front that never accepts connections, and restores', async () => {
    const old = olderFront();
    fake.exec = ({ cmd }) => (cmd[0] === 'node' && cmd[1] === '-e' && cmd[2]!.includes('connect(80') ? { exitCode: 1, stderr: 'ECONNREFUSED' } : { exitCode: 0 });
    const out: string[] = [];
    const code = await run(['proxy', 'upgrade', '--json'], {
      env: { BASTION_ROOT: root },
      stdout: (t) => out.push(t),
      stderr: () => {},
      readStdin: async () => '',
      ctx: { docker: new DockerApi(fake.socket), proxyReadyMs: 50, healthIntervalMs: 1 },
    });
    expect(code).toBe(1);
    const answer = JSON.parse(out.join('')) as { error: string; proxyUpgrade: DeployProxyUpgrade };
    expect(answer.error).toMatch(/The proxy could not be upgraded .* the previous one keeps serving: The new proxy did not accept connections in time/);
    expect(answer.proxyUpgrade).toMatchObject({ trigger: 'manual', result: 'failed', replaced: ['front'] });
    expect(fake.containers.get(PROXY_CONTAINER)).toBe(old);
    expect(old.State.Running).toBe(true);
  });

  it('puts back a proxy an upgrade cut off left aside', async () => {
    const old = olderFront();
    fake.containers.delete(PROXY_CONTAINER);
    old.Name = PROXY_PREVIOUS;
    old.State = { ...old.State, Running: false, Status: 'exited' };
    fake.containers.set(PROXY_PREVIOUS, old);
    const c = ctx();
    await ops.deploy(c, 'site1', upload('b.tgz'));
    expect(logs).toContain(`Putting back ${PROXY_PREVIOUS} (an upgrade was cut off before its replacement was in place)`);
    expect(c.report!.proxyUpgrade).toMatchObject({ result: 'success', replaced: ['front'] });
    expect(fake.containers.get(PROXY_CONTAINER)!.Image).toBe(PROXY_IMAGE);
  });
});

describe('pinned servers and explicit requests', () => {
  it('leaves a pinned server’s proxy alone, but proxy upgrade and setup still upgrade it', async () => {
    olderCaddy();
    const old = olderFront();
    fs.writeFileSync(path.join(layout.bin, '.pinned'), 'testing elsewhere first\n');
    expect(await proxyStatus(ctx())).toMatchObject({ state: 'outdated', pinned: true });
    const c = ctx();
    expect((await ops.deploy(c, 'site1', upload('b.tgz'))).result).toBe('success');
    await ops.restart(c, 'site1');
    await ops.proxyApply(c);
    expect(c.report!.proxyUpgrade).toBeUndefined();
    expect(fake.containers.get(PROXY_CONTAINER)).toBe(old);
    expect(logs).toContain(`warning: the proxy is from bastionctl ${OLD_BUILD} (this is ${BASTIONCTL_VERSION}); this server is pinned, so it is not upgraded automatically`);

    const manual = ctx();
    const r = await ops.proxyUpgrade(manual);
    expect(r.proxyUpgrade).toMatchObject({ trigger: 'manual', result: 'success', replaced: ['front', 'caddy'] });
    expect(r.status).toMatchObject({ state: 'ok', pinned: true });
    expect(fs.readlinkSync(path.join(caddyDir(), 'caddy'))).toBe(`${CADDY_ID}/caddy`);
    // Nothing left to do
    expect((await ops.proxyUpgrade(ctx())).proxyUpgrade).toBeNull();

    olderFront();
    const s = ctx();
    const setup = await ops.setup(s);
    expect(s.report!.proxyUpgrade).toMatchObject({ trigger: 'setup', result: 'success' });
    expect(setup.proxyContainer?.state).toBe('running');
  });

  it('reports the upgrade in the command’s JSON, and in { error } when the command itself fails', async () => {
    olderCaddy();
    const out: string[] = [];
    const io = {
      env: { BASTION_ROOT: root },
      stdout: (t: string) => out.push(t),
      stderr: () => {},
      readStdin: async () => '',
      ctx: { docker: new DockerApi(fake.socket), drainMs: 0, healthIntervalMs: 1, now: () => new Date((clock += 1000)) },
    };
    expect(await run(['restart', 'site1', '--json'], io)).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ app: 'site1', proxyUpgrade: { trigger: 'restart', result: 'success', replaced: ['caddy'] } });

    olderCaddy();
    // Rolling back to the release that serves fails, after the upgrade ran
    const current = (await ops.status(ctx(), 'site1')).currentRelease!;
    expect(await run(['rollback', 'site1', current, '--json'], io)).toBe(1);
    expect(JSON.parse(out.pop()!)).toMatchObject({ error: expect.stringMatching(/already the current release/), proxyUpgrade: { trigger: 'rollback', result: 'success' } });
  });
});
