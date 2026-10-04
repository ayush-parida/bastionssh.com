import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Resource and feature modules (unified roles spec §3.1, §3.2, §4.1): every
 * route of Servers (terminal, SFTP, Docker, health, host keys, key rotation),
 * Containers, Kubernetes, FTP, Object Storage, Cloud Accounts, Saved
 * Commands, Cron Jobs, Recordings, Monitoring & Alerts, DNS & Diagnostics and
 * the AI Assistant.
 *
 * - No access: every one of those routes is a 404, found by walking the
 *   app's own route table, so a route added later without a module gate
 *   fails here.
 * - A module off while its role still holds grants ("parked", spec §10.4):
 *   404 just the same.
 * - Module matrix: a member holding only a custom role with one module at
 *   each level, table-driven per module.
 * - Built-in roles: each gate the base roles decided before answers the same.
 * - Run-time re-checks (cron, saved-command runs, AI tools) and closing AI
 *   streams when the AI Assistant module goes off.
 *
 * Nothing reaches the network: servers have no credentials and Docker off,
 * a body the route refuses (400) shows a request got past the gates, and the
 * egress-IP lookup is stubbed.
 */
const spies = vi.hoisted(() => ({
  egress: vi.fn(async () => ({ ip: '192.0.2.10', source: 'configured' as const, checkedAt: null })),
}));
vi.mock('../../diagnostics/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../diagnostics/index.js')>()),
  getEgressIp: spies.egress,
}));

import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import type { AccessLevel, ModuleKey, ModuleLevel, ModulePermissions, ResourceType } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import {
  cloudAccounts,
  cronJobs,
  ftpConnections,
  keyRotations,
  kubeClusters,
  resourceGrants,
  roleMembers,
  roles,
  savedCommands,
  serverAlerts,
  servers,
  sessionRecordings,
  sshKeys,
  storageConnections,
} from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { encodeCredentials } from '../../cloud/index.js';
import { moduleLevel, snapshotAccess, revokeAfterChange } from '../../auth/access/index.js';
import { registerAgentStream, activeAgentStreamCount } from '../../ai/streams.js';
import { ToolExecutor } from '../../ai/tools.js';
import { creatorRefusal } from '../../worker/processors/cron.js';
import { runnerRefusal } from '../../commands/run.js';
import { runRotation } from '../../ssh/key-rotation.js';
import { seedOrg, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

/** The route prefixes of the modules this suite covers, and the id their `:id` / `:serverId` stand for. */
const PREFIXES: { prefix: string; id: () => string }[] = [];

describe('resource and feature modules', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: Who;
  const ids = {} as Record<
    'server' | 'cluster' | 'ftp' | 'storage' | 'cloud' | 'command' | 'job' | 'recording' | 'alert',
    string
  >;

  // Each request from its own address, so the sweep stays under the per-IP rate limit
  let requests = 0;
  const call = (who: Who, method: string, url: string, payload?: object) => {
    requests++;
    return app.inject({
      method: method as 'GET',
      url,
      headers: who.headers,
      remoteAddress: `10.${(requests >> 16) & 255}.${(requests >> 8) & 255}.${requests & 255}`,
      ...(payload !== undefined && { payload }),
    });
  };

  /** Hold only `roleId` (no built-in role). */
  function holdOnly(userId: string, roleId: string) {
    getDb().delete(roleMembers).where(and(eq(roleMembers.userId, userId), eq(roleMembers.orgId, orgId))).run();
    getDb().insert(roleMembers).values({ roleId, userId, orgId }).run();
  }

  /** A custom role with these modules and an "All …" grant per type. */
  function customRole(modules: ModulePermissions, grants: Partial<Record<ResourceType, AccessLevel>>): string {
    const id = nanoid();
    getDb()
      .insert(roles)
      .values({ id, orgId, name: `matrix-${id}`, createdBy: admin.userId, modulePermissions: JSON.stringify(modules) })
      .run();
    for (const [resourceType, level] of Object.entries(grants)) {
      getDb()
        .insert(resourceGrants)
        .values({ id: nanoid(), orgId, principalType: 'role', principalId: id, resourceType, selector: 'all', level: level!, grantedBy: admin.userId })
        .run();
    }
    return id;
  }

  /** A member holding nothing but one custom role. */
  function memberWith(modules: ModulePermissions, grants: Partial<Record<ResourceType, AccessLevel>> = {}): Who {
    const who = seedUser(orgId, 'viewer');
    holdOnly(who.userId, customRole(modules, grants));
    return who;
  }

  const EVERY_TYPE: Partial<Record<ResourceType, AccessLevel>> = {
    server: 'manage',
    cluster: 'manage',
    ftp_connection: 'manage',
    storage_connection: 'manage',
    cloud_account: 'manage',
    saved_command: 'manage',
    cron_job: 'manage',
  };

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-resource-modules');
    admin = seedUser(orgId, 'admin');
    const db = getDb();

    ids.server = nanoid();
    db.insert(servers)
      .values({ id: ids.server, orgId, name: 'web-1', host: '127.0.0.1', port: 1, username: 'root', createdBy: admin.userId, dockerMode: 'off' })
      .run();
    ids.cluster = nanoid();
    db.insert(kubeClusters)
      .values({
        id: ids.cluster,
        orgId,
        name: 'shop-prod',
        apiUrl: 'https://192.0.2.20:6443',
        authType: 'token',
        encryptedCredential: 'x',
        credentialHint: 'token',
        createdBy: admin.userId,
      })
      .run();
    ids.ftp = nanoid();
    db.insert(ftpConnections)
      .values({
        id: ids.ftp,
        orgId,
        name: 'deploy',
        host: 'ftp.example.com',
        username: 'deploy',
        encryptedPassword: await vault.encrypt('secret', ids.ftp),
        createdBy: admin.userId,
      })
      .run();
    ids.storage = nanoid();
    db.insert(storageConnections)
      .values({
        id: ids.storage,
        orgId,
        name: 'assets',
        provider: 'minio',
        endpoint: 'http://minio.example.com:9000',
        accessKeyId: 'AKIAEXAMPLE',
        encryptedSecretAccessKey: await vault.encrypt('secret', ids.storage),
        forcePathStyle: true,
        createdBy: admin.userId,
      })
      .run();
    ids.cloud = nanoid();
    db.insert(cloudAccounts)
      .values({
        id: ids.cloud,
        orgId,
        name: 'hetzner',
        provider: 'hetzner',
        encryptedCredentials: await vault.encrypt(encodeCredentials({ kind: 'token', token: 'hcloud-secret' }), ids.cloud),
        credentialHint: '…cret',
        syncEnabled: false,
        createdBy: admin.userId,
      })
      .run();
    ids.command = nanoid();
    db.insert(savedCommands).values({ id: ids.command, orgId, name: 'uptime', command: 'uptime', createdBy: admin.userId }).run();
    ids.job = nanoid();
    db.insert(cronJobs)
      .values({ id: ids.job, orgId, serverId: ids.server, name: 'nightly', schedule: '0 * * * *', createdBy: admin.userId, enabled: false, inlineCommand: 'uptime' })
      .run();
    ids.recording = nanoid();
    db.insert(sessionRecordings)
      .values({
        id: ids.recording,
        orgId,
        serverId: ids.server,
        serverName: 'web-1',
        userId: admin.userId,
        filePath: '/nonexistent/recording.cast',
        endedAt: new Date().toISOString(),
      })
      .run();
    ids.alert = nanoid();
    db.insert(serverAlerts).values({ id: ids.alert, orgId, serverId: ids.server, type: 'offline', message: 'down' }).run();

    PREFIXES.push(
      { prefix: '/api/servers', id: () => ids.server },
      { prefix: '/api/keys/rotat', id: () => ids.server },
      { prefix: '/api/ssh-sessions', id: () => 'x' },
      { prefix: '/api/sftp', id: () => ids.server },
      { prefix: '/api/monitoring', id: () => ids.server },
      { prefix: '/api/notifications', id: () => 'x' },
      { prefix: '/api/docker', id: () => ids.server },
      { prefix: '/api/kube', id: () => ids.cluster },
      { prefix: '/api/ftp', id: () => ids.ftp },
      { prefix: '/api/storage', id: () => ids.storage },
      { prefix: '/api/cloud', id: () => ids.cloud },
      { prefix: '/api/commands', id: () => ids.command },
      { prefix: '/api/cron-jobs', id: () => ids.job },
      { prefix: '/api/recordings', id: () => ids.recording },
      { prefix: '/api/dns', id: () => 'x' },
      { prefix: '/api/diagnostics', id: () => ids.server },
      { prefix: '/api/ai', id: () => 'x' },
    );

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Every route of these modules, read from the app's own route table
   * (`printRoutes` draws it as a tree of path segments), with real ids in
   * `:id` / `:serverId` and a placeholder in the other parameters.
   */
  function moduleRoutes(): { method: string; url: string }[] {
    const routes: { method: string; url: string }[] = [];
    const stack: string[] = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const m = /^((?:│ {3}| {4})*)(?:├── |└── )(.*?)(?: \(([^)]*)\))?$/.exec(line);
      if (!m) continue;
      stack.length = m[1]!.length / 4;
      stack.push(m[2]!);
      if (!m[3]) continue;
      const path = stack.join('');
      const owner = PREFIXES.find((p) => path.startsWith(p.prefix));
      if (!owner) continue;
      const url = path
        .replace(/:(id|serverId)\b/g, owner.id())
        .replace(/:[A-Za-z]+/g, 'x');
      for (const method of m[3].split(', ')) if (method !== 'HEAD') routes.push({ method, url });
    }
    return routes;
  }

  describe('a member with No access', () => {
    it('gets 404 on every route of these modules', async () => {
      const nobody = seedUser(orgId, 'viewer');
      holdOnly(nobody.userId, `builtin:${orgId}:none`);
      const routes = moduleRoutes();
      // The walk found them all: one per module at least, and plenty in all
      for (const { prefix } of PREFIXES) expect(routes.some((r) => r.url.startsWith(prefix)), prefix).toBe(true);
      expect(routes.length).toBeGreaterThan(150);
      const wrong: string[] = [];
      for (const route of routes) {
        const res = await call(nobody, route.method, route.url, route.method === 'GET' || route.method === 'DELETE' ? undefined : {});
        if (res.statusCode !== 404) wrong.push(`${route.method} ${route.url} → ${res.statusCode}`);
      }
      expect(wrong).toEqual([]);
    });

    it('gets 404 just the same with every module off and grants to everything parked on the role', async () => {
      const parked = memberWith({ dashboard: 'view' }, EVERY_TYPE);
      const wrong: string[] = [];
      for (const route of moduleRoutes()) {
        const res = await call(parked, route.method, route.url, route.method === 'GET' || route.method === 'DELETE' ? undefined : {});
        if (res.statusCode !== 404) wrong.push(`${route.method} ${route.url} → ${res.statusCode}`);
      }
      expect(wrong).toEqual([]);
    });
  });

  // ── Module matrix ──────────────────────────────────────────────────────────

  type Expect = Partial<Record<ModuleLevel, number>>;
  interface MatrixRoute {
    name: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: () => string;
    body?: () => object;
    expect: Expect;
  }
  interface ModuleCase {
    module: ModuleKey;
    /** Other modules the role holds, so the module under test is the only thing that varies. */
    with?: ModulePermissions;
    grants: Partial<Record<ResourceType, AccessLevel>>;
    routes: MatrixRoute[];
  }

  const MATRIX: ModuleCase[] = [
    {
      module: 'servers',
      // Adding a server also needs the org's SSH keys (below)
      with: { ssh_keys: 'operate' },
      grants: { server: 'manage' },
      routes: [
        { name: 'list', method: 'GET', url: () => '/api/servers', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'one', method: 'GET', url: () => `/api/servers/${ids.server}`, expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'health', method: 'GET', url: () => `/api/monitoring/servers/${ids.server}`, expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'host key', method: 'GET', url: () => `/api/servers/${ids.server}/host-key`, expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'Docker tab', method: 'GET', url: () => `/api/docker/servers/${ids.server}`, expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'rotation history', method: 'GET', url: () => '/api/keys/rotations', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        // Adding a server is the module's own right (spec §3.1); 400 = past the gate, refused for its body
        { name: 'add', method: 'POST', url: () => '/api/servers', body: () => ({}), expect: { none: 404, view: 403, operate: 403, manage: 400 } },
      ],
    },
    {
      module: 'containers',
      with: { servers: 'view' },
      grants: { server: 'manage' },
      routes: [
        { name: 'fleet', method: 'GET', url: () => '/api/docker/containers', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'settings', method: 'GET', url: () => '/api/docker/settings', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'change settings', method: 'PATCH', url: () => '/api/docker/settings', body: () => ({ bogus: true }), expect: { none: 404, view: 403, operate: 403, manage: 400 } },
      ],
    },
    {
      module: 'kubernetes',
      grants: { cluster: 'manage' },
      routes: [
        { name: 'list', method: 'GET', url: () => '/api/kube/clusters', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'settings', method: 'GET', url: () => '/api/kube/settings', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'change settings', method: 'PATCH', url: () => '/api/kube/settings', body: () => ({ bogus: true }), expect: { none: 404, view: 403, operate: 403, manage: 400 } },
        { name: 'add', method: 'POST', url: () => '/api/kube/clusters', body: () => ({ name: 'x', apiUrl: 'http://10.0.0.1:6443', token: 't' }), expect: { none: 404, view: 403, operate: 403, manage: 400 } },
      ],
    },
    {
      module: 'ftp',
      grants: { ftp_connection: 'manage' },
      routes: [
        { name: 'list', method: 'GET', url: () => '/api/ftp/connections', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'one', method: 'GET', url: () => `/api/ftp/connections/${ids.ftp}`, expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'add', method: 'POST', url: () => '/api/ftp/connections', body: () => ({}), expect: { none: 404, view: 403, operate: 403, manage: 400 } },
      ],
    },
    {
      module: 'storage',
      grants: { storage_connection: 'manage' },
      routes: [
        { name: 'list', method: 'GET', url: () => '/api/storage/connections', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'one', method: 'GET', url: () => `/api/storage/connections/${ids.storage}`, expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'add', method: 'POST', url: () => '/api/storage/connections', body: () => ({}), expect: { none: 404, view: 403, operate: 403, manage: 400 } },
      ],
    },
    {
      module: 'cloud',
      grants: { cloud_account: 'manage' },
      routes: [
        { name: 'list', method: 'GET', url: () => '/api/cloud/accounts', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'add', method: 'POST', url: () => '/api/cloud/accounts', body: () => ({}), expect: { none: 404, view: 403, operate: 403, manage: 400 } },
        // Credentials stay with whoever may add accounts, even for a manager of this one (at `manage` the provider would be asked)
        { name: 'change credentials', method: 'PATCH', url: () => `/api/cloud/accounts/${ids.cloud}`, body: () => ({ token: 'new-token' }), expect: { none: 404, view: 403, operate: 403 } },
      ],
    },
    {
      module: 'saved_commands',
      with: { servers: 'operate' },
      // `operate` on every command, so creating is down to the module alone
      grants: { saved_command: 'operate', server: 'operate' },
      routes: [
        { name: 'list', method: 'GET', url: () => '/api/commands', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'create', method: 'POST', url: () => '/api/commands', body: () => ({ name: 'n', command: 'true' }), expect: { none: 404, view: 403, operate: 403, manage: 201 } },
      ],
    },
    {
      module: 'cron_jobs',
      with: { servers: 'operate' },
      grants: { cron_job: 'operate', server: 'operate' },
      routes: [
        { name: 'list', method: 'GET', url: () => '/api/cron-jobs', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        {
          name: 'create',
          method: 'POST',
          url: () => '/api/cron-jobs',
          body: () => ({ serverId: ids.server, name: 'n', schedule: '0 * * * *', inlineCommand: 'true', enabled: false }),
          expect: { none: 404, view: 403, operate: 403, manage: 201 },
        },
      ],
    },
    {
      module: 'monitoring',
      with: { servers: 'operate' },
      grants: { server: 'operate' },
      routes: [
        { name: 'overview', method: 'GET', url: () => '/api/monitoring/overview', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'alerts', method: 'GET', url: () => '/api/monitoring/alerts', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'acknowledge', method: 'POST', url: () => `/api/monitoring/alerts/${ids.alert}/acknowledge`, expect: { none: 404, view: 403, operate: 200, manage: 200 } },
        { name: 'channels', method: 'GET', url: () => '/api/notifications/channels', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        { name: 'add channel', method: 'POST', url: () => '/api/notifications/channels', body: () => ({}), expect: { none: 404, view: 403, operate: 403, manage: 400 } },
      ],
    },
    {
      module: 'diagnostics',
      with: { servers: 'operate' },
      grants: { server: 'operate' },
      routes: [
        // 400: past the gate, refused for its query
        { name: 'DNS lookup', method: 'GET', url: () => '/api/dns/lookup', expect: { none: 404, view: 400, operate: 400 } },
        { name: 'egress IP', method: 'GET', url: () => '/api/diagnostics/egress-ip', expect: { none: 404, view: 403, operate: 200 } },
      ],
    },
    {
      module: 'ai',
      with: { servers: 'operate' },
      grants: { server: 'operate' },
      routes: [
        { name: 'providers', method: 'GET', url: () => '/api/ai/providers', expect: { none: 404, view: 200, manage: 200 } },
        { name: 'context', method: 'GET', url: () => '/api/ai/context', expect: { none: 404, view: 200, manage: 200 } },
        { name: 'access', method: 'GET', url: () => '/api/ai/access', expect: { none: 404, view: 200, manage: 200 } },
        { name: 'add provider', method: 'POST', url: () => '/api/ai/providers', body: () => ({}), expect: { none: 404, view: 403, manage: 400 } },
        // No provider in this org: past the gate, the chat says so
        { name: 'chat', method: 'POST', url: () => '/api/ai/chat', body: () => ({ messages: [] }), expect: { none: 404, view: 400, manage: 400 } },
      ],
    },
    {
      module: 'recordings',
      with: { servers: 'view' },
      grants: { server: 'view' },
      routes: [
        { name: 'list', method: 'GET', url: () => '/api/recordings', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        // Someone else's recording: all of them from `operate`
        { name: "another's recording", method: 'GET', url: () => `/api/recordings/${ids.recording}`, expect: { none: 404, view: 404, operate: 200, manage: 200 } },
        { name: 'settings', method: 'GET', url: () => '/api/recordings/settings', expect: { none: 404, view: 200, operate: 200, manage: 200 } },
        // The policy and deleting stay with owners, as before (below)
        { name: 'change settings', method: 'PATCH', url: () => '/api/recordings/settings', body: () => ({ enabled: true }), expect: { none: 404, view: 403, operate: 403, manage: 403 } },
      ],
    },
  ];

  const LEVELS: ModuleLevel[] = ['none', 'view', 'operate', 'manage'];

  describe.each(MATRIX)('$module module', (c) => {
    const levels = LEVELS.filter((l) => c.routes.some((r) => r.expect[l] !== undefined));
    const holders = {} as Record<ModuleLevel, Who>;

    beforeAll(() => {
      for (const level of levels) holders[level] = memberWith({ ...c.with, [c.module]: level }, c.grants);
    });

    for (const route of c.routes) {
      const asked = levels.filter((l) => route.expect[l] !== undefined);
      it(`${route.name}: ${route.method} at ${asked.join(' / ')}`, async () => {
        const got: Expect = {};
        for (const level of asked) got[level] = (await call(holders[level], route.method, route.url(), route.body?.())).statusCode;
        expect(got).toEqual(route.expect);
      });
    }
  });

  it('sees only their own recordings at `view`, everyone’s from `operate`', async () => {
    const own = memberWith({ servers: 'view', recordings: 'view' }, { server: 'view' });
    const all = memberWith({ servers: 'view', recordings: 'operate' }, { server: 'view' });
    const listed = async (who: Who) => ((await call(who, 'GET', '/api/recordings')).json() as { items: { id: string }[] }).items.map((r) => r.id);
    expect(await listed(own)).not.toContain(ids.recording);
    expect(await listed(all)).toContain(ids.recording);
  });

  it('keeps a module hidden while its holder sees nothing in it, unless they may add there', async () => {
    const empty = seedOrg('org-resource-modules-empty');
    const viewer = seedUser(empty, 'viewer');
    const owner = seedUser(empty, 'owner');
    // Viewer has Servers at `view`, but there is no server to see
    expect((await call(viewer, 'GET', '/api/servers')).statusCode).toBe(404);
    // Owners may add servers, so the module is there for them
    expect((await call(owner, 'GET', '/api/servers')).json()).toEqual([]);
    getDb().insert(servers).values({ id: nanoid(), orgId: empty, name: 'first', host: '127.0.0.1', username: 'root', createdBy: owner.userId }).run();
    expect((await call(viewer, 'GET', '/api/servers')).json()).toHaveLength(1);
  });

  // ── What a module at `manage` does not carry ─────────────────────────────

  /**
   * Adding or re-pointing servers, FTP connections and cloud accounts was
   * admin-only before; at `manage` on their module a custom role may now do
   * it. That must not hand over the org's SSH keys (a terminal names any org
   * key, so whoever sets where a server connects decides where every key
   * logs in) or a tunnel through a jump host the member cannot operate.
   */
  describe('what Servers, FTP and Cloud Accounts at `manage` do not carry', () => {
    let keyId: string;
    const newServer = (extra: object = {}) => ({ name: `s-${nanoid(4)}`, host: '127.0.0.1', username: 'root', authType: 'password', password: 'pw', ...extra });

    beforeAll(() => {
      keyId = nanoid();
      getDb()
        .insert(sshKeys)
        .values({ id: keyId, orgId, name: 'deploy', publicKey: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:deploy', encryptedPrivateKey: 'x', createdBy: admin.userId })
        .run();
    });

    it('adds a server, or changes where one connects, only with SSH Keys at `operate`', async () => {
      const noKeys = memberWith({ servers: 'manage' }, { server: 'manage' });
      const keys = memberWith({ servers: 'manage', ssh_keys: 'operate' }, { server: 'manage' });
      expect((await call(noKeys, 'POST', '/api/servers', newServer())).statusCode).toBe(403);
      expect((await call(keys, 'POST', '/api/servers', newServer())).statusCode).toBe(201);
      expect((await call(noKeys, 'PATCH', `/api/servers/${ids.server}`, { host: '192.0.2.99' })).statusCode).toBe(403);
      expect((await call(noKeys, 'PATCH', `/api/servers/${ids.server}`, { authType: 'key', defaultKeyId: keyId })).statusCode).toBe(403);
      // A rename touches neither a key nor where the server connects
      expect((await call(noKeys, 'PATCH', `/api/servers/${ids.server}`, { name: 'web-1' })).statusCode).toBe(200);
    });

    it('connects through a jump host only with `operate` on it', async () => {
      const db = getDb();
      const hidden = nanoid();
      const seen = nanoid();
      db.insert(servers).values({ id: hidden, orgId, name: 'bastion', host: '127.0.0.1', username: 'root', createdBy: admin.userId }).run();
      db.insert(servers).values({ id: seen, orgId, name: 'web-edge', host: '127.0.0.1', username: 'root', createdBy: admin.userId, tags: '["edge"]' }).run();
      const roleId = customRole({ servers: 'manage', ssh_keys: 'operate' }, {});
      db.insert(resourceGrants)
        .values({ id: nanoid(), orgId, principalType: 'role', principalId: roleId, resourceType: 'server', selector: 'tag', tag: 'edge', level: 'view', grantedBy: admin.userId })
        .run();
      const member = seedUser(orgId, 'viewer');
      holdOnly(member.userId, roleId);

      // One they cannot see reads as unknown; one they only see is refused
      const viaHidden = await call(member, 'POST', '/api/servers', newServer({ jumpServerId: hidden }));
      expect(viaHidden.statusCode).toBe(400);
      expect(viaHidden.json().error).toBe('Unknown jump host');
      expect((await call(member, 'POST', '/api/servers', newServer({ jumpServerId: seen }))).statusCode).toBe(403);
      // The built-in Admin operates every server, as before
      expect((await call(admin, 'POST', '/api/servers', newServer({ jumpServerId: hidden }))).statusCode).toBe(201);
    });

    it('lets an FTP connection or cloud account log in with an org key only with SSH Keys at `operate`', async () => {
      const ftp = memberWith({ ftp: 'manage' }, { ftp_connection: 'manage' });
      const keyAuth = { name: 'k', host: '192.0.2.40', protocol: 'sftp', username: 'deploy', authMethod: 'key', sshKeyId: keyId };
      expect((await call(ftp, 'POST', '/api/ftp/connections', keyAuth)).statusCode).toBe(403);
      // A password connection uses no org key
      const passwordAuth = { name: 'p', host: '192.0.2.41', protocol: 'ftps', username: 'deploy', password: 'pw' };
      expect((await call(ftp, 'POST', '/api/ftp/connections', passwordAuth)).statusCode).toBe(201);
      const ftpKeys = memberWith({ ftp: 'manage', ssh_keys: 'operate' }, { ftp_connection: 'manage' });
      expect((await call(ftpKeys, 'POST', '/api/ftp/connections', keyAuth)).statusCode).toBe(201);
      // Nor turned onto a key on an existing connection
      expect((await call(ftp, 'PATCH', `/api/ftp/connections/${ids.ftp}`, { protocol: 'sftp', authMethod: 'key', sshKeyId: keyId })).statusCode).toBe(403);

      const cloud = memberWith({ cloud: 'manage' }, { cloud_account: 'manage' });
      const account = { name: 'c', provider: 'hetzner', token: 'hcloud-token-123', defaultKeyId: keyId };
      expect((await call(cloud, 'POST', '/api/cloud/accounts', account)).statusCode).toBe(403);
      expect((await call(cloud, 'PATCH', `/api/cloud/accounts/${ids.cloud}`, { defaultKeyId: keyId })).statusCode).toBe(403);
    });
  });

  // ── Built-in roles: the gates the base roles decided before ───────────────

  describe('built-in roles', () => {
    const ROLE_RANK = { viewer: 0, operator: 1, admin: 2, owner: 3 } as const;
    type BaseRole = keyof typeof ROLE_RANK;
    /**
     * Each gate that was `requireRole(minimum)` before, and a body that is
     * refused past it (or a request that passes). Below the minimum it is
     * refused as before: 403, or 404 where the role does not have the module
     * at all (`hiddenFor` — the AI Assistant for viewers).
     */
    const GATES: {
      name: string;
      minimum: BaseRole;
      method: 'GET' | 'POST' | 'PATCH';
      url: () => string;
      body?: () => object;
      pass: number;
      hiddenFor?: BaseRole[];
    }[] = [
      { name: 'add a server', minimum: 'admin', method: 'POST', url: () => '/api/servers', body: () => ({}), pass: 400 },
      { name: 'add an FTP connection', minimum: 'admin', method: 'POST', url: () => '/api/ftp/connections', body: () => ({}), pass: 400 },
      { name: 'add a storage connection', minimum: 'admin', method: 'POST', url: () => '/api/storage/connections', body: () => ({}), pass: 400 },
      { name: 'add a cloud account', minimum: 'admin', method: 'POST', url: () => '/api/cloud/accounts', body: () => ({}), pass: 400 },
      { name: 'Docker settings', minimum: 'admin', method: 'PATCH', url: () => '/api/docker/settings', body: () => ({ bogus: true }), pass: 400 },
      { name: 'Kubernetes settings', minimum: 'admin', method: 'PATCH', url: () => '/api/kube/settings', body: () => ({ bogus: true }), pass: 400 },
      { name: 'add a cluster', minimum: 'admin', method: 'POST', url: () => '/api/kube/clusters', body: () => ({ name: 'x', apiUrl: 'http://10.0.0.1:6443', token: 't' }), pass: 400 },
      { name: 'AI providers', minimum: 'admin', method: 'POST', url: () => '/api/ai/providers', body: () => ({}), pass: 400, hiddenFor: ['viewer'] },
      { name: 'notification channels', minimum: 'admin', method: 'POST', url: () => '/api/notifications/channels', body: () => ({}), pass: 400 },
      { name: 'recording policy', minimum: 'owner', method: 'PATCH', url: () => '/api/recordings/settings', body: () => ({}), pass: 400 },
      { name: 'egress IP', minimum: 'operator', method: 'GET', url: () => '/api/diagnostics/egress-ip', pass: 200 },
    ];

    it.each(['owner', 'admin', 'operator', 'viewer'] as const)('%s: allowed exactly what the base role allowed', async (base) => {
      const who = seedUser(orgId, base);
      const got: Record<string, number> = {};
      const want: Record<string, number> = {};
      for (const gate of GATES) {
        got[gate.name] = (await call(who, gate.method, gate.url(), gate.body?.())).statusCode;
        want[gate.name] = ROLE_RANK[base] >= ROLE_RANK[gate.minimum] ? gate.pass : gate.hiddenFor?.includes(base) ? 404 : 403;
      }
      expect(got).toEqual(want);
    });

    it('module levels of the built-ins match the base roles’ AI, recordings and diagnostics rights', () => {
      const of = (base: BaseRole) => ({ orgId, userId: seedUser(orgId, base).userId });
      expect(moduleLevel(of('operator'), 'ai')).toBe('view');
      expect(moduleLevel(of('viewer'), 'ai')).toBe('none');
      expect(moduleLevel(of('admin'), 'recordings')).toBe('manage');
      expect(moduleLevel(of('operator'), 'recordings')).toBe('view');
      expect(moduleLevel(of('viewer'), 'diagnostics')).toBe('view');
      expect(moduleLevel(of('operator'), 'diagnostics')).toBe('operate');
    });
  });

  // ── At run time ───────────────────────────────────────────────────────────

  describe('run-time re-checks', () => {
    function setModules(roleId: string, modules: ModulePermissions) {
      getDb().update(roles).set({ modulePermissions: JSON.stringify(modules) }).where(eq(roles.id, roleId)).run();
    }

    it('stops a cron job when its creator’s Cron Jobs or Servers module goes off', () => {
      const creator = seedUser(orgId, 'viewer');
      const modules = { servers: 'operate', cron_jobs: 'manage', saved_commands: 'operate' } as const;
      const roleId = customRole(modules, { server: 'operate', cron_job: 'manage', saved_command: 'operate' });
      holdOnly(creator.userId, roleId);
      const job = { id: ids.job, orgId, createdBy: creator.userId, serverId: ids.server, savedCommandId: null, inlineCommand: 'uptime' };
      expect(creatorRefusal(job)).toBeNull();
      setModules(roleId, { ...modules, cron_jobs: 'none' });
      expect(creatorRefusal(job)).toMatch(/cron jobs/);
      setModules(roleId, { ...modules, servers: 'none' });
      expect(creatorRefusal(job)).not.toBeNull();
      setModules(roleId, { ...modules, saved_commands: 'none' });
      expect(creatorRefusal({ ...job, savedCommandId: ids.command, inlineCommand: null })).toMatch(/saved command/);
    });

    it('stops a queued saved-command run when the Saved Commands module goes off', () => {
      const runner = seedUser(orgId, 'viewer');
      const modules = { servers: 'operate', saved_commands: 'operate' } as const;
      const roleId = customRole(modules, { server: 'operate', saved_command: 'operate' });
      holdOnly(runner.userId, roleId);
      const who = { orgId, userId: runner.userId };
      const command = { id: ids.command, serverId: null };
      expect(runnerRefusal(who, command, ids.server)).toBeNull();
      setModules(roleId, { ...modules, saved_commands: 'none' });
      expect(runnerRefusal(who, command, ids.server)).toMatch(/saved commands/);
    });

    it('fails a queued key rotation whose asker lost the Servers module before it ran', async () => {
      const asker = seedUser(orgId, 'viewer');
      const roleId = customRole({ servers: 'manage' }, { server: 'manage' });
      holdOnly(asker.userId, roleId);
      // Queued in a bulk batch, as POST /api/keys/rotate leaves it
      const queued = nanoid();
      getDb()
        .insert(keyRotations)
        .values({ id: queued, orgId, batchId: nanoid(), serverId: ids.server, serverName: 'web-1', oldKeyId: 'k', oldFingerprint: 'SHA256:x', startedBy: asker.userId })
        .run();
      setModules(roleId, { servers: 'none' });
      const done = await runRotation(queued, { orgId, userId: asker.userId, email: 'asker@test.local' });
      expect(done).toMatchObject({ status: 'failed', error: expect.stringMatching(/no longer rotate keys/) });
    });

    it('lets the AI agent act only while the AI Assistant module is on, and closes its streams when it goes off', async () => {
      const member = seedUser(orgId, 'viewer');
      const modules = { servers: 'operate', ai: 'view' } as const;
      const roleId = customRole(modules, { server: 'operate' });
      holdOnly(member.userId, roleId);
      const tools = new ToolExecutor(orgId, member.userId);
      expect(await tools.execute('list_servers', {})).toContain('web-1');

      const stream = registerAgentStream({ orgId, userId: member.userId });
      const before = snapshotAccess(orgId, [member.userId]);
      setModules(roleId, { ...modules, ai: 'none' });
      // Nothing else changed: only the module-scoped AI stream closes
      const closed = revokeAfterChange(orgId, [member.userId], before).get(member.userId);
      expect(closed).toMatchObject({ agents: 1, terminals: 0 });
      expect(stream.signal.aborted).toBe(true);
      stream.release();
      expect(activeAgentStreamCount()).toBe(0);
      await expect(tools.execute('list_servers', {})).rejects.toThrow(/not available/);
      // …and the routes are gone for them
      expect((await call(member, 'GET', '/api/ai/access')).statusCode).toBe(404);
    });
  });
});
