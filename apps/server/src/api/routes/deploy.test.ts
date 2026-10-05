import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Deployment routes end to end, with the server replaced at the one seam
 * every route goes through (deploy/remote.ts): a fake filesystem and a
 * scripted bastionctl, reached by parsing back the exact command lines the
 * app sends. Under test: the module × server-level matrix, the integrity
 * check refusing a foreign bastionctl, setup installing the shipped files,
 * deploy uploads and SSE logs (and what happens when the browser leaves or
 * access is revoked mid-deploy), config validation, `.env` values kept out of
 * command lines and audit rows, and that a deploy leaves nothing in the
 * database but audit entries.
 */

interface FakeRun {
  argv: string[];
  stdin?: string;
}

interface Scripted {
  stdout?: unknown;
  stderr?: string[];
  exitCode?: number | null;
  /** Hold the command open until this settles. */
  wait?: Promise<void>;
}

const fake = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  modes: new Map<string, number>(),
  root: '/opt/bastion' as string | null,
  runs: [] as FakeRun[],
  commands: [] as string[],
  opened: 0,
  released: 0,
  bastionctl: null as null | ((args: string[], run: FakeRun) => Scripted | Promise<Scripted>),
  /** Bytes seen by upload(), per path. */
  uploads: new Map<string, number>(),
}));

/** Split a command line made of single-quoted words (shellCommand's output) back into argv; anything else throws. */
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
  const { DISCOVER_SCRIPT, PREPARE_SCRIPT } = await import('../../deploy/install.js');
  const openRemote = async (_req: unknown, server: import('../../deploy/remote.js').ServerRow): Promise<import('../../deploy/remote.js').Remote> => {
    fake.opened++;
    let released = false;
    return {
      server,
      async run(command, opts = {}) {
        fake.commands.push(command);
        const argv = parseQuoted(command);
        const started = Date.now();
        const done = (stdout: string, stderr: string[], exitCode: number | null = 0) => {
          for (const line of stderr) opts.onLine?.('stderr', line);
          if (stdout) opts.onLine?.('stdout', stdout.trimEnd());
          return { exitCode, signal: null, timedOut: false, stdout, stderr: stderr.join('\n'), durationMs: Date.now() - started };
        };
        if (argv[0] === 'sh' && argv[1] === '-c') {
          if (argv[2] === DISCOVER_SCRIPT) return done(`root=${fake.root ?? ''}\n`, []);
          if (argv[2] === PREPARE_SCRIPT) return done('root=/opt/bastion\nsudo=no\ndocker=yes\nsocket=writable\n', []);
          throw new Error('unexpected script');
        }
        if (argv[0] !== 'env' || !argv[1]!.startsWith('BASTION_ACTOR=') || argv[2] !== `${fake.root}/bin/bastionctl` || argv.at(-1) !== '--json') {
          throw new Error(`unexpected command ${command}`);
        }
        const run: FakeRun = { argv: argv.slice(3, -1), stdin: opts.stdin };
        fake.runs.push(run);
        const scripted = await fake.bastionctl!(run.argv, run);
        for (const line of scripted.stderr ?? []) opts.onLine?.('stderr', line);
        await scripted.wait;
        return done(scripted.stdout === undefined ? '' : JSON.stringify(scripted.stdout) + '\n', [], 'exitCode' in scripted ? (scripted.exitCode ?? null) : 0);
      },
      async hashFile(path) {
        const data = fake.files.get(path);
        return data ? createHash('sha256').update(data).digest('hex') : null;
      },
      async readFile(path) {
        return fake.files.get(path) ?? null;
      },
      async writeFile(path, data, mode) {
        fake.files.set(path, Buffer.from(data));
        fake.modes.set(path, mode);
      },
      async upload(path, source) {
        const chunks: Buffer[] = [];
        for await (const c of source as AsyncIterable<Buffer>) chunks.push(c);
        fake.files.set(path, Buffer.concat(chunks));
        fake.uploads.set(path, Buffer.concat(chunks).length);
        return Buffer.concat(chunks).length;
      },
      async remove(path) {
        fake.files.delete(path);
      },
      release() {
        if (released) throw new Error('released twice');
        released = true;
        fake.released++;
      },
    };
  };
  return { ...actual, openRemote };
});

import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AccessLevel, ModulePermissions } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb, getRawDb } from '../../db/index.js';
import { auditLog, passkeys, resourceGrants, roleMembers, roles, sessions } from '../../db/schema.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import { setBastionctlBundleForTests, type BastionctlBundle } from '../../deploy/bundle.js';
import { activeDeployStreamCount } from '../../deploy/sse.js';
import { shellCommand } from '../../docker/shell.js';
import { seedOrg, seedServer, seedSession, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const SCRIPT = Buffer.from('// bastionctl.mjs as shipped\n');
const WRAPPER = Buffer.from('#!/bin/sh\n# bastionctl wrapper as shipped\n');
const BUNDLE: BastionctlBundle = { version: '9.9.9', script: SCRIPT, wrapper: WRAPPER, scriptSha256: sha(SCRIPT), wrapperSha256: sha(WRAPPER) };

const until = async (check: () => boolean, ms = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const OUTCOME = { app: 'site1', release: '20261005-120000-abcdef12', previous: null, result: 'success', error: null };

/** The default bastionctl: plausible answers for every command. */
function defaultBastionctl(args: string[]): Scripted {
  const [command, ...rest] = args;
  switch (command) {
    case 'setup':
      return { stdout: { root: '/opt/bastion', proxy: 'caddy', network: 'bastion-apps', proxyContainer: null, version: '9.9.9' } };
    case 'list':
      return { stdout: [{ name: 'site1', domains: ['site1.com'], buildType: 'nextjs', currentRelease: OUTCOME.release, container: null, configError: null, locked: false }] };
    case 'status':
      return rest[0] === 'site1' ? { stdout: { name: 'site1' } } : { stdout: { error: `No app named ${rest[0]} on this server`, code: 1 }, exitCode: 1 };
    case 'releases':
      return { stdout: [] };
    case 'validate':
      return { stdout: { ok: true, errors: [] } };
    case 'init':
      return { stdout: { app: rest[0], created: false } };
    case 'deploy':
    case 'rollback':
      return { stderr: ['Unpacking the upload', 'Health check passed'], stdout: OUTCOME };
    case 'restart':
    case 'stop':
      return { stdout: { app: rest[0], container: `bastion-${rest[0]}-${OUTCOME.release}` } };
    case 'delete':
      return { stdout: { app: rest[0], purged: rest.includes('--purge') } };
    case 'env':
      if (rest[0] === 'keys') return { stdout: { keys: ['DB_URL'] } };
      if (rest[0] === 'get') return { stdout: { key: rest[2], value: 'postgres://user:hunter2@db/app' } };
      return { stdout: { key: rest[2], changed: true } };
    default:
      return { stdout: { error: `Unknown command ${command}`, code: 2 }, exitCode: 2 };
  }
}

describe('deployment routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let orgId: string;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let serverA: string;
  let otherOrgServer: string;

  const call = (who: Pick<Who, 'headers'>, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, ...(payload && { payload }) });
  const api = (path = '', server = serverA) => `/api/deploy/servers/${server}${path}`;

  function audits(action: string) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .orderBy(desc(auditLog.createdAt))
      .all()
      .map((r) => ({ ...r, meta: JSON.parse(r.metadata ?? '{}') as Record<string, unknown> }));
  }

  /** A member holding only a custom role with these modules and an "all servers" grant at `server`. */
  function memberWith(modules: ModulePermissions, server: AccessLevel | null): Who {
    const who = seedUser(orgId, 'viewer');
    const roleId = nanoid();
    const db = getDb();
    db.insert(roles).values({ id: roleId, orgId, name: `deploy-${roleId}`, createdBy: admin.userId, modulePermissions: JSON.stringify(modules) }).run();
    if (server) {
      db.insert(resourceGrants)
        .values({ id: nanoid(), orgId, principalType: 'role', principalId: roleId, resourceType: 'server', selector: 'all', level: server, grantedBy: admin.userId })
        .run();
    }
    db.delete(roleMembers).where(and(eq(roleMembers.userId, who.userId), eq(roleMembers.orgId, orgId))).run();
    db.insert(roleMembers).values({ roleId, userId: who.userId, orgId }).run();
    return who;
  }

  function installed() {
    fake.files.set('/opt/bastion/bin/bastionctl.mjs', SCRIPT);
    fake.files.set('/opt/bastion/bin/bastionctl', WRAPPER);
  }

  function tarGz(): Buffer {
    // Content is the server's business; the app streams it through untouched
    return Buffer.from('\x1f\x8b fake tar.gz payload '.repeat(100));
  }

  async function postForm(who: Who, path: string, body: Buffer | null, field = 'source') {
    const abort = new AbortController();
    const form = new FormData();
    if (body) form.append(field, new Blob([body]), 'site.tar.gz');
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: who.headers, body: form, signal: abort.signal });
    return { res, abort };
  }

  function reader(res: Response) {
    const r = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return async (): Promise<Record<string, unknown> | null> => {
      for (;;) {
        const at = buffer.indexOf('\n\n');
        if (at !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith('data: ')) return JSON.parse(block.slice(6)) as Record<string, unknown>;
          continue;
        }
        const { done, value } = await r.read().catch(() => ({ done: true, value: undefined }));
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    };
  }

  async function allEvents(res: Response) {
    const next = reader(res);
    const events: Record<string, unknown>[] = [];
    for (let e = await next(); e; e = await next()) events.push(e);
    return events;
  }

  beforeAll(async () => {
    await runMigrations();
    setBastionctlBundleForTests(BUNDLE);
    orgId = seedOrg('org-deploy');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    serverA = seedServer(orgId, admin.userId, 'web-1');
    const otherOrg = seedOrg('org-deploy-other');
    otherOrgServer = seedServer(otherOrg, seedUser(otherOrg, 'admin').userId, 'elsewhere');
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
    fake.modes.clear();
    fake.root = '/opt/bastion';
    fake.runs.length = 0;
    fake.commands.length = 0;
    fake.uploads.clear();
    fake.bastionctl = defaultBastionctl;
    installed();
  });

  describe('permissions (module × server level)', () => {
    const routes = {
      list: { method: 'GET' as const, path: '/apps' },
      restart: { method: 'POST' as const, path: '/apps/site1/restart' },
      config: { method: 'PUT' as const, path: '/apps/site1/config', payload: { text: 'name: site1\n' } },
    };
    const expectations: Array<[string, ModulePermissions, AccessLevel | null, { list: number; restart: number; config: number }]> = [
      ['module off, server manage', { servers: 'manage' }, 'manage', { list: 404, restart: 404, config: 404 }],
      ['module view, server manage', { servers: 'manage', deployments: 'view' }, 'manage', { list: 200, restart: 403, config: 403 }],
      ['module operate, server view', { servers: 'view', deployments: 'operate' }, 'view', { list: 200, restart: 403, config: 403 }],
      ['module operate, server operate', { servers: 'operate', deployments: 'operate' }, 'operate', { list: 200, restart: 200, config: 403 }],
      ['module manage, server operate', { servers: 'operate', deployments: 'manage' }, 'operate', { list: 200, restart: 200, config: 403 }],
      ['module manage, server manage', { servers: 'manage', deployments: 'manage' }, 'manage', { list: 200, restart: 200, config: 200 }],
      // Nothing to deploy to: the module is hidden (no server in sight)
      ['module manage, no server', { servers: 'manage', deployments: 'manage' }, null, { list: 404, restart: 404, config: 404 }],
    ];

    it.each(expectations)('%s', async (_name, modules, level, expected) => {
      const who = memberWith(modules, level);
      for (const [key, route] of Object.entries(routes) as [keyof typeof routes, (typeof routes)[keyof typeof routes]][]) {
        const res = await call(who, route.method, api(route.path), 'payload' in route ? route.payload : undefined);
        expect(res.statusCode, `${key}: ${res.body}`).toBe(expected[key]);
      }
    });

    it('gives the built-in roles their defaults: Viewer view, Operator operate, Admin manage', async () => {
      expect((await call(viewer, 'GET', api('/apps'))).statusCode).toBe(200);
      expect((await call(viewer, 'POST', api('/apps/site1/restart'))).statusCode).toBe(403);
      expect((await call(operator, 'POST', api('/apps/site1/restart'))).statusCode).toBe(200);
      expect((await call(operator, 'PUT', api('/apps/site1/config'), { text: 'x' })).statusCode).toBe(403);
      expect((await call(operator, 'POST', api('/setup'))).statusCode).toBe(403);
      expect((await call(admin, 'PUT', api('/apps/site1/config'), { text: 'x' })).statusCode).toBe(200);
      expect((await call(viewer, 'GET', '/api/deploy/bastionctl')).json()).toEqual({ version: '9.9.9', sha256: sha(SCRIPT) });
    });

    it('answers 404 for a server in another org, before anything reaches a server', async () => {
      const opened = fake.opened;
      expect((await call(admin, 'GET', api('/apps', otherOrgServer))).statusCode).toBe(404);
      expect((await call(admin, 'POST', api('/setup', otherOrgServer))).statusCode).toBe(404);
      expect(fake.opened).toBe(opened);
    });

    it('refuses hostile names before any command runs', async () => {
      for (const path of ['/apps/Site1', "/apps/a';reboot'", '/apps/-rf/restart', `/apps/${'a'.repeat(42)}`]) {
        expect((await call(admin, 'GET', api(path))).statusCode, path).toBeGreaterThanOrEqual(400);
      }
      expect((await call(admin, 'PUT', api('/apps/site1/env/BAD-KEY'), { value: 'x' })).statusCode).toBe(400);
      expect((await call(admin, 'POST', api('/apps/site1/rollback'), { release: '--purge' })).statusCode).toBe(400);
      expect(fake.runs).toEqual([]);
    });
  });

  describe('install and integrity', () => {
    it('refuses to run a bastionctl that is not the shipped one, and says how to fix it', async () => {
      fake.files.set('/opt/bastion/bin/bastionctl.mjs', Buffer.from('// tampered'));
      const res = await call(admin, 'GET', api('/apps'));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'bastionctl_mismatch', error: expect.stringMatching(/Reinstall/) });
      fake.files.set('/opt/bastion/bin/bastionctl.mjs', SCRIPT);
      fake.files.set('/opt/bastion/bin/bastionctl', Buffer.from('#!/bin/sh\nexec evil\n'));
      expect((await call(admin, 'POST', api('/apps/site1/restart'))).json().code).toBe('bastionctl_mismatch');
      expect(fake.runs).toEqual([]);
      expect((await call(admin, 'GET', api())).json()).toEqual({ root: '/opt/bastion', integrity: 'mismatch', version: '9.9.9' });
    });

    it('reports a server that is not set up', async () => {
      fake.root = null;
      const res = await call(viewer, 'GET', api('/apps'));
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('not_set_up');
      expect((await call(viewer, 'GET', api())).json()).toEqual({ root: null, integrity: 'missing', version: '9.9.9' });
    });

    it('sets up: installs both files 0755, verifies them, runs setup, audits', async () => {
      fake.files.clear();
      fake.root = '/opt/bastion';
      const res = await call(admin, 'POST', api('/setup'));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ root: '/opt/bastion', proxy: 'caddy', sudo: false, socket: 'writable' });
      expect(fake.files.get('/opt/bastion/bin/bastionctl.mjs')).toEqual(SCRIPT);
      expect(fake.files.get('/opt/bastion/bin/bastionctl')).toEqual(WRAPPER);
      expect(fake.modes.get('/opt/bastion/bin/bastionctl')).toBe(0o755);
      expect(fake.runs.map((r) => r.argv)).toEqual([['setup']]);
      expect(audits('deploy.setup')[0]!.meta).toMatchObject({ root: '/opt/bastion', version: '9.9.9', result: 'success' });
      // A reinstall over a modified copy works the same
      fake.files.set('/opt/bastion/bin/bastionctl.mjs', Buffer.from('// tampered'));
      expect((await call(admin, 'POST', api('/setup'))).statusCode).toBe(200);
      expect(fake.files.get('/opt/bastion/bin/bastionctl.mjs')).toEqual(SCRIPT);
    });

    it('answers 503 when this build has no bastionctl', async () => {
      setBastionctlBundleForTests(null);
      try {
        expect((await call(admin, 'GET', api('/apps'))).json()).toMatchObject({ code: 'bastionctl_missing_bundle' });
        expect((await call(admin, 'GET', api('/apps'))).statusCode).toBe(503);
      } finally {
        setBastionctlBundleForTests(BUNDLE);
      }
    });
  });

  describe('commands', () => {
    it('passes every argument as its own quoted word, with the caller as actor', async () => {
      await call(operator, 'POST', api('/apps/site1/rollback'), { release: '20261005-120000-abcdef12' });
      await call(admin, 'DELETE', api('/apps/site1?purge=true'));
      for (const command of fake.commands) expect(shellCommand(parseQuoted(command))).toBe(command);
      expect(fake.runs.map((r) => r.argv)).toEqual([
        ['rollback', 'site1', '20261005-120000-abcdef12'],
        ['delete', 'site1', '--purge'],
      ]);
      const deleteCommand = parseQuoted(fake.commands.at(-1)!);
      expect(deleteCommand[1]).toMatch(/^BASTION_ACTOR=.+@test\.local$/);
    });

    it('maps bastionctl errors to statuses', async () => {
      expect((await call(viewer, 'GET', api('/apps/nope'))).statusCode).toBe(404);
      fake.bastionctl = () => ({ stdout: { error: 'The deploy of site1 is locked by ann since …', code: 4 }, exitCode: 4 });
      const locked = await call(operator, 'POST', api('/apps/site1/restart'));
      expect(locked.statusCode).toBe(409);
      expect(locked.json().code).toBe('locked');
      fake.bastionctl = () => ({ stderr: ['docker: permission denied'], exitCode: 126 });
      const broken = await call(viewer, 'GET', api('/apps'));
      expect(broken.statusCode).toBe(502);
    });

    it('validates a config before writing it, and cleans up its temp file', async () => {
      fake.bastionctl = (args) =>
        args[0] === 'validate'
          ? { stdout: { ok: false, errors: [{ path: 'run.port', message: 'A port from 1 to 65535' }] }, exitCode: 3 }
          : defaultBastionctl(args);
      const bad = await call(admin, 'PUT', api('/apps/site1/config'), { text: 'name: site1\nrun: { port: 0 }\n' });
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toEqual({ error: 'The config is not valid', code: 'invalid_config', errors: [{ path: 'run.port', message: 'A port from 1 to 65535' }] });
      expect(fake.runs.map((r) => r.argv[0])).toEqual(['validate']);

      fake.bastionctl = defaultBastionctl;
      fake.runs.length = 0;
      const ok = await call(admin, 'PUT', api('/apps/site1/config'), { text: 'name: site1\n' });
      expect(ok.statusCode).toBe(200);
      const [validate, init] = fake.runs.map((r) => r.argv);
      expect(validate!.slice(0, 3)).toEqual(['validate', 'site1', '--file']);
      expect(validate![3]).toMatch(/^\/opt\/bastion\/tmp\/config-[0-9a-f]{24}\.yml$/);
      expect(init).toEqual(['init', 'site1', '--config', validate![3], '--force']);
      expect([...fake.files.keys()].filter((k) => k.includes('/tmp/'))).toEqual([]);
      expect(audits('deploy.config_update')[0]!.meta).toEqual({ app: 'site1', created: false });

      fake.files.set('/opt/bastion/apps/site1/bastion.yml', Buffer.from('name: site1\n'));
      expect((await call(viewer, 'GET', api('/apps/site1/config'))).json()).toEqual({ text: 'name: site1\n' });
      expect((await call(viewer, 'GET', api('/apps/other/config'))).statusCode).toBe(404);
    });
  });

  describe('.env', () => {
    it('sends values on stdin only, and audits names only', async () => {
      const secret = "p@ss w0rd'; rm -rf / #";
      const res = await call(admin, 'PUT', api('/apps/site1/env/DB_PASSWORD'), { value: secret });
      expect(res.statusCode).toBe(200);
      expect(fake.runs.at(-1)).toEqual({ argv: ['env', 'set', 'site1', 'DB_PASSWORD'], stdin: secret });
      expect(fake.commands.join('\n')).not.toContain('w0rd');
      const [row] = audits('deploy.env_set');
      expect(row!.meta).toEqual({ app: 'site1', key: 'DB_PASSWORD', changed: true });
      expect(JSON.stringify(row)).not.toContain('w0rd');
      expect((await call(admin, 'GET', api('/apps/site1/env'))).json()).toEqual({ keys: ['DB_URL'] });
      expect((await call(operator, 'GET', api('/apps/site1/env'))).statusCode).toBe(403);
      expect((await call(admin, 'DELETE', api('/apps/site1/env/DB_PASSWORD'))).statusCode).toBe(200);
    });

    it('reveals a value only from a browser session after a passkey step-up', async () => {
      expect((await call(admin, 'POST', api('/apps/site1/env/DB_URL/reveal'))).statusCode).toBe(403);
      const session = await seedSession(admin.userId);
      expect((await call(session, 'POST', api('/apps/site1/env/DB_URL/reveal'))).json().code).toBe('DEPLOY_REVEAL_NEEDS_PASSKEY');
      getDb()
        .insert(passkeys)
        .values({ id: nanoid(), userId: admin.userId, credentialId: nanoid(), publicKey: Buffer.from([1]), deviceType: 'multiDevice', name: 'Laptop' })
        .run();
      expect((await call(session, 'POST', api('/apps/site1/env/DB_URL/reveal'))).json().code).toBe('PASSKEY_STEP_UP_REQUIRED');
      expect(fake.runs).toEqual([]);
      getDb().update(sessions).set({ passkeyVerified: true }).where(eq(sessions.id, session.sessionId)).run();
      const res = await call(session, 'POST', api('/apps/site1/env/DB_URL/reveal'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ key: 'DB_URL', value: 'postgres://user:hunter2@db/app' });
      const [row] = audits('deploy.env_reveal');
      expect(row!.meta).toEqual({ app: 'site1', key: 'DB_URL' });
      expect(row!.metadata).not.toContain('hunter2');
    });
  });

  describe('deploy and rollback streams', () => {
    it('streams the upload to <root>/tmp, then the log, result and exit; audits start and finish', async () => {
      const payload = tarGz();
      let seenUpload: Buffer | undefined;
      fake.bastionctl = (args) => {
        if (args[0] === 'deploy') seenUpload = fake.files.get(args[3]!);
        return defaultBastionctl(args);
      };
      const { res } = await postForm(operator, api('/apps/site1/deploy'), payload);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const events = await allEvents(res);
      expect(events).toEqual([
        { type: 'log', lines: [{ stream: 'stderr', text: 'Unpacking the upload' }, { stream: 'stderr', text: 'Health check passed' }] },
        { type: 'result', outcome: OUTCOME },
        { type: 'exit', exitCode: 0, signal: null, durationMs: expect.any(Number), timedOut: false },
        { type: 'end' },
      ]);
      const [deploy] = fake.runs;
      expect(deploy!.argv.slice(0, 3)).toEqual(['deploy', 'site1', '--source']);
      expect(deploy!.argv[3]).toMatch(/^\/opt\/bastion\/tmp\/upload-[0-9a-f]{24}\.tar\.gz$/);
      expect(seenUpload).toEqual(payload);
      // Left over only if the deploy did not move it: removed either way
      expect(fake.files.has(deploy!.argv[3]!)).toBe(false);
      expect(audits('deploy.start')[0]!.meta).toEqual({ app: 'site1', bytes: payload.length });
      expect(audits('deploy.finish')[0]!.meta).toEqual({
        app: 'site1',
        release: OUTCOME.release,
        result: 'success',
        error: null,
        exitCode: 0,
        durationMs: expect.any(Number),
      });
      expect(fake.released).toBe(fake.opened);
    });

    it('audits a failed deploy with the first line of its error, never the app log after it', async () => {
      const failed = { ...OUTCOME, result: 'failed', error: 'Health check failed after 30s: no answer\nContainer log:\nDATABASE_URL=postgres://app:hunter2@db/app' };
      fake.bastionctl = (args) => (args[0] === 'deploy' ? { ...defaultBastionctl(args), stdout: failed, exitCode: 1 } : defaultBastionctl(args));
      const { res } = await postForm(operator, api('/apps/site1/deploy'), tarGz());
      const events = await allEvents(res);
      // The person deploying sees all of it in the log
      expect(events).toContainEqual({ type: 'result', outcome: failed });
      const meta = audits('deploy.finish')[0]!.meta;
      expect(meta).toMatchObject({ result: 'failed', error: 'Health check failed after 30s: no answer' });
      expect(JSON.stringify(meta)).not.toContain('hunter2');
    });

    it('answers problems before the upload as JSON', async () => {
      const noFile = await postForm(operator, api('/apps/site1/deploy'), null);
      expect(noFile.res.status).toBe(400);
      const wrongField = await postForm(operator, api('/apps/site1/deploy'), tarGz(), 'file');
      expect(wrongField.res.status).toBe(400);
      const json = await call(operator, 'POST', api('/apps/site1/deploy'), { source: 'x' });
      expect(json.statusCode).toBe(400);
      fake.root = null;
      const notSetUp = await postForm(operator, api('/apps/site1/deploy'), tarGz());
      expect(notSetUp.res.status).toBe(409);
      expect(((await notSetUp.res.json()) as { code: string }).code).toBe('not_set_up');
      expect(fake.runs).toEqual([]);
    });

    it('keeps the deploy running when the browser leaves, and audits it as detached', async () => {
      const hold = deferred();
      fake.bastionctl = (args) => (args[0] === 'deploy' ? { ...defaultBastionctl(args), wait: hold.promise } : defaultBastionctl(args));
      const finished = audits('deploy.finish').length;
      const { res, abort } = await postForm(operator, api('/apps/site1/deploy'), tarGz());
      const next = reader(res);
      expect(await next()).toMatchObject({ type: 'log' });
      expect(activeDeployStreamCount(operator.userId)).toBe(1);

      abort.abort();
      await until(() => activeDeployStreamCount(operator.userId) === 0);
      // The command is still running on the server, the connection still leased
      expect(audits('deploy.finish')).toHaveLength(finished);
      expect(fake.released).toBeLessThan(fake.opened);

      hold.resolve();
      await until(() => audits('deploy.finish').length === finished + 1);
      expect(audits('deploy.finish')[0]!.meta).toMatchObject({ result: 'success', detached: true });
      await until(() => fake.released === fake.opened);
    });

    it('ends a deploy log stream when the member loses access to the server', async () => {
      const hold = deferred();
      fake.bastionctl = (args) => (args[0] === 'rollback' ? { ...defaultBastionctl(args), wait: hold.promise } : defaultBastionctl(args));
      const res = await fetch(`${base}${api('/apps/site1/rollback')}`, {
        method: 'POST',
        headers: { ...operator.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ release: OUTCOME.release }),
      });
      const next = reader(res);
      expect(await next()).toMatchObject({ type: 'log' });
      expect(activeDeployStreamCount(operator.userId)).toBe(1);

      revokeLiveAccess(operator.userId, { orgId });
      expect(await next()).toEqual({ type: 'error', error: 'Your access has changed. This stream was stopped.', status: 403 });
      expect(await next()).toBeNull();
      expect(activeDeployStreamCount(operator.userId)).toBe(0);
      hold.resolve();
      await until(() => audits('deploy.rollback').some((r) => r.meta.detached === true));
    });

    it('reports a command cut off without a result as an error event', async () => {
      fake.bastionctl = (args) => (args[0] === 'rollback' ? { stderr: ['Starting'], exitCode: null } : defaultBastionctl(args));
      const res = await fetch(`${base}${api('/apps/site1/rollback')}`, {
        method: 'POST',
        headers: { ...admin.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ release: OUTCOME.release }),
      });
      const events = await allEvents(res);
      expect(events.map((e) => e.type)).toEqual(['log', 'error', 'exit', 'end']);
      expect(events[1]).toMatchObject({ error: expect.stringMatching(/without a result/) });
      expect(audits('deploy.rollback').some((r) => r.meta.result === 'failed' && r.meta.exitCode === null)).toBe(true);
    });
  });

  describe('no deployment data in the database', () => {
    it('writes nothing but audit rows for a whole round of operations', async () => {
      const raw = getRawDb();
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
      const counts = () => Object.fromEntries(tables.map((t) => [t, (raw.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n]));
      const before = counts();

      await call(admin, 'POST', api('/setup'));
      installed();
      await call(admin, 'PUT', api('/apps/site1/config'), { text: 'name: site1\n' });
      await call(admin, 'PUT', api('/apps/site1/env/API_KEY'), { value: 'secret-value' });
      const { res } = await postForm(admin, api('/apps/site1/deploy'), tarGz());
      await allEvents(res);
      await call(admin, 'GET', api('/apps'));
      await call(admin, 'GET', api('/apps/site1/releases'));
      await call(admin, 'POST', api('/apps/site1/restart'));
      await call(admin, 'DELETE', api('/apps/site1'));

      const after = counts();
      const changed = tables.filter((t) => after[t] !== before[t]);
      expect(changed).toEqual(['audit_log']);
      const dump = JSON.stringify(raw.prepare('SELECT * FROM audit_log').all());
      expect(dump).not.toContain('secret-value');
    });
  });
});
