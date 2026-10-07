import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serviceConfigYaml, serviceTemplate, serviceVersion, type ServiceTemplate, type ServiceVersion } from '@smt/shared';
import { run } from './cli.js';
import type { Ctx } from './context.js';
import { DockerApi } from './docker.js';
import { startFakeDocker, type FakeDocker } from './fake-docker.test-helper.js';
import { Layout } from './names.js';
import * as ops from './ops.js';
import { currentRelease, readRelease } from './releases.js';
import { setImage } from './service-config.js';

/**
 * Rollback keeps Update version's rules (lines.ts): a quick service's
 * release on another major line of a database is refused in both
 * directions, an older line of a forward-only template (Grafana 13 → 12)
 * too, a newer one and the same line are allowed; a release from before
 * lines were recorded has its line read from its build log (proved by its
 * checksum), one whose line cannot be told is refused, and `--force-line`
 * overrides the refusal. Apps without `service:` are unaffected.
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

const PG = serviceTemplate('postgres')!;
const GRAFANA = serviceTemplate('grafana')!;
/** An older PostgreSQL 17 release than the catalog pins (same line). */
const PG17_OLD = `postgres:17.4-alpine@sha256:${'b'.repeat(64)}`;

/** A service of `t` on line `v`, created as BastionSSH creates one (its bastion.yml), then deployed. */
async function service(name: string, t: ServiceTemplate, v: ServiceVersion) {
  const yml = serviceConfigYaml(t, { name, version: v, memory: t.memory, publish: { scope: 'none', port: null }, domain: null, tls: 'auto', proxy: 'caddy' });
  fs.writeFileSync(path.join(layout.tmp, `${name}.yml`), yml);
  await ops.init(ctx(), name, { config: `tmp/${name}.yml` });
  return deployed(name);
}

async function deployed(name: string) {
  const outcome = await ops.deploy(ctx(), name);
  expect(outcome.result, outcome.error ?? '').toBe('success');
  return outcome.release;
}

/** Update version: the image in bastion.yml, then a deploy. */
async function update(name: string, ref: string) {
  await setImage(ctx(), name, ref);
  return deployed(name);
}

/** As an older bastionctl wrote it: no ref, service or line. */
function legacy(app: string, id: string) {
  const file = path.join(layout.release(app, id), 'release.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete raw.ref;
  delete raw.service;
  delete raw.line;
  fs.writeFileSync(file, JSON.stringify(raw));
}

async function cli(args: string[]) {
  const out: string[] = [];
  const code = await run([...args, '--json'], { env: { BASTION_ROOT: root }, stdout: (t) => out.push(t), stderr: () => {}, readStdin: async () => '', ctx: ctx() });
  return { code, json: JSON.parse(out.join('').trim().split('\n').at(-1)!) as Record<string, unknown> };
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-lines-')));
  layout = new Layout(root);
  logs = [];
  clock = Date.parse('2026-10-08T12:00:00Z');
  fake.containers.clear();
  fake.images.clear();
  fake.networks.clear();
  fake.execs.length = 0;
  fake.pulls.length = 0;
  fake.events.length = 0;
  fake.exec = () => ({ exitCode: 0 });
  fake.crashOnStart = () => false;
  fake.pullError = null;
  fake.afterChange = null;
  await ops.setup(ctx());
});

describe('a quick service records its line', () => {
  it('writes the image, template and line into release.json at deploy', async () => {
    const v = serviceVersion(PG, '16')!;
    const id = await service('orders-db', PG, v);
    expect(readRelease(layout, 'orders-db', id)).toMatchObject({ ref: v.image, service: 'postgres', line: '16' });
  });

  it('records no line for an app without service:, and rolls it back across anything', async () => {
    fs.writeFileSync(path.join(layout.tmp, 'web.yml'), 'name: web\ndomains: []\nbuild: { type: image, image: "postgres:16.4" }\nrun: { port: 5432 }\nhealthcheck: { type: tcp }\n');
    await ops.init(ctx(), 'web', { config: 'tmp/web.yml' });
    const first = await deployed('web');
    await update('web', 'postgres:17.2');
    expect(readRelease(layout, 'web', first)).toMatchObject({ ref: 'postgres:16.4' });
    expect(readRelease(layout, 'web', first)).not.toHaveProperty('line');
    expect((await ops.releases(ctx(), 'web')).find((r) => r.id === first)).not.toHaveProperty('rollbackRefused');
    expect((await ops.rollback(ctx(), 'web', first)).result).toBe('success');
  });
});

describe('rollback across lines', () => {
  it('refuses another major line of a database in both directions, unless --force-line', async () => {
    const pg16 = await service('orders-db', PG, serviceVersion(PG, '16')!);
    const pg17 = await update('orders-db', serviceVersion(PG, '17')!.image);
    // Older major
    await expect(ops.rollback(ctx(), 'orders-db', pg16)).rejects.toThrow(
      `Release ${pg16} runs another line: PostgreSQL cannot be moved from PostgreSQL 17 to PostgreSQL 16 in place.`,
    );
    expect(currentRelease(layout, 'orders-db')).toBe(pg17);
    const listed = await ops.releases(ctx(), 'orders-db');
    expect(listed.find((r) => r.id === pg16)).toMatchObject({ line: '16', rollbackRefused: expect.stringContaining('cannot be moved from PostgreSQL 17 to PostgreSQL 16') });
    expect(listed.find((r) => r.id === pg17)).not.toHaveProperty('rollbackRefused');

    // Forced: served, with a warning naming who
    const forced = await ops.rollback(ctx(), 'orders-db', pg16, { forceLine: true });
    expect(forced.result).toBe('success');
    expect(currentRelease(layout, 'orders-db')).toBe(pg16);
    expect(logs.some((l) => l.startsWith('warning: Release') && l.endsWith('Rolling back anyway (--force-line, by ann@example.com).'))).toBe(true);
    // Newer major, from the older one: refused as well (a database line is never crossed in place)
    await expect(ops.rollback(ctx(), 'orders-db', pg17)).rejects.toThrow('cannot be moved from PostgreSQL 16 to PostgreSQL 17 in place');
  });

  it('refuses an older line of a forward-only template, allows a newer one', async () => {
    const g12 = await service('dash', GRAFANA, serviceVersion(GRAFANA, '12')!);
    const g13 = await update('dash', serviceVersion(GRAFANA, '13')!.image);
    await expect(ops.rollback(ctx(), 'dash', g12)).rejects.toThrow('Grafana cannot be moved back from Grafana 13 to Grafana 12');
    expect((await ops.releases(ctx(), 'dash')).find((r) => r.id === g12)?.rollbackRefused).toContain('moved back from Grafana 13 to Grafana 12');
    await ops.rollback(ctx(), 'dash', g12, { forceLine: true });
    // From 12, the 13 release is forward: allowed
    expect((await ops.releases(ctx(), 'dash')).find((r) => r.id === g13)?.rollbackRefused).toBeNull();
    expect((await ops.rollback(ctx(), 'dash', g13)).result).toBe('success');
    expect(currentRelease(layout, 'dash')).toBe(g13);
  });

  it('allows the same line, an older release of it too', async () => {
    const old = await service('orders-db', PG, { ...serviceVersion(PG, '17')!, image: PG17_OLD });
    const pinned = await update('orders-db', serviceVersion(PG, '17')!.image);
    expect((await ops.releases(ctx(), 'orders-db')).find((r) => r.id === old)?.rollbackRefused).toBeNull();
    expect((await ops.rollback(ctx(), 'orders-db', old)).result).toBe('success');
    expect((await ops.rollback(ctx(), 'orders-db', pinned)).result).toBe('success');
  });
});

describe('releases from before lines were recorded', () => {
  it('reads the line from the build log, proved by the checksum', async () => {
    const g12 = await service('dash', GRAFANA, serviceVersion(GRAFANA, '12')!);
    const g13 = await update('dash', serviceVersion(GRAFANA, '13')!.image);
    legacy('dash', g12);
    legacy('dash', g13);
    const listed = await ops.releases(ctx(), 'dash');
    expect(listed.find((r) => r.id === g12)?.rollbackRefused).toContain('moved back from Grafana 13 to Grafana 12');
    await expect(ops.rollback(ctx(), 'dash', g12)).rejects.toThrow('moved back from Grafana 13 to Grafana 12');
  });

  it('refuses a release whose line cannot be told, and --force-line on the command line serves it', async () => {
    const g12 = await service('dash', GRAFANA, serviceVersion(GRAFANA, '12')!);
    const g13 = await update('dash', serviceVersion(GRAFANA, '13')!.image);
    legacy('dash', g12);
    // A build log naming another image than the release's checksum is not believed
    fs.writeFileSync(path.join(layout.release('dash', g12), 'build.log'), `Pulling ${serviceVersion(GRAFANA, '13')!.image}\n`);
    const refused = await cli(['rollback', 'dash', g12]);
    expect(refused.code).toBe(1);
    expect(refused.json).toMatchObject({ refused: 'line_change', error: expect.stringContaining(`The Grafana line of release ${g12} cannot be told`) });
    expect(refused.json.error).toContain('--force-line rolls back anyway');
    expect(currentRelease(layout, 'dash')).toBe(g13);
    expect((await ops.releases(ctx(), 'dash')).find((r) => r.id === g12)?.rollbackRefused).toContain('cannot be told');

    const forced = await cli(['rollback', 'dash', g12, '--force-line']);
    expect(forced.code).toBe(0);
    expect(forced.json).toMatchObject({ result: 'success', release: g12 });
    expect(logs.some((l) => l.includes('Rolling back anyway (--force-line'))).toBe(true);
    expect(currentRelease(layout, 'dash')).toBe(g12);
  });

  it('refuses when the line serving now cannot be told', async () => {
    const g12 = await service('dash', GRAFANA, serviceVersion(GRAFANA, '12')!);
    const g13 = await update('dash', serviceVersion(GRAFANA, '13')!.image);
    legacy('dash', g13);
    fs.rmSync(path.join(layout.release('dash', g13), 'build.log'));
    await expect(ops.rollback(ctx(), 'dash', g12)).rejects.toThrow(`The Grafana line dash runs now cannot be told`);
  });
});
