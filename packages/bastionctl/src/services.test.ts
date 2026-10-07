import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { run } from './cli.js';
import type { Ctx } from './context.js';
import { DockerApi } from './docker.js';
import { parseEnv } from './env.js';
import { startFakeDocker, type FakeDocker } from './fake-docker.test-helper.js';
import { Layout, PROXY_CONTAINER } from './names.js';
import * as ops from './ops.js';
import { currentRelease, readRelease } from './releases.js';

/**
 * Services (services spec §3.2) on a temp root and the fake Docker API:
 * `build.type: image` pulled and recorded by digest, health checks by TCP
 * connect and by a command in the container, `run.strategy: recreate` never
 * running two containers on a volume (and starting the previous one again
 * when the new one fails), `run.publish`, an app without domains (no proxy
 * entry), `env generate` and `exec`.
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
    now: () => new Date((clock += 1000)),
    drainMs: 0,
    healthIntervalMs: 1,
    report: {},
  };
}

const DIGEST = `sha256:${'a'.repeat(64)}`;
const DB = `name: db
service: postgres
domains: []
build: { type: image, image: "postgres:16.4@${DIGEST}" }
run:
  port: 5432
  volumes: [{ name: data, path: /var/lib/postgresql/data, exclusive: true }]
healthcheck: { type: command, command: [pg_isready, -h, 127.0.0.1, -U, app], timeout: 2s }
keep_releases: 2
`;

async function app(name: string, config: string) {
  fs.writeFileSync(path.join(layout.tmp, `${name}.yml`), config);
  await ops.init(ctx(), name, { config: `tmp/${name}.yml` });
}

const running = () => [...fake.containers.values()].filter((c) => c.State.Running);
const withVolume = (volume: string) => running().filter((c) => ((c.HostConfig.Mounts ?? []) as Array<{ Source: string }>).some((m) => m.Source === volume));

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-services-')));
  layout = new Layout(root);
  logs = [];
  clock = Date.parse('2026-10-07T12:00:00Z');
  fake.containers.clear();
  fake.images.clear();
  fake.networks.clear();
  fake.execs.length = 0;
  fake.pulls.length = 0;
  fake.events.length = 0;
  fake.volumesRemoved.length = 0;
  fake.exec = () => ({ exitCode: 0 });
  fake.crashOnStart = () => false;
  fake.pullError = null;
  fake.afterChange = null;
  await ops.setup(ctx());
  fake.pulls.length = 0;
  fake.execs.length = 0;
  fake.events.length = 0;
});

describe('build.type: image', () => {
  it('pulls the image instead of building, tags it as the release and records its digest', async () => {
    await app('db', DB);
    const outcome = await ops.deploy(ctx(), 'db');
    expect(outcome).toMatchObject({ app: 'db', result: 'success', error: null });
    expect(fake.pulls).toEqual([`postgres@${DIGEST}`]);
    expect(fake.builds.filter((b) => b.query.get('t')?.startsWith('bastion-db'))).toEqual([]);
    const id = outcome.release;
    expect(fake.images.has(`bastion-db:${id}`)).toBe(true);
    expect(readRelease(layout, 'db', id)).toMatchObject({ buildType: 'image', digest: DIGEST, image: `bastion-db:${id}`, result: 'success' });
    // No upload is kept: the release folder has its log and record only
    expect(fs.readdirSync(layout.release('db', id)).sort()).toEqual(['build.log', 'release.json']);
    // A digest already on the server is not pulled again
    await ops.deploy(ctx(), 'db');
    expect(fake.pulls).toHaveLength(1);
    expect(logs).toContain(`postgres:16.4@${DIGEST} is on the server already`);
  });

  it('pulls a tag every time, recording what it resolved to', async () => {
    await app('cache', 'name: cache\ndomains: []\nbuild: { type: image, image: "redis:7" }\nrun: { port: 6379 }\n');
    const outcome = await ops.deploy(ctx(), 'cache');
    expect(fake.pulls).toEqual(['redis:7']);
    expect(readRelease(layout, 'cache', outcome.release)?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await ops.deploy(ctx(), 'cache');
    expect(fake.pulls).toEqual(['redis:7', 'redis:7']);
  });

  it('records a failed pull as a failed release, the previous one serving', async () => {
    await app('cache', 'name: cache\ndomains: []\nbuild: { type: image, image: "redis:7" }\nrun: { port: 6379 }\n');
    const first = await ops.deploy(ctx(), 'cache');
    fake.pullError = 'manifest for redis:7 not found';
    const outcome = await ops.deploy(ctx(), 'cache');
    expect(outcome).toMatchObject({ result: 'failed', error: 'manifest for redis:7 not found' });
    expect(readRelease(layout, 'cache', outcome.release)).toMatchObject({ result: 'failed', digest: null });
    expect(currentRelease(layout, 'cache')).toBe(first.release);
  });

  it('takes no --source, and an upload app needs one', async () => {
    await app('db', DB);
    fs.writeFileSync(path.join(layout.tmp, 'x.tgz'), 'x');
    await expect(ops.deploy(ctx(), 'db', 'tmp/x.tgz')).rejects.toThrow(/build.type of db is image: postgres:16.4@sha256:a+ is pulled from its registry, so deploy takes no --source/);
    await app('web', 'name: web\ndomains: [web.com]\nbuild: { type: dockerfile }\n');
    await expect(ops.deploy(ctx(), 'web')).rejects.toThrow('Usage: bastionctl deploy <app> --source <file>');
  });

  it('removes the release tags with the app, never the pulled image', async () => {
    await app('db', DB);
    const { release } = await ops.deploy(ctx(), 'db');
    await ops.remove(ctx(), 'db', { purge: true });
    expect(fake.images.has(`bastion-db:${release}`)).toBe(false);
    expect(fake.images.has(`postgres@${DIGEST}`)).toBe(true);
    expect(fake.volumesRemoved).toContain('bastion-db.data');
  });
});

describe('an app without domains', () => {
  it('gets no proxy entry, and other apps reach it by its name on bastion-apps', async () => {
    await app('db', DB);
    const { release } = await ops.deploy(ctx(), 'db');
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).not.toContain('bastion-db-live');
    const c = fake.containers.get(`bastion-db-${release}`)!;
    expect(c.Aliases).toEqual(['db']);
    expect(c.HostConfig).not.toHaveProperty('PortBindings');
    expect(c.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: 'bastion-db.data', Target: '/var/lib/postgresql/data', ReadOnly: false }]);
  });

  it('leaves the proxy when its domains are taken away', async () => {
    await app('web', 'name: web\ndomains: [web.com]\nbuild: { type: image, image: "nginx:1.27" }\nrun: { port: 80 }\n');
    await ops.deploy(ctx(), 'web');
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toContain('web.com');
    fs.writeFileSync(path.join(layout.tmp, 'web.yml'), 'name: web\ndomains: []\nbuild: { type: image, image: "nginx:1.27" }\nrun: { port: 80 }\n');
    await ops.init(ctx(), 'web', { config: 'tmp/web.yml', force: true });
    await ops.restart(ctx(), 'web');
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).not.toContain('web.com');
  });
});

describe('health checks', () => {
  it('runs a command health check in the new container until it exits 0', async () => {
    await app('db', DB);
    // The test clock moves a second per reading: give it time for three attempts
    fs.writeFileSync(layout.config('db'), DB.replace('timeout: 2s', 'timeout: 30s'));
    let attempts = 0;
    fake.exec = ({ container, cmd }) => (cmd[0] === 'pg_isready' && container.startsWith('bastion-db-') && ++attempts < 3 ? { exitCode: 2, stderr: '127.0.0.1:5432 - no response' } : { exitCode: 0 });
    const { release } = await ops.deploy(ctx(), 'db');
    expect(fake.execs.filter((e) => e.cmd[0] === 'pg_isready')).toEqual(Array(3).fill({ container: `bastion-db-${release}`, cmd: ['pg_isready', '-h', '127.0.0.1', '-U', 'app'] }));
    expect(logs).toContain(`Health check: pg_isready -h 127.0.0.1 -U app in bastion-db-${release} (up to 30s)`);
  });

  it('fails a command health check with its output once the timeout passes', async () => {
    await app('db', DB);
    fake.exec = ({ cmd }) => (cmd[0] === 'pg_isready' ? { exitCode: 2, stdout: '127.0.0.1:5432 - no response' } : { exitCode: 0 });
    const outcome = await ops.deploy(ctx(), 'db');
    expect(outcome.result).toBe('failed');
    expect(outcome.error).toMatch(/^Health check failed after 2s: 127\.0\.0\.1:5432 - no response/);
  });

  it('connects over TCP from the proxy container by the container’s address', async () => {
    await app('cache', 'name: cache\ndomains: []\nbuild: { type: image, image: "redis:7" }\nrun: { port: 6379 }\n');
    const { release } = await ops.deploy(ctx(), 'cache');
    const c = fake.containers.get(`bastion-cache-${release}`)!;
    const probe = fake.execs.find((e) => e.container === PROXY_CONTAINER && e.cmd[0] === 'node' && e.cmd[1] === '-e')!;
    expect(probe.cmd[2]).toContain(`connect(6379,"${c.IPAddress}")`);
    expect(logs).toContain(`Health check: TCP connect to bastion-cache-${release}:6379 (up to 30s)`);
    fake.exec = ({ cmd }) => (cmd[1] === '-e' ? { exitCode: 1, stderr: 'connect ECONNREFUSED' } : { exitCode: 0 });
    fs.writeFileSync(path.join(layout.tmp, 'cache.yml'), 'name: cache\ndomains: []\nbuild: { type: image, image: "redis:7" }\nrun: { port: 6379 }\nhealthcheck: { type: tcp, timeout: 1s }\n');
    await ops.init(ctx(), 'cache', { config: 'tmp/cache.yml', force: true });
    expect((await ops.deploy(ctx(), 'cache')).error).toMatch(/^Health check failed after 1s: connect ECONNREFUSED/);
  });
});

describe('run.strategy: recreate', () => {
  it('never runs two containers on an exclusive volume, and keeps the data volume', async () => {
    await app('db', DB);
    let most = 0;
    fake.afterChange = () => (most = Math.max(most, withVolume('bastion-db.data').length));
    const first = await ops.deploy(ctx(), 'db');
    const second = await ops.deploy(ctx(), 'db');
    await ops.restart(ctx(), 'db');
    await ops.rollback(ctx(), 'db', first.release);
    expect(most).toBe(1);
    expect(withVolume('bastion-db.data').map((c) => c.Name)).toEqual([`bastion-db-${first.release}`]);
    expect([...fake.containers.keys()].filter((n) => n.startsWith('bastion-db-'))).toEqual([`bastion-db-${first.release}`]);
    // The old container stops before the new one is started
    const order = fake.events.filter((e) => e.includes('bastion-db-'));
    const stopFirst = order.indexOf(`stop bastion-db-${first.release}`);
    expect(stopFirst).toBeGreaterThan(-1);
    expect(stopFirst).toBeLessThan(order.indexOf(`start bastion-db-${second.release}`));
    expect(logs).toContain(`Stopping bastion-db-${first.release} before the new container starts (volume data is exclusive); the app is unavailable until the new one is healthy`);
    expect(fake.volumesRemoved).toEqual([]);
  });

  it('starts the previous container again when the new one fails, and says so', async () => {
    await app('db', DB);
    const good = await ops.deploy(ctx(), 'db');
    fake.exec = ({ container, cmd }) => (cmd[0] === 'pg_isready' && container !== `bastion-db-${good.release}` ? { exitCode: 2, stderr: 'no response' } : { exitCode: 0 });
    let most = 0;
    fake.afterChange = () => (most = Math.max(most, withVolume('bastion-db.data').length));
    const outcome = await ops.deploy(ctx(), 'db');
    expect(outcome.result).toBe('failed');
    expect(outcome.error).toMatch(new RegExp(`Health check failed after 2s: no response[\\s\\S]*\\nThe previous container \\(bastion-db-${good.release}\\) was started again and serves\\.$`));
    expect(most).toBe(1);
    expect(fake.containers.get(`bastion-db-${good.release}`)!.State.Running).toBe(true);
    expect(fake.containers.has(`bastion-db-${outcome.release}`)).toBe(false);
    expect(currentRelease(layout, 'db')).toBe(good.release);

    // A restart that fails the same way: the release's container is back too
    fake.exec = ({ cmd }) => (cmd[0] === 'pg_isready' ? { exitCode: 2, stderr: 'no response' } : { exitCode: 0 });
    await expect(ops.restart(ctx(), 'db')).rejects.toThrow(/was started again and serves/);
    expect(fake.containers.get(`bastion-db-${good.release}`)!.State.Running).toBe(true);
    expect(fake.containers.has(`bastion-db-${good.release}-next`)).toBe(false);
  });

  it('reports a previous container that would not start again', async () => {
    await app('db', DB);
    const good = await ops.deploy(ctx(), 'db');
    fake.exec = ({ cmd }) => (cmd[0] === 'pg_isready' ? { exitCode: 2 } : { exitCode: 0 });
    fake.crashOnStart = (name) => name === `bastion-db-${good.release}`;
    const docker = new DockerApi(fake.socket);
    const start = docker.start.bind(docker);
    docker.start = async (name) => {
      if (name.length === 64 && fake.containers.get(`bastion-db-${good.release}`)?.Id === name) throw new Error('port is already allocated');
      return start(name);
    };
    const outcome = await ops.deploy({ ...ctx(), docker }, 'db');
    expect(outcome.error).toMatch(/Starting the previous container again failed \(bastion-db-\S+: port is already allocated\); the app is down until a deploy, rollback or restart succeeds\.$/);
  });

  it('applies to an app that asks for it without a volume, rolling staying the default', async () => {
    await app('web', 'name: web\ndomains: [web.com]\nbuild: { type: image, image: "nginx:1.27" }\nrun: { port: 80, strategy: recreate }\n');
    const first = await ops.deploy(ctx(), 'web');
    const second = await ops.deploy(ctx(), 'web');
    const order = fake.events.filter((e) => e.includes('bastion-web-'));
    expect(order.indexOf(`stop bastion-web-${first.release}`)).toBeLessThan(order.indexOf(`start bastion-web-${second.release}`));
    expect(logs).toContain(`Stopping bastion-web-${first.release} before the new container starts (run.strategy is recreate); the app is unavailable until the new one is healthy`);
  });
});

describe('run.publish', () => {
  it('binds the port on 127.0.0.1 or every address, and refuses a host port another app publishes', async () => {
    await app('db', DB.replace('  port: 5432', '  port: 5432\n  publish: localhost:15432'));
    const { release } = await ops.deploy(ctx(), 'db');
    const c = fake.containers.get(`bastion-db-${release}`)!;
    expect(c.HostConfig.PortBindings).toEqual({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }] });

    await app('minio', 'name: minio\ndomains: []\nbuild: { type: image, image: "minio/minio:RELEASE.2024-10-02T17-50-41Z" }\nrun: { port: 9000, publish: "public:9000" }\n');
    const minio = await ops.deploy(ctx(), 'minio');
    expect(fake.containers.get(`bastion-minio-${minio.release}`)!.HostConfig.PortBindings).toEqual({ '9000/tcp': [{ HostIp: '0.0.0.0', HostPort: '9000' }] });

    fs.writeFileSync(path.join(layout.tmp, 'other.yml'), 'name: other\ndomains: []\nbuild: { type: image, image: "redis:7" }\nrun: { port: 6379, publish: "localhost:15432" }\n');
    await expect(ops.init(ctx(), 'other', { config: 'tmp/other.yml' })).rejects.toThrow('Invalid config: run.publish: Host port 15432 is already published by app db');
    expect(ops.validate(ctx(), 'db', 'tmp/other.yml').errors).toEqual([{ path: 'name', message: "Must be the app's name (db)" }]);
  });
});

describe('env generate', () => {
  it('writes a random URL-safe value, never printing it, and keeps one that is set with --if-missing', async () => {
    await app('db', DB);
    const out: string[] = [];
    const err: string[] = [];
    const cli = (args: string[]) =>
      run(args, { env: { BASTION_ROOT: root }, stdout: (t) => out.push(t), stderr: (t) => err.push(t), readStdin: async () => '', ctx: { docker: new DockerApi(fake.socket) } });
    expect(await cli(['env', 'generate', 'db', 'POSTGRES_PASSWORD', '--json'])).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual({ key: 'POSTGRES_PASSWORD', generated: true });
    const value = parseEnv(fs.readFileSync(layout.env('db'), 'utf8')).get('POSTGRES_PASSWORD')!;
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.join('') + err.join('')).not.toContain(value);
    expect(fs.statSync(layout.env('db')).mode & 0o777).toBe(0o600);

    expect(await cli(['env', 'generate', 'db', 'POSTGRES_PASSWORD', '--if-missing', '--json'])).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual({ key: 'POSTGRES_PASSWORD', generated: false });
    expect(parseEnv(fs.readFileSync(layout.env('db'), 'utf8')).get('POSTGRES_PASSWORD')).toBe(value);

    expect(await cli(['env', 'generate', 'db', 'POSTGRES_PASSWORD', '--bytes', '64', '--json'])).toBe(0);
    const longer = parseEnv(fs.readFileSync(layout.env('db'), 'utf8')).get('POSTGRES_PASSWORD')!;
    expect(longer).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(longer).not.toBe(value);

    for (const bad of [['--bytes', '8'], ['--bytes', '9999'], ['--bytes', 'x']]) {
      expect(await cli(['env', 'generate', 'db', 'K', ...bad, '--json']), bad.join(' ')).toBe(2);
    }
    expect(await cli(['env', 'generate', 'db', '1BAD', '--json'])).toBe(2);
    expect(await cli(['env', 'generate', 'nope', 'K', '--json'])).toBe(1);
  });
});

describe('exec', () => {
  async function cli(args: string[]) {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const text: string[] = [];
    const code = await run(args, {
      env: { BASTION_ROOT: root },
      stdout: (t) => text.push(t),
      stderr: () => {},
      writeStdout: (c) => out.push(c),
      writeStderr: (c) => err.push(c),
      readStdin: async () => '',
      ctx: { docker: new DockerApi(fake.socket) },
    });
    return { code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString(), text: text.join('') };
  }

  it('runs the argv in the live container as given, streaming its output and passing its exit code on', async () => {
    await app('db', DB);
    const { release } = await ops.deploy(ctx(), 'db');
    fake.exec = ({ cmd }) => (cmd[0] === 'psql' ? { exitCode: 3, stdout: ' count \n-------\n 42\n', stderr: 'NOTICE: hi\n' } : { exitCode: 0 });
    const r = await cli(['exec', 'db', '--', 'psql', '-U', 'app', '-c', 'select count(*) from t; --json', '--json']);
    expect(r.code).toBe(3);
    expect(r.out).toBe(' count \n-------\n 42\n');
    expect(r.err).toBe('NOTICE: hi\n');
    // Everything after -- is the program's, --json included
    expect(fake.execs.at(-1)).toEqual({ container: `bastion-db-${release}`, cmd: ['psql', '-U', 'app', '-c', 'select count(*) from t; --json', '--json'] });

    // With --json before --: the program's output on stderr, one result line on stdout
    const j = await cli(['exec', 'db', '--json', '--', 'psql']);
    expect(j.err).toContain(' 42\n');
    expect(JSON.parse(j.text)).toEqual({ app: 'db', container: `bastion-db-${release}`, exitCode: 3 });
  });

  it('refuses what it cannot run', async () => {
    await app('db', DB);
    expect((await cli(['exec', 'db', '--', 'ls'])).code).toBe(1); // no release yet
    await ops.deploy(ctx(), 'db');
    expect((await cli(['exec', 'db'])).code).toBe(2);
    expect((await cli(['exec', 'db', '--'])).code).toBe(2);
    expect((await cli(['exec', 'db', '--', ''])).code).toBe(2);
    expect((await cli(['exec', 'db', '--', 'a\0b'])).code).toBe(2);
    expect((await cli(['exec', 'db', '--', ...Array(300).fill('x')])).code).toBe(2);
    expect((await cli(['list', '--', 'ls'])).code).toBe(2);
    expect((await cli(['exec', '../x', '--', 'ls'])).code).toBe(2);
    await ops.stop(ctx(), 'db');
    expect((await cli(['exec', 'db', '--json', '--', 'ls'])).text).toMatch(/is not running/);
  });
});
