import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Builds on the BastionSSH side through the routes, with both ends faked:
 * the server at deploy/remote.ts (a scripted bastionctl, and its Docker
 * Engine API as an in-process daemon on a Unix socket that takes
 * `/images/load`), and BuildKit as a fake `buildctl` script. Under test: the
 * upload never reaching the server, environment files left out (or kept),
 * only NEXT_PUBLIC_* and build.args reaching the build and their values
 * masked, the image loaded gzipped then served with `deploy --prebuilt`,
 * one build at a time, cancel (and what it leaves: no image, no context
 * folder), a failed build, the builder's status and Clear build cache, and
 * the audit.
 */

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-deploy-build-'));
  process.env.SMT_BUILDKIT_ADDR = 'tcp://buildkit:1234';
  process.env.SMT_BUILDCTL_PATH = path.join(dir, 'bin', 'buildctl');
  process.env.SMT_BUILD_WORK_DIR = path.join(dir, 'work');
  return { dir, socket: path.join(dir, 'docker.sock'), work: path.join(dir, 'work'), log: path.join(dir, 'buildctl.log') };
});

interface Scripted {
  stdout?: unknown;
  stderr?: string[];
  exitCode?: number | null;
}

const fake = vi.hoisted(() => ({
  runs: [] as string[][],
  uploads: 0,
  bastionctl: null as null | ((args: string[]) => Scripted),
  /** Bodies /images/load received, gunzipped. */
  loads: [] as Buffer[],
  removed: [] as string[],
  images: new Set<string>(),
  /** What the server's Docker says it runs on (`/info`). */
  arch: 'x86_64',
}));

function parseQuoted(command: string): string[] {
  const argv: string[] = [];
  let i = 0;
  while (i < command.length) {
    let word = '';
    for (;;) {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end);
      i = end + 1;
      if (command.startsWith("\\''", i)) {
        word += "'";
        i += 2;
        continue;
      }
      break;
    }
    argv.push(word);
    i++;
  }
  return argv;
}

vi.mock('../../deploy/remote.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../deploy/remote.js')>();
  const net = await import('node:net');
  const { createHash } = await import('node:crypto');
  const { DockerClient } = await import('../../docker/client.js');
  const { DISCOVER_SCRIPT } = await import('../../deploy/install.js');
  const SCRIPT = Buffer.from('// bastionctl.mjs as shipped\n');
  const WRAPPER = Buffer.from('#!/bin/sh\n# bastionctl wrapper as shipped\n');
  const files = new Map<string, Buffer>([
    ['/opt/bastion/bin/bastionctl.mjs', SCRIPT],
    ['/opt/bastion/bin/bastionctl', WRAPPER],
  ]);
  const openRemote = async (_req: unknown, server: import('../../deploy/remote.js').ServerRow): Promise<import('../../deploy/remote.js').Remote> => ({
    server,
    async run(command, opts = {}) {
      const argv = parseQuoted(command);
      const done = (stdout: string, exitCode: number | null = 0) => ({ exitCode, signal: null, timedOut: false, stdout, stderr: '', durationMs: 1 });
      if (argv[0] === 'sh' && argv[2] === DISCOVER_SCRIPT) return done('root=/opt/bastion\n');
      const args = argv.slice(3, -1);
      fake.runs.push(args);
      const scripted = fake.bastionctl!(args);
      for (const line of scripted.stderr ?? []) opts.onLine?.('stderr', line);
      return done(scripted.stdout === undefined ? '' : JSON.stringify(scripted.stdout) + '\n', scripted.exitCode ?? 0);
    },
    async hashFile(path) {
      const data = files.get(path);
      return data ? createHash('sha256').update(data).digest('hex') : null;
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async writeFile() {},
    async upload() {
      fake.uploads++;
      return 0;
    },
    async remove() {},
    async download() {
      return null;
    },
    async docker() {
      return new DockerClient(
        () =>
          new Promise((resolve, reject) => {
            const s = net.connect(env.socket);
            s.once('connect', () => resolve(s));
            s.once('error', reject);
          }),
        '1.45',
      );
    },
    release() {},
  });
  return { ...actual, openRemote };
});

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog } from '../../db/schema.js';
import { config } from '../../config/index.js';
import { setBastionctlBundleForTests } from '../../deploy/bundle.js';
import { resetBastionctlUpgradesForTests } from '../../deploy/upgrade.js';
import { BUILD_CACHE_FILTERS } from '../../build/buildctl.js';
import { fakeBuildctlCalls, tarOf, writeFakeBuildctl } from '../../build/fake-buildctl.test-helper.js';
import { activeBuildCount } from './deploy-build.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

const SCRIPT = Buffer.from('// bastionctl.mjs as shipped\n');
const WRAPPER = Buffer.from('#!/bin/sh\n# bastionctl wrapper as shipped\n');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const ARGS = { NEXT_PUBLIC_API_URL: 'https://api.example.com', SENTRY_RELEASE: 'release-2026-10-09' };

function status(where: 'server' | 'bastion' = 'bastion') {
  return {
    name: 'site1',
    config: {
      name: 'site1',
      permissions: { deploy: 'operate' },
      build: { type: 'nextjs', node: null, dir: '.', output: null, image: null, where, args: ['SENTRY_RELEASE'] },
      run: { port: 3000, env_file: '.env', volumes: [], memory: null, cpus: null, strategy: 'rolling', publish: { scope: 'none', port: null } },
    },
    configError: null,
  };
}

function defaultBastionctl(args: string[]): Scripted {
  const [command, ...rest] = args;
  if (command === 'status') return { stdout: { ...status(), name: rest[0] } };
  if (command === 'env' && rest[0] === 'build-args') return { stdout: { args: ARGS } };
  if (command === 'deploy') {
    const tag = rest[rest.indexOf('--prebuilt') + 1] ?? '';
    return { stderr: ['Health check passed'], stdout: { app: rest[0], release: tag.split(':')[1] ?? 'x', previous: null, result: 'success', error: null } };
  }
  if (command === 'proxy') return { stdout: { state: 'ok', build: '9.9.9', target: '9.9.9', outdated: [], pinned: false } };
  return { stdout: { error: `Unknown command ${command}`, code: 2 }, exitCode: 2 };
}

const NEXT_APP = {
  'package.json': '{"name":"site1","scripts":{"build":"next build"}}',
  'package-lock.json': '{}',
  'next.config.js': "module.exports = { output: 'standalone' };",
  'app/page.js': 'export default function Page() { return null }',
  '.env': 'DATABASE_URL=postgres://u:hunter2@db/app',
  '.env.local': 'SECRET=local',
  '.env.example': 'DATABASE_URL=',
};

describe('builds on the BastionSSH side', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let daemon: http.Server;
  let base: string;
  let orgId: string;
  let admin: { userId: string; headers: Record<string, string> };
  let operator: { userId: string; headers: Record<string, string> };
  let serverA: string;

  const api = (p = '') => `/api/deploy/servers/${serverA}${p}`;
  const audits = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .orderBy(desc(auditLog.createdAt))
      .all()
      .map((r) => JSON.parse(r.metadata ?? '{}') as Record<string, unknown>);

  async function deploy(who = operator, query = '', files: Record<string, string> = NEXT_APP) {
    const form = new FormData();
    form.append('source', new Blob([zlib.gzipSync(tarOf(files))]), 'site.tar.gz');
    return fetch(`${base}${api(`/apps/site1/deploy${query}`)}`, { method: 'POST', headers: who.headers, body: form });
  }

  async function events(res: Response): Promise<Array<Record<string, unknown>>> {
    return (await res.text())
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
  }

  const logText = (evs: Array<Record<string, unknown>>) =>
    evs
      .filter((e) => e.type === 'log')
      .flatMap((e) => (e.lines as Array<{ text: string }>).map((l) => l.text))
      .join('\n');

  const workLeft = () => (fs.existsSync(env.work) ? fs.readdirSync(env.work) : []);

  beforeAll(async () => {
    writeFakeBuildctl(path.dirname(process.env.SMT_BUILDCTL_PATH!));
    daemon = http.createServer((req, res) => {
      const route = (req.url ?? '').replace(/^\/v[\d.]+/, '');
      if (route === '/info') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ OSType: 'linux', Architecture: fake.arch }));
      }
      if (route.startsWith('/images/load') && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const tar = zlib.gunzipSync(Buffer.concat(chunks));
          fake.loads.push(tar);
          const name = /"RepoTags":\["([^"]+)"\]/.exec(tar.toString('latin1'))?.[1] ?? '';
          fake.images.add(name);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ stream: `Loaded image: ${name}\n` }) + '\n');
        });
        return;
      }
      const m = /^\/images\/([^/?]+)(?:\?.*)?$/.exec(route);
      if (m && req.method === 'DELETE') {
        const name = decodeURIComponent(m[1]!);
        fake.removed.push(name);
        res.statusCode = fake.images.delete(name) ? 200 : 404;
        return res.end(res.statusCode === 200 ? '[]' : JSON.stringify({ message: 'No such image' }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `not faked: ${req.method} ${route}` }));
    });
    await new Promise<void>((r) => daemon.listen(env.socket, r));
    await runMigrations();
    setBastionctlBundleForTests({ version: '9.9.9', script: SCRIPT, wrapper: WRAPPER, scriptSha256: sha(SCRIPT), wrapperSha256: sha(WRAPPER) });
    orgId = seedOrg('org-deploy-build');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    serverA = seedServer(orgId, admin.userId, 'web-1');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((r) => daemon.close(r));
    setBastionctlBundleForTests(undefined);
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fake.runs.length = 0;
    fake.uploads = 0;
    fake.loads.length = 0;
    fake.removed.length = 0;
    fake.images.clear();
    fake.arch = 'x86_64';
    fake.bastionctl = defaultBastionctl;
    fs.rmSync(env.log, { force: true });
    process.env.FAKE_BUILDCTL_LOG = env.log;
    for (const k of ['FAKE_BUILD_DELAY_MS', 'FAKE_BUILD_EXIT', 'FAKE_BUILD_SIGNAL_FILE', 'FAKE_BUILDKIT_DOWN', 'FAKE_BUILDKIT_PLATFORM']) delete process.env[k];
    (config.builder as { addr: string | null }).addr = 'tcp://buildkit:1234';
    (config.builder as { timeoutMs: number }).timeoutMs = 30 * 60_000;
    resetBastionctlUpgradesForTests();
  });

  it('builds next to BastionSSH, loads the image into the server and serves it with deploy --prebuilt; the server never gets the source', async () => {
    const res = await deploy();
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const evs = await events(res);
    const log = logText(evs);

    // The build steps, then the usual release flow
    expect(evs.filter((e) => e.type === 'build').map((e) => e.state)).toEqual(['building', 'loading', 'deploying']);
    expect(evs.find((e) => e.type === 'build' && e.state === 'building')).toMatchObject({ platform: 'linux/amd64' });
    expect(evs.find((e) => e.type === 'result')).toMatchObject({ outcome: { result: 'success' } });
    expect(evs.at(-1)).toEqual({ type: 'end' });
    expect(fake.uploads).toBe(0);

    // For the server's platform, with the builder's own noted (emulation)
    const [build] = fakeBuildctlCalls(env.log);
    expect(build!.argv).toContain('platform=linux/amd64');
    expect(log).toContain('Building on BastionSSH for linux/amd64 (BuildKit v0.33.1 on linux/arm64)');
    expect(log).toMatch(/linux\/amd64 is built under QEMU emulation/);

    // Environment files left out and named; .env.example kept; the generated Dockerfile declares the build args
    expect(build!.files).toEqual(['.bastion.Dockerfile', '.env.example', 'app/page.js', 'next.config.js', 'package-lock.json', 'package.json']);
    expect(log).toContain('Left out 2 environment files of the upload: .env, .env.local');
    expect(build!.dockerfile).toContain('ARG NEXT_PUBLIC_API_URL\nARG SENTRY_RELEASE\nRUN npm run build');

    // Only NEXT_PUBLIC_* and build.args reach the build; values never in the log
    expect(build!.argv.filter((a) => a.startsWith('build-arg:'))).toEqual([
      'build-arg:NEXT_PUBLIC_API_URL=https://api.example.com',
      'build-arg:SENTRY_RELEASE=release-2026-10-09',
    ]);
    expect(log).toContain('Build args from .env: NEXT_PUBLIC_API_URL, SENTRY_RELEASE');
    expect(log).toContain('NEXT_PUBLIC_API_URL is ••••');
    expect(log).not.toContain('https://api.example.com');
    expect(log).not.toContain('release-2026-10-09');

    // The image: labelled for the app and release, loaded gzipped, then served by bastionctl
    const tag = build!.argv.find((a) => a.startsWith('type=docker,name='))!.slice('type=docker,name='.length);
    expect(tag).toMatch(/^bastion-site1:\d{8}-\d{6}-[0-9a-f]{8}$/);
    const release = tag.split(':')[1]!;
    expect(build!.argv).toEqual(expect.arrayContaining(['label:bastion.app=site1', `label:bastion.release=${release}`, 'label:bastion.managed=app']));
    expect(fake.loads).toHaveLength(1);
    expect(fake.loads[0]!.subarray(257, 262).toString()).toBe('ustar');
    const deployRun = fake.runs.find((r) => r[0] === 'deploy')!;
    expect(deployRun.slice(0, 4)).toEqual(['deploy', 'site1', '--prebuilt', tag]);
    expect(deployRun[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(deployRun[5]!.slice(0, 8)).toBe(release.slice(-8));
    expect(deployRun.slice(6, 7)).toEqual(['--build-ms']);
    expect(fake.removed).toEqual([]);

    // Nothing kept here: the upload and its context are gone
    expect(workLeft()).toEqual([]);
    expect(activeBuildCount()).toBe(0);
    expect(audits('deploy.start')[0]).toMatchObject({ app: 'site1', builtOn: 'bastion' });
    const finish = audits('deploy.finish')[0]!;
    expect(finish).toMatchObject({ app: 'site1', builtOn: 'bastion', result: 'success', platform: 'linux/amd64', release });
    for (const k of ['queueMs', 'buildMs', 'loadMs', 'imageBytes']) expect(typeof finish[k], k).toBe('number');
    expect(JSON.stringify(audits('deploy.finish'))).not.toContain('api.example.com');
  });

  it('keeps environment files when the deploy asks to, and builds on the server when the dialog says so', async () => {
    const evs = await events(await deploy(operator, '?includeEnvFiles=1'));
    expect(evs.find((e) => e.type === 'result')).toMatchObject({ outcome: { result: 'success' } });
    expect(fakeBuildctlCalls(env.log)[0]!.files).toEqual(expect.arrayContaining(['.env', '.env.local']));
    expect(logText(evs)).toContain('Environment files in the upload were kept, as asked');
    expect(audits('deploy.start')[0]).toMatchObject({ builtOn: 'bastion', includeEnvFiles: true });

    fake.runs.length = 0;
    fs.rmSync(env.log, { force: true });
    const server = await events(await deploy(operator, '?where=server'));
    expect(server.find((e) => e.type === 'result')).toMatchObject({ outcome: { result: 'success' } });
    expect(fake.uploads).toBe(1);
    expect(fakeBuildctlCalls(env.log)).toEqual([]);
    expect(fake.runs.find((r) => r[0] === 'deploy')!.slice(0, 3)).toEqual(['deploy', 'site1', '--source']);
  });

  it('refuses a build on BastionSSH before the upload when it has no builder', async () => {
    (config.builder as { addr: string | null }).addr = null;
    const res = await deploy();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'builder_unavailable' });
    expect(fake.loads).toEqual([]);
    expect(workLeft()).toEqual([]);
  });

  it('reports a failed build (exit 137) without loading anything or running bastionctl deploy', async () => {
    process.env.FAKE_BUILD_EXIT = '1';
    const evs = await events(await deploy());
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ error: expect.stringMatching(/The build failed: ERROR: .*exit code: 137/) });
    expect(evs.map((e) => e.type).slice(-3)).toEqual(['error', 'exit', 'end']);
    expect(fake.loads).toEqual([]);
    expect(fake.runs.some((r) => r[0] === 'deploy')).toBe(false);
    expect(workLeft()).toEqual([]);
    expect(audits('deploy.finish')[0]).toMatchObject({ builtOn: 'bastion', result: 'failed' });
  });

  it('cancels mid-build: BuildKit is told to stop, nothing is loaded, the context folder is gone, and it is audited', async () => {
    process.env.FAKE_BUILD_DELAY_MS = '20000';
    const signalFile = path.join(env.dir, 'signal');
    process.env.FAKE_BUILD_SIGNAL_FILE = signalFile;
    const pending = deploy().then(events);
    for (let i = 0; i < 300 && fakeBuildctlCalls(env.log).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(workLeft()).toHaveLength(1);
    // Viewers cannot cancel, nor can anyone cancel a build that is not running
    const cancel = await app.inject({ method: 'POST', url: api('/apps/site1/build/cancel'), headers: operator.headers });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const evs = await pending;
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ error: expect.stringMatching(/cancelled by/), status: 499 });
    expect(fs.readFileSync(signalFile, 'utf8')).toBe('SIGTERM');
    expect(fake.loads).toEqual([]);
    expect(fake.runs.some((r) => r[0] === 'deploy')).toBe(false);
    expect(workLeft()).toEqual([]);
    expect(audits('deploy.build_cancel')[0]).toMatchObject({ app: 'site1' });
    expect(audits('deploy.finish')[0]).toMatchObject({ result: 'cancelled' });
    const again = await app.inject({ method: 'POST', url: api('/apps/site1/build/cancel'), headers: operator.headers });
    expect(again.statusCode).toBe(409);
  });

  it('refuses a server platform the builder cannot build for, saying how to add emulation, before building anything', async () => {
    fake.arch = 's390x';
    const evs = await events(await deploy());
    const error = evs.find((e) => e.type === 'error') as { error: string; status: number };
    expect(error.error).toContain('The builder cannot build for linux/s390x');
    expect(error.error).toContain('docker run --privileged --rm tonistiigi/binfmt --install all');
    expect(error.status).toBe(409);
    expect(fakeBuildctlCalls(env.log).filter((c) => c.command === 'build')).toEqual([]);
    expect(fake.loads).toEqual([]);
    expect(fake.runs.some((r) => r[0] === 'deploy' || (r[0] === 'env' && r[1] === 'build-args'))).toBe(false);
    expect(workLeft()).toEqual([]);
  });

  it('builds natively without a note on emulation when the server is the builder’s platform', async () => {
    fake.arch = 'aarch64';
    const evs = await events(await deploy());
    expect(evs.find((e) => e.type === 'result')).toMatchObject({ outcome: { result: 'success' } });
    expect(fakeBuildctlCalls(env.log).find((c) => c.command === 'build')!.argv).toContain('platform=linux/arm64');
    expect(logText(evs)).not.toContain('emulation');
  });

  it('stops a build past the timeout (504): BuildKit is told to stop, nothing is loaded, nothing kept', async () => {
    (config.builder as { timeoutMs: number }).timeoutMs = 1500;
    process.env.FAKE_BUILD_DELAY_MS = '20000';
    const signalFile = path.join(env.dir, 'signal-timeout');
    process.env.FAKE_BUILD_SIGNAL_FILE = signalFile;
    const evs = await events(await deploy());
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ error: expect.stringMatching(/did not finish within/), status: 504 });
    expect(evs.find((e) => e.type === 'exit')).toMatchObject({ timedOut: true });
    expect(fs.readFileSync(signalFile, 'utf8')).toBe('SIGTERM');
    expect(fake.loads).toEqual([]);
    expect(fake.runs.some((r) => r[0] === 'deploy')).toBe(false);
    expect(workLeft()).toEqual([]);
    expect(activeBuildCount()).toBe(0);
  });

  it('fails a deploy when the builder is away (503), with nothing loaded or kept', async () => {
    process.env.FAKE_BUILDKIT_DOWN = '1';
    const evs = await events(await deploy());
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ error: expect.stringMatching(/The builder did not answer: .*connection refused/), status: 503 });
    expect(fake.loads).toEqual([]);
    expect(workLeft()).toEqual([]);
    expect(audits('deploy.finish')[0]).toMatchObject({ builtOn: 'bastion', result: 'failed' });
  });

  it('runs one build at a time: a second deploy waits its turn and is told so', async () => {
    process.env.FAKE_BUILD_DELAY_MS = '600';
    fake.bastionctl = (args) => (args[0] === 'status' ? { stdout: { ...status(), name: args[1] } } : defaultBastionctl(args));
    const first = deploy().then(events);
    for (let i = 0; i < 300 && fakeBuildctlCalls(env.log).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const form = new FormData();
    form.append('source', new Blob([zlib.gzipSync(tarOf(NEXT_APP))]), 'site.tar.gz');
    const second = fetch(`${base}${api('/apps/site2/deploy')}`, { method: 'POST', headers: operator.headers, body: form }).then(events);
    const [a, b] = await Promise.all([first, second]);
    expect(a.find((e) => e.type === 'result')).toMatchObject({ outcome: { result: 'success' } });
    expect(b.filter((e) => e.type === 'build').map((e) => e.state)).toEqual(['queued', 'building', 'loading', 'deploying']);
    expect(b.find((e) => e.state === 'queued')).toMatchObject({ position: 1 });
    expect(logText(b)).toContain('Waiting for the build before this one to finish');
    expect(fake.loads).toHaveLength(2);
  });

  it('removes the loaded image when bastionctl refuses or fails the release', async () => {
    fake.bastionctl = (args) =>
      args[0] === 'deploy' ? { stdout: { error: 'Another deploy of site1 is running', code: 4 }, exitCode: 4 } : defaultBastionctl(args);
    const evs = await events(await deploy());
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ error: 'Another deploy of site1 is running' });
    expect(fake.removed).toHaveLength(1);
    expect(fake.removed[0]).toMatch(/^bastion-site1:/);
    expect(fake.images.size).toBe(0);
  });

  it('shows the builder, the server platform, and clears the build cache for managers only', async () => {
    const statusRes = await app.inject({ method: 'GET', url: '/api/deploy/builder', headers: operator.headers });
    expect(statusRes.json()).toMatchObject({
      configured: true,
      reachable: true,
      platform: 'linux/arm64',
      version: 'v0.33.1',
      cacheBytes: 3345,
      cacheLimitBytes: 10e9,
      running: null,
      queued: 0,
    });
    process.env.FAKE_BUILDKIT_DOWN = '1';
    expect((await app.inject({ method: 'GET', url: '/api/deploy/builder', headers: operator.headers })).json()).toMatchObject({
      configured: true,
      reachable: false,
      error: expect.stringMatching(/connection refused/),
    });
    delete process.env.FAKE_BUILDKIT_DOWN;
    (config.builder as { addr: string | null }).addr = null;
    expect((await app.inject({ method: 'GET', url: '/api/deploy/builder', headers: operator.headers })).json()).toMatchObject({ configured: false, reachable: false });
    (config.builder as { addr: string | null }).addr = 'tcp://buildkit:1234';

    expect((await app.inject({ method: 'GET', url: api('/platform'), headers: operator.headers })).json()).toEqual({ platform: 'linux/amd64' });

    const refused = await app.inject({ method: 'POST', url: '/api/deploy/builder/prune', headers: operator.headers });
    expect(refused.statusCode).toBe(403);
    const pruned = await app.inject({ method: 'POST', url: '/api/deploy/builder/prune', headers: admin.headers });
    expect(pruned.json()).toEqual({ reclaimedBytes: 3345, records: 2 });
    expect(fakeBuildctlCalls(env.log).find((c) => c.command === 'prune')!.argv).toEqual(['prune', ...BUILD_CACHE_FILTERS.flatMap((f) => ['--filter', f]), '--format', '{{json .}}']);
    expect(audits('deploy.build_cache_clear')[0]).toEqual({ reclaimedBytes: 3345, records: 2 });
  });
});
