import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Quick-service routes (services spec §3.3, §3.4) with the server replaced
 * at deploy/remote.ts, as in deploy.test.ts: a fake filesystem and a
 * scripted bastionctl read back from the exact command lines sent. Under
 * test: create from the catalog (the bastion.yml it writes, fixed values on
 * stdin, secrets generated on the server, the streamed deploy, refusals
 * before anything is written), connection details with secrets masked,
 * Update version within a line and the refusal across one, rollback kept
 * within a service's version line (409 `line_change_refused`, forceLine for
 * managers only, audited), and backups —
 * levels, the passkey step-up for downloads, the restore confirmation, and
 * the audit rows (names and files only, never a value).
 */

interface FakeRun {
  argv: string[];
  stdin?: string;
}

interface Scripted {
  stdout?: unknown;
  stderr?: string[];
  exitCode?: number | null;
}

const fake = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  runs: [] as FakeRun[],
  commands: [] as string[],
  bastionctl: null as null | ((args: string[], run: FakeRun) => Scripted),
  downloads: [] as string[],
}));

function parseQuoted(command: string): string[] {
  const argv: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] !== "'") throw new Error(`Unquoted text in command at ${i}: ${command.slice(i, i + 20)}`);
    let word = '';
    for (;;) {
      const end = command.indexOf("'", i + 1);
      if (end === -1) throw new Error('Unterminated quote');
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
    if (i < command.length) {
      if (command[i] !== ' ') throw new Error(`Expected a space at ${i}`);
      i++;
    }
  }
  return argv;
}

vi.mock('../../deploy/remote.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../deploy/remote.js')>();
  const { createHash } = await import('node:crypto');
  const { Readable } = await import('node:stream');
  const { DISCOVER_SCRIPT } = await import('../../deploy/install.js');
  const openRemote = async (_req: unknown, server: import('../../deploy/remote.js').ServerRow): Promise<import('../../deploy/remote.js').Remote> => ({
    server,
    async run(command, opts = {}) {
      fake.commands.push(command);
      const argv = parseQuoted(command);
      const done = (stdout: string, exitCode: number | null = 0) => ({ exitCode, signal: null, timedOut: false, stdout, stderr: '', durationMs: 5 });
      if (argv[0] === 'sh' && argv[1] === '-c') {
        if (argv[2] === DISCOVER_SCRIPT) return done('root=/opt/bastion\n');
        throw new Error('unexpected script');
      }
      if (argv[0] !== 'env' || argv[2] !== '/opt/bastion/bin/bastionctl' || argv.at(-1) !== '--json') throw new Error(`unexpected command ${command}`);
      const run: FakeRun = { argv: argv.slice(3, -1), stdin: opts.stdin };
      fake.runs.push(run);
      // A config written for validate/init is read back as the server would
      const scripted = fake.bastionctl!(run.argv, run);
      for (const line of scripted.stderr ?? []) opts.onLine?.('stderr', line);
      const stdout = scripted.stdout === undefined ? '' : JSON.stringify(scripted.stdout) + '\n';
      if (stdout) opts.onLine?.('stdout', stdout.trimEnd());
      return done(stdout, 'exitCode' in scripted ? (scripted.exitCode ?? null) : 0);
    },
    async hashFile(path) {
      const data = fake.files.get(path);
      return data ? createHash('sha256').update(data).digest('hex') : null;
    },
    async readFile(path) {
      return fake.files.get(path) ?? null;
    },
    async writeFile(path, data) {
      fake.files.set(path, Buffer.from(data));
    },
    async upload() {
      throw new Error('no uploads here');
    },
    async remove(path) {
      fake.files.delete(path);
    },
    async download(path) {
      fake.downloads.push(path);
      const data = fake.files.get(path);
      return data ? { size: data.length, stream: Readable.from([data]) } : null;
    },
    release() {},
  });
  return { ...actual, openRemote };
});

import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { serviceTemplate, serviceVersion } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, passkeys, sessions } from '../../db/schema.js';
import { setBastionctlBundleForTests, type BastionctlBundle } from '../../deploy/bundle.js';
import { resetBastionctlUpgradesForTests } from '../../deploy/upgrade.js';
import { seedOrg, seedServer, seedSession, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const SCRIPT = Buffer.from('// bastionctl.mjs as shipped\n');
const WRAPPER = Buffer.from('#!/bin/sh\n# bastionctl wrapper as shipped\n');
const BUNDLE: BastionctlBundle = { version: '9.9.9', script: SCRIPT, wrapper: WRAPPER, scriptSha256: sha(SCRIPT), wrapperSha256: sha(WRAPPER) };

const PG = serviceTemplate('postgres')!;
const PG17 = serviceVersion(PG, '17')!;
const PG16 = serviceVersion(PG, '16')!;
const OUTCOME = { app: 'orders-db', release: '20261007-120000-abcdef12', previous: null, result: 'success', error: null };
const BACKUP = '20261007T120000Z.dump';

/** Releases of a Grafana service as bastionctl lists them: 13 serving, a 13.1 one, and a 12 one a rollback may not return to. */
const R12 = '20261007-100000-aaaaaaaa';
const R131 = '20261007-110000-bbbbbbbb';
const R13 = '20261007-120000-cccccccc';
const REFUSED = `Release ${R12} runs another line: Grafana cannot be moved back from Grafana 13 to Grafana 12: its data was migrated by the newer release.`;
const release = (id: string, line: string, extra: Record<string, unknown>) => ({ id, app: 'dash', buildType: 'image', result: 'success', service: 'grafana', line, imagePresent: true, current: false, ...extra });
const RELEASES = [release(R13, '13', { current: true }), release(R131, '13', { rollbackRefused: null }), release(R12, '12', { rollbackRefused: REFUSED })];

/** What `status` says about an app: a PostgreSQL service, a MinIO with a domain, or a plain app. */
const apps: Record<string, unknown> = {};
function serviceStatus(name: string, config: Record<string, unknown>) {
  apps[name] = { name, service: config.service ?? null, configError: null, config: { domains: [], tls: 'auto', ...config } };
}

function defaultBastionctl(args: string[], _run?: FakeRun): Scripted {
  const [command, ...rest] = args;
  switch (command) {
    case 'status':
      return apps[rest[0]!] ? { stdout: apps[rest[0]!] } : { stdout: { error: `No app named ${rest[0]} on this server`, code: 1 }, exitCode: 1 };
    case 'validate':
      return { stdout: { ok: true, errors: [] } };
    case 'init':
      return { stdout: { app: rest[0], created: true } };
    case 'env':
      if (rest[0] === 'generate') return { stdout: { key: rest[2], generated: true } };
      return { stdout: { key: rest[2], changed: true } };
    case 'deploy':
      return { stderr: [`Pulling ${PG17.image}`, 'Health check passed'], stdout: OUTCOME };
    case 'set-image':
      return { stdout: { app: rest[0], from: null, to: rest[1], changed: true } };
    case 'releases':
      return { stdout: RELEASES };
    case 'rollback':
      return { stderr: [`Rolling ${rest[0]} back to ${rest[1]}`], stdout: { ...OUTCOME, app: rest[0], release: rest[1] } };
    case 'backups':
      if (rest[0] === 'list') return { stdout: { app: rest[1], service: 'postgres', supported: true, backups: [{ file: BACKUP, bytes: 12, createdAt: '2026-10-07T12:00:00.000Z', kind: 'manual' }], settings: { schedule: 'off', keep: 7 }, lastScheduled: null, cron: null } };
      if (rest[0] === 'delete') return { stdout: { app: rest[1], file: rest[2] } };
      if (rest[0] === 'schedule') return { stdout: { app: rest[1], settings: { schedule: rest[2], keep: rest[4] ? Number(rest[4]) : 7 } } };
      break;
    case 'backup':
      return { stdout: { app: rest[0], backup: { file: BACKUP, bytes: 12, createdAt: '2026-10-07T12:00:00.000Z', kind: 'manual' }, pruned: [] } };
    case 'restore':
      return { stdout: { app: rest[0], file: rest[1], safety: { file: '20261007T130000Z-pre-restore.dump', bytes: 10, createdAt: '2026-10-07T13:00:00.000Z', kind: 'pre-restore' }, method: 'exec' } };
  }
  return { stdout: { error: `Unknown command ${command}`, code: 2 }, exitCode: 2 };
}

describe('quick-service routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let orgId: string;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let serverA: string;

  let calls = 0;
  const call = (who: Pick<Who, 'headers'>, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, remoteAddress: `10.79.${(++calls >> 8) & 255}.${calls & 255}`, ...(payload && { payload }) });
  const api = (path = '') => `/api/deploy/servers/${serverA}${path}`;
  const runsOf = (command: string) => fake.runs.filter((r) => r.argv[0] === command);

  function audits(action: string) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .orderBy(desc(auditLog.createdAt))
      .all()
      .map((r) => ({ ...r, meta: JSON.parse(r.metadata ?? '{}') as Record<string, unknown> }));
  }

  async function events(who: Who, path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { ...who.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      json: () => JSON.parse(text) as Record<string, unknown>,
      events: text
        .split('\n\n')
        .filter((b) => b.startsWith('data: '))
        .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>),
    };
  }
  const logText = (evts: Array<Record<string, unknown>>) =>
    evts
      .filter((e) => e.type === 'log')
      .flatMap((e) => (e.lines as Array<{ text: string }>).map((l) => l.text))
      .join('\n');

  beforeAll(async () => {
    await runMigrations();
    setBastionctlBundleForTests(BUNDLE);
    orgId = seedOrg('org-services');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    serverA = seedServer(orgId, admin.userId, 'db-1');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await app.close();
    setBastionctlBundleForTests(undefined);
  });

  beforeEach(() => {
    fake.files.clear();
    fake.runs.length = 0;
    fake.commands.length = 0;
    fake.downloads.length = 0;
    fake.bastionctl = defaultBastionctl;
    for (const k of Object.keys(apps)) delete apps[k];
    fake.files.set('/opt/bastion/bin/bastionctl.mjs', SCRIPT);
    fake.files.set('/opt/bastion/bin/bastionctl', WRAPPER);
    resetBastionctlUpgradesForTests();
  });

  describe('create from the catalog', () => {
    it('writes the template’s bastion.yml, sets fixed values on stdin, generates secrets on the server, and streams the deploy', async () => {
      let yml = '';
      fake.bastionctl = (args, run) => {
        if (args[0] === 'validate') yml = fake.files.get(args[3]!)!.toString('utf8');
        return defaultBastionctl(args, run);
      };
      const res = await events(admin, api('/services'), { name: 'orders-db', template: 'postgres', version: '17', memory: '1g', publish: { scope: 'localhost', port: 15432 } });
      expect(res.status).toBe(200);
      expect(res.type).toBe('text/event-stream');
      expect(yml).toContain('service: postgres');
      expect(yml).toContain(`image: "${PG17.image}"`);
      expect(yml).toContain('memory: 1g');
      expect(yml).toContain('publish: "localhost:15432"');
      expect(yml).toContain('strategy: recreate');
      expect(fake.runs.map((r) => r.argv)).toEqual([
        ['status', 'orders-db'],
        ['validate', 'orders-db', '--file', expect.stringMatching(/^\/opt\/bastion\/tmp\/service-orders-db-[a-z0-9]+\.yml$/)],
        ['init', 'orders-db', '--config', expect.stringMatching(/^\/opt\/bastion\/tmp\/service-orders-db-/)],
        ['env', 'set', 'orders-db', 'POSTGRES_USER'],
        ['env', 'set', 'orders-db', 'POSTGRES_DB'],
        ['env', 'generate', 'orders-db', 'POSTGRES_PASSWORD', '--bytes', '24', '--if-missing'],
        ['deploy', 'orders-db'],
      ]);
      expect(runsOf('env').slice(0, 2).map((r) => r.stdin)).toEqual(['app', 'app']);
      // The temporary config is gone
      expect([...fake.files.keys()].filter((f) => f.includes('/tmp/'))).toEqual([]);
      const log = logText(res.events);
      expect(log).toContain(`Created orders-db from the PostgreSQL template: ${PG17.image}`);
      expect(log).toContain('Generated POSTGRES_PASSWORD on the server (24 random bytes)');
      expect(res.events.find((e) => e.type === 'result')).toEqual({ type: 'result', outcome: OUTCOME });
      const [created] = audits('deploy.service_create');
      expect(created!.meta).toEqual({ app: 'orders-db', template: 'postgres', version: '17', image: PG17.image, memory: '1g', publish: 'localhost:15432', domain: null, generated: ['POSTGRES_PASSWORD'] });
      expect(audits('deploy.finish')[0]!.meta).toMatchObject({ app: 'orders-db', result: 'success', release: OUTCOME.release });
    });

    it('gives a UI service its domain and the template’s defaults', async () => {
      let yml = '';
      fake.bastionctl = (args, run) => {
        if (args[0] === 'validate') yml = fake.files.get(args[3]!)!.toString('utf8');
        return defaultBastionctl(args, run);
      };
      const res = await events(admin, api('/services'), { name: 'files', template: 'minio', domain: 'console.example.com', tls: 'internal', publish: { scope: 'public', port: 19000 } });
      expect(res.status).toBe(200);
      expect(yml).toContain('domains: [console.example.com]');
      expect(yml).toContain('tls: internal');
      // The S3 port is published; the domain serves the console
      expect(yml).toContain('publish: "public:19000:9000"');
      expect(yml).toContain('port: 9001');
      expect(runsOf('env').map((r) => r.argv.slice(0, 4))).toEqual([
        ['env', 'set', 'files', 'MINIO_ROOT_USER'],
        ['env', 'generate', 'files', 'MINIO_ROOT_PASSWORD'],
      ]);
    });

    it('refuses before writing anything: levels, unknown templates, versions, memory, domains, names taken', async () => {
      const body = { name: 'orders-db', template: 'postgres' };
      expect((await call(operator, 'POST', api('/services'), body)).statusCode).toBe(403);
      expect((await call(viewer, 'POST', api('/services'), body)).statusCode).toBe(403);
      expect((await call(admin, 'POST', api('/services'), { ...body, template: 'oracle' })).json()).toEqual({ error: 'No service template oracle' });
      expect((await call(admin, 'POST', api('/services'), { ...body, version: '9' })).json().error).toBe('PostgreSQL is offered in 18, 17, 16');
      expect((await call(admin, 'POST', api('/services'), { ...body, memory: '64m' })).json().error).toBe('PostgreSQL needs at least 128m of memory');
      expect((await call(admin, 'POST', api('/services'), { ...body, domain: 'db.example.com' })).json().error).toBe('PostgreSQL has no web UI to give a domain');
      expect((await call(admin, 'POST', api('/services'), { ...body, publish: { scope: 'public' } })).statusCode).toBe(400);
      expect((await call(admin, 'POST', api('/services'), { ...body, publish: { scope: 'public', port: 80 } })).statusCode).toBe(400);
      expect((await call(admin, 'POST', api('/services'), { ...body, name: 'Orders' })).statusCode).toBe(400);
      expect((await call(admin, 'POST', api('/services'), { ...body, image: 'evil/db:1' })).statusCode).toBe(400);
      expect(fake.runs).toEqual([]);
      serviceStatus('orders-db', { service: 'postgres', build: { type: 'image', image: PG17.image } });
      const taken = await call(admin, 'POST', api('/services'), body);
      expect(taken.statusCode).toBe(409);
      expect(taken.json()).toMatchObject({ code: 'exists' });
      expect(fake.runs.map((r) => r.argv[0])).toEqual(['status']);
    });

    it('answers 422 with bastionctl’s problems, and creates nothing', async () => {
      fake.bastionctl = (args, run) =>
        args[0] === 'validate' ? { stdout: { ok: false, errors: [{ path: 'run.publish', message: 'Host port 15432 is already published by app other' }] } } : defaultBastionctl(args, run);
      const res = await call(admin, 'POST', api('/services'), { name: 'orders-db', template: 'postgres', publish: { scope: 'localhost', port: 15432 } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'invalid_config', errors: [{ path: 'run.publish' }] });
      expect(runsOf('init')).toEqual([]);
    });
  });

  describe('connection', () => {
    it('gives host, ports, published address and strings with the secrets masked, to viewers too', async () => {
      serviceStatus('orders-db', { service: 'postgres', build: { type: 'image', image: PG17.image }, run: { port: 5432, publish: { scope: 'public', port: 15432, target: null } } });
      const res = await call(viewer, 'GET', api('/apps/orders-db/connection'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        app: 'orders-db',
        service: 'postgres',
        name: 'PostgreSQL',
        host: 'orders-db',
        port: 5432,
        published: { scope: 'public', host: '10.0.0.1', port: 15432, target: 5432 },
        secrets: ['POSTGRES_PASSWORD'],
        ui: null,
        docs: '/docs/deployments/services-postgres',
      });
      expect(res.json().strings[0]).toEqual({ label: 'URL', internal: 'postgres://app:{POSTGRES_PASSWORD}@orders-db:5432/app', published: 'postgres://app:{POSTGRES_PASSWORD}@10.0.0.1:15432/app' });
      // Nothing secret was read for it
      expect(fake.runs.map((r) => r.argv[0])).toEqual(['status']);
    });

    it('lists the UI’s address, and answers 404 for an app that is no quick service', async () => {
      serviceStatus('files', { service: 'minio', domains: ['console.example.com'], build: { type: 'image', image: serviceTemplate('minio')!.versions[0]!.image }, run: { port: 9001, publish: { scope: 'none', port: null } } });
      expect((await call(viewer, 'GET', api('/apps/files/connection'))).json()).toMatchObject({ ui: { label: 'Console', urls: ['https://console.example.com'] }, strings: [{ label: 'S3 endpoint', internal: 'http://files:9000', published: null }] });
      serviceStatus('site1', { build: { type: 'nextjs', image: null }, run: { port: 3000, publish: { scope: 'none', port: null } } });
      const res = await call(viewer, 'GET', api('/apps/site1/connection'));
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('not_a_service');
    });
  });

  describe('Update version', () => {
    it('moves to the line’s pinned image and redeploys, streamed and audited', async () => {
      const older = PG17.image.replace(/:[^@]+@sha256:[0-9a-f]+$/, `:17.1-alpine@sha256:${'c'.repeat(64)}`);
      serviceStatus('orders-db', { service: 'postgres', build: { type: 'image', image: older }, run: { port: 5432, publish: { scope: 'none', port: null } } });
      expect((await call(operator, 'POST', api('/apps/orders-db/service/version'), { version: '17' })).statusCode).toBe(403);
      const res = await events(admin, api('/apps/orders-db/service/version'), { version: '17' });
      expect(res.status).toBe(200);
      expect(fake.runs.map((r) => r.argv)).toEqual([['status', 'orders-db'], ['set-image', 'orders-db', PG17.image], ['deploy', 'orders-db']]);
      expect(logText(res.events)).toContain(`Updating orders-db from ${older} to ${PG17.image}`);
      expect(audits('deploy.service_update')[0]!.meta).toEqual({ app: 'orders-db', template: 'postgres', line: '17', from: older, to: PG17.image });
    });

    it('refuses a new major for a database, and says why', async () => {
      serviceStatus('orders-db', { service: 'postgres', build: { type: 'image', image: PG16.image }, run: { port: 5432, publish: { scope: 'none', port: null } } });
      const res = await call(admin, 'POST', api('/apps/orders-db/service/version'), { version: '17' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'major_upgrade_refused', docs: '/docs/deployments/services-postgres#upgrading' });
      expect(res.json().error).toContain('PostgreSQL cannot be moved from PostgreSQL 16 to PostgreSQL 17 in place');
      expect(runsOf('set-image')).toEqual([]);
      const current = await call(admin, 'POST', api('/apps/orders-db/service/version'), { version: '16' });
      expect(current.json()).toMatchObject({ code: 'up_to_date' });
    });

    it('puts the previous image back in bastion.yml when the deploy fails', async () => {
      const older = PG17.image.replace(/:[^@]+@/, ':17.1-alpine@');
      serviceStatus('orders-db', { service: 'postgres', build: { type: 'image', image: older }, run: { port: 5432, publish: { scope: 'none', port: null } } });
      fake.bastionctl = (args, run) => (args[0] === 'deploy' ? { stdout: { ...OUTCOME, result: 'failed', error: 'Health check failed after 120s' }, exitCode: 1 } : defaultBastionctl(args, run));
      const res = await events(admin, api('/apps/orders-db/service/version'), { version: '17' });
      expect(runsOf('set-image').map((r) => r.argv[2])).toEqual([PG17.image, older]);
      expect(logText(res.events)).toContain(`bastion.yml names ${older} again`);
    });
  });

  describe('rollback across version lines', () => {
    beforeEach(() => {
      serviceStatus('dash', { service: 'grafana', build: { type: 'image', image: serviceVersion(serviceTemplate('grafana')!, '13')!.image }, run: { port: 3000, publish: { scope: 'none', port: null } } });
    });

    it('refuses a release on another line with 409 before anything runs, and audits the refusal', async () => {
      const res = await call(operator, 'POST', api('/apps/dash/rollback'), { release: R12 });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: REFUSED, code: 'line_change_refused', docs: '/docs/deployments/releases-rollback#version-lines' });
      expect(fake.runs.map((r) => r.argv)).toEqual([['status', 'dash'], ['releases', 'dash']]);
      expect(audits('deploy.rollback')[0]!.meta).toEqual({ app: 'dash', release: R12, service: 'grafana', result: 'refused', error: REFUSED });
    });

    it('rolls back within the line as usual', async () => {
      const res = await events(operator, api('/apps/dash/rollback'), { release: R131 });
      expect(res.type).toBe('text/event-stream');
      expect(fake.runs.map((r) => r.argv)).toEqual([['status', 'dash'], ['releases', 'dash'], ['rollback', 'dash', R131]]);
      expect(audits('deploy.rollback')[0]!.meta).toMatchObject({ app: 'dash', release: R131, result: 'success' });
    });

    it('lets only managers force a line change, passing --force-line and auditing it', async () => {
      const denied = await call(operator, 'POST', api('/apps/dash/rollback'), { release: R12, forceLine: true });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe('force_line_needs_manage');
      expect(runsOf('rollback')).toEqual([]);
      expect((await call(viewer, 'POST', api('/apps/dash/rollback'), { release: R12, forceLine: true })).statusCode).toBe(403);
      fake.runs.length = 0;

      const res = await events(admin, api('/apps/dash/rollback'), { release: R12, forceLine: true });
      expect(res.type).toBe('text/event-stream');
      // No release list: bastionctl is told to roll back anyway, and logs the warning itself
      expect(fake.runs.map((r) => r.argv)).toEqual([['status', 'dash'], ['rollback', 'dash', R12, '--force-line']]);
      expect(audits('deploy.rollback')[0]!.meta).toMatchObject({ app: 'dash', release: R12, forceLine: true, result: 'success' });
    });

    it('leaves apps without service: alone (no release list read)', async () => {
      serviceStatus('site1', { build: { type: 'nextjs', image: null }, run: { port: 3000, publish: { scope: 'none', port: null } } });
      await events(operator, api('/apps/site1/rollback'), { release: R12 });
      expect(fake.runs.map((r) => r.argv)).toEqual([['status', 'site1'], ['rollback', 'site1', R12]]);
    });
  });

  describe('backups', () => {
    it('lists for viewers, backs up for operators, and audits the file made', async () => {
      expect((await call(viewer, 'GET', api('/apps/orders-db/backups'))).json().backups).toHaveLength(1);
      expect((await call(viewer, 'POST', api('/apps/orders-db/backups'))).statusCode).toBe(403);
      const res = await call(operator, 'POST', api('/apps/orders-db/backups'));
      expect(res.statusCode).toBe(200);
      expect(res.json().backup.file).toBe(BACKUP);
      expect(audits('deploy.backup_create')[0]!.meta).toEqual({ app: 'orders-db', file: BACKUP, bytes: 12, pruned: [], result: 'success' });
      fake.bastionctl = (args, run) => (args[0] === 'backup' ? { stdout: { error: 'The dump failed (exit 1): disk full\nmore', code: 1 }, exitCode: 1 } : defaultBastionctl(args, run));
      expect((await call(operator, 'POST', api('/apps/orders-db/backups'))).statusCode).toBe(409);
      expect(audits('deploy.backup_create')[0]!.meta).toEqual({ app: 'orders-db', result: 'failed', error: 'The dump failed (exit 1): disk full' });
    });

    it('downloads only from a browser session after a passkey step-up, streamed and audited', async () => {
      const path = `/opt/bastion/apps/orders-db/backups/${BACKUP}`;
      fake.files.set(path, Buffer.from('PGDMP custom dump'));
      expect((await call(operator, 'GET', api(`/apps/orders-db/backups/${BACKUP}`))).statusCode).toBe(403);
      // An API token, even a manager's
      expect((await call(admin, 'GET', api(`/apps/orders-db/backups/${BACKUP}`))).statusCode).toBe(403);
      const session = await seedSession(admin.userId);
      expect((await call(session, 'GET', api(`/apps/orders-db/backups/${BACKUP}`))).json().code).toBe('DEPLOY_REVEAL_NEEDS_PASSKEY');
      getDb()
        .insert(passkeys)
        .values({ id: nanoid(), userId: admin.userId, credentialId: nanoid(), publicKey: Buffer.from([1]), deviceType: 'multiDevice', name: 'Laptop' })
        .run();
      expect((await call(session, 'GET', api(`/apps/orders-db/backups/${BACKUP}`))).json().code).toBe('PASSKEY_STEP_UP_REQUIRED');
      expect(fake.downloads).toEqual([]);
      getDb().update(sessions).set({ passkeyVerified: true }).where(eq(sessions.id, session.sessionId)).run();
      const res = await call(session, 'GET', api(`/apps/orders-db/backups/${BACKUP}`));
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('PGDMP custom dump');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="orders-db-${BACKUP}"`);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(fake.downloads).toEqual([path]);
      expect(audits('deploy.backup_download')[0]!.meta).toEqual({ app: 'orders-db', file: BACKUP, bytes: 17 });
      expect((await call(session, 'GET', api('/apps/orders-db/backups/20200101T000000Z.dump'))).statusCode).toBe(404);
      for (const bad of ['..%2Fbastion.yml', '.env', 'x.dump']) expect((await call(session, 'GET', api(`/apps/orders-db/backups/${bad}`))).statusCode, bad).toBe(400);
    });

    it('restores only with the service’s name typed, and audits the backup taken first', async () => {
      expect((await call(operator, 'POST', api(`/apps/orders-db/backups/${BACKUP}/restore`), { confirm: 'orders-db' })).statusCode).toBe(403);
      const wrong = await call(admin, 'POST', api(`/apps/orders-db/backups/${BACKUP}/restore`), { confirm: 'orders' });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().code).toBe('confirm_mismatch');
      expect(runsOf('restore')).toEqual([]);
      const res = await call(admin, 'POST', api(`/apps/orders-db/backups/${BACKUP}/restore`), { confirm: 'orders-db' });
      expect(res.statusCode).toBe(200);
      expect(runsOf('restore').map((r) => r.argv)).toEqual([['restore', 'orders-db', BACKUP]]);
      expect(audits('deploy.backup_restore')[0]!.meta).toEqual({ app: 'orders-db', file: BACKUP, safety: '20261007T130000Z-pre-restore.dump', method: 'exec', result: 'success' });
    });

    it('deletes and schedules for managers only', async () => {
      expect((await call(operator, 'DELETE', api(`/apps/orders-db/backups/${BACKUP}`))).statusCode).toBe(403);
      expect((await call(admin, 'DELETE', api(`/apps/orders-db/backups/${BACKUP}`))).json()).toEqual({ app: 'orders-db', file: BACKUP });
      expect(audits('deploy.backup_delete')[0]!.meta).toEqual({ app: 'orders-db', file: BACKUP });
      expect((await call(operator, 'PUT', api('/apps/orders-db/backups/schedule'), { schedule: 'daily' })).statusCode).toBe(403);
      expect((await call(admin, 'PUT', api('/apps/orders-db/backups/schedule'), { schedule: 'weekly' })).statusCode).toBe(400);
      const res = await call(admin, 'PUT', api('/apps/orders-db/backups/schedule'), { schedule: 'daily', keep: 14 });
      expect(res.json()).toEqual({ app: 'orders-db', settings: { schedule: 'daily', keep: 14 } });
      expect(runsOf('backups').at(-1)!.argv).toEqual(['backups', 'schedule', 'orders-db', 'daily', '--keep', '14']);
      expect(audits('deploy.backup_schedule')[0]!.meta).toEqual({ app: 'orders-db', schedule: 'daily', keep: 14 });
    });
  });
});
