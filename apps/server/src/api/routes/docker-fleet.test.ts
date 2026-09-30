import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * The fleet view end to end through the real pool, detection and client,
 * with ssh2 replaced by the fake-daemon stand-in (as in docker.test.ts). A
 * server whose host is `hang.invalid` never finishes its SSH handshake, which
 * is how timeouts, concurrency and cancellation are observed.
 */
const fake = vi.hoisted(() => ({
  options: { daemonSocket: '', cli: true } as import('../../docker/fake-daemon.test-helper.js').FakeSshOptions,
  log: { streamlocal: [] as string[], exec: [] as string[] },
  /** Handshakes started to hanging hosts, by server id. */
  hanging: [] as string[],
}));

vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const { fakeSshMethods } = await import('../../docker/fake-daemon.test-helper.js');
  // Methods and a closure map only — class fields in a vi.mock factory break the import
  const channels = new WeakMap<object, Set<import('node:net').Socket>>();
  class Client extends EventEmitter {
    constructor() {
      super();
      const open = new Set<import('node:net').Socket>();
      channels.set(this, open);
      Object.assign(
        this,
        fakeSshMethods(
          () => fake.options,
          fake.log,
          (s) => {
            open.add(s);
            s.on('close', () => open.delete(s));
          },
        ),
      );
    }
    connect(cfg: { host?: string; username?: string }) {
      if (cfg.host === 'hang.invalid') {
        fake.hanging.push(String(cfg.username));
        return this;
      }
      setImmediate(() => this.emit('ready'));
      return this;
    }
    end() {
      for (const s of channels.get(this) ?? []) s.destroy();
      setImmediate(() => this.emit('close'));
      return this;
    }
  }
  return { ...actual, default: { ...(actual as { default?: object }).default, Client }, Client };
});

import { and, eq } from 'drizzle-orm';
import type { DockerFleetResponse } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, servers } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { fleetLimits, mapPooled } from '../../docker/fleet.js';
import { startFakeDaemon, type FakeDaemon } from '../../docker/fake-daemon.test-helper.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('docker fleet', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let daemon: FakeDaemon;
  let base: string;
  let orgId: string;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let alpha: string;
  let bravo: string;
  let charlie: string;
  let off: string;
  let elsewhere: string;

  const get = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: who.headers });
  const fleet = async (who: Who, query = '') => {
    const res = await get(who, `/api/docker/containers${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as DockerFleetResponse;
  };

  async function server(orgOf: string, createdBy: string, name: string, patch: Partial<typeof servers.$inferInsert> = {}) {
    const id = seedServer(orgOf, createdBy, name);
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', id), ...patch })
      .where(eq(servers.id, id))
      .run();
    return id;
  }

  /** Servers that never answer, detected so the fleet asks them; their SSH username is their name. */
  async function hangingServers(prefix: string, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await server(orgId, admin.userId, `${prefix}-${i}`, {
          host: 'hang.invalid',
          username: `${prefix}-${i}`,
          dockerTransport: 'streamlocal',
          dockerDetectedSocketPath: '/var/run/docker.sock',
          dockerDetectedAt: new Date().toISOString(),
          dockerApiVersion: '1.47',
          dockerVersion: '27.3.1',
        }),
      );
    }
    return ids;
  }

  beforeAll(async () => {
    daemon = await startFakeDaemon();
    fake.options.daemonSocket = daemon.socketPath;
    await runMigrations();
    orgId = seedOrg('org-docker-fleet');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'viewer');
    alpha = await server(orgId, admin.userId, 'alpha');
    bravo = await server(orgId, admin.userId, 'bravo');
    charlie = await server(orgId, admin.userId, 'charlie');
    off = await server(orgId, admin.userId, 'delta-off', { dockerMode: 'off' });
    const otherOrg = seedOrg('org-docker-fleet-other');
    elsewhere = await server(otherOrg, seedUser(otherOrg, 'admin').userId, 'elsewhere');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    // Alpha and bravo had their Docker tab opened (detected); charlie never did
    for (const id of [alpha, bravo]) {
      expect((await get(admin, `/api/docker/servers/${id}/containers`)).statusCode).toBe(200);
    }
    const grant = await app.inject({
      method: 'PUT',
      url: `/api/team/members/${restricted.userId}/access`,
      headers: admin.headers,
      payload: { serverAccess: 'restricted', serverIds: [alpha] },
    });
    expect(grant.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await daemon.close();
  });

  beforeEach(() => {
    fake.options = { daemonSocket: daemon.socketPath, cli: true };
    fleetLimits.timeoutMs = 10_000;
    fleetLimits.concurrency = 5;
  });

  it('lists containers on every detected server, and says which servers it left out', async () => {
    const res = await fleet(viewer, '?all=1');
    expect(res.servers.map((s) => s.serverName)).toEqual(['alpha', 'bravo']);
    for (const s of res.servers) {
      expect(s).toMatchObject({ ok: true });
      expect(s.containers.map((c) => c.name)).toEqual(['web', 'worker']);
    }
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { serverId: charlie, serverName: 'charlie', reason: 'not_detected' },
        { serverId: off, serverName: 'delta-off', reason: 'off' },
      ]),
    );
    // Running only unless all=1
    expect((await fleet(viewer)).servers[0]!.containers.map((c) => c.name)).toEqual(['web']);
  });

  it('detects a server on demand when it is asked for by id', async () => {
    const res = await fleet(operator, `?serverIds=${charlie},${off}`);
    expect(res.servers).toHaveLength(1);
    expect(res.servers[0]).toMatchObject({ serverId: charlie, ok: true });
    expect(getDb().select().from(servers).where(eq(servers.id, charlie)).get()!.dockerTransport).toBe('streamlocal');
    expect(res.skipped).toEqual([{ serverId: off, serverName: 'delta-off', reason: 'off' }]);
  });

  it('only asks servers the caller can access, and does not say whether others exist', async () => {
    const mine = await fleet(restricted, `?serverIds=${alpha},${bravo},${elsewhere},nope`);
    expect(mine.servers.map((s) => s.serverId)).toEqual([alpha]);
    expect(mine.skipped).toEqual([]);
    const all = await fleet(restricted);
    expect(all.servers.map((s) => s.serverId)).toEqual([alpha]);
    expect(all.skipped).toEqual([]);
    // Another org's server is never reached, even for its owner's org admin
    expect((await fleet(admin, `?serverIds=${elsewhere}`)).servers).toEqual([]);
  });

  it('answers with partial results: a server that does not answer in time is an error on its own row', async () => {
    fleetLimits.timeoutMs = 200;
    const [stuck] = await hangingServers('stuck', 1);
    const res = await fleet(viewer, `?serverIds=${alpha},${stuck}`);
    const byId = new Map(res.servers.map((s) => [s.serverId, s]));
    expect(byId.get(alpha)).toMatchObject({ ok: true });
    expect(byId.get(stuck!)).toMatchObject({ ok: false, containers: [] });
    expect(byId.get(stuck!)!.error).toMatch(/No answer within/);
  });

  it('reports a Docker failure on its server’s row with its code', async () => {
    fake.options.socketDenied = true;
    // A fresh probe is needed for the failure to show; charlie-like server never detected
    const fresh = await server(orgId, admin.userId, 'echo');
    const res = await fleet(viewer, `?serverIds=${fresh},${alpha}`);
    const echo = res.servers.find((s) => s.serverId === fresh)!;
    expect(echo).toMatchObject({ ok: false, code: 'DOCKER_PERMISSION_DENIED' });
    // Alpha was already detected: the list itself is refused by the same socket
    expect(res.servers.find((s) => s.serverId === alpha)!.ok).toBe(false);
  });

  it('asks at most five servers at once', async () => {
    fleetLimits.timeoutMs = 300;
    const ids = await hangingServers('busy', 7);
    fake.hanging.length = 0;
    const pending = fleet(viewer, `?serverIds=${ids.join(',')}`);
    await sleep(150);
    expect(fake.hanging.filter((u) => u.startsWith('busy-'))).toHaveLength(5);
    const res = await pending;
    expect(fake.hanging.filter((u) => u.startsWith('busy-'))).toHaveLength(7);
    expect(res.servers.every((s) => !s.ok)).toBe(true);
  });

  it('stops asking servers when the browser leaves', async () => {
    fleetLimits.timeoutMs = 2_000;
    const ids = await hangingServers('gone', 7);
    fake.hanging.length = 0;
    const abort = new AbortController();
    const request = fetch(`${base}/api/docker/containers?serverIds=${ids.join(',')}`, {
      headers: viewer.headers,
      signal: abort.signal,
    }).catch((err: unknown) => err);
    await sleep(150);
    expect(fake.hanging).toHaveLength(5);
    abort.abort();
    await request;
    // The first five are cancelled rather than waited out, and the last two never asked
    await sleep(300);
    expect(fake.hanging).toHaveLength(5);
  });

  it('container alerts are an org opt-in, off by default, turned on by admins only and audited', async () => {
    expect((await get(viewer, '/api/docker/settings')).json()).toMatchObject({ containerAlerts: false });
    const patch = (who: Who, payload: object) =>
      app.inject({ method: 'PATCH', url: '/api/docker/settings', headers: who.headers, payload });
    expect((await patch(operator, { containerAlerts: true })).statusCode).toBe(403);
    expect((await patch(admin, { containerAlerts: 'yes' })).statusCode).toBe(400);
    const res = await patch(admin, { containerAlerts: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ containerAlerts: true, operatorsCanExec: true });
    const audited = getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'org.docker_settings')))
      .all()
      .map((r) => JSON.parse(r.metadata!) as { before: object; after: object });
    expect(audited).toEqual([
      expect.objectContaining({ before: expect.objectContaining({ containerAlerts: false }), after: expect.objectContaining({ containerAlerts: true }) }),
    ]);
  });

  it('needs a session, and validates the query', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/docker/containers' })).statusCode).toBe(401);
    const many = Array.from({ length: 201 }, (_, i) => `s${i}`).join(',');
    expect((await get(viewer, `/api/docker/containers?serverIds=${many}`)).statusCode).toBe(400);
  });
});

describe('mapPooled', () => {
  it('keeps input order, bounds concurrency and skips the rest once aborted', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPooled([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(n * 5);
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);

    const abort = new AbortController();
    const seen: number[] = [];
    const partial = await mapPooled(
      [1, 2, 3, 4],
      1,
      async (n) => {
        seen.push(n);
        if (n === 2) abort.abort();
        return n;
      },
      abort.signal,
      () => -1,
    );
    expect(seen).toEqual([1, 2]);
    expect(partial).toEqual([1, 2, -1, -1]);
  });
});
