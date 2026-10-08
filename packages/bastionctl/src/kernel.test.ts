import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEPLOY_TROUBLESHOOTING_ANCHORS,
  defaultServiceVersionFor,
  kernelAtLeast,
  kernelMajorMinor,
  serviceConfigYaml,
  serviceKernelConflict,
  serviceKernelRuleOfImage,
  serviceTemplate,
  serviceVersion,
  SERVICE_CATALOG,
  type ServiceVersion,
} from '@smt/shared';
import { run } from './cli.js';
import type { Ctx } from './context.js';
import { DockerApi } from './docker.js';
import { startFakeDocker, type FakeDocker } from './fake-docker.test-helper.js';
import { Layout } from './names.js';
import * as ops from './ops.js';
import { currentRelease, readRelease } from './releases.js';
import { setImage } from './service-config.js';

/**
 * Lines that will not start on the host's kernel (kernel.ts, the catalog's
 * `kernelIncompatibility`): MongoDB 8 refuses kernels it reads as 6.19 or
 * newer — Ubuntu's patched `7.0.0-1012-aws` included — so a deploy, Update
 * version (set-image) or rollback to an 8.x line is refused there before
 * anything is pulled or changed. 7.0 is unaffected, other apps are never
 * checked, and a kernel that cannot be read only warns.
 */

const MONGO = serviceTemplate('mongodb')!;
const M8 = serviceVersion(MONGO, '8.0')!;
const M7 = serviceVersion(MONGO, '7.0')!;
/** An older MongoDB 8.0 release than the catalog pins (same line). */
const M8_OLD = `mongo:8.0.30@sha256:${'c'.repeat(64)}`;
const UBUNTU_AWS = '7.0.0-1012-aws';
const DOCS = `/docs/deployments/troubleshooting#${DEPLOY_TROUBLESHOOTING_ANCHORS.mongodbKernel}`;

describe('the kernel rule (shared catalog)', () => {
  it('reads major.minor of a kernel release', () => {
    expect(kernelMajorMinor('7.0.0-1012-aws')).toEqual([7, 0]);
    expect(kernelMajorMinor('6.8.0-45-generic')).toEqual([6, 8]);
    expect(kernelMajorMinor('6.19')).toEqual([6, 19]);
    expect(kernelMajorMinor('5.15.0-1066-azure')).toEqual([5, 15]);
    for (const odd of ['', 'unknown', 'v6.19', '6', '-1.2', null, undefined]) expect(kernelMajorMinor(odd), String(odd)).toBeNull();
  });

  it('refuses 6.19 and newer, numerically', () => {
    expect(kernelAtLeast('6.18.7', '6.19')).toBe(false);
    expect(kernelAtLeast('6.19.0', '6.19')).toBe(true);
    expect(kernelAtLeast('6.19', '6.19')).toBe(true);
    expect(kernelAtLeast(UBUNTU_AWS, '6.19')).toBe(true);
    expect(kernelAtLeast('5.15.0-1066-azure', '6.19')).toBe(false);
    expect(kernelAtLeast('6.2.0', '6.19')).toBe(false);
    expect(kernelAtLeast('10.1', '6.19')).toBe(true);
    // Cannot be told: the caller does not refuse
    expect(kernelAtLeast('weird', '6.19')).toBeNull();
    expect(kernelAtLeast(null, '6.19')).toBeNull();
  });

  it('is on MongoDB 8.0 only, pointing at 7.0 and the troubleshooting docs', () => {
    expect(M8.kernelIncompatibility).toMatchObject({ from: '6.19', instead: '7.0', docs: DOCS });
    expect(M7.kernelIncompatibility).toBeUndefined();
    expect(serviceKernelConflict(M8, UBUNTU_AWS)).toBe(M8.kernelIncompatibility);
    expect(serviceKernelConflict(M8, '6.18.2')).toBeNull();
    expect(serviceKernelConflict(M8, 'odd')).toBeNull();
    expect(serviceKernelConflict(M7, UBUNTU_AWS)).toBeNull();
    // `instead` is a line of its template that has no rule itself
    for (const t of SERVICE_CATALOG) {
      for (const v of t.versions) {
        const rule = v.kernelIncompatibility;
        if (!rule) continue;
        expect(kernelMajorMinor(rule.from), `${t.id} ${v.major}`).not.toBeNull();
        expect(serviceVersion(t, rule.instead)?.kernelIncompatibility, `${t.id} ${v.major}`).toBeUndefined();
      }
    }
  });

  it('starts a new service on the line the rule names when the default will not start', () => {
    expect(defaultServiceVersionFor(MONGO, UBUNTU_AWS)).toBe(M7);
    expect(defaultServiceVersionFor(MONGO, '6.8.0-45-generic')).toBe(M8);
    expect(defaultServiceVersionFor(MONGO, null)).toBe(M8);
    expect(defaultServiceVersionFor(MONGO, 'odd')).toBe(M8);
    expect(defaultServiceVersionFor(serviceTemplate('postgres')!, UBUNTU_AWS).major).toBe('17');
  });

  it('finds the rule of an image: its line, or the nearest older offered line for one not offered', () => {
    expect(serviceKernelRuleOfImage(MONGO, M8.image)).toEqual({ label: 'MongoDB 8.0', rule: M8.kernelIncompatibility });
    expect(serviceKernelRuleOfImage(MONGO, M8_OLD)?.label).toBe('MongoDB 8.0');
    expect(serviceKernelRuleOfImage(MONGO, 'mongo:8.2.1-noble')).toEqual({ label: 'MongoDB 8.2.1', rule: M8.kernelIncompatibility });
    expect(serviceKernelRuleOfImage(MONGO, M7.image)).toBeNull();
    expect(serviceKernelRuleOfImage(MONGO, 'mongo:7.3.4')).toBeNull();
    expect(serviceKernelRuleOfImage(MONGO, 'mongo:6.0.20')).toBeNull();
    expect(serviceKernelRuleOfImage(MONGO, 'mongo:latest')).toBeNull();
    expect(serviceKernelRuleOfImage(MONGO, 'mongo')).toBeNull();
    expect(serviceKernelRuleOfImage(MONGO, 'example.com/mongo:8.0.1')).toBeNull();
  });
});

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

/** A MongoDB service on line `v`, created as BastionSSH creates one (not deployed). */
async function mongo(name: string, v: ServiceVersion) {
  const yml = serviceConfigYaml(MONGO, { name, version: v, memory: MONGO.memory, publish: { scope: 'none', port: null }, domain: null, tls: 'auto', proxy: 'caddy' });
  fs.writeFileSync(path.join(layout.tmp, `${name}.yml`), yml);
  await ops.init(ctx(), name, { config: `tmp/${name}.yml` });
}

async function cli(args: string[]) {
  const out: string[] = [];
  const code = await run([...args, '--json'], { env: { BASTION_ROOT: root }, stdout: (t) => out.push(t), stderr: () => {}, readStdin: async () => '', ctx: ctx() });
  return { code, json: JSON.parse(out.join('').trim().split('\n').at(-1)!) as Record<string, unknown> };
}

const releasesOf = (app: string) => (fs.existsSync(layout.releases(app)) ? fs.readdirSync(layout.releases(app)) : []);

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-kernel-')));
  layout = new Layout(root);
  logs = [];
  clock = Date.parse('2026-10-08T12:00:00Z');
  fake.containers.clear();
  fake.images.clear();
  fake.networks.clear();
  fake.exec = () => ({ exitCode: 0 });
  fake.crashOnStart = () => false;
  fake.pullError = null;
  fake.afterChange = null;
  fake.kernelVersion = '6.8.0-45-generic';
  await ops.setup(ctx());
  fake.pulls.length = 0;
  fake.requests.length = 0;
});

describe('deploy', () => {
  it('refuses MongoDB 8 on a 6.19+ kernel before pulling, saying why, what to do and where to read more', async () => {
    fake.kernelVersion = UBUNTU_AWS;
    await mongo('events-db', M8);
    const { code, json } = await cli(['deploy', 'events-db']);
    expect(code).toBe(1);
    expect(json).toMatchObject({ refused: 'kernel', kernel: UBUNTU_AWS, docs: DOCS });
    const error = json.error as string;
    expect(error).toContain(`MongoDB 8.0 will not start on this server's Linux kernel ${UBUNTU_AWS}`);
    expect(error).toContain('refuses Linux kernels it reads as 6.19 or newer (SERVER-121912), including Ubuntu kernels that report x.y.0');
    expect(error).toContain('Use MongoDB 7.0: delete this service and create it again with version 7.0, or update the image once MongoDB fixes its check.');
    expect(error).toContain(`Nothing was pulled or changed. See ${DOCS}`);
    expect(fake.pulls).toEqual([]);
    expect(releasesOf('events-db')).toEqual([]);
    expect(currentRelease(layout, 'events-db')).toBeNull();
  });

  it('refuses at 6.19 exactly, deploys on 6.18 and older', async () => {
    await mongo('events-db', M8);
    fake.kernelVersion = '6.19.0-1-generic';
    await expect(ops.deploy(ctx(), 'events-db')).rejects.toThrow("will not start on this server's Linux kernel 6.19.0-1-generic");
    expect(fake.pulls).toEqual([]);
    fake.kernelVersion = '6.18.9';
    expect((await ops.deploy(ctx(), 'events-db')).result).toBe('success');
    fake.kernelVersion = '5.15.0-1066-azure';
    expect((await ops.deploy(ctx(), 'events-db')).result).toBe('success');
    expect(fake.pulls).toHaveLength(1);
  });

  it('deploys MongoDB 7.0 on the same kernel', async () => {
    fake.kernelVersion = UBUNTU_AWS;
    await mongo('events-db', M7);
    expect((await ops.deploy(ctx(), 'events-db')).result).toBe('success');
    expect(fake.pulls).toEqual([M7.image.replace(/:[^@]*@/, '@')]);
  });

  it('does not refuse on a kernel it cannot read, and says it did not check', async () => {
    await mongo('events-db', M8);
    fake.kernelVersion = 'custom-kernel';
    expect((await ops.deploy(ctx(), 'events-db')).result).toBe('success');
    expect(logs).toContain('warning: the host\'s kernel version "custom-kernel" cannot be read, so whether MongoDB 8.0 starts on it (kernels 6.19 and newer are refused) was not checked');
    logs.length = 0;
    fake.kernelVersion = 'fail';
    expect((await ops.deploy(ctx(), 'events-db')).result).toBe('success');
    expect(logs.some((l) => l.startsWith("warning: could not read the host's kernel from Docker: info is broken"))).toBe(true);
    fake.kernelVersion = null;
    expect((await ops.deploy(ctx(), 'events-db')).result).toBe('success');
  });

  it('never asks the kernel for an app that is not such a service', async () => {
    fake.kernelVersion = UBUNTU_AWS;
    fs.writeFileSync(path.join(layout.tmp, 'own.yml'), `name: own\ndomains: []\nbuild: { type: image, image: "${M8.image}" }\nrun: { port: 27017 }\nhealthcheck: { type: tcp }\n`);
    await ops.init(ctx(), 'own', { config: 'tmp/own.yml' });
    expect((await ops.deploy(ctx(), 'own')).result).toBe('success');
    await mongo('old-db', M7);
    expect((await ops.deploy(ctx(), 'old-db')).result).toBe('success');
    expect(fake.requests).not.toContain('GET /info');
  });
});

describe('set-image (Update version)', () => {
  it('refuses an 8.x image on a 6.19+ kernel, leaving bastion.yml as it was', async () => {
    await mongo('events-db', M8);
    const before = fs.readFileSync(layout.config('events-db'), 'utf8');
    fake.kernelVersion = UBUNTU_AWS;
    await expect(setImage(ctx(), 'events-db', M8_OLD)).rejects.toThrow("events-db keeps its image; nothing was changed. See /docs/deployments/troubleshooting#");
    await expect(setImage(ctx(), 'events-db', 'mongo:8.2.1')).rejects.toThrow("MongoDB 8.2.1 will not start on this server's Linux kernel");
    expect(fs.readFileSync(layout.config('events-db'), 'utf8')).toBe(before);
    const { code, json } = await cli(['set-image', 'events-db', M8_OLD]);
    expect(code).toBe(1);
    expect(json).toMatchObject({ refused: 'kernel', kernel: UBUNTU_AWS });
    // 7.0 is not refused (the line rule is BastionSSH's to keep)
    expect((await setImage(ctx(), 'events-db', M7.image)).changed).toBe(true);
    fake.kernelVersion = '6.12.1';
    expect((await setImage(ctx(), 'events-db', M8_OLD)).changed).toBe(true);
  });
});

describe('rollback', () => {
  it('refuses a release on an 8.x line once the kernel is 6.19+, the current one serving on', async () => {
    await mongo('events-db', M8);
    await setImage(ctx(), 'events-db', M8_OLD);
    const old = (await ops.deploy(ctx(), 'events-db')).release;
    await setImage(ctx(), 'events-db', M8.image);
    const pinned = (await ops.deploy(ctx(), 'events-db')).release;
    fake.kernelVersion = UBUNTU_AWS;
    const started = fake.events.length;
    await expect(ops.rollback(ctx(), 'events-db', old)).rejects.toThrow(`Release ${old} was not rolled back to. See ${DOCS}`);
    const { code, json } = await cli(['rollback', 'events-db', old]);
    expect(code).toBe(1);
    expect(json).toMatchObject({ refused: 'kernel' });
    expect(currentRelease(layout, 'events-db')).toBe(pinned);
    expect(fake.events.slice(started)).toEqual([]);
    fake.kernelVersion = '6.18.0';
    expect((await ops.rollback(ctx(), 'events-db', old)).result).toBe('success');
    expect(readRelease(layout, 'events-db', old)?.line).toBe('8.0');
  });
});

describe('proxy status', () => {
  it('reports the host kernel for BastionSSH to show', async () => {
    fake.kernelVersion = UBUNTU_AWS;
    const { json } = await cli(['proxy', 'status']);
    expect(json).toMatchObject({ state: 'ok', kernelVersion: UBUNTU_AWS });
    fake.kernelVersion = 'fail';
    expect((await cli(['proxy', 'status'])).json).toMatchObject({ state: 'ok', kernelVersion: null });
  });
});
