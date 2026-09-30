import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Docker routes end to end through the real pool, detection and client: ssh2
 * is replaced by a stand-in whose channels reach an in-process fake daemon on
 * a Unix socket (docker/fake-daemon.test-helper.ts). What is under test is
 * access (roles, per-server 404s, Docker off), redaction, the event streams
 * and their cancellation, and revocation.
 */
const fake = vi.hoisted(() => ({
  options: { daemonSocket: '', cli: true } as import('../../docker/fake-daemon.test-helper.js').FakeSshOptions,
  log: { streamlocal: [] as string[], exec: [] as string[] },
  clients: [] as { ended: boolean }[],
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
        { ended: false },
        fakeSshMethods(
          () => fake.options,
          fake.log,
          (s) => {
            open.add(s);
            s.on('close', () => open.delete(s));
          },
        ),
      );
      fake.clients.push(this as unknown as { ended: boolean });
    }
    connect() {
      setImmediate(() => this.emit('ready'));
      return this;
    }
    end() {
      (this as unknown as { ended: boolean }).ended = true;
      for (const s of channels.get(this) ?? []) s.destroy();
      setImmediate(() => this.emit('close'));
      return this;
    }
  }
  return { ...actual, default: { ...(actual as { default?: object }).default, Client }, Client };
});

import { and, eq } from 'drizzle-orm';
import type { DockerContainer, DockerServerStatus } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, servers } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import { activeDockerStreamCount, MAX_STREAMS_PER_USER } from '../../docker/sse.js';
import { recordProbe } from '../../docker/probe.js';
import { startFakeDaemon, type FakeDaemon } from '../../docker/fake-daemon.test-helper.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

const WEB = 'a'.repeat(64);
const WORKER = 'b'.repeat(64);

type Who = { userId: string; headers: Record<string, string> };

/** Server-sent events in an injected body. */
function events(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
}

const until = async (check: () => boolean, ms = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('docker routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let daemon: FakeDaemon;
  let base: string;
  let orgId: string;
  let owner: Who;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let serverA: string;
  let serverB: string;
  let otherOrgServer: string;

  const get = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: who.headers });
  const send = (who: Who, method: 'POST' | 'PATCH', url: string, payload: object = {}) =>
    app.inject({ method, url, headers: who.headers, payload });
  const row = (id: string) => getDb().select().from(servers).where(eq(servers.id, id)).get()!;

  async function withPassword(orgOf: string, createdBy: string, name: string) {
    const id = seedServer(orgOf, createdBy, name);
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', id) })
      .where(eq(servers.id, id))
      .run();
    return id;
  }

  /** Open an SSE stream over real HTTP; returns a reader of parsed events and a way to drop it. */
  async function openStream(who: Who, path: string) {
    const abort = new AbortController();
    const res = await fetch(`${base}${path}`, { headers: who.headers, signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async (): Promise<Record<string, unknown> | null> => {
      for (;;) {
        const at = buffer.indexOf('\n\n');
        if (at !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith('data: ')) return JSON.parse(block.slice(6)) as Record<string, unknown>;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    return { res, next, close: () => abort.abort() };
  }

  beforeAll(async () => {
    daemon = await startFakeDaemon();
    fake.options.daemonSocket = daemon.socketPath;
    await runMigrations();
    orgId = seedOrg('org-docker');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');
    serverA = await withPassword(orgId, admin.userId, 'alpha');
    serverB = await withPassword(orgId, admin.userId, 'bravo');
    const otherOrg = seedOrg('org-docker-other');
    otherOrgServer = await withPassword(otherOrg, seedUser(otherOrg, 'admin').userId, 'elsewhere');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;

    const grant = await app.inject({
      method: 'PUT',
      url: `/api/team/members/${restricted.userId}/access`,
      headers: admin.headers,
      payload: { serverAccess: 'restricted', serverIds: [serverA] },
    });
    expect(grant.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await daemon.close();
  });

  beforeEach(() => {
    fake.options = { daemonSocket: daemon.socketPath, cli: true };
  });

  describe('detection', () => {
    it('detects Docker lazily on first use and records what it found', async () => {
      expect(row(serverA).dockerTransport).toBeNull();
      const res = await get(viewer, `/api/docker/servers/${serverA}/containers?all=1`);
      expect(res.statusCode).toBe(200);
      const list = res.json() as DockerContainer[];
      expect(list.map((c) => c.name)).toEqual(['web', 'worker']);
      expect(list[0]).toMatchObject({ state: 'running', health: 'healthy', composeProject: 'shop' });
      expect(row(serverA)).toMatchObject({
        dockerTransport: 'streamlocal',
        dockerDetectedSocketPath: '/var/run/docker.sock',
        dockerVersion: '27.3.1',
        dockerApiVersion: '1.47',
      });
      // Later calls use the pinned version
      expect(daemon.requests.at(-1)).toMatch(/^\/v1\.47\/containers\/json/);
    });

    it('lets admins probe, audited; nobody else', async () => {
      expect((await send(operator, 'POST', `/api/docker/servers/${serverB}/probe`)).statusCode).toBe(403);
      const res = await send(admin, 'POST', `/api/docker/servers/${serverB}/probe`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, transport: 'streamlocal', apiVersion: '1.47' });
      const audited = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'docker.probe'), eq(auditLog.resourceId, serverB)))
        .get();
      expect(JSON.parse(audited!.metadata!)).toMatchObject({ ok: true, transport: 'streamlocal' });
    });

    it('explains a failed detection, with the hint', async () => {
      fake.options.socketDenied = true;
      const probe = await send(admin, 'POST', `/api/docker/servers/${serverB}/probe`);
      expect(probe.json()).toMatchObject({ ok: false, problem: 'permission_denied' });
      // The failed probe forgot the old detection, so the next use detects again and says why
      expect(row(serverB).dockerTransport).toBeNull();
      const list = await get(operator, `/api/docker/servers/${serverB}/containers`);
      expect(list.statusCode).toBe(403);
      expect(list.json()).toMatchObject({ code: 'DOCKER_PERMISSION_DENIED' });
      expect(list.json().hint).toContain('usermod -aG docker root');
    });
  });

  describe('access', () => {
    it('lets every role list, and only operators and up read logs, stats, top and inspect', async () => {
      for (const path of ['containers', 'images', 'volumes', 'networks', 'info']) {
        expect((await get(viewer, `/api/docker/servers/${serverA}/${path}`)).statusCode).toBe(200);
      }
      for (const path of [`containers/${WEB}`, `containers/${WEB}/logs`, `containers/${WEB}/stats`, `containers/${WEB}/top`, `containers/${WEB}/logs/download`, 'images/nginx:1.27']) {
        const res = await get(viewer, `/api/docker/servers/${serverA}/${path}`);
        expect(res.statusCode, path).toBe(403);
      }
      for (const path of [`containers/${WEB}`, `containers/${WEB}/logs`, `containers/${WEB}/top`, 'images/nginx:1.27']) {
        expect((await get(operator, `/api/docker/servers/${serverA}/${path}`)).statusCode, path).toBe(200);
      }
    });

    it('answers 404 for servers the caller cannot access', async () => {
      expect((await get(restricted, `/api/docker/servers/${serverB}/containers`)).statusCode).toBe(404);
      expect((await get(restricted, `/api/docker/servers/${serverB}/containers/${WEB}/logs`)).statusCode).toBe(404);
      expect((await get(restricted, `/api/docker/servers/${serverB}`)).statusCode).toBe(404);
      expect((await get(restricted, `/api/docker/servers/${serverA}/containers`)).statusCode).toBe(200);
      expect((await get(owner, `/api/docker/servers/${otherOrgServer}/containers`)).statusCode).toBe(404);
      expect((await get(owner, `/api/docker/servers/does-not-exist/containers`)).statusCode).toBe(404);
      expect((await send(admin, 'POST', `/api/docker/servers/${otherOrgServer}/probe`)).statusCode).toBe(404);
    });

    it('reports each role’s permissions, following the org settings', async () => {
      const perms = async (who: Who) =>
        ((await get(who, `/api/docker/servers/${serverA}`)).json() as DockerServerStatus).permissions;
      expect(await perms(viewer)).toMatchObject({ view: true, inspect: false, exec: false, prune: false });
      expect(await perms(operator)).toMatchObject({ inspect: true, control: true, exec: true, remove: false, prune: false });
      expect(await perms(admin)).toMatchObject({ remove: true, prune: true, revealEnv: true, configure: true });

      const res = await send(admin, 'PATCH', '/api/docker/settings', { operatorsCanRemove: true, operatorsCanExec: false });
      expect(res.statusCode).toBe(200);
      expect(await perms(operator)).toMatchObject({ exec: false, remove: true });
      await send(admin, 'PATCH', '/api/docker/settings', { operatorsCanRemove: false, operatorsCanExec: true });
    });
  });

  describe('org settings', () => {
    it('starts at the defaults and is changed by owners and admins only, audited', async () => {
      const org = seedOrg('org-docker-settings');
      const orgAdmin = seedUser(org, 'admin');
      const orgOperator = seedUser(org, 'operator');
      expect((await get(orgOperator, '/api/docker/settings')).json()).toEqual({
        operatorsCanExec: true,
        operatorsCanRemove: false,
        allowPrune: true,
        containerAlerts: false,
      });
      expect((await send(orgOperator, 'PATCH', '/api/docker/settings', { allowPrune: false })).statusCode).toBe(403);
      expect((await send(orgAdmin, 'PATCH', '/api/docker/settings', { nope: true })).statusCode).toBe(400);
      const res = await send(orgAdmin, 'PATCH', '/api/docker/settings', { allowPrune: false });
      expect(res.json()).toMatchObject({ allowPrune: false, operatorsCanExec: true });
      const audited = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'org.docker_settings'), eq(auditLog.orgId, org)))
        .get();
      expect(JSON.parse(audited!.metadata!)).toMatchObject({ before: { allowPrune: true }, after: { allowPrune: false } });
    });
  });

  describe('server settings', () => {
    it('turns Docker off per server: routes answer 400, the status still loads', async () => {
      const id = await withPassword(orgId, admin.userId, 'charlie');
      expect((await send(operator, 'PATCH', `/api/servers/${id}`, { dockerMode: 'off' })).statusCode).toBe(403);
      const res = await send(admin, 'PATCH', `/api/servers/${id}`, { dockerMode: 'off' });
      expect(res.statusCode).toBe(200);
      expect(res.json().docker).toMatchObject({ mode: 'off' });

      const list = await get(operator, `/api/docker/servers/${id}/containers`);
      expect(list.statusCode).toBe(400);
      expect(list.json()).toMatchObject({ code: 'DOCKER_DISABLED' });
      expect((await get(operator, `/api/docker/servers/${id}/events`)).statusCode).toBe(400);
      expect((await get(operator, `/api/docker/servers/${id}`)).json().docker.mode).toBe('off');

      const audited = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'server.update'), eq(auditLog.resourceId, id)))
        .get();
      expect(JSON.parse(audited!.metadata!)).toEqual({ dockerMode: { from: 'auto', to: 'off' } });
    });

    it('clears what was detected when the socket path changes, and validates it', async () => {
      const id = await withPassword(orgId, admin.userId, 'delta');
      await get(operator, `/api/docker/servers/${id}/containers`);
      expect(row(id).dockerTransport).toBe('streamlocal');

      expect((await send(admin, 'PATCH', `/api/servers/${id}`, { dockerSocketPath: 'relative.sock' })).statusCode).toBe(400);
      expect((await send(admin, 'PATCH', `/api/servers/${id}`, { dockerSocketPath: '/tmp/$(id).sock' })).statusCode).toBe(400);

      const res = await send(admin, 'PATCH', `/api/servers/${id}`, { dockerSocketPath: '/run/user/1000/docker.sock' });
      expect(res.statusCode).toBe(200);
      expect(res.json().docker).toMatchObject({ socketPath: '/run/user/1000/docker.sock', transport: null, version: null });

      // The override is the only socket tried; the fake has none there
      expect((await get(operator, `/api/docker/servers/${id}/containers`)).json()).toMatchObject({
        problem: 'daemon_not_running',
      });
      fake.options.remotePath = '/run/user/1000/docker.sock';
      expect((await get(operator, `/api/docker/servers/${id}/containers`)).statusCode).toBe(200);
      expect(row(id).dockerDetectedSocketPath).toBe('/run/user/1000/docker.sock');
    });

    it('drops a probe outcome for a socket path that changed while it ran', async () => {
      const id = await withPassword(orgId, admin.userId, 'delta-2');
      const found = (await send(admin, 'POST', `/api/docker/servers/${id}/probe`)).json();
      expect(found.ok).toBe(true);
      // The admin points the server elsewhere; a probe still running for the old path finishes after
      await send(admin, 'PATCH', `/api/servers/${id}`, { dockerSocketPath: '/run/podman/podman.sock' });
      recordProbe(id, found, null);
      expect(row(id)).toMatchObject({ dockerSocketPath: '/run/podman/podman.sock', dockerTransport: null });
      recordProbe(id, { ...found, socketPath: '/run/podman/podman.sock' }, '/run/podman/podman.sock');
      expect(row(id).dockerDetectedSocketPath).toBe('/run/podman/podman.sock');
    });
  });

  describe('pooled connections', () => {
    it('are dropped when the server is edited, its host key changes, or it is deleted', async () => {
      const id = await withPassword(orgId, admin.userId, 'echo');
      const live = () => fake.clients.filter((c) => !c.ended).length;
      const warm = async () => {
        expect((await get(operator, `/api/docker/servers/${id}/containers`)).statusCode).toBe(200);
        return live();
      };

      let before = await warm();
      expect((await send(admin, 'PATCH', `/api/servers/${id}`, { port: 2222 })).statusCode).toBe(200);
      await until(() => live() === before - 1);

      before = await warm();
      const forget = await app.inject({ method: 'DELETE', url: `/api/servers/${id}/host-key`, headers: admin.headers });
      expect(forget.statusCode).toBeLessThan(300);
      await until(() => live() === before - 1);

      before = await warm();
      expect((await app.inject({ method: 'DELETE', url: `/api/servers/${id}`, headers: admin.headers })).statusCode).toBe(204);
      await until(() => live() === before - 1);
    });
  });

  describe('reads', () => {
    it('redacts environment values in container and image inspect', async () => {
      const res = await get(operator, `/api/docker/servers/${serverA}/containers/web`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('hunter2');
      expect(res.json().Config.Env).toEqual(['DB_PASSWORD=••••', 'PATH=••••']);
      const image = await get(operator, `/api/docker/servers/${serverA}/images/nginx:1.27`);
      expect(image.body).not.toContain('abc');
    });

    it('validates ids and passes the daemon’s 404 through', async () => {
      expect((await get(operator, `/api/docker/servers/${serverA}/containers/..%2Fimages`)).statusCode).toBe(400);
      const missing = await get(operator, `/api/docker/servers/${serverA}/containers/nope`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe('No such container: nope');
      expect((await get(operator, `/api/docker/servers/${serverA}/containers/nope/logs`)).statusCode).toBe(404);
    });

    it('lists images with in-use and dangling flags, volumes and networks with usage', async () => {
      const images = (await get(viewer, `/api/docker/servers/${serverA}/images`)).json();
      expect(images).toMatchObject([
        { repoTags: ['nginx:1.27'], inUse: true, dangling: false },
        { repoTags: [], inUse: false, dangling: true },
      ]);
      expect((await get(viewer, `/api/docker/servers/${serverA}/volumes`)).json()).toMatchObject([{ name: 'data', inUse: true }]);
      expect((await get(viewer, `/api/docker/servers/${serverA}/networks`)).json()).toMatchObject([
        { name: 'bridge', containers: 2, subnets: ['172.17.0.0/16'] },
      ]);
    });

    it('returns engine info with disk usage', async () => {
      const info = (await get(viewer, `/api/docker/servers/${serverA}/info`)).json();
      expect(info).toMatchObject({
        serverVersion: '27.3.1',
        apiVersion: '1.47',
        transport: 'streamlocal',
        socketPath: '/var/run/docker.sock',
        containersRunning: 1,
        diskUsage: { images: { size: 1000, reclaimable: 400 }, containers: { reclaimable: 20 }, volumes: { reclaimable: 50 } },
      });
    });

    it('lists processes', async () => {
      expect((await get(operator, `/api/docker/servers/${serverA}/containers/web/top`)).json()).toEqual({
        titles: ['PID', 'CMD'],
        processes: [['1', 'nginx']],
      });
    });
  });

  describe('logs', () => {
    it('streams demultiplexed lines with their stream and time, then ends', async () => {
      const res = await get(operator, `/api/docker/servers/${serverA}/containers/web/logs?timestamps=1&tail=100`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      const got = events(res.body);
      expect(got.at(-1)).toEqual({ type: 'end' });
      const lines = got.filter((e) => e.type === 'logs').flatMap((e) => e.lines as unknown[]);
      expect(lines).toEqual([
        { stream: 'stdout', time: '2026-09-30T10:00:00.000000000Z', text: 'hello stdout' },
        { stream: 'stderr', time: '2026-09-30T10:00:00.000000000Z', text: 'oops stderr' },
      ]);
      expect(daemon.requests.at(-1)).toContain('tail=100');
    });

    it('reads a TTY container’s raw stream', async () => {
      const got = events((await get(operator, `/api/docker/servers/${serverA}/containers/${WORKER}/logs`)).body);
      const lines = got.filter((e) => e.type === 'logs').flatMap((e) => e.lines as Array<{ text: string }>);
      expect(lines.map((l) => l.text)).toEqual(['tty line one', 'tty line two']);
    });

    it('caps the tail', async () => {
      expect((await get(operator, `/api/docker/servers/${serverA}/containers/web/logs?tail=10001`)).statusCode).toBe(400);
    });

    it('downloads plain text, streamed', async () => {
      const res = await get(operator, `/api/docker/servers/${serverA}/containers/web/logs/download`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="web.log"');
      expect(res.body).toBe('hello stdout\noops stderr\n');
    });
  });

  describe('event streams', () => {
    it('stops reading from the daemon when the browser disconnects', async () => {
      const stats = await openStream(operator, `/api/docker/servers/${serverA}/containers/web/stats`);
      const first = await stats.next();
      expect(first).toMatchObject({ type: 'stats', sample: { memUsage: 200, memLimit: 1000, memPercent: 20, pids: 3 } });
      expect(daemon.openStreams()).toBe(1);
      expect(activeDockerStreamCount(operator.userId)).toBe(1);
      stats.close();
      await until(() => daemon.openStreams() === 0 && activeDockerStreamCount(operator.userId) === 0);
    });

    it('follows logs until the browser leaves', async () => {
      const logs = await openStream(operator, `/api/docker/servers/${serverA}/containers/web/logs?follow=1&tail=0`);
      const seen: string[] = [];
      while (seen.length < 4) {
        const e = await logs.next();
        for (const l of (e?.lines as Array<{ text: string }>) ?? []) seen.push(l.text);
      }
      expect(seen).toContain('tick 1');
      logs.close();
      await until(() => daemon.openStreams() === 0);
    });

    it('delivers engine events', async () => {
      const stream = await openStream(viewer, `/api/docker/servers/${serverA}/events`);
      expect(await stream.next()).toMatchObject({ type: 'event', event: { type: 'container', action: 'start', name: 'web' } });
      stream.close();
      await until(() => daemon.openStreams() === 0);
    });

    it(`caps open streams at ${MAX_STREAMS_PER_USER} per user`, async () => {
      const who = seedUser(orgId, 'viewer');
      const open = [];
      for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
        const s = await openStream(who, `/api/docker/servers/${serverA}/events`);
        await s.next();
        open.push(s);
      }
      const refused = await get(who, `/api/docker/servers/${serverA}/events`);
      expect(refused.statusCode).toBe(429);
      for (const s of open) s.close();
      await until(() => activeDockerStreamCount(who.userId) === 0 && daemon.openStreams() === 0);
    });

    it('ends a member’s logs stream when they are demoted below operator', async () => {
      const who = seedUser(orgId, 'operator');
      const logs = await openStream(who, `/api/docker/servers/${serverA}/containers/web/logs?follow=1&tail=0`);
      expect(await logs.next()).toMatchObject({ type: 'logs' });

      const demoted = await app.inject({
        method: 'PATCH',
        url: `/api/team/members/${who.userId}`,
        headers: admin.headers,
        payload: { role: 'viewer' },
      });
      expect(demoted.statusCode).toBe(200);
      let event = await logs.next();
      while (event?.type === 'logs') event = await logs.next();
      expect(event).toMatchObject({ type: 'error', status: 403 });
      expect(await logs.next()).toBeNull();
      await until(() => daemon.openStreams() === 0 && activeDockerStreamCount(who.userId) === 0);
      expect((await get(who, `/api/docker/servers/${serverA}/containers/web/logs`)).statusCode).toBe(403);
    });

    it('ends streams and pooled connections when the user’s access is revoked', async () => {
      const who = seedUser(orgId, 'operator');
      const stream = await openStream(who, `/api/docker/servers/${serverA}/events`);
      await stream.next();
      const clientsBefore = fake.clients.filter((c) => !c.ended).length;

      const revoked = revokeLiveAccess(who.userId, { orgId });
      expect(revoked.docker).toBeGreaterThanOrEqual(2); // the stream and the pooled connection

      expect(await stream.next()).toMatchObject({ type: 'error', status: 403 });
      expect(await stream.next()).toBeNull();
      await until(() => daemon.openStreams() === 0 && activeDockerStreamCount(who.userId) === 0);
      expect(fake.clients.filter((c) => !c.ended).length).toBe(clientsBefore - 1);
    });
  });
});
