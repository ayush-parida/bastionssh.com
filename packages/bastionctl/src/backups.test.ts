import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serviceConfigYaml, serviceTemplate, serviceVersion } from '@smt/shared';
import * as backups from './backups.js';
import { run } from './cli.js';
import type { Ctx } from './context.js';
import { CRON_CONTAINER } from './cron.js';
import { DockerApi } from './docker.js';
import { startFakeDocker, type FakeDocker } from './fake-docker.test-helper.js';
import { acquireLock } from './lock.js';
import { Layout } from './names.js';
import * as ops from './ops.js';
import { setBackupSchedule, setImage } from './service-config.js';

/**
 * Backups of quick services (services spec §3.4) on a temp root and the
 * fake Docker API: the template's dump run in the live container and
 * streamed to `backups/` (mode 0600, nothing left of a failed one, .env
 * values masked in errors), retention, restore (a backup of the data it
 * replaces first; exec restore with the file copied into the container,
 * Redis's data file replaced while it is stopped), the deploy lock, the
 * schedule run by bastion-cron, and Update version's set-image.
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
    hostSocket: '/var/run/docker.sock',
  };
}

const PASSWORD = 'pg-secret-value-123';

async function service(name: string, id: string, major?: string) {
  const t = serviceTemplate(id)!;
  const version = major ? serviceVersion(t, major)! : t.versions.find((v) => v.default)!;
  const text = `# kept by edits\n${serviceConfigYaml(t, { name, version, memory: t.memory, publish: { scope: 'none', port: null }, domain: null, tls: 'auto', proxy: 'caddy' })}`;
  fs.writeFileSync(path.join(layout.tmp, `${name}.yml`), text);
  await ops.init(ctx(), name, { config: `tmp/${name}.yml` });
  for (const s of t.secrets) ops.envSet(ctx(), name, s.key, s.key === 'POSTGRES_PASSWORD' ? PASSWORD : `${s.key.toLowerCase()}-value`);
  for (const [k, v] of Object.entries(t.env)) ops.envSet(ctx(), name, k, v);
  const outcome = await ops.deploy(ctx(), name);
  expect(outcome.result, outcome.error ?? '').toBe('success');
  return outcome;
}

const dir = (app: string) => path.join(layout.app(app), 'backups');
const isDump = (cmd: string[]) => cmd.join(' ').includes('pg_dump') || cmd.join(' ').includes('--rdb');

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-backups-')));
  layout = new Layout(root);
  logs = [];
  clock = Date.parse('2026-10-07T12:00:00Z');
  fake.containers.clear();
  fake.images.clear();
  fake.networks.clear();
  fake.execs.length = 0;
  fake.events.length = 0;
  fake.archives.length = 0;
  fake.crashOnStart = () => false;
  fake.pullError = null;
  fake.afterChange = null;
  // A dump writes its bytes; anything else (health checks, restores) succeeds quietly
  fake.exec = (call) => (isDump(call.cmd) ? { exitCode: 0, stdout: `DUMP of ${call.container}`, stderr: 'progress' } : { exitCode: 0 });
  await ops.setup(ctx());
});

describe('backup', () => {
  it("runs the template's dump in the live container and streams it to backups/<UTC timestamp>.<ext>, mode 0600", async () => {
    const { release } = await service('orders-db', 'postgres');
    fake.execs.length = 0;
    const result = await backups.backup(ctx(), 'orders-db');
    expect(result.backup).toMatchObject({ kind: 'manual', file: expect.stringMatching(/^\d{8}T\d{6}Z\.dump$/) });
    expect(fake.execs).toEqual([{ container: `bastion-orders-db-${release}`, cmd: serviceTemplate('postgres')!.backup!.dump }]);
    const file = path.join(dir('orders-db'), result.backup.file);
    expect(fs.readFileSync(file, 'utf8')).toBe(`DUMP of bastion-orders-db-${release}`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir('orders-db')).mode & 0o777).toBe(0o700);
    expect(result.backup.bytes).toBe(fs.statSync(file).size);
    const list = await backups.backupsList(ctx(), 'orders-db');
    expect(list).toMatchObject({ app: 'orders-db', service: 'postgres', supported: true, settings: { schedule: 'off', keep: 7 }, lastScheduled: null, cron: null });
    expect(list.backups).toEqual([{ file: result.backup.file, bytes: result.backup.bytes, createdAt: expect.any(String), kind: 'manual' }]);
  });

  it('keeps nothing of a failed dump, and masks .env values in its error', async () => {
    await service('orders-db', 'postgres');
    fake.exec = (call) => (isDump(call.cmd) ? { exitCode: 1, stdout: 'half', stderr: `pg_dump: error: password ${PASSWORD} rejected` } : { exitCode: 0 });
    await expect(backups.backup(ctx(), 'orders-db')).rejects.toThrow('The dump failed (exit 1): pg_dump: error: password •••• rejected');
    expect(fs.readdirSync(dir('orders-db'))).toEqual([]);
    fake.exec = (call) => (isDump(call.cmd) ? { exitCode: 0, stdout: '' } : { exitCode: 0 });
    await expect(backups.backup(ctx(), 'orders-db')).rejects.toThrow('The dump wrote nothing');
    expect(fs.readdirSync(dir('orders-db'))).toEqual([]);
  });

  it('keeps the newest backups.keep (or --keep), oldest removed first', async () => {
    await service('orders-db', 'postgres');
    const made: string[] = [];
    for (let i = 0; i < 4; i++) made.push((await backups.backup(ctx(), 'orders-db', { keep: 3 })).backup.file);
    expect(backups.listBackups(ctx(), 'orders-db').map((b) => b.file)).toEqual(made.slice(1).reverse());
    expect(backups.prune(ctx(), 'orders-db', 1)).toEqual({ app: 'orders-db', pruned: [made[2], made[1]] });
    expect(() => backups.prune(ctx(), 'orders-db', 0)).toThrow('--keep takes a whole number from 1 to 100');
  });

  it('refuses apps without a backup command, and runs only while no deploy holds the app', async () => {
    await service('cache', 'memcached');
    await expect(backups.backup(ctx(), 'cache')).rejects.toThrow('Memcached has no backup command');
    await service('orders-db', 'postgres');
    const release = await acquireLock(layout.lock('orders-db'), { holder: 'deployer', what: 'deploy of orders-db' });
    await expect(backups.backup(ctx(), 'orders-db')).rejects.toMatchObject({ exitCode: 4 });
    release();
    await ops.stop(ctx(), 'orders-db');
    await expect(backups.backup(ctx(), 'orders-db')).rejects.toThrow('is not running');
  });

  it('deletes one backup by name, and refuses names that are not backups', async () => {
    await service('orders-db', 'postgres');
    const { backup } = await backups.backup(ctx(), 'orders-db');
    fs.writeFileSync(path.join(layout.app('orders-db'), 'bastion.secret'), 'x');
    for (const bad of ['../bastion.yml', '.env', 'bastion.secret', `${backup.file}/x`]) expect(() => backups.deleteBackup(ctx(), 'orders-db', bad), bad).toThrow('Invalid backup file');
    expect(() => backups.deleteBackup(ctx(), 'orders-db', '20200101T000000Z.dump')).toThrow('orders-db has no backup 20200101T000000Z.dump');
    expect(backups.deleteBackup(ctx(), 'orders-db', backup.file)).toEqual({ app: 'orders-db', file: backup.file });
    expect(backups.listBackups(ctx(), 'orders-db')).toEqual([]);
  });
});

describe('restore', () => {
  it('backs up the data it replaces, copies the file into the container and runs the restore command there', async () => {
    const { release } = await service('orders-db', 'postgres');
    const { backup } = await backups.backup(ctx(), 'orders-db');
    fake.execs.length = 0;
    const result = await backups.restore(ctx(), 'orders-db', backup.file);
    expect(result).toMatchObject({ app: 'orders-db', file: backup.file, method: 'exec', safety: { kind: 'pre-restore', file: expect.stringMatching(/-pre-restore\.dump$/) } });
    const container = `bastion-orders-db-${release}`;
    const [archive] = fake.archives;
    expect(archive).toMatchObject({ container, path: '/tmp', running: true });
    // The tar holds the backup's bytes under a random name
    const inside = archive!.tar.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    expect(inside).toMatch(/^bastion-restore-[0-9a-f]{12}\.dump$/);
    expect(archive!.tar.subarray(512, 512 + backup.bytes).toString('utf8')).toBe(`DUMP of ${container}`);
    const restoreCmd = serviceTemplate('postgres')!.backup!.restore as { command: string[] };
    expect(fake.execs.map((e) => e.cmd)).toEqual([serviceTemplate('postgres')!.backup!.dump, restoreCmd.command.map((a) => a.replace('{file}', `/tmp/${inside}`)), ['rm', '-f', `/tmp/${inside}`]]);
    expect(backups.listBackups(ctx(), 'orders-db').map((b) => b.kind).sort()).toEqual(['manual', 'pre-restore']);
  });

  it('says where the replaced data is when the restore command fails, and removes the copied file', async () => {
    await service('orders-db', 'postgres');
    const { backup } = await backups.backup(ctx(), 'orders-db');
    fake.exec = (call) =>
      isDump(call.cmd) ? { exitCode: 0, stdout: 'DUMP' } : call.cmd.join(' ').includes('pg_restore') ? { exitCode: 1, stderr: 'pg_restore: error: could not execute query' } : { exitCode: 0 };
    await expect(backups.restore(ctx(), 'orders-db', backup.file)).rejects.toThrow(/The restore command failed \(exit 1\): pg_restore: error: could not execute query\. The data before the restore is in backups\/\d{8}T\d{6}Z-pre-restore\.dump/);
    expect(fake.execs.at(-1)!.cmd[0]).toBe('rm');
  });

  it('stops nothing and changes nothing when the backup of the current data fails', async () => {
    await service('orders-db', 'postgres');
    const { backup } = await backups.backup(ctx(), 'orders-db');
    fake.exec = (call) => (isDump(call.cmd) ? { exitCode: 2, stderr: 'disk full' } : { exitCode: 0 });
    await expect(backups.restore(ctx(), 'orders-db', backup.file)).rejects.toThrow('The dump failed (exit 2): disk full');
    expect(fake.archives).toEqual([]);
  });

  it("replaces Redis's dump.rdb while the container is stopped, then starts and health-checks it", async () => {
    const { release } = await service('cache', 'redis');
    const { backup } = await backups.backup(ctx(), 'cache');
    expect(backup.file).toMatch(/\.rdb$/);
    fake.events.length = 0;
    const result = await backups.restore(ctx(), 'cache', backup.file);
    const container = `bastion-cache-${release}`;
    expect(result).toMatchObject({ method: 'replace-file', safety: { kind: 'pre-restore' } });
    expect(fake.events).toEqual([`stop ${container}`, `start ${container}`]);
    expect(fake.archives).toEqual([expect.objectContaining({ container, path: '/data', running: false })]);
    expect(fake.archives[0]!.tar.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')).toBe('dump.rdb');
    expect(logs.at(-1)).toBe(`Restored cache from ${backup.file}`);
  });

  it('refuses a file of another format', async () => {
    await service('orders-db', 'postgres');
    fs.mkdirSync(dir('orders-db'), { recursive: true });
    fs.writeFileSync(path.join(dir('orders-db'), '20261001T000000Z.sql'), 'select 1;');
    await expect(backups.restore(ctx(), 'orders-db', '20261001T000000Z.sql')).rejects.toThrow('is not a pg_dump custom format (pg_dump -Fc) backup (.dump)');
  });
});

describe('schedules and bastion-cron', () => {
  it('edits backups in bastion.yml (comments kept) and runs bastion-cron only while a schedule exists', async () => {
    await service('orders-db', 'postgres');
    const r = await setBackupSchedule(ctx(), 'orders-db', 'daily', 14);
    expect(r).toEqual({ app: 'orders-db', settings: { schedule: 'daily', keep: 14 } });
    const text = fs.readFileSync(layout.config('orders-db'), 'utf8');
    expect(text).toContain('# kept by edits');
    expect(text).toContain('backups: { schedule: "daily", keep: 14 }');
    const cron = fake.containers.get(CRON_CONTAINER)!;
    expect(cron.State.Running).toBe(true);
    expect(cron.Spec).toMatchObject({
      User: `${process.getuid!()}:${process.getgid!()}`,
      WorkingDir: root,
      Entrypoint: ['sh', '-c'],
      Cmd: ['while :; do node "$BASTION_ROOT/bin/bastionctl.mjs" backups run-due --json; sleep 60; done'],
      HostConfig: expect.objectContaining({ Binds: [`${root}:${root}`, '/var/run/docker.sock:/var/run/docker.sock'], NetworkMode: 'none', RestartPolicy: { Name: 'unless-stopped' } }),
    });
    expect(cron.Spec.Env).toContain(`BASTION_ROOT=${root}`);
    // Again: the same container, left as it is
    const id = cron.Id;
    await setBackupSchedule(ctx(), 'orders-db', 'hourly');
    expect(fake.containers.get(CRON_CONTAINER)!.Id).toBe(id);
    expect((await backups.backupsList(ctx(), 'orders-db')).cron).toMatchObject({ name: CRON_CONTAINER, state: 'running' });
    await setBackupSchedule(ctx(), 'orders-db', 'off');
    expect(fake.containers.has(CRON_CONTAINER)).toBe(false);
  });

  it('refuses a schedule for a service without a backup command', async () => {
    await service('cache', 'memcached');
    await expect(setBackupSchedule(ctx(), 'cache', 'daily')).rejects.toThrow('backups.schedule: The memcached template has no backup command');
  });

  it('runs a scheduled backup when one is due, records it, and retries a failed one a quarter of an hour later', async () => {
    await service('orders-db', 'postgres');
    await service('plain', 'redis');
    await setBackupSchedule(ctx(), 'orders-db', 'hourly', 2);
    const first = await backups.runDue(ctx());
    expect(first.ran).toEqual([{ app: 'orders-db', file: expect.stringMatching(/-scheduled\.dump$/), error: null }]);
    // Not due again until the hour is (nearly) up
    expect((await backups.runDue(ctx())).ran).toEqual([]);
    clock += 59 * 60_000;
    expect((await backups.runDue(ctx())).ran).toHaveLength(1);
    expect((await backups.backupsList(ctx(), 'orders-db')).lastScheduled).toMatchObject({ result: 'success', file: expect.stringMatching(/-scheduled\.dump$/) });

    clock += 60 * 60_000;
    fake.exec = (call) => (isDump(call.cmd) ? { exitCode: 1, stderr: 'boom' } : { exitCode: 0 });
    expect((await backups.runDue(ctx())).ran).toEqual([{ app: 'orders-db', file: null, error: 'The dump failed (exit 1): boom' }]);
    expect((await backups.backupsList(ctx(), 'orders-db')).lastScheduled).toMatchObject({ result: 'failed', error: 'The dump failed (exit 1): boom' });
    expect((await backups.runDue(ctx())).skipped).toEqual([{ app: 'orders-db', reason: 'failed recently; retried later' }]);
    clock += 15 * 60_000;
    fake.exec = (call) => (isDump(call.cmd) ? { exitCode: 0, stdout: 'ok' } : { exitCode: 0 });
    expect((await backups.runDue(ctx())).ran).toHaveLength(1);
    // keep: 2
    expect(backups.listBackups(ctx(), 'orders-db')).toHaveLength(2);
  });

  it('skips a service whose deploy lock is held, and tries again at the next tick', async () => {
    await service('orders-db', 'postgres');
    await setBackupSchedule(ctx(), 'orders-db', 'daily');
    const release = await acquireLock(layout.lock('orders-db'), { holder: 'deployer', what: 'deploy of orders-db' });
    expect(await backups.runDue(ctx())).toEqual({ ran: [], skipped: [{ app: 'orders-db', reason: 'busy (a deploy, backup or restore is running)' }] });
    release();
    expect((await backups.runDue(ctx())).ran).toHaveLength(1);
  });

  it('is set up again by setup, and removed with the last scheduled service', async () => {
    await service('orders-db', 'postgres');
    await setBackupSchedule(ctx(), 'orders-db', 'daily');
    await ctx().docker.remove(CRON_CONTAINER);
    await ops.setup(ctx());
    expect(fake.containers.get(CRON_CONTAINER)?.State.Running).toBe(true);
    await ops.remove(ctx(), 'orders-db', { purge: true });
    expect(fake.containers.has(CRON_CONTAINER)).toBe(false);
  });
});

describe('set-image (Update version)', () => {
  it('rewrites build.image in place and keeps the rest of bastion.yml', async () => {
    await service('orders-db', 'postgres', '17');
    const before = fs.readFileSync(layout.config('orders-db'), 'utf8');
    const next = `postgres:17.99-alpine@sha256:${'b'.repeat(64)}`;
    const r = await setImage(ctx(), 'orders-db', next);
    expect(r).toMatchObject({ app: 'orders-db', from: serviceVersion(serviceTemplate('postgres')!, '17')!.image, to: next, changed: true });
    const after = fs.readFileSync(layout.config('orders-db'), 'utf8');
    expect(after).toBe(before.replace(r.from!, next));
    expect((await setImage(ctx(), 'orders-db', next)).changed).toBe(false);
    await expect(setImage(ctx(), 'orders-db', 'not an image')).rejects.toThrow('Not an image reference');
  });

  it('refuses an app that is not built from an image', async () => {
    fs.writeFileSync(path.join(layout.tmp, 'site.yml'), 'name: site\ndomains: [site.example.com]\nbuild: { type: dockerfile }\n');
    await ops.init(ctx(), 'site', { config: 'tmp/site.yml' });
    await expect(setImage(ctx(), 'site', 'nginx:1')).rejects.toThrow('site is not built from an image');
  });
});

describe('the command line', () => {
  it('lists, backs up, restores and schedules with --json', async () => {
    await service('orders-db', 'postgres');
    const out: string[] = [];
    const io = { env: { BASTION_ROOT: root }, stdout: (t: string) => out.push(t), stderr: () => {}, readStdin: async () => '', ctx: { docker: new DockerApi(fake.socket), now: () => new Date((clock += 1000)), healthIntervalMs: 1 } };
    const last = () => JSON.parse(out.at(-1)!) as Record<string, unknown>;
    expect(await run(['backup', 'orders-db', '--keep', '3', '--json'], io)).toBe(0);
    const file = (last().backup as { file: string }).file;
    expect(await run(['backups', 'list', 'orders-db', '--json'], io)).toBe(0);
    expect((last().backups as unknown[]).length).toBe(1);
    expect(await run(['restore', 'orders-db', file, '--json'], io)).toBe(0);
    expect(last()).toMatchObject({ app: 'orders-db', file, method: 'exec' });
    expect(await run(['restore', 'orders-db', '../bastion.yml', '--json'], io)).toBe(2);
    expect(await run(['backups', 'schedule', 'orders-db', 'weekly', '--json'], io)).toBe(2);
    expect(await run(['backup', 'orders-db', '--keep', '0', '--json'], io)).toBe(2);
    expect(await run(['backups', 'delete', 'orders-db', file, '--json'], io)).toBe(0);
  });
});
