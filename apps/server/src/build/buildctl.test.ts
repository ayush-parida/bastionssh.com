import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BUILD_CACHE_FILTERS, buildArgv, builderCacheBytes, builderWorker, buildImage, parseDiskUsage, parseWorkers, pruneBuildCache } from './buildctl.js';
import { fakeBuildctlCalls, writeFakeBuildctl } from './fake-buildctl.test-helper.js';

/** BastionSSH's buildctl calls, against a fake buildctl: status, prune's filters, a build's argv, cancel. */

let dir: string;
let opts: { bin: string; addr: string };
let logFile: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-buildctl-'));
  opts = { bin: writeFakeBuildctl(dir), addr: 'tcp://buildkit:1234' };
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  logFile = path.join(dir, `log-${Math.random().toString(36).slice(2)}`);
  process.env.FAKE_BUILDCTL_LOG = logFile;
  for (const k of ['FAKE_BUILD_DELAY_MS', 'FAKE_BUILD_EXIT', 'FAKE_BUILD_SIGNAL_FILE', 'FAKE_BUILDKIT_DOWN', 'FAKE_BUILDKIT_PLATFORM']) delete process.env[k];
});

describe('reading the builder', () => {
  it('parses workers: its own platform first, every platform, the version and the cache limit', () => {
    expect(
      parseWorkers(
        JSON.stringify([
          {
            platforms: [{ os: 'linux', architecture: 'arm64' }, { os: 'linux', architecture: 'amd64' }, { os: 'linux', architecture: 'arm', variant: 'v7' }],
            buildkitVersion: { version: 'v0.33.1' },
            gcPolicy: [{ maxUsedSpace: 512e6 }, { reservedSpace: 10e9 }],
          },
        ]),
      ),
    ).toEqual({ platform: 'linux/arm64', platforms: ['linux/arm64', 'linux/amd64', 'linux/arm/v7'], version: 'v0.33.1', cacheLimitBytes: 10e9 });
    expect(() => parseWorkers('[]')).toThrow(/no worker/);
    expect(() => parseWorkers('nope')).toThrow(/not JSON/);
    expect(parseDiskUsage(JSON.stringify([{ size: 10 }, { size: 32 }, {}]))).toBe(42);
    expect(parseDiskUsage('')).toBe(0);
  });

  it('asks the fake builder, and reports it unreachable as a 503', async () => {
    expect(await builderWorker(opts)).toMatchObject({ platform: 'linux/arm64', version: 'v0.33.1' });
    expect(await builderCacheBytes(opts)).toBe(3345);
    process.env.FAKE_BUILDKIT_DOWN = '1';
    await expect(builderWorker(opts)).rejects.toMatchObject({ statusCode: 503, code: 'builder_unavailable', message: expect.stringMatching(/connection refused/) });
  });

  it('clears only our builds’ cache records (no --all) and reports what was freed', async () => {
    expect(await pruneBuildCache(opts)).toEqual({ reclaimedBytes: 3345, records: 2 });
    const [call] = fakeBuildctlCalls(logFile);
    expect(call!.argv).toEqual(['prune', ...BUILD_CACHE_FILTERS.flatMap((f) => ['--filter', f]), '--format', '{{json .}}']);
    expect(call!.argv).not.toContain('--all');
  });
});

describe('a build', () => {
  const request = {
    context: '/tmp/ctx',
    dockerfile: '.bastion.Dockerfile',
    platform: 'linux/amd64',
    buildArgs: { NEXT_PUBLIC_API_URL: 'https://api.example.com' },
    labels: { 'bastion.app': 'web', 'bastion.release': '20261009-120000-abcdef12' },
    name: 'bastion-web:20261009-120000-abcdef12',
  };

  it('passes the context, Dockerfile, platform, build args and labels as one argv (no shell)', () => {
    expect(buildArgv({ ...opts, tlsDir: '/certs' }, request)).toEqual([
      '--addr',
      'tcp://buildkit:1234',
      '--tlsdir',
      '/certs',
      'build',
      '--progress',
      'plain',
      '--frontend',
      'dockerfile.v0',
      '--local',
      'context=/tmp/ctx',
      '--local',
      'dockerfile=/tmp/ctx',
      '--opt',
      'filename=.bastion.Dockerfile',
      '--opt',
      'platform=linux/amd64',
      '--opt',
      'build-arg:NEXT_PUBLIC_API_URL=https://api.example.com',
      '--opt',
      'label:bastion.app=web',
      '--opt',
      'label:bastion.release=20261009-120000-abcdef12',
      '--output',
      'type=docker,name=bastion-web:20261009-120000-abcdef12',
    ]);
  });

  it('streams the progress and the image, and reports a failed build with its error line', async () => {
    const ctx = fs.mkdtempSync(path.join(dir, 'ctx-'));
    fs.writeFileSync(path.join(ctx, '.bastion.Dockerfile'), 'FROM scratch\n');
    const lines: string[] = [];
    const build = buildImage(opts, { ...request, context: ctx, onLine: (l) => lines.push(l) });
    const chunks: Buffer[] = [];
    for await (const c of build.stdout as AsyncIterable<Buffer>) chunks.push(c);
    await build.done;
    expect(Buffer.concat(chunks).subarray(257, 262).toString()).toBe('ustar');
    expect(lines).toContain('#6 exporting to docker image format');

    process.env.FAKE_BUILD_EXIT = '1';
    const failed = buildImage(opts, { ...request, context: ctx, onLine: () => {} });
    failed.stdout.resume();
    await expect(failed.done).rejects.toMatchObject({ statusCode: 422, code: 'build_failed', message: expect.stringMatching(/^The build failed: ERROR: process .* exit code: 137/) });
  });

  it('cancels: buildctl gets SIGTERM (it cancels the solve) and the build ends without an image', async () => {
    const ctx = fs.mkdtempSync(path.join(dir, 'ctx-'));
    fs.writeFileSync(path.join(ctx, '.bastion.Dockerfile'), 'FROM scratch\n');
    process.env.FAKE_BUILD_DELAY_MS = '10000';
    const signalFile = path.join(dir, `sig-${Date.now()}`);
    process.env.FAKE_BUILD_SIGNAL_FILE = signalFile;
    const lines: string[] = [];
    const build = buildImage(opts, { ...request, context: ctx, onLine: (l) => lines.push(l) });
    const chunks: Buffer[] = [];
    build.stdout.on('data', (c: Buffer) => chunks.push(c));
    // Started: the fake echoes its build args first
    for (let i = 0; i < 200 && !lines.some((l) => l.includes('NEXT_PUBLIC_API_URL')); i++) await new Promise((r) => setTimeout(r, 10));
    build.stop();
    await expect(build.done).rejects.toMatchObject({ code: 'build_failed' });
    expect(fs.readFileSync(signalFile, 'utf8')).toBe('SIGTERM');
    expect(chunks).toEqual([]);
  });
});
