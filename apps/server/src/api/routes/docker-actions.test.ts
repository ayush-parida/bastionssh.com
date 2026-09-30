import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Docker actions (D2) end to end through the real pool, detection and client,
 * against the fake daemon with the Act endpoints (actions-daemon.test-helper.ts)
 * behind a stand-in ssh2. Under test: the §6 role matrix with the org
 * toggles, per-server 404s, validation, audit rows, pull progress and its
 * cancellation, prune and its dry run, and the env reveal step-up.
 */
const fake = vi.hoisted(() => ({
  options: { daemonSocket: '', cli: true } as import('../../docker/fake-daemon.test-helper.js').FakeSshOptions,
  log: { streamlocal: [] as string[], exec: [] as string[] },
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
    connect() {
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

import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, passkeys, servers, sessions } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { activeDockerStreamCount } from '../../docker/sse.js';
import { startFakeDaemon, type FakeDaemon } from '../../docker/fake-daemon.test-helper.js';
import { fakeEngine, type FakeEngine } from '../../docker/actions-daemon.test-helper.js';
import { seedOrg, seedServer, seedSession, seedUser } from './test-utils.js';

const WEB = 'a'.repeat(64);

type Who = { userId: string; headers: Record<string, string> };

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

describe('docker action routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let daemon: FakeDaemon;
  let engine: FakeEngine;
  let base: string;
  let orgId: string;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let serverA: string;
  let serverB: string;

  const call = (who: Pick<Who, 'headers'>, method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, ...(payload && { payload }) });
  const api = (path: string, server = serverA) => `/api/docker/servers/${server}${path}`;

  function audits(action: string) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .orderBy(desc(auditLog.createdAt))
      .all()
      .map((r) => ({ ...r, meta: JSON.parse(r.metadata ?? '{}') as Record<string, unknown> }));
  }

  /** A pull's audit row: written once the stream has ended, so possibly just after the response. */
  async function pullAudit(image: string) {
    const find = () => audits('docker.image_pull').find((r) => r.meta.image === image);
    await until(() => !!find());
    return find()!.meta;
  }

  async function withPassword(orgOf: string, createdBy: string, name: string) {
    const id = seedServer(orgOf, createdBy, name);
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', id) })
      .where(eq(servers.id, id))
      .run();
    return id;
  }

  /** Reset the fake containers to their starting state. */
  function resetContainers() {
    daemon.containers.splice(
      0,
      daemon.containers.length,
      { Id: WEB, Names: ['/web'], Image: 'nginx:1.27', ImageID: 'sha256:' + '1'.repeat(64), State: 'running', Status: 'Up', Env: ['DB_PASSWORD=hunter2', 'PATH=/usr/bin'] },
      { Id: 'b'.repeat(64), Names: ['/worker'], Image: 'busybox', ImageID: 'sha256:' + '2'.repeat(64), State: 'exited', Status: 'Exited (0)', Tty: true },
    );
  }

  beforeAll(async () => {
    engine = fakeEngine();
    daemon = await startFakeDaemon(engine.options);
    fake.options.daemonSocket = daemon.socketPath;
    await runMigrations();
    orgId = seedOrg('org-docker-actions');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');
    serverA = await withPassword(orgId, admin.userId, 'alpha');
    serverB = await withPassword(orgId, admin.userId, 'bravo');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const grant = await call(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, {
      serverAccess: 'restricted',
      serverIds: [serverA],
    });
    expect(grant.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await daemon.close();
  });

  beforeEach(async () => {
    fake.options = { daemonSocket: daemon.socketPath, cli: true };
    engine.failPull = false;
    engine.slowPull = false;
    resetContainers();
    await call(admin, 'PATCH', '/api/docker/settings', { operatorsCanExec: true, operatorsCanRemove: false, allowPrune: true });
  });

  describe('container lifecycle', () => {
    it('lets operators and up start, stop, restart, kill, pause and unpause; viewers cannot', async () => {
      expect((await call(viewer, 'POST', api(`/containers/web/stop`))).statusCode).toBe(403);
      for (const action of ['stop', 'start', 'restart', 'pause', 'unpause', 'kill']) {
        const res = await call(operator, 'POST', api(`/containers/web/${action}`));
        expect(res.statusCode, action).toBe(200);
        expect(res.json()).toEqual({ changed: true });
      }
      expect(engine.actions.slice(-6)).toEqual(['stop web', 'start web', 'restart web', 'pause web', 'unpause web', 'kill web']);
    });

    it('audits each action against the server, naming the container', async () => {
      await call(operator, 'POST', api('/containers/web/stop'), { timeout: 5 });
      const [row] = audits('docker.container_stop');
      expect(row).toMatchObject({ actorId: operator.userId, resourceType: 'server', resourceId: serverA, resourceName: 'alpha' });
      expect(row!.meta).toEqual({ container: { id: WEB, name: 'web' }, timeout: 5 });
      expect(engine.actions.at(-1)).toBe('stop web t=5');
    });

    it('treats "already in that state" as nothing changed, not an error', async () => {
      const res = await call(operator, 'POST', api('/containers/web/start'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ changed: false });
      expect(audits('docker.container_start')[0]!.meta).toMatchObject({ changed: false });
    });

    it('passes a kill signal, and validates it and the timeout', async () => {
      expect((await call(operator, 'POST', api('/containers/web/kill'), { signal: 'SIGTERM' })).statusCode).toBe(200);
      expect(engine.actions.at(-1)).toBe('kill web SIGTERM');
      expect((await call(operator, 'POST', api('/containers/web/kill'), { signal: 'TERM; rm -rf /' })).statusCode).toBe(400);
      expect((await call(operator, 'POST', api('/containers/web/stop'), { timeout: 9999 })).statusCode).toBe(400);
      expect((await call(operator, 'POST', api('/containers/web/stop'), { nope: 1 })).statusCode).toBe(400);
    });

    it('validates the container and passes the daemon’s 404 and 409 through', async () => {
      expect((await call(operator, 'POST', api('/containers/..%2Fimages/start'))).statusCode).toBe(400);
      const missing = await call(operator, 'POST', api('/containers/nope/start'));
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe('No such container: nope');
      const paused = await call(operator, 'POST', api('/containers/worker/pause'));
      expect(paused.statusCode).toBe(409);
    });

    it('answers 404 for servers the caller cannot access', async () => {
      expect((await call(restricted, 'POST', api('/containers/web/stop', serverB))).statusCode).toBe(404);
      expect((await call(restricted, 'POST', api('/containers/web/stop'))).statusCode).toBe(200);
      expect((await call(admin, 'POST', api('/containers/web/stop', 'nope'))).statusCode).toBe(404);
    });
  });

  describe('removing containers', () => {
    it('is admin-only unless operators may remove, and audited', async () => {
      expect((await call(viewer, 'DELETE', api('/containers/worker'))).statusCode).toBe(403);
      const refused = await call(operator, 'DELETE', api('/containers/worker'));
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toMatch(/not allowed for your role/);

      await call(admin, 'PATCH', '/api/docker/settings', { operatorsCanRemove: true });
      expect((await call(operator, 'DELETE', api('/containers/worker?volumes=1'))).statusCode).toBe(204);
      expect(engine.actions.at(-1)).toBe('remove worker volumes');
      expect(audits('docker.container_remove')[0]!.meta).toMatchObject({
        container: { id: 'b'.repeat(64), name: 'worker' },
        force: false,
        volumes: true,
      });
    });

    it('refuses a running container unless forced', async () => {
      const running = await call(admin, 'DELETE', api('/containers/web'));
      expect(running.statusCode).toBe(409);
      expect(running.json().error).toMatch(/cannot remove a running container/);
      expect((await call(admin, 'DELETE', api('/containers/web?force=1'))).statusCode).toBe(204);
      expect(daemon.containers.map((c) => c.Names[0])).toEqual(['/worker']);
    });

    it('answers 404 for servers the caller cannot access', async () => {
      await call(admin, 'PATCH', '/api/docker/settings', { operatorsCanRemove: true });
      expect((await call(restricted, 'DELETE', api('/containers/worker', serverB))).statusCode).toBe(404);
    });
  });

  describe('images', () => {
    it('pulls with progress over SSE, and audits the pull', async () => {
      const res = await call(operator, 'POST', api('/images/pull'), { image: 'ghcr.io/acme/app', tag: '1.2' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      const got = events(res.body);
      expect(got[1]).toEqual({ type: 'pull', progress: { id: 'layer1', status: 'Downloading', current: 50, total: 100 } });
      expect(got.at(-2)).toMatchObject({ type: 'pull', progress: { status: 'Status: Downloaded newer image for ghcr.io/acme/app:1.2' } });
      expect(got.at(-1)).toEqual({ type: 'end' });
      expect(engine.pulls.at(-1)).toBe('ghcr.io/acme/app:1.2');
      expect(await pullAudit('ghcr.io/acme/app:1.2')).toEqual({ image: 'ghcr.io/acme/app:1.2', outcome: 'pulled' });
    });

    it('pulls latest by default and keeps a digest', async () => {
      await call(operator, 'POST', api('/images/pull'), { image: 'nginx' });
      expect(engine.pulls.at(-1)).toBe('nginx:latest');
      const digest = 'sha256:' + 'c'.repeat(64);
      await call(operator, 'POST', api('/images/pull'), { image: `nginx@${digest}` });
      expect(engine.pulls.at(-1)).toBe(`nginx:${digest}`);
    });

    it('validates the reference before asking the daemon', async () => {
      const before = engine.pulls.length;
      for (const payload of [{ image: 'Nginx' }, { image: 'nginx;rm -rf /' }, { image: 'nginx:1', tag: '2' }, { image: 'nginx', tag: 'bad tag' }, { image: '' }]) {
        expect((await call(operator, 'POST', api('/images/pull'), payload)).statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(engine.pulls.length).toBe(before);
      expect((await call(viewer, 'POST', api('/images/pull'), { image: 'nginx' })).statusCode).toBe(403);
      expect((await call(restricted, 'POST', api('/images/pull', serverB), { image: 'nginx' })).statusCode).toBe(404);
    });

    it('answers a pull the daemon refuses as JSON, and ends a failed one with an error event', async () => {
      const refused = await call(operator, 'POST', api('/images/pull'), { image: 'private/missing' });
      expect(refused.statusCode).toBe(404);
      expect(refused.json().error).toMatch(/pull access denied/);

      engine.failPull = true;
      const failed = await call(operator, 'POST', api('/images/pull'), { image: 'flaky/app' });
      expect(events(failed.body).at(-1)).toMatchObject({ type: 'error', error: 'unexpected EOF' });
      expect(await pullAudit('flaky/app:latest')).toEqual({ image: 'flaky/app:latest', outcome: 'failed', error: 'unexpected EOF' });
    });

    it('cancels the pull when the browser leaves', async () => {
      engine.slowPull = true;
      const abort = new AbortController();
      const res = await fetch(`${base}${api('/images/pull')}`, {
        method: 'POST',
        headers: { ...operator.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ image: 'big/image' }),
        signal: abort.signal,
      });
      const reader = res.body!.getReader();
      await reader.read();
      expect(engine.openPulls()).toBe(1);
      abort.abort();
      await until(() => engine.openPulls() === 0 && activeDockerStreamCount(operator.userId) === 0);
      expect((await pullAudit('big/image:latest')).outcome).toBe('cancelled');
    });

    it('removes images for those who may remove, audited', async () => {
      expect((await call(operator, 'DELETE', api('/images/nginx:1.27'))).statusCode).toBe(403);
      const res = await call(admin, 'DELETE', api(`/images/${encodeURIComponent('ghcr.io/acme/app:1.2')}?force=1`));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ untagged: ['ghcr.io/acme/app:1.2'], deleted: ['sha256:' + '9'.repeat(64)] });
      expect(engine.removedImages.at(-1)).toBe('ghcr.io/acme/app:1.2 force');
      expect(audits('docker.image_remove')[0]!.meta).toEqual({
        image: 'ghcr.io/acme/app:1.2',
        force: true,
        untagged: ['ghcr.io/acme/app:1.2'],
        deleted: 1,
      });
      const busy = await call(admin, 'DELETE', api('/images/busy:1'));
      expect(busy.statusCode).toBe(409);
      expect((await call(admin, 'DELETE', api('/images/..%2F..%2Fcontainers'))).statusCode).toBe(400);
    });
  });

  describe('prune', () => {
    it('is admin-only and follows allowPrune', async () => {
      expect((await call(operator, 'GET', api('/prune'))).statusCode).toBe(403);
      expect((await call(operator, 'POST', api('/prune'), { containers: true })).statusCode).toBe(403);
      await call(admin, 'PATCH', '/api/docker/settings', { allowPrune: false });
      const off = await call(admin, 'POST', api('/prune'), { containers: true });
      expect(off.statusCode).toBe(403);
      expect(off.json().error).toMatch(/Pruning is turned off/);
      expect((await call(admin, 'GET', api('/prune'))).statusCode).toBe(403);
    });

    it('shows a dry run first', async () => {
      const res = await call(admin, 'GET', api('/prune'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        containers: { count: 1, size: 20 },
        // The fake's disk usage lists images without tags
        danglingImages: { count: 1, size: 400 },
        unusedImages: { count: 1, size: 400 },
        volumes: { count: 0, size: 0 },
        volumesIncludeNamed: false,
        networks: { count: 0, size: null },
      });
    });

    it('prunes what was asked for, in order, and audits what was reclaimed', async () => {
      expect((await call(admin, 'POST', api('/prune'), {})).statusCode).toBe(400);
      const res = await call(admin, 'POST', api('/prune'), { containers: true, images: true, volumes: true, networks: true, dangling: false });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        containers: { deleted: 2, reclaimed: 20 },
        images: { deleted: 1, reclaimed: 400 },
        volumes: { deleted: 1, reclaimed: 50 },
        networks: { deleted: 1 },
        reclaimed: 470,
      });
      expect(engine.prunes.slice(-4)).toEqual(['containers', 'networks', 'volumes', 'images {"dangling":["false"]}']);
      expect(audits('docker.prune')[0]!.meta).toMatchObject({ reclaimed: 470, requested: { images: true, dangling: false } });

      await call(admin, 'POST', api('/prune'), { images: true });
      expect(engine.prunes.at(-1)).toBe('images {"dangling":["true"]}');
    });

    it('answers 404 for servers the caller cannot access', async () => {
      const otherOrg = seedOrg('org-docker-actions-other');
      const outsider = seedUser(otherOrg, 'owner');
      expect((await call(outsider, 'POST', api('/prune'), { containers: true })).statusCode).toBe(404);
    });
  });

  describe('revealing the environment', () => {
    it('is refused to operators and to API tokens', async () => {
      expect((await call(operator, 'POST', api('/containers/web/env/reveal'))).statusCode).toBe(403);
      // Admin, but with a token rather than a browser session
      expect((await call(admin, 'POST', api('/containers/web/env/reveal'))).statusCode).toBe(403);
    });

    it('needs a passkey, then a step-up with it; audited with names only', async () => {
      const session = await seedSession(admin.userId);
      const noPasskey = await call(session, 'POST', api('/containers/web/env/reveal'));
      expect(noPasskey.statusCode).toBe(403);
      expect(noPasskey.json().code).toBe('DOCKER_REVEAL_NEEDS_PASSKEY');

      getDb()
        .insert(passkeys)
        .values({ id: nanoid(), userId: admin.userId, credentialId: nanoid(), publicKey: Buffer.from([1]), deviceType: 'multiDevice', name: 'Laptop' })
        .run();
      const stepUp = await call(session, 'POST', api('/containers/web/env/reveal'));
      expect(stepUp.statusCode).toBe(403);
      expect(stepUp.json().code).toBe('PASSKEY_STEP_UP_REQUIRED');

      getDb().update(sessions).set({ passkeyVerified: true }).where(eq(sessions.id, session.sessionId)).run();
      const res = await call(session, 'POST', api('/containers/web/env/reveal'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ env: ['DB_PASSWORD=hunter2', 'PATH=/usr/bin'] });
      const [row] = audits('docker.env_reveal');
      expect(row!.meta).toEqual({ container: { id: WEB, name: 'web' }, variables: ['DB_PASSWORD', 'PATH'] });
      expect(row!.metadata).not.toContain('hunter2');

      expect((await call(session, 'POST', api('/containers/web/env/reveal', 'nope'))).statusCode).toBe(404);
    });
  });
});
