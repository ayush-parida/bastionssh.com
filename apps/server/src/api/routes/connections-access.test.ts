import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable, type Writable } from 'node:stream';

/**
 * Custom roles on FTP/SFTP connections, storage connections and cloud
 * accounts (spec §5, §6, §10 route matrix): every route of each type, for a
 * role-scoped member with no access (404), with a custom role or a personal
 * grant at view / operate / manage (403 below the level the action needs),
 * and for all-scope members, whose base role keeps what it allowed before.
 * Lists show only what a member may see; managers below admin cannot reach
 * the org's SSH keys or send a stored password somewhere new; losing a role
 * closes pooled FTP sessions on the lost connections only.
 *
 * No network: FTP commands, S3 calls, cloud providers and diagnostics probes
 * are replaced; routes, auth, the access engine, DB and vault are real.
 */

vi.hoisted(() => {
  process.env.SMT_EGRESS_IP = '49.43.168.212';
});

// One fake FTP client per login, remembered by host so a test can see which closed
const ftpClients = vi.hoisted(() => new Map<string, { closed: boolean; close: () => void }[]>());
vi.mock('../../ftp/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ftp/client.js')>();
  return {
    ...actual,
    openClient: vi.fn(async (target: { host: string }) => {
      const client = {
        closed: false,
        close() {
          client.closed = true;
        },
      };
      ftpClients.set(target.host, [...(ftpClients.get(target.host) ?? []), client]);
      return client;
    }),
  };
});

vi.mock('../../ftp/ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ftp/ops.js')>();
  const entry = (name: string, type: 'file' | 'directory', size = 0) => ({
    name,
    path: `/home/deploy/${name}`,
    type,
    size,
    permissions: 'rw-r--r--',
    modifiedAt: null,
    rawModifiedAt: null,
    link: null,
    targetType: null,
  });
  return {
    ...actual,
    testConnection: vi.fn(async () => ({ ok: true, workingDirectory: '/home/deploy', entryCount: 1 })),
    home: vi.fn(async () => '/home/deploy'),
    list: vi.fn(async () => [entry('index.html', 'file', 5)]),
    stat: vi.fn(async () => entry('index.html', 'file', 5)),
    linkTargetSize: vi.fn(async () => 5),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    removeEmptyDir: vi.fn(async () => {}),
    removeDirRecursive: vi.fn(async () => {}),
    download: vi.fn(async (_c: unknown, _p: string, dest: Writable) => {
      dest.end('hello');
    }),
    upload: vi.fn(async (_c: unknown, body: Readable) => {
      for await (const _chunk of body) {
        /* drain */
      }
    }),
  };
});

vi.mock('../../storage/ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/ops.js')>();
  return {
    ...actual,
    listBuckets: vi.fn(async () => [{ name: 'media', createdAt: null }]),
    testConnection: vi.fn(async () => ({ ok: true, bucketCount: 1 })),
    createBucket: vi.fn(async () => {}),
    deleteBucket: vi.fn(async () => {}),
    listObjects: vi.fn(async () => ({ bucket: 'media', prefix: '', folders: [], objects: [], nextToken: null })),
    getObject: vi.fn(async () => ({
      body: Readable.from([Buffer.from('hi')]),
      contentType: 'text/plain',
      contentLength: 2,
      contentEncoding: null,
      lastModified: null,
    })),
    putObject: vi.fn(async (_c: unknown, _b: string, _k: string, body: Readable) => {
      for await (const _chunk of body) {
        /* drain */
      }
    }),
    createFolder: vi.fn(async () => {}),
    objectExists: vi.fn(async () => false),
    renameObject: vi.fn(async () => {}),
    deleteObject: vi.fn(async () => {}),
    deletePrefix: vi.fn(async () => 0),
  };
});

vi.mock('../../cloud/providers/index.js', () => ({
  getProvider: () => ({ listInstances: async () => [] }),
}));

vi.mock('../../diagnostics/steps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../diagnostics/steps.js')>();
  const { fakeDeps } = await import('../../diagnostics/fakes.test-helper.js');
  return { ...actual, defaultDeps: fakeDeps() };
});

import type { InjectOptions } from 'fastify';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import type { AccessLevel, ResourceType } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import {
  cloudAccounts,
  ftpConnections,
  memberships,
  resourceGrants,
  roleMembers,
  roles,
  sshKeys,
  storageConnections,
} from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { encodeCredentials } from '../../cloud/index.js';
import { revokeAfterChange, snapshotAccess } from '../../auth/access/index.js';
import { seedOrg, seedUser } from './test-utils.js';

type ConnectionType = Extract<ResourceType, 'ftp_connection' | 'storage_connection' | 'cloud_account'>;

let orgId: string;
let admin: ReturnType<typeof seedUser>;
let app: Awaited<ReturnType<typeof buildApp>>;

// A fresh address per request: the global per-IP rate limit is not under test
let calls = 0;
const inject = (opts: InjectOptions) =>
  app.inject({ ...opts, remoteAddress: `10.88.${(++calls >> 8) & 255}.${calls & 255}` });

const RANK: Record<AccessLevel, number> = { view: 0, operate: 1, manage: 2 };

async function ftpConnection(name = nanoid(6)): Promise<string> {
  const id = nanoid();
  getDb()
    .insert(ftpConnections)
    .values({
      id,
      orgId,
      name,
      // A host per connection, so the fake clients can be told apart
      host: `${id.toLowerCase().replace(/[^a-z0-9]/g, '')}.example.com`,
      username: 'deploy',
      encryptedPassword: await vault.encrypt('shh-secret', id),
      createdBy: admin.userId,
    })
    .run();
  return id;
}

async function storageConnection(): Promise<string> {
  const id = nanoid();
  getDb()
    .insert(storageConnections)
    .values({
      id,
      orgId,
      name: `bucket-${id}`,
      provider: 'minio',
      endpoint: 'http://minio.example.com:9000',
      accessKeyId: 'AKIAEXAMPLE',
      encryptedSecretAccessKey: await vault.encrypt('secret', id),
      forcePathStyle: true,
      createdBy: admin.userId,
    })
    .run();
  return id;
}

async function cloudAccount(): Promise<string> {
  const id = nanoid();
  getDb()
    .insert(cloudAccounts)
    .values({
      id,
      orgId,
      name: `cloud-${id}`,
      provider: 'hetzner',
      encryptedCredentials: await vault.encrypt(encodeCredentials({ kind: 'token', token: 'hcloud-token-secret' }), id),
      credentialHint: '…cret',
      syncEnabled: false,
      createdBy: admin.userId,
    })
    .run();
  return id;
}

const create: Record<ConnectionType, () => Promise<string>> = {
  ftp_connection: () => ftpConnection(),
  storage_connection: storageConnection,
  cloud_account: cloudAccount,
};

function scopeRoles(userId: string) {
  getDb().update(memberships).set({ scope: 'roles' }).where(eq(memberships.userId, userId)).run();
}

function grant(
  principal: { role: string } | { user: string },
  resourceType: ResourceType,
  level: AccessLevel,
  resourceId: string | null,
) {
  getDb()
    .insert(resourceGrants)
    .values({
      id: nanoid(),
      orgId,
      principalType: 'role' in principal ? 'role' : 'user',
      principalId: 'role' in principal ? principal.role : principal.user,
      resourceType,
      selector: resourceId ? 'id' : 'all',
      resourceId,
      level,
      grantedBy: admin.userId,
    })
    .run();
}

function role(userIds: string[]): string {
  const id = nanoid();
  getDb().insert(roles).values({ id, orgId, name: `role-${id}`, createdBy: admin.userId }).run();
  for (const userId of userIds) getDb().insert(roleMembers).values({ roleId: id, userId, orgId }).run();
  return id;
}

/**
 * Who asks, given the resource: their headers and what they should get. A
 * level means "allowed up to that level, 403 above"; 'none' means 404.
 */
interface Subject {
  name: string;
  make: (type: ConnectionType, id: string) => { headers: Record<string, string> };
  level: AccessLevel | 'none';
  /** The base role applies (scope `all`): it keeps browsing and downloading at view. */
  base?: boolean;
}

const SUBJECTS: Subject[] = [
  {
    name: 'role-scoped, nothing granted',
    level: 'none',
    make: () => {
      const u = seedUser(orgId, 'operator');
      scopeRoles(u.userId);
      return u;
    },
  },
  {
    name: 'role-scoped, granted another one',
    level: 'none',
    make: (type) => {
      const u = seedUser(orgId, 'operator');
      scopeRoles(u.userId);
      // A different resource of the same type: this one stays hidden
      grant({ user: u.userId }, type, 'manage', nanoid());
      return u;
    },
  },
  ...(['view', 'operate', 'manage'] as const).flatMap((level): Subject[] => [
    {
      name: `role-scoped viewer, custom role at ${level}`,
      level,
      make: (type, id) => {
        const u = seedUser(orgId, 'viewer');
        scopeRoles(u.userId);
        grant({ role: role([u.userId]) }, type, level, id);
        return u;
      },
    },
    {
      name: `role-scoped viewer, personal grant at ${level}`,
      level,
      make: (type, id) => {
        const u = seedUser(orgId, 'viewer');
        scopeRoles(u.userId);
        grant({ user: u.userId }, type, level, id);
        return u;
      },
    },
  ]),
  {
    name: 'role-scoped viewer, custom role on every one at operate',
    level: 'operate',
    make: (type) => {
      const u = seedUser(orgId, 'viewer');
      scopeRoles(u.userId);
      grant({ role: role([u.userId]) }, type, 'operate', null);
      return u;
    },
  },
  { name: 'all-scope viewer', level: 'view', base: true, make: () => seedUser(orgId, 'viewer') },
  { name: 'all-scope operator', level: 'operate', base: true, make: () => seedUser(orgId, 'operator') },
  { name: 'all-scope admin', level: 'manage', base: true, make: () => seedUser(orgId, 'admin') },
  {
    name: 'all-scope viewer raised by a custom role to operate',
    level: 'operate',
    base: true,
    make: (type, id) => {
      const u = seedUser(orgId, 'viewer');
      grant({ role: role([u.userId]) }, type, 'operate', id);
      return u;
    },
  },
];

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: (id: string) => string;
  /** The level the spec's §5 table asks for. */
  level: AccessLevel;
  /** The base role (scope `all`) has always allowed it at view. */
  baseView?: boolean;
  payload?: unknown;
  octet?: boolean;
}

const ftp = (path: string) => (id: string) => `/api/ftp/connections/${id}${path}`;
const storage = (path: string) => (id: string) => `/api/storage/connections/${id}${path}`;
const cloud = (path: string) => (id: string) => `/api/cloud/accounts/${id}${path}`;

const ROUTES: Record<ConnectionType, Route[]> = {
  ftp_connection: [
    { method: 'GET', url: ftp(''), level: 'view' },
    { method: 'GET', url: ftp('/list?path=.'), level: 'operate', baseView: true },
    { method: 'GET', url: ftp('/download?path=/home/deploy/index.html'), level: 'operate', baseView: true },
    { method: 'PUT', url: ftp('/file?path=/home/deploy/new.txt'), level: 'operate', payload: Buffer.from('hey'), octet: true },
    { method: 'POST', url: ftp('/mkdir'), level: 'operate', payload: { path: '/home/deploy/new' } },
    { method: 'POST', url: ftp('/rename'), level: 'operate', payload: { from: '/home/deploy/a', to: '/home/deploy/b' } },
    { method: 'DELETE', url: ftp('/file?path=/home/deploy/index.html'), level: 'operate' },
    { method: 'POST', url: ftp('/test'), level: 'operate' },
    { method: 'POST', url: (id) => `/api/diagnostics/ftp/${id}`, level: 'operate', payload: {} },
    { method: 'PATCH', url: ftp(''), level: 'manage', payload: { name: 'renamed' } },
    // FTPS has no host key: a 400 past the gate shows the gate let it through
    { method: 'GET', url: ftp('/host-key'), level: 'manage' },
    { method: 'POST', url: ftp('/host-key/scan'), level: 'manage' },
    { method: 'PUT', url: ftp('/host-key'), level: 'manage', payload: { fingerprint: `SHA256:${'A'.repeat(43)}` } },
    { method: 'POST', url: ftp('/host-key/accept'), level: 'manage', payload: { fingerprint: `SHA256:${'A'.repeat(43)}` } },
    { method: 'DELETE', url: ftp('/host-key'), level: 'manage' },
    { method: 'DELETE', url: ftp(''), level: 'manage' },
  ],
  storage_connection: [
    { method: 'GET', url: storage(''), level: 'view' },
    { method: 'GET', url: storage('/buckets'), level: 'view' },
    { method: 'GET', url: storage('/buckets/media/objects'), level: 'view' },
    { method: 'GET', url: storage('/buckets/media/object?key=a.txt'), level: 'operate', baseView: true },
    { method: 'PUT', url: storage('/buckets/media/object?key=b.txt'), level: 'operate', payload: Buffer.from('hey'), octet: true },
    { method: 'POST', url: storage('/buckets/media/folder'), level: 'operate', payload: { prefix: 'new/' } },
    { method: 'POST', url: storage('/buckets/media/rename'), level: 'operate', payload: { from: 'a.txt', to: 'b.txt' } },
    { method: 'DELETE', url: storage('/buckets/media/object?key=a.txt'), level: 'operate' },
    { method: 'POST', url: (id) => `/api/diagnostics/storage/${id}`, level: 'operate', payload: {} },
    { method: 'POST', url: storage('/test'), level: 'manage' },
    { method: 'POST', url: storage('/buckets'), level: 'manage', payload: { name: 'fresh-bucket' } },
    { method: 'DELETE', url: storage('/buckets/media'), level: 'manage' },
    { method: 'PATCH', url: storage(''), level: 'manage', payload: { name: 'renamed' } },
    { method: 'DELETE', url: storage(''), level: 'manage' },
  ],
  cloud_account: [
    { method: 'POST', url: cloud('/sync'), level: 'operate' },
    { method: 'POST', url: cloud('/test'), level: 'manage' },
    { method: 'PATCH', url: cloud(''), level: 'manage', payload: { name: 'renamed' } },
    { method: 'DELETE', url: cloud(''), level: 'manage' },
  ],
};

const LISTS: Record<ConnectionType, string> = {
  ftp_connection: '/api/ftp/connections',
  storage_connection: '/api/storage/connections',
  cloud_account: '/api/cloud/accounts',
};

function expected(subject: Subject, route: Route): 'allowed' | 403 | 404 {
  if (subject.level === 'none') return 404;
  if (RANK[subject.level] >= RANK[route.level]) return 'allowed';
  return subject.base && route.baseView ? 'allowed' : 403;
}

describe('connections, storage and cloud accounts under custom roles', () => {
  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-connections-access');
    admin = seedUser(orgId, 'admin');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  for (const type of Object.keys(ROUTES) as ConnectionType[]) {
    describe(type, () => {
      for (const subject of SUBJECTS) {
        it(`${subject.name}: list shows ${subject.level === 'none' ? 'nothing' : 'it'}`, async () => {
          const id = await create[type]();
          const hidden = await create[type]();
          const who = subject.make(type, id);
          const res = await inject({ method: 'GET', url: LISTS[type], headers: who.headers });
          expect(res.statusCode).toBe(200);
          const ids = (res.json() as { id: string }[]).map((row) => row.id);
          expect(ids.includes(id)).toBe(subject.level !== 'none');
          // Only all-scope members and "every one" roles see the one nobody granted
          expect(ids.includes(hidden)).toBe(!!subject.base || subject.name.includes('every one'));
        });

        for (const route of ROUTES[type]) {
          const outcome = expected(subject, route);
          const path = route.url(':id');
          it(`${subject.name}: ${route.method} ${path} → ${outcome}`, async () => {
            // A fresh resource per case, so deletes and renames do not leak between cases
            const id = await create[type]();
            const who = subject.make(type, id);
            const payload = route.payload as Buffer | Record<string, unknown> | undefined;
            const res = await inject({
              method: route.method,
              url: route.url(id),
              headers: {
                ...who.headers,
                ...(route.octet && { 'content-type': 'application/octet-stream' }),
              },
              ...(payload !== undefined && { payload }),
            });
            if (outcome === 'allowed') {
              expect([403, 404], res.body).not.toContain(res.statusCode);
              expect(res.statusCode, res.body).toBeLessThan(500);
            } else {
              expect(res.statusCode, res.body).toBe(outcome);
            }
          });
        }
      }
    });
  }

  it('keeps creating connections and accounts admin-only, whatever a role gives', async () => {
    const u = seedUser(orgId, 'viewer');
    scopeRoles(u.userId);
    const r = role([u.userId]);
    for (const type of Object.keys(ROUTES) as ConnectionType[]) grant({ role: r }, type, 'manage', null);
    for (const url of Object.values(LISTS)) {
      const res = await inject({ method: 'POST', url, headers: u.headers, payload: { name: 'x' } });
      expect(res.statusCode).toBe(403);
    }
  });

  describe('a manager below admin', () => {
    async function manager(type: ConnectionType, id: string) {
      const u = seedUser(orgId, 'operator');
      scopeRoles(u.userId);
      grant({ role: role([u.userId]) }, type, 'manage', id);
      return u;
    }

    it('edits an FTP connection but sends its password nowhere new without it', async () => {
      const id = await ftpConnection();
      const u = await manager('ftp_connection', id);
      const patch = (payload: object, who = u) =>
        inject({ method: 'PATCH', url: `/api/ftp/connections/${id}`, headers: who.headers, payload });

      expect((await patch({ host: 'evil.example.net' })).statusCode).toBe(403);
      expect((await patch({ protocol: 'ftp' })).statusCode).toBe(403);
      expect((await patch({ verifyTls: false })).statusCode).toBe(403);
      expect((await patch({ restrictToRoot: false, rootPath: '/' })).statusCode).toBe(200);
      expect((await patch({ host: 'new.example.net', password: 'new-secret' })).statusCode).toBe(200);
      // An admin may move it without retyping the password, as before
      expect((await patch({ host: 'other.example.net' }, admin)).statusCode).toBe(200);
    });

    it('never chooses or redirects the org SSH key an SFTP connection logs in with', async () => {
      const keyId = nanoid();
      getDb()
        .insert(sshKeys)
        .values({ id: keyId, orgId, name: 'deploy key', publicKey: 'ssh-ed25519 AAAA', encryptedPrivateKey: 'x', fingerprint: `fp-${keyId}`, type: 'ed25519', createdBy: admin.userId })
        .run();
      const id = await ftpConnection();
      getDb().update(ftpConnections).set({ protocol: 'sftp', port: 22 }).where(eq(ftpConnections.id, id)).run();
      const u = await manager('ftp_connection', id);
      const patch = (payload: object, who = u) =>
        inject({ method: 'PATCH', url: `/api/ftp/connections/${id}`, headers: who.headers, payload });

      expect((await patch({ authMethod: 'key', sshKeyId: keyId })).statusCode).toBe(403);
      expect((await patch({ authMethod: 'key', sshKeyId: keyId }, admin)).statusCode).toBe(200);
      expect((await patch({ host: 'evil.example.net' })).statusCode).toBe(403);
      expect((await patch({ username: 'root' })).statusCode).toBe(403);
      expect((await patch({ rootPath: '/' })).statusCode).toBe(403);
      expect((await patch({ name: 'renamed' })).statusCode).toBe(200);
      // Back to a password is fine with the new password
      expect((await patch({ authMethod: 'password', password: 'pw' })).statusCode).toBe(200);
    });

    it('edits a cloud account but not the SSH key its servers are imported with', async () => {
      const keyId = nanoid();
      getDb()
        .insert(sshKeys)
        .values({ id: keyId, orgId, name: 'import key', publicKey: 'ssh-ed25519 AAAA', encryptedPrivateKey: 'x', fingerprint: `fp-${keyId}`, type: 'ed25519', createdBy: admin.userId })
        .run();
      const id = await cloudAccount();
      const u = await manager('cloud_account', id);
      const patch = (payload: object, who = u) =>
        inject({ method: 'PATCH', url: `/api/cloud/accounts/${id}`, headers: who.headers, payload });
      expect((await patch({ defaultKeyId: keyId })).statusCode).toBe(403);
      expect((await patch({ defaultUsername: 'deploy', autoImport: false })).statusCode).toBe(200);
      expect((await patch({ defaultKeyId: keyId }, admin)).statusCode).toBe(200);
    });
  });

  describe('revocation', () => {
    const hostOf = (id: string) =>
      getDb().select({ host: ftpConnections.host }).from(ftpConnections).where(eq(ftpConnections.id, id)).get()!.host;
    const open = (id: string) => (ftpClients.get(hostOf(id)) ?? []).filter((c) => !c.closed).length;
    const browse = (who: { headers: Record<string, string> }, id: string) =>
      inject({ method: 'GET', url: `/api/ftp/connections/${id}/list?path=.`, headers: who.headers });

    it('closes pooled FTP sessions on the connections a lost role gave, and only those', async () => {
      const a = await ftpConnection();
      const b = await ftpConnection();
      const u = seedUser(orgId, 'viewer');
      scopeRoles(u.userId);
      const keep = role([u.userId]);
      const lose = role([u.userId]);
      grant({ role: keep }, 'ftp_connection', 'operate', a);
      grant({ role: lose }, 'ftp_connection', 'operate', b);
      expect((await browse(u, a)).statusCode).toBe(200);
      expect((await browse(u, b)).statusCode).toBe(200);
      expect([open(a), open(b)]).toEqual([1, 1]);

      const before = snapshotAccess(orgId, [u.userId]);
      getDb().delete(roleMembers).where(eq(roleMembers.roleId, lose)).run();
      const closed = revokeAfterChange(orgId, [u.userId], before).get(u.userId);
      expect(closed?.ftp).toBe(1);
      expect([open(a), open(b)]).toEqual([1, 0]);
      expect((await browse(u, b)).statusCode).toBe(404);
    });

    it('closes them where only view is left', async () => {
      const a = await ftpConnection();
      const u = seedUser(orgId, 'viewer');
      scopeRoles(u.userId);
      const r = role([u.userId]);
      grant({ role: r }, 'ftp_connection', 'operate', a);
      expect((await browse(u, a)).statusCode).toBe(200);

      const before = snapshotAccess(orgId, [u.userId]);
      getDb().update(resourceGrants).set({ level: 'view' }).where(eq(resourceGrants.principalId, r)).run();
      revokeAfterChange(orgId, [u.userId], before);
      expect(open(a)).toBe(0);
      expect((await browse(u, a)).statusCode).toBe(403);
    });

    it('keeps an all-scope viewer’s sessions when a role that raised them goes, since their base role browses', async () => {
      const a = await ftpConnection();
      const u = seedUser(orgId, 'viewer');
      const r = role([u.userId]);
      grant({ role: r }, 'ftp_connection', 'operate', a);
      expect((await browse(u, a)).statusCode).toBe(200);

      const before = snapshotAccess(orgId, [u.userId]);
      getDb().delete(roleMembers).where(eq(roleMembers.roleId, r)).run();
      revokeAfterChange(orgId, [u.userId], before);
      expect(open(a)).toBe(1);
    });

    it('closes them when scope narrows to roles that only show the connections', async () => {
      const a = await ftpConnection();
      const u = seedUser(orgId, 'viewer');
      // Every type visible either way: only browsing (and so the session) is lost
      const r = role([u.userId]);
      for (const type of ['server', 'cluster', 'ftp_connection', 'storage_connection', 'cloud_account', 'saved_command', 'cron_job'] as const) {
        grant({ role: r }, type, 'view', null);
      }
      expect((await browse(u, a)).statusCode).toBe(200);

      const before = snapshotAccess(orgId, [u.userId]);
      scopeRoles(u.userId);
      revokeAfterChange(orgId, [u.userId], before);
      expect(open(a)).toBe(0);
    });
  });
});
