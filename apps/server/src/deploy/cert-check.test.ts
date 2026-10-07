import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../notifications/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notifications/index.js')>()),
  notifyAlertsChanged: (events: Array<Record<string, unknown>>) => sent.events.push(...events),
}));

import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { auditLog, serverAlerts, servers } from '../db/schema.js';
import { seedOrg, seedServer, seedUser } from '../api/routes/test-utils.js';
import type { BastionctlBundle } from './bundle.js';
import { resetCertificateAlertsForTests } from './cert-alerts.js';
import { certCheckLimits, runCertificateCheck, type CertCheckDeps } from './cert-check.js';
import { DISCOVER_SCRIPT } from './install.js';
import { NGINX_HELPER_PATH } from './nginx.js';
import { resetBastionctlUpgradesForTests } from './upgrade.js';
import type { Remote, RunResult, ServerRow } from './remote.js';

/**
 * The background certificate check (deployments spec §6) against fake
 * servers: it finds deployments the way a request does (nothing recorded
 * about which servers have any), never runs a bastionctl that is not the
 * shipped one, reads each deployed app's certificates — through bastionctl,
 * or the nginx helper in nginx mode — and raises and resolves alerts through
 * the notification pipeline; an unreachable server or an unreadable app
 * keeps its alerts, a server without deployments or paused loses them, and
 * only a few servers are checked at once.
 */

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const SCRIPT = Buffer.from('// bastionctl.mjs as shipped\n');
const WRAPPER = Buffer.from('#!/bin/sh\n# wrapper as shipped\n');
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
const NOW = Date.parse('2026-10-05T12:00:00.000Z');

interface FakeServer {
  root: string | null;
  files: Map<string, Buffer>;
  /** bastionctl answers by subcommand. */
  answers: Record<string, (args: string[]) => unknown>;
  unreachable?: boolean;
  /** Writing fails (bin/ not writable). */
  readOnly?: boolean;
  /** Every argv run, bastionctl's without wrapper and --json. */
  runs: string[][];
}

const fakes = new Map<string, FakeServer>();
let open = 0;
let maxOpen = 0;
let released = 0;

function parseQuoted(command: string): string[] {
  const argv: string[] = [];
  for (const m of command.matchAll(/'((?:[^']|'\\'')*)'/g)) argv.push(m[1]!.replaceAll("'\\''", "'"));
  return argv;
}

function done(stdout: string, exitCode = 0): RunResult {
  return { exitCode, signal: null, timedOut: false, stdout, stderr: '', durationMs: 1 };
}

function fakeRemote(server: ServerRow, fake: FakeServer): Remote {
  return {
    server,
    async run(command) {
      const argv = parseQuoted(command);
      if (argv[0] === 'sh' && argv[2] === DISCOVER_SCRIPT) return done(`root=${fake.root ?? ''}\n`);
      if (argv[0] === 'sudo' && argv[2] === NGINX_HELPER_PATH) {
        fake.runs.push(['helper', ...argv.slice(3)]);
        return done('cert=bastion-site1\nnotBefore=Jul  1 00:00:00 2026 GMT\nnotAfter=Oct 10 00:00:00 2026 GMT\nstatus=ok\n');
      }
      if (argv[0] !== 'env' || argv[2] !== `${fake.root}/bin/bastionctl`) throw new Error(`unexpected ${command}`);
      expect(argv[1]).toBe('BASTION_ACTOR=bastionssh-certificate-check');
      const args = argv.slice(3, -1);
      fake.runs.push(args);
      const answer = fake.answers[args[0]!];
      if (!answer) return done(`${JSON.stringify({ error: `no ${args[0]}`, code: 1 })}\n`, 1);
      return done(`${JSON.stringify(answer(args))}\n`);
    },
    async hashFile(path) {
      const data = fake.files.get(path);
      return data ? sha(data) : null;
    },
    async readFile(path) {
      return fake.files.get(path) ?? null;
    },
    async writeFile(path, data) {
      if (fake.readOnly) throw new Error('Permission denied');
      fake.files.set(path, Buffer.from(data));
    },
    upload: () => Promise.reject(new Error('read only')),
    remove: () => Promise.reject(new Error('read only')),
    release() {
      released++;
      open--;
    },
  };
}

const deps: CertCheckDeps = {
  async open(server) {
    const fake = fakes.get(server.id);
    if (!fake || fake.unreachable) throw new Error('connect ECONNREFUSED');
    open++;
    maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 5));
    return fakeRemote(server, fake);
  },
  bundle: () => BUNDLE,
  now: () => NOW,
};

const CONFIG = (name: string, domains: string[], tls = 'auto') => ({ name, domains, tls, proxy: 'caddy' });
const ACME_FAILING = (domain: string) => ({ domain, source: 'acme', issuer: 'R11', notBefore: '2026-07-01T00:00:00.000Z', notAfter: '2026-10-20T00:00:00.000Z', lastError: { at: '2026-10-04T00:00:00.000Z', message: 'rate limited' } });
const ACME_VALID = (domain: string) => ({ domain, source: 'acme', issuer: 'R11', notBefore: '2026-10-01T00:00:00.000Z', notAfter: '2026-12-30T00:00:00.000Z', lastError: null });

function setUp(root = '/opt/bastion'): FakeServer {
  return {
    root,
    files: new Map([
      [`${root}/bin/bastionctl.mjs`, SCRIPT],
      [`${root}/bin/bastionctl`, WRAPPER],
    ]),
    answers: {
      list: () => [
        { name: 'site1', domains: ['site1.com'], buildType: 'nextjs', currentRelease: 'r1', container: null, configError: null, locked: false },
        { name: 'draft', domains: ['draft.com'], buildType: 'nextjs', currentRelease: null, container: null, configError: null, locked: false },
      ],
      status: (args) => ({ name: args[1], config: CONFIG(args[1]!, args[1] === 'site1' ? ['site1.com'] : ['draft.com']), configError: null }),
      certs: () => [ACME_FAILING('site1.com')],
    },
    runs: [],
  };
}

let orgId: string;
let admin: string;

function alertsOf(serverId: string) {
  return getDb()
    .select()
    .from(serverAlerts)
    .where(and(eq(serverAlerts.serverId, serverId), eq(serverAlerts.type, 'deploy_certificate'), isNull(serverAlerts.resolvedAt)))
    .all();
}

beforeAll(async () => {
  await runMigrations();
  orgId = seedOrg('org-cert-check');
  admin = seedUser(orgId, 'admin').userId;
});

afterAll(() => resetCertificateAlertsForTests());

beforeEach(() => {
  // Only this file's servers
  getDb().delete(servers).run();
  fakes.clear();
  resetCertificateAlertsForTests();
  resetBastionctlUpgradesForTests();
  getDb().delete(auditLog).where(eq(auditLog.action, 'deploy.bastionctl_upgrade')).run();
  sent.events.length = 0;
  open = 0;
  maxOpen = 0;
  released = 0;
});

describe('background certificate check', () => {
  it('reads deployed apps on servers set up for deployments, and alerts once', async () => {
    const withApps = seedServer(orgId, admin, 'apps');
    const plain = seedServer(orgId, admin, 'plain');
    fakes.set(withApps, setUp());
    fakes.set(plain, { ...setUp(), root: null, runs: [] });

    const outcomes = await runCertificateCheck(deps);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { serverId: withApps, result: 'checked', apps: 1, skipped: 0 },
        { serverId: plain, result: 'no_deployments' },
      ]),
    );
    // A server without deployments only answered the discovery
    expect(fakes.get(plain)!.runs).toEqual([]);
    // Apps never deployed have nothing to read
    expect(fakes.get(withApps)!.runs).toEqual([['list'], ['status', 'site1'], ['certs', 'site1']]);
    expect(sent.events).toMatchObject([{ kind: 'opened', type: 'deploy_certificate', serverId: withApps, orgId, container: 'site1/site1.com' }]);
    expect(alertsOf(withApps)).toHaveLength(1);
    expect(released).toBe(2);

    // Six hours later, still failing: nothing new
    await runCertificateCheck(deps);
    expect(sent.events).toHaveLength(1);

    // Renewed: resolved
    fakes.get(withApps)!.answers.certs = () => [ACME_VALID('site1.com')];
    await runCertificateCheck(deps);
    expect(sent.events.map((e) => e.kind)).toEqual(['opened', 'resolved']);
    expect(alertsOf(withApps)).toEqual([]);
  });

  it('upgrades a bastionctl that is not the shipped one (audited as the system), then reads with it', async () => {
    const id = seedServer(orgId, admin, 'older');
    const fake = setUp();
    fake.files.set('/opt/bastion/bin/bastionctl.mjs', Buffer.from('#!/usr/bin/env node\nvar BASTIONCTL_VERSION = "0.1.0";\n'));
    fakes.set(id, fake);
    expect(await runCertificateCheck(deps)).toEqual([{ serverId: id, result: 'checked', apps: 1, skipped: 0, upgraded: true }]);
    expect(fake.files.get('/opt/bastion/bin/bastionctl.mjs')).toEqual(SCRIPT);
    expect(fake.runs).toEqual([['list'], ['status', 'site1'], ['certs', 'site1']]);
    const rows = getDb().select().from(auditLog).where(eq(auditLog.action, 'deploy.bastionctl_upgrade')).all();
    expect(rows).toMatchObject([{ orgId, actorId: 'system', resourceId: id, resourceName: 'older' }]);
    expect(JSON.parse(rows[0]!.metadata!)).toEqual({ root: '/opt/bastion', from: '0.1.0', to: '9.9.9', result: 'success', trigger: 'certificate_check' });
    // Current from now on
    expect(await runCertificateCheck(deps)).toEqual([{ serverId: id, result: 'checked', apps: 1, skipped: 0 }]);
  });

  it('never runs a bastionctl that is pinned, or that it could not upgrade', async () => {
    const pinned = seedServer(orgId, admin, 'pinned');
    const locked = seedServer(orgId, admin, 'locked');
    const tampered = (extra: Partial<FakeServer> = {}) => {
      const fake = { ...setUp(), ...extra };
      fake.files.set('/opt/bastion/bin/bastionctl.mjs', Buffer.from('// modified'));
      return fake;
    };
    fakes.set(pinned, tampered());
    fakes.get(pinned)!.files.set('/opt/bastion/bin/.pinned', Buffer.from(''));
    fakes.set(locked, tampered({ readOnly: true }));
    expect(await runCertificateCheck(deps)).toEqual(
      expect.arrayContaining([
        { serverId: pinned, result: 'mismatch' },
        { serverId: locked, result: 'mismatch' },
      ]),
    );
    expect(fakes.get(pinned)!.files.get('/opt/bastion/bin/bastionctl.mjs')!.toString()).toBe('// modified');
    expect(fakes.get(pinned)!.runs).toEqual([]);
    expect(fakes.get(locked)!.runs).toEqual([]);
    const rows = getDb().select().from(auditLog).where(eq(auditLog.action, 'deploy.bastionctl_upgrade')).all();
    expect(rows.map((r) => [r.resourceId, JSON.parse(r.metadata!).result])).toEqual([[locked, 'failed']]);
  });

  it('keeps alerts of a server it cannot reach or an app it cannot read; resolves them once deployments are gone', async () => {
    const id = seedServer(orgId, admin, 'flaky');
    const fake = setUp();
    fakes.set(id, fake);
    await runCertificateCheck(deps);
    expect(alertsOf(id)).toHaveLength(1);

    fake.unreachable = true;
    expect(await runCertificateCheck(deps)).toEqual([{ serverId: id, result: 'unreachable' }]);
    fake.unreachable = false;
    delete fake.answers.certs;
    expect(await runCertificateCheck(deps)).toEqual([{ serverId: id, result: 'checked', apps: 0, skipped: 1 }]);
    expect(alertsOf(id)).toHaveLength(1);

    // The app was deleted
    fake.answers.list = () => [];
    await runCertificateCheck(deps);
    expect(alertsOf(id)).toEqual([]);
    expect(sent.events.map((e) => e.kind)).toEqual(['opened', 'resolved']);
  });

  it('keeps the alerts of an app whose bastion.yml does not read, or whose name it does not know', async () => {
    const id = seedServer(orgId, admin, 'broken-config');
    const fake = setUp();
    fakes.set(id, fake);
    await runCertificateCheck(deps);
    expect(alertsOf(id)).toHaveLength(1);

    const listed = fake.answers.list!([]) as Array<Record<string, unknown>>;
    fake.answers.list = () => [{ ...listed[0], configError: 'bastion.yml: bad YAML', domains: [] }, { ...listed[1], name: 'Bad_Name', currentRelease: 'r1' }];
    fake.runs.length = 0;
    expect(await runCertificateCheck(deps)).toEqual([{ serverId: id, result: 'checked', apps: 0, skipped: 2 }]);
    expect(fake.runs).toEqual([['list']]);
    expect(alertsOf(id)).toHaveLength(1);
    expect(sent.events.map((e) => e.kind)).toEqual(['opened']);
  });

  it('closes a connection that opens only after the server ran out of time, and reads nothing over it', async () => {
    const id = seedServer(orgId, admin, 'slow');
    const fake = setUp();
    fakes.set(id, fake);
    const saved = certCheckLimits.serverTimeoutMs;
    certCheckLimits.serverTimeoutMs = 20;
    try {
      const slow: CertCheckDeps = {
        ...deps,
        async open(server) {
          await new Promise((r) => setTimeout(r, 60));
          return deps.open(server);
        },
      };
      expect(await runCertificateCheck(slow)).toEqual([{ serverId: id, result: 'unreachable' }]);
      await new Promise((r) => setTimeout(r, 120));
      expect(open).toBe(0);
      expect(released).toBe(1);
      expect(fake.runs).toEqual([]);
    } finally {
      certCheckLimits.serverTimeoutMs = saved;
    }
  });

  it('resolves quietly when monitoring is off for a server, and asks nothing of it', async () => {
    const id = seedServer(orgId, admin, 'paused');
    fakes.set(id, setUp());
    await runCertificateCheck(deps);
    sent.events.length = 0;
    getDb().update(servers).set({ monitoringEnabled: false }).where(eq(servers.id, id)).run();
    fakes.get(id)!.runs.length = 0;
    expect(await runCertificateCheck(deps)).toEqual([{ serverId: id, result: 'paused' }]);
    expect(fakes.get(id)!.runs).toEqual([]);
    expect(alertsOf(id)).toEqual([]);
    expect(sent.events).toEqual([]);
  });

  it('reads certbot through the helper in nginx mode', async () => {
    const id = seedServer(orgId, admin, 'nginx');
    const fake = setUp();
    fake.files.set('/opt/bastion/proxy/mode', Buffer.from('nginx\n'));
    fake.files.set(NGINX_HELPER_PATH, HELPER);
    delete fake.answers.certs;
    fakes.set(id, fake);
    expect(await runCertificateCheck(deps)).toEqual([{ serverId: id, result: 'checked', apps: 1, skipped: 0 }]);
    expect(fake.runs).toEqual([['list'], ['status', 'site1'], ['helper', 'status', 'site1']]);
    // Expires in five days and certbot has not renewed it
    expect(sent.events).toMatchObject([{ kind: 'opened', container: 'site1/site1.com', value: 4 }]);
  });

  it('checks a few servers at a time', async () => {
    for (let i = 0; i < 9; i++) fakes.set(seedServer(orgId, admin, `many-${i}`), setUp());
    const outcomes = await runCertificateCheck(deps);
    expect(outcomes.filter((o) => o.result === 'checked')).toHaveLength(9);
    expect(maxOpen).toBeLessThanOrEqual(certCheckLimits.concurrency);
    expect(maxOpen).toBeGreaterThan(1);
  });
});
