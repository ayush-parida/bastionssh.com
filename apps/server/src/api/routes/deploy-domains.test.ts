import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Domains, TLS and nginx mode through the API, with the server replaced at
 * deploy/remote.ts (as in deploy.test.ts) and DNS and sockets at the domain
 * checks' seam: setup picking nginx mode when the host's nginx owns the
 * ports (and uploading the helper), the helper run with sudo after a
 * deploy, a config change and a delete — its lines in the deploy log, its
 * failures reported but not failing what came before — the domains report
 * in both modes, renewal alerts through the notification channels on a
 * change only, and the permission levels of each route.
 */

interface Scripted {
  stdout?: unknown;
  stderr?: string[];
  exitCode?: number | null;
}

const fake = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  modes: new Map<string, number>(),
  /** Every command line, parsed back into argv. */
  commands: [] as string[][],
  /** `bastionctl <args>` answers. */
  bastionctl: null as null | ((args: string[]) => Scripted),
  /** `sudo -n bastion-nginx <args>` answers: key=value text. */
  helper: null as null | ((args: string[]) => { stdout: string; stderr?: string[]; exitCode?: number }),
  detect: '',
  alerts: [] as Array<Record<string, unknown>>,
}));

/** Split a command line of single-quoted words (shellCommand's output) back into argv. */
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

vi.mock('../../notifications/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../notifications/index.js')>();
  return { ...actual, notifyAlertsChanged: (events: Array<Record<string, unknown>>) => fake.alerts.push(...events) };
});

vi.mock('../../deploy/remote.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../deploy/remote.js')>();
  const { createHash } = await import('node:crypto');
  const { DISCOVER_SCRIPT, PREPARE_SCRIPT } = await import('../../deploy/install.js');
  const { DETECT_SCRIPT, NGINX_HELPER_PATH } = await import('../../deploy/nginx.js');
  const { PUBLIC_IP_SCRIPT } = await import('../../deploy/domains.js');
  const openRemote = async (_req: unknown, server: import('../../deploy/remote.js').ServerRow): Promise<import('../../deploy/remote.js').Remote> => ({
    server,
    async run(command, opts = {}) {
      const argv = parseQuoted(command);
      fake.commands.push(argv);
      const done = (stdout: string, stderr: string[] = [], exitCode: number | null = 0) => {
        for (const line of stderr) opts.onLine?.('stderr', line);
        return { exitCode, signal: null, timedOut: false, stdout, stderr: stderr.join('\n'), durationMs: 1 };
      };
      if (argv[0] === 'sh' && argv[1] === '-c') {
        if (argv[2] === DISCOVER_SCRIPT) return done('root=/opt/bastion\n');
        if (argv[2] === PREPARE_SCRIPT) return done('root=/opt/bastion\nsudo=no\ndocker=yes\nsocket=writable\n');
        if (argv[2] === DETECT_SCRIPT) return done(fake.detect);
        if (argv[2] === PUBLIC_IP_SCRIPT) return done('ip=203.0.113.10\n');
        throw new Error('unexpected script');
      }
      if (argv[0] === 'sudo') {
        if (argv[1] !== '-n' || argv[2] !== NGINX_HELPER_PATH) throw new Error(`unexpected sudo ${command}`);
        const r = fake.helper!(argv.slice(3));
        return done(r.stdout, r.stderr, r.exitCode ?? 0);
      }
      if (argv[0] !== 'env' || argv[2] !== '/opt/bastion/bin/bastionctl' || argv.at(-1) !== '--json') throw new Error(`unexpected command ${command}`);
      const s = fake.bastionctl!(argv.slice(3, -1));
      return done(s.stdout === undefined ? '' : JSON.stringify(s.stdout) + '\n', s.stderr, s.exitCode === undefined ? 0 : s.exitCode);
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
      return Buffer.concat(chunks).length;
    },
    async remove(path) {
      fake.files.delete(path);
    },
    async download() {
      return null;
    },
    release() {},
  });
  return { ...actual, openRemote };
});

import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { DeployDomainsReport } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog } from '../../db/schema.js';
import { setBastionctlBundleForTests, type BastionctlBundle } from '../../deploy/bundle.js';
import { resetCertificateAlertsForTests } from '../../deploy/cert-alerts.js';
import { fakeConnect, fakeDeps } from '../../diagnostics/fakes.test-helper.js';
import { setDomainDepsForTests } from './deploy-domains.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const SCRIPT = Buffer.from('// bastionctl.mjs as shipped\n');
const WRAPPER = Buffer.from('#!/bin/sh\n# bastionctl wrapper as shipped\n');
const HELPER = Buffer.from('#!/bin/sh\n# bastion-nginx as shipped\n');
const BUNDLE: BastionctlBundle = {
  version: '9.9.9',
  script: SCRIPT,
  wrapper: WRAPPER,
  scriptSha256: sha(SCRIPT),
  wrapperSha256: sha(WRAPPER),
  nginxHelper: HELPER,
  nginxHelperSha256: sha(HELPER),
};
const HELPER_PATH = '/usr/local/sbin/bastion-nginx';
const OUTCOME = { app: 'site1', release: '20261005-120000-abcdef12', previous: null, result: 'success', error: null };
const NGINX_HOST = 'installed=yes\nrunning=yes\nhttp=yes\nhttps=yes\ncertbot=yes\ninclude=yes\nsudo=yes\n';
const CONFIG = {
  name: 'site1',
  domains: ['site1.com', 'www.site1.com'],
  redirect_www: 'apex',
  tls: 'auto',
  build: { type: 'dockerfile', node: null, dir: '.', output: null },
  run: { port: 3000, env_file: '.env', volumes: [], memory: null, cpus: null },
  healthcheck: { path: '/', timeout: '30s' },
  keep_releases: 5,
  proxy: 'caddy',
};

function defaultBastionctl(args: string[]): Scripted {
  const [command, ...rest] = args;
  switch (command) {
    case 'setup':
      return { stdout: { root: '/opt/bastion', proxy: rest[1], network: 'bastion-apps', proxyContainer: null, version: '9.9.9' } };
    case 'status':
      // bastionctl reads the mode itself: a broken SFTP channel (below) does not reach it
      return { stdout: { name: rest[0], config: { ...CONFIG, proxy: (Map.prototype.get.call(fake.files, '/opt/bastion/proxy/mode') as Buffer | undefined)?.toString().trim() ?? 'caddy' }, configError: null } };
    case 'certs':
      return {
        stdout: [
          { domain: 'site1.com', source: 'acme', issuer: "Let's Encrypt R11", notBefore: '2026-10-01T00:00:00.000Z', notAfter: '2026-12-30T00:00:00.000Z', lastError: null },
          { domain: 'www.site1.com', source: 'acme', issuer: null, notBefore: null, notAfter: null, lastError: { at: '2026-10-05T10:00:00.000Z', message: 'NXDOMAIN looking up A for www.site1.com' } },
        ],
      };
    case 'validate':
      return { stdout: { ok: true, errors: [] } };
    case 'init':
      return { stdout: { app: rest[0], created: false } };
    case 'deploy':
      return { stderr: ['Health check passed', 'nginx: the server block of site1 changed'], stdout: OUTCOME };
    case 'delete':
      return { stdout: { app: rest[0], purged: false } };
    default:
      return { stdout: { error: `Unknown command ${command}`, code: 2 }, exitCode: 2 };
  }
}

function defaultHelper(args: string[]) {
  if (args[0] === 'apply') return { stdout: 'result=applied\ncertificate=issued\n', stderr: ['nginx: reloaded with the new server block of site1', 'certbot: bastion-site1 for site1.com www.site1.com'] };
  if (args[0] === 'remove') return { stdout: 'result=removed\ncertificate=skipped\n' };
  if (args[0] === 'status') return { stdout: 'cert=bastion-site1\nissuer=C = US, O = Let\'s Encrypt, CN = R11\nnotBefore=Oct  1 00:00:00 2026 GMT\nnotAfter=Dec 30 00:00:00 2026 GMT\nstatus=ok\n' };
  return { stdout: 'error=usage\n', exitCode: 1 };
}

describe('deployment domains, TLS and nginx mode', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let orgId: string;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let serverA: string;

  const call = (who: Pick<Who, 'headers'>, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, ...(payload && { payload }) });
  const api = (path = '') => `/api/deploy/servers/${serverA}${path}`;
  const helperRuns = () => fake.commands.filter((c) => c[0] === 'sudo').map((c) => c.slice(3));
  const bastionctlRuns = () => fake.commands.filter((c) => c[0] === 'env').map((c) => c.slice(3, -1));

  function audits(action: string) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .orderBy(desc(auditLog.createdAt))
      .all()
      .map((r) => JSON.parse(r.metadata ?? '{}') as Record<string, unknown>);
  }

  function nginxMode() {
    fake.files.set('/opt/bastion/proxy/mode', Buffer.from('nginx\n'));
    fake.files.set('/opt/bastion/proxy/nginx/site1.site', Buffer.from('app=site1\n'));
    fake.files.set(HELPER_PATH, HELPER);
  }

  async function deployEvents() {
    const form = new FormData();
    form.append('source', new Blob([Buffer.from('\x1f\x8b fake')]), 'site.tar.gz');
    const res = await fetch(`${base}${api('/apps/site1/deploy')}`, { method: 'POST', headers: admin.headers, body: form });
    const text = await res.text();
    return text
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
  }

  beforeAll(async () => {
    await runMigrations();
    setBastionctlBundleForTests(BUNDLE);
    orgId = seedOrg('org-deploy-domains');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    serverA = seedServer(orgId, admin.userId, 'web-1');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await app.close();
    setBastionctlBundleForTests(undefined);
    setDomainDepsForTests(undefined);
  });

  beforeEach(() => {
    fake.files.clear();
    fake.modes.clear();
    fake.commands.length = 0;
    fake.alerts.length = 0;
    fake.bastionctl = defaultBastionctl;
    fake.helper = defaultHelper;
    fake.detect = 'installed=no\nrunning=no\nhttp=no\nhttps=no\ncertbot=no\ninclude=no\nsudo=no\n';
    fake.files.set('/opt/bastion/bin/bastionctl.mjs', SCRIPT);
    fake.files.set('/opt/bastion/bin/bastionctl', WRAPPER);
    resetCertificateAlertsForTests();
    setDomainDepsForTests({
      resolve: async (name, type) => {
        if (type === 'A' && name === 'site1.com') return ['203.0.113.10'];
        throw Object.assign(new Error('no data'), { code: 'ENODATA' });
      },
      diagnostics: fakeDeps({ connect: fakeConnect({ kind: 'connect' }).connect }),
    });
  });

  describe('setup', () => {
    it("picks nginx mode when the host's nginx owns the ports, and uploads the helper for the administrator", async () => {
      fake.detect = NGINX_HOST;
      const res = await call(admin, 'POST', api('/setup'));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ proxy: 'nginx' });
      expect(bastionctlRuns()).toEqual([['setup', '--proxy', 'nginx']]);
      expect(fake.files.get('/opt/bastion/bin/bastion-nginx')).toEqual(HELPER);
      expect(fake.modes.get('/opt/bastion/bin/bastion-nginx')).toBe(0o755);
      expect(audits('deploy.setup')[0]).toMatchObject({ proxy: 'nginx', result: 'success' });
    });

    it('keeps the mode a server was set up with, and takes an explicit choice', async () => {
      fake.detect = NGINX_HOST;
      fake.files.set('/opt/bastion/proxy/mode', Buffer.from('caddy\n'));
      expect((await call(admin, 'POST', api('/setup'))).json()).toMatchObject({ proxy: 'caddy' });
      expect(fake.commands.some((c) => c[2]?.includes('pgrep'))).toBe(false);
      expect((await call(admin, 'POST', api('/setup'), { proxy: 'nginx' })).json()).toMatchObject({ proxy: 'nginx' });
      expect((await call(admin, 'POST', api('/setup'), { proxy: 'apache' })).statusCode).toBe(400);
    });

    it('keeps Caddy on a server set up before modes existed, whose bastion-caddy owns the ports', async () => {
      // nginx runs elsewhere on the host; 80/443 answer because Caddy holds them
      fake.detect = NGINX_HOST;
      fake.files.set('/opt/bastion/proxy/Caddyfile', Buffer.from('# Generated by bastionctl\n'));
      expect((await call(admin, 'POST', api('/setup'))).json()).toMatchObject({ proxy: 'caddy' });
      expect(bastionctlRuns()).toEqual([['setup', '--proxy', 'caddy']]);
      expect(fake.files.has('/opt/bastion/bin/bastion-nginx')).toBe(false);
      expect((await call(viewer, 'GET', api('/proxy'))).json()).toMatchObject({ mode: 'caddy', instructions: [] });
    });
  });

  describe('GET /proxy', () => {
    it('shows viewers the mode, the host nginx and the commands nginx mode still needs', async () => {
      fake.detect = NGINX_HOST.replace('sudo=yes', 'sudo=no');
      const res = await call(viewer, 'GET', api('/proxy'));
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ mode: null, helperPath: HELPER_PATH, nginx: { detected: true, helper: 'missing', sudo: false } });
      expect(body.instructions).toEqual([
        "'sudo' 'install' '-o' 'root' '-g' 'root' '-m' '0755' '/opt/bastion/bin/bastion-nginx' '/usr/local/sbin/bastion-nginx'",
        "echo 'root ALL=(root) NOPASSWD: /usr/local/sbin/bastion-nginx' | sudo tee /etc/sudoers.d/bastion-nginx && sudo chmod 0440 /etc/sudoers.d/bastion-nginx",
      ]);
    });
  });

  describe('the helper after changes (nginx mode)', () => {
    it('applies the server block after a deploy, in the deploy log before the result, and audits it', async () => {
      nginxMode();
      const events = await deployEvents();
      const log = events.filter((e) => e.type === 'log').flatMap((e) => (e.lines as Array<{ text: string }>).map((l) => l.text));
      expect(log).toEqual(['Health check passed', 'nginx: the server block of site1 changed', 'nginx: reloaded with the new server block of site1', 'certbot: bastion-site1 for site1.com www.site1.com']);
      expect(events.map((e) => e.type)).toEqual(['log', 'log', 'log', 'result', 'exit', 'end']);
      expect(helperRuns()).toEqual([['apply', '/opt/bastion', 'site1']]);
      expect(audits('deploy.proxy_sync')[0]).toEqual({ app: 'site1', action: 'apply', result: 'applied', certificate: 'issued', error: null });
    });

    it('reports a missing helper without failing the deploy', async () => {
      nginxMode();
      fake.files.delete(HELPER_PATH);
      const events = await deployEvents();
      expect(events.find((e) => e.type === 'result')).toMatchObject({ outcome: { result: 'success' } });
      expect(JSON.stringify(events)).toContain('nginx: The nginx helper is not installed at /usr/local/sbin/bastion-nginx');
      expect(helperRuns()).toEqual([]);
      expect(audits('deploy.proxy_sync')[0]).toMatchObject({ result: 'failed', certificate: 'skipped' });
    });

    it('applies after a config change, removes on delete, and does nothing in Caddy mode', async () => {
      nginxMode();
      const put = await call(admin, 'PUT', api('/apps/site1/config'), { text: 'name: site1\n' });
      expect(put.json()).toMatchObject({ app: 'site1', proxy: { result: 'applied', certificate: 'issued' } });
      const del = await call(admin, 'DELETE', api('/apps/site1'));
      expect(del.json()).toMatchObject({ proxy: { result: 'removed' } });
      expect(helperRuns()).toEqual([
        ['apply', '/opt/bastion', 'site1'],
        ['remove', 'site1'],
      ]);

      fake.commands.length = 0;
      fake.files.set('/opt/bastion/proxy/mode', Buffer.from('caddy\n'));
      await deployEvents();
      await call(admin, 'PUT', api('/apps/site1/config'), { text: 'name: site1\n' });
      await call(admin, 'DELETE', api('/apps/site1'));
      expect(helperRuns()).toEqual([]);
    });

    it('keeps the result and the finish audit when the server cannot be read after a deploy, a config change or a delete', async () => {
      nginxMode();
      const realFiles = fake.files;
      const failing = new Map(realFiles);
      // SFTP gone once the bastionctl command finished
      const broken = Object.assign(failing, {
        get(path: string) {
          if (path.startsWith('/opt/bastion/proxy/')) throw new Error('SFTP channel closed');
          return Map.prototype.get.call(failing, path) as Buffer | undefined;
        },
      });
      fake.files = broken;
      try {
        const events = await deployEvents();
        expect(events.find((e) => e.type === 'result')).toMatchObject({ outcome: { result: 'success' } });
        expect(JSON.stringify(events)).toContain('nginx: SFTP channel closed');
        expect(audits('deploy.finish')[0]).toMatchObject({ result: 'success' });
        const put = await call(admin, 'PUT', api('/apps/site1/config'), { text: 'name: site1\n' });
        expect(put.statusCode, put.body).toBe(200);
        expect(put.json()).toMatchObject({ app: 'site1', proxy: { result: 'failed', error: 'SFTP channel closed' } });
        const del = await call(admin, 'DELETE', api('/apps/site1'));
        expect(del.statusCode, del.body).toBe(200);
        expect(audits('deploy.proxy_sync')[0]).toMatchObject({ action: 'remove', result: 'failed', error: 'SFTP channel closed' });
      } finally {
        fake.files = realFiles;
      }
    });

    it('skips apply for an app never deployed (no site file yet)', async () => {
      nginxMode();
      fake.files.delete('/opt/bastion/proxy/nginx/site1.site');
      expect((await call(admin, 'PUT', api('/apps/site1/config'), { text: 'name: site1\n' })).json()).toEqual({ app: 'site1', created: false });
      expect(helperRuns()).toEqual([]);
    });

    it('POST /apps/:app/proxy runs it again for operators, nginx mode only', async () => {
      expect((await call(operator, 'POST', api('/apps/site1/proxy'))).statusCode).toBe(409);
      nginxMode();
      expect((await call(viewer, 'POST', api('/apps/site1/proxy'))).statusCode).toBe(403);
      const res = await call(operator, 'POST', api('/apps/site1/proxy'));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ result: 'applied', certificate: 'issued' });
    });
  });

  describe('GET /apps/:app/domains', () => {
    it('checks DNS against the server, the ports, and certificates read from Caddy — and alerts once', async () => {
      const res = await call(viewer, 'GET', api('/apps/site1/domains'));
      expect(res.statusCode, res.body).toBe(200);
      const report = res.json() as DeployDomainsReport;
      // The server is 10.0.0.1 in BastionSSH: its public address comes from the server itself
      expect(report).toMatchObject({ app: 'site1', proxy: 'caddy', serverAddresses: ['203.0.113.10'], addressSource: 'server', certificatesError: null });
      expect(report.domains[0]).toMatchObject({ domain: 'site1.com', dns: { status: 'ok' }, certificate: { issuer: "Let's Encrypt R11", state: expect.stringMatching(/valid|failing|expired/) } });
      expect(report.domains[1]).toMatchObject({
        domain: 'www.site1.com',
        dns: { status: 'missing', records: [{ type: 'A', name: 'www.site1.com', value: '203.0.113.10' }] },
        certificate: { state: 'failing', lastError: { message: 'NXDOMAIN looking up A for www.site1.com' } },
      });
      expect(report.ports.map((p) => [p.port, p.status])).toEqual([
        [80, 'open'],
        [443, 'open'],
      ]);
      expect(bastionctlRuns()).toEqual([['status', 'site1'], ['certs', 'site1']]);

      const opened = fake.alerts.filter((a) => a.container === 'site1/www.site1.com');
      expect(opened).toMatchObject([{ kind: 'opened', type: 'deploy_certificate', serverId: serverA, orgId }]);
      // Read again: nothing new for channels
      const count = fake.alerts.length;
      await call(viewer, 'GET', api('/apps/site1/domains'));
      expect(fake.alerts.length).toBe(count);
    });

    it('reads certificates through the helper in nginx mode', async () => {
      nginxMode();
      const report = (await call(viewer, 'GET', api('/apps/site1/domains'))).json() as DeployDomainsReport;
      expect(report.proxy).toBe('nginx');
      expect(report.domains[0]!.certificate).toMatchObject({ source: 'certbot', issuer: "Let's Encrypt R11", notAfter: '2026-12-30T00:00:00.000Z' });
      expect(helperRuns()).toEqual([['status', 'site1']]);
      expect(bastionctlRuns()).toEqual([['status', 'site1']]);
    });

    it('is not found from another org', async () => {
      const outsider = seedUser(seedOrg('org-domains-other'), 'admin');
      expect((await call(outsider, 'GET', api('/apps/site1/domains'))).statusCode).toBe(404);
    });
  });
});
