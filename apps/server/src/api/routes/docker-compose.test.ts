import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Compose routes end to end through the real pool, detection, discovery and
 * command building. ssh2 is the same stand-in as in docker.test.ts, reaching
 * an in-process fake daemon; `docker compose` exec channels are scripted here
 * (`fake.compose`). Under test: the role matrix, per-server 404s, quoting of
 * hostile labels, audit rows with exit codes, and what happens to a running
 * action or a merged log stream when the browser leaves or access is revoked.
 */
type ComposeChannel = import('node:stream').PassThrough & {
  stderr: import('node:stream').PassThrough;
  close: () => void;
  /** The remote command's output ends (`end()` is the app closing stdin, as on ssh2). */
  finish: () => void;
};

const fake = vi.hoisted(() => ({
  options: { daemonSocket: '', cli: true } as import('../../docker/fake-daemon.test-helper.js').FakeSshOptions,
  log: { streamlocal: [] as string[], exec: [] as string[] },
  clients: [] as { ended: boolean }[],
  /** Plays a `docker compose` run on its channel. */
  compose: null as null | ((command: string, channel: ComposeChannel) => void),
  /** Commands whose stdin the app closed. */
  stdinClosed: [] as string[],
}));

vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { fakeSshMethods } = await import('../../docker/fake-daemon.test-helper.js');
  // Methods and a closure map only — class fields in a vi.mock factory break the import
  const channels = new WeakMap<object, Set<{ destroy: () => void }>>();
  class Client extends EventEmitter {
    constructor() {
      super();
      const open = new Set<{ destroy: () => void }>();
      channels.set(this, open);
      const track = (s: import('node:net').Socket | ComposeChannel) => {
        open.add(s);
        s.on('close', () => open.delete(s));
      };
      const methods = fakeSshMethods(() => fake.options, fake.log, track);
      const exec = (command: string, cb: (err: Error | undefined, channel?: unknown) => void) => {
        if (!command.includes("'compose'")) return methods.exec(command, cb);
        fake.log.exec.push(command);
        const channel: ComposeChannel = Object.assign(new PassThrough(), {
          stderr: new PassThrough(),
          close: () => channel.destroy(),
          signal: () => {},
          finish: () => void Reflect.apply(PassThrough.prototype.end, channel, []),
          // ssh2: EOF on the remote stdin; the channel stays open
          end: () => {
            fake.stdinClosed.push(command);
            return channel;
          },
        });
        track(channel);
        setImmediate(() => {
          cb(undefined, channel);
          fake.compose?.(command, channel);
        });
      };
      Object.assign(this, { ended: false }, methods, { exec });
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

import { and, desc, eq } from 'drizzle-orm';
import type { DockerComposeProject } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, servers } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import { activeDockerStreamCount } from '../../docker/sse.js';
import { composeCommand } from '../../docker/compose.js';
import { shellQuote } from '../../docker/shell.js';
import { startFakeDaemon, type FakeContainer, type FakeDaemon } from '../../docker/fake-daemon.test-helper.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

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

const HOSTILE_DIR = `/srv/it's $(touch /tmp/PWNED); rm -rf / \`id\` --rm`;
const HOSTILE_FILE = `${HOSTILE_DIR}/-f;--project-name=evil.yaml`;

function composed(name: string, project: string, service: string, number: number, labels: Record<string, string> = {}): FakeContainer {
  return {
    Id: `${project}${service}${number}`.padEnd(64, 'f').replace(/[^a-f0-9]/g, 'e'),
    Names: [`/${project}-${service}-${number}`],
    Image: 'nginx',
    ImageID: 'sha256:' + '1'.repeat(64),
    State: 'running',
    Status: 'Up 1 minute',
    Labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.service': service,
      'com.docker.compose.container-number': String(number),
      'com.docker.compose.project.working_dir': `/srv/${project}`,
      'com.docker.compose.project.config_files': `/srv/${project}/compose.yaml`,
      ...labels,
    },
  };
}

describe('docker compose routes', () => {
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
  const post = (who: Who, url: string) => app.inject({ method: 'POST', url, headers: who.headers, payload: {} });
  const compose = (server: string, rest = '') => `/api/docker/servers/${server}/compose${rest}`;
  const audits = (action: string, serverId: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action as 'docker.compose_up'), eq(auditLog.resourceId, serverId)))
      .orderBy(desc(auditLog.createdAt))
      .all()
      .map((r) => ({ ...r, meta: JSON.parse(r.metadata ?? '{}') as Record<string, unknown> }));

  async function withPassword(orgOf: string, createdBy: string, name: string) {
    const id = seedServer(orgOf, createdBy, name);
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', id) })
      .where(eq(servers.id, id))
      .run();
    return id;
  }

  async function openStream(who: Who, path: string, method: 'GET' | 'POST' = 'GET') {
    const abort = new AbortController();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...who.headers, ...(method === 'POST' && { 'content-type': 'application/json' }) },
      ...(method === 'POST' && { body: '{}' }),
      signal: abort.signal,
    });
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
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    return { res, next, close: () => abort.abort() };
  }

  /** A run that prints two lines and exits with `code`. */
  const finishes =
    (code: number) =>
    (_command: string, ch: ComposeChannel) => {
      ch.write('Container blog-web-1  Starting\n');
      ch.stderr.write('Container blog-web-1  Started\n');
      setTimeout(() => {
        ch.emit('exit', code);
        ch.stderr.end();
        ch.finish();
      }, 5);
    };

  beforeAll(async () => {
    daemon = await startFakeDaemon();
    daemon.containers.push(
      composed('blog-web-1', 'blog', 'web', 1),
      composed('blog-api-1', 'blog', 'api', 1),
      composed('bad-web-1', 'bad', 'web', 1, {
        'com.docker.compose.project.working_dir': HOSTILE_DIR,
        'com.docker.compose.project.config_files': HOSTILE_FILE,
      }),
    );
    await runMigrations();
    orgId = seedOrg('org-compose');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');
    serverA = await withPassword(orgId, admin.userId, 'alpha');
    serverB = await withPassword(orgId, admin.userId, 'bravo');
    const otherOrg = seedOrg('org-compose-other');
    otherOrgServer = await withPassword(otherOrg, seedUser(otherOrg, 'admin').userId, 'elsewhere');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

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
    fake.compose = finishes(0);
  });

  describe('discovery', () => {
    it('lists projects from labels, for every role', async () => {
      const res = await get(viewer, compose(serverA));
      expect(res.statusCode).toBe(200);
      const projects = res.json() as DockerComposeProject[];
      expect(projects.map((p) => p.name)).toEqual(['bad', 'blog', 'shop']);
      const blog = projects.find((p) => p.name === 'blog')!;
      expect(blog).toMatchObject({
        workingDir: '/srv/blog',
        configFiles: ['/srv/blog/compose.yaml'],
        unmanageable: null,
        running: 2,
        total: 2,
        state: 'running',
      });
      expect(blog.services.map((s) => s.name)).toEqual(['api', 'web']);
      // The default fake containers carry no working dir: listed, but not actionable
      const shop = projects.find((p) => p.name === 'shop')!;
      expect(shop).toMatchObject({ state: 'partial', running: 1, total: 2 });
      expect(shop.unmanageable).toMatch(/working directory/);
      // The label filter reached the daemon
      expect(daemon.requests.at(-1)).toContain(encodeURIComponent('"label":["com.docker.compose.project"]'));
    });
  });

  describe('access', () => {
    it('lets operators and up act and read logs, not viewers', async () => {
      expect((await post(viewer, compose(serverA, '/blog/up'))).statusCode).toBe(403);
      expect((await get(viewer, compose(serverA, '/blog/logs'))).statusCode).toBe(403);
      for (const who of [operator, admin, owner]) {
        const res = await post(who, compose(serverA, '/blog/restart'));
        expect(res.statusCode).toBe(200);
        expect(events(res.body).at(-1)).toEqual({ type: 'end' });
        expect((await get(who, compose(serverA, '/blog/logs'))).statusCode).toBe(200);
      }
    });

    it('answers 404 for servers the caller cannot access', async () => {
      expect((await get(restricted, compose(serverB))).statusCode).toBe(404);
      expect((await post(restricted, compose(serverB, '/blog/up'))).statusCode).toBe(404);
      expect((await get(restricted, compose(serverB, '/blog/logs'))).statusCode).toBe(404);
      expect((await get(restricted, compose(serverA))).statusCode).toBe(200);
      expect((await get(owner, compose(otherOrgServer))).statusCode).toBe(404);
      expect((await post(owner, compose(otherOrgServer, '/blog/down'))).statusCode).toBe(404);
      expect((await get(owner, compose('does-not-exist'))).statusCode).toBe(404);
    });

    it('answers 400 when Docker is off for the server', async () => {
      const id = await withPassword(orgId, admin.userId, 'charlie');
      expect((await app.inject({ method: 'PATCH', url: `/api/servers/${id}`, headers: admin.headers, payload: { dockerMode: 'off' } })).statusCode).toBe(200);
      expect((await get(operator, compose(id))).json()).toMatchObject({ code: 'DOCKER_DISABLED' });
      expect((await post(operator, compose(id, '/blog/up'))).statusCode).toBe(400);
    });
  });

  describe('actions', () => {
    it('runs the fixed verb in the working dir, streams output, and audits the exit code', async () => {
      fake.log.exec = [];
      const res = await post(operator, compose(serverA, '/blog/up'));
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      const got = events(res.body);
      const lines = got.filter((e) => e.type === 'logs').flatMap((e) => e.lines as unknown[]);
      expect(lines).toEqual([
        { stream: 'stdout', text: 'Container blog-web-1  Starting' },
        { stream: 'stderr', text: 'Container blog-web-1  Started' },
      ]);
      expect(got.at(-2)).toMatchObject({ type: 'exit', exitCode: 0, signal: null, timedOut: false });
      expect(got.at(-1)).toEqual({ type: 'end' });

      const project = { name: 'blog', workingDir: '/srv/blog', configFiles: ['/srv/blog/compose.yaml'] };
      expect(fake.log.exec).toEqual([composeCommand({ project, socketPath: '/var/run/docker.sock' }, 'up')]);
      expect(fake.log.exec[0]).toContain(`'--project-name=blog' '--project-directory=/srv/blog' '--file=/srv/blog/compose.yaml' 'up' '--detach'`);
      // Nothing is typed into compose: its stdin is closed as soon as it runs
      expect(fake.stdinClosed).toContain(fake.log.exec[0]);

      const [row] = audits('docker.compose_up', serverA);
      expect(row).toMatchObject({ actorId: operator.userId, resourceType: 'server', resourceName: 'alpha' });
      expect(row!.meta).toMatchObject({
        project: 'blog',
        workingDir: '/srv/blog',
        configFiles: ['/srv/blog/compose.yaml'],
        command: 'docker compose -p blog up --detach',
        exitCode: 0,
      });
      expect(row!.meta.durationMs).toBeTypeOf('number');
    });

    it('audits a failing action with its exit code', async () => {
      fake.compose = finishes(17);
      const got = events((await post(operator, compose(serverA, '/blog/pull'))).body);
      expect(got.find((e) => e.type === 'exit')).toMatchObject({ exitCode: 17 });
      expect(audits('docker.compose_pull', serverA)[0]!.meta).toMatchObject({ project: 'blog', exitCode: 17 });
    });

    it('passes hostile label values as single quoted arguments', async () => {
      fake.log.exec = [];
      const res = await post(operator, compose(serverA, '/bad/down'));
      expect(res.statusCode).toBe(200);
      const command = fake.log.exec[0]!;
      expect(command).toContain(shellQuote(HOSTILE_DIR));
      expect(command).toContain(shellQuote(`--project-directory=${HOSTILE_DIR}`));
      expect(command).toContain(shellQuote(`--file=${HOSTILE_FILE}`));
      // Nothing from the labels appears unquoted: stripping the quoted arguments leaves only spaces
      const quoted = /'[^']*'(?:\\''[^']*')*/g;
      expect(command.replace(quoted, '').trim()).toBe('');
      expect(audits('docker.compose_down', serverA)[0]!.meta).toMatchObject({ project: 'bad', workingDir: HOSTILE_DIR });
    });

    it('refuses unknown verbs, bad names, unknown and unusable projects', async () => {
      for (const verb of ['exec', 'run', 'rm', 'logs', 'up%20-d', 'up;id']) {
        expect((await post(operator, compose(serverA, `/blog/${verb}`))).statusCode, verb).toBeGreaterThanOrEqual(400);
      }
      expect((await post(operator, compose(serverA, '/blog/exec'))).statusCode).toBe(400);
      expect((await post(operator, compose(serverA, `/${encodeURIComponent('blog;id')}/up`))).statusCode).toBe(400);
      expect((await post(operator, compose(serverA, '/-p/up'))).statusCode).toBe(400);
      expect((await post(operator, compose(serverA, '/nope/up'))).json()).toMatchObject({ error: 'Compose project not found' });
      const unusable = await post(operator, compose(serverA, '/shop/up'));
      expect(unusable.statusCode).toBe(409);
      expect(unusable.json().error).toMatch(/working directory/);
    });

    it('refuses a second action on a project while one runs', async () => {
      let finish: () => void = () => {};
      fake.compose = (_c, ch) => {
        finish = () => {
          ch.emit('exit', 0);
          ch.finish();
        };
      };
      const first = await openStream(operator, compose(serverA, '/blog/restart'), 'POST');
      await until(() => fake.log.exec.some((c) => c.includes("'restart'")));
      const second = await post(admin, compose(serverA, '/blog/up'));
      expect(second.statusCode).toBe(409);
      // Another project is not blocked
      fake.compose = finishes(0);
      expect((await post(admin, compose(serverA, '/bad/restart'))).statusCode).toBe(200);
      finish();
      let e = await first.next();
      while (e && e.type !== 'exit') e = await first.next();
      expect(e).toMatchObject({ exitCode: 0 });
    });

    it('keeps running when the browser leaves, and audits the end', async () => {
      let finish: () => void = () => {};
      fake.compose = (_c, ch) => {
        ch.write('pulling\n');
        finish = () => {
          ch.emit('exit', 0);
          ch.finish();
        };
      };
      const before = audits('docker.compose_up', serverB).length;
      const stream = await openStream(operator, compose(serverB, '/blog/up'), 'POST');
      expect(await stream.next()).toMatchObject({ type: 'logs' });
      stream.close();
      await until(() => activeDockerStreamCount(operator.userId) === 0);
      expect(audits('docker.compose_up', serverB).length).toBe(before);
      finish();
      await until(() => audits('docker.compose_up', serverB).length === before + 1);
      expect(audits('docker.compose_up', serverB)[0]!.meta).toMatchObject({ exitCode: 0, detached: true });
    });

    it('stops the action when the user’s access is revoked, audited without an exit code', async () => {
      const who = seedUser(orgId, 'operator');
      fake.compose = (_c, ch) => ch.write('starting\n');
      const stream = await openStream(who, compose(serverA, '/blog/down'), 'POST');
      expect(await stream.next()).toMatchObject({ type: 'logs' });
      const revoked = revokeLiveAccess(who.userId, { orgId });
      expect(revoked.docker).toBeGreaterThanOrEqual(2);
      expect(await stream.next()).toMatchObject({ type: 'error', status: 403 });
      await until(() => audits('docker.compose_down', serverA).some((r) => r.actorId === who.userId));
      const row = audits('docker.compose_down', serverA).find((r) => r.actorId === who.userId)!;
      expect(row.meta).toMatchObject({ project: 'blog', exitCode: null });
    });
  });

  describe('service actions', () => {
    const service = (server: string, project: string, name: string, verb: string) =>
      compose(server, `/${project}/services/${encodeURIComponent(name)}/${verb}`);

    it('runs up --no-deps, restart, pull and stop on one service, audited with it', async () => {
      const project = { name: 'blog', workingDir: '/srv/blog', configFiles: ['/srv/blog/compose.yaml'] };
      for (const verb of ['up', 'restart', 'pull', 'stop'] as const) {
        fake.log.exec = [];
        const res = await post(operator, service(serverA, 'blog', 'web', verb));
        expect(res.statusCode, verb).toBe(200);
        expect(events(res.body).find((e) => e.type === 'exit'), verb).toMatchObject({ exitCode: 0 });
        expect(fake.log.exec).toEqual([composeCommand({ project, socketPath: '/var/run/docker.sock' }, verb, 'web')]);
      }
      expect(composeCommand({ project, socketPath: '/var/run/docker.sock' }, 'up', 'web')).toMatch(/ 'up' '--detach' '--no-deps' 'web'$/);
      expect(audits('docker.compose_up', serverA)[0]!.meta).toMatchObject({
        project: 'blog',
        service: 'web',
        command: 'docker compose -p blog up --detach --no-deps web',
        exitCode: 0,
      });
      expect(audits('docker.compose_stop', serverA)[0]!.meta).toMatchObject({ service: 'web', command: 'docker compose -p blog stop web' });
    });

    it('refuses hostile and unknown service names, and verbs a service does not take', async () => {
      fake.log.exec = [];
      for (const name of ['web;id', '-p', '--file=/etc/passwd', '.hidden', "web'", 'web web', '$(id)']) {
        const res = await post(operator, service(serverA, 'blog', name, 'up'));
        expect(res.statusCode, name).toBe(400);
      }
      // A valid name the project's containers do not carry never reaches the command line
      const ghost = await post(operator, service(serverA, 'blog', 'ghost', 'up'));
      expect(ghost.statusCode).toBe(404);
      expect(ghost.json().error).toBe('No such service in this project');
      for (const verb of ['down', 'exec', 'rm', 'run']) {
        expect((await post(operator, service(serverA, 'blog', 'web', verb))).statusCode, verb).toBe(400);
      }
      expect(fake.log.exec.filter((c) => c.includes("'compose'"))).toEqual([]);
    });

    it('follows the same gates as project actions', async () => {
      expect((await post(viewer, service(serverA, 'blog', 'web', 'up'))).statusCode).toBe(403);
      expect((await post(restricted, service(serverB, 'blog', 'web', 'up'))).statusCode).toBe(404);
      expect((await post(restricted, service(serverA, 'blog', 'web', 'restart'))).statusCode).toBe(200);
      expect((await post(operator, service(serverA, 'shop', 'web', 'up'))).statusCode).toBe(409);
      expect((await post(operator, service(serverA, 'nope', 'web', 'up'))).statusCode).toBe(404);
    });

    it('shares the project lock with project actions', async () => {
      let finish: () => void = () => {};
      fake.compose = (_c, ch) => {
        finish = () => {
          ch.emit('exit', 0);
          ch.finish();
        };
      };
      const first = await openStream(operator, compose(serverA, '/blog/up'), 'POST');
      await until(() => fake.log.exec.some((c) => c.includes("'up'")));
      expect((await post(admin, service(serverA, 'blog', 'web', 'restart'))).statusCode).toBe(409);
      finish();
      let e = await first.next();
      while (e && e.type !== 'exit') e = await first.next();
    });

    it('reads the image each service is configured with', async () => {
      expect((await get(viewer, compose(serverA, '/service-images'))).statusCode).toBe(200);
      const images = (await get(viewer, compose(serverA, '/service-images'))).json() as Array<Record<string, unknown>>;
      expect(images).toContainEqual({ project: 'blog', service: 'web', image: 'nginx' });
      expect(images).toContainEqual({ project: 'shop', service: 'web', image: 'nginx:1.27' });
      expect((await get(restricted, compose(serverB, '/service-images'))).statusCode).toBe(404);
    });
  });

  describe('logs', () => {
    it('merges the project’s container logs, tagged by source', async () => {
      const res = await get(operator, compose(serverA, '/blog/logs?tail=10&timestamps=1'));
      expect(res.statusCode).toBe(200);
      const got = events(res.body);
      expect(got.at(-1)).toEqual({ type: 'end' });
      expect(got.filter((e) => e.type === 'end')).toHaveLength(1);
      const lines = got.filter((e) => e.type === 'logs').flatMap((e) => e.lines as Array<Record<string, string>>);
      expect(new Set(lines.map((l) => l.source))).toEqual(new Set(['api-1', 'web-1']));
      expect(lines).toContainEqual({ stream: 'stderr', source: 'web-1', time: '2026-09-30T10:00:00.000000000Z', text: 'oops stderr' });
      expect(daemon.requests.filter((r) => r.includes('/logs?')).slice(-2).every((r) => r.includes('tail=10'))).toBe(true);
    });

    it('narrows to one service, validates it, and caps the tail', async () => {
      const got = events((await get(operator, compose(serverA, '/blog/logs?service=api'))).body);
      const sources = got.filter((e) => e.type === 'logs').flatMap((e) => (e.lines as Array<{ source: string }>).map((l) => l.source));
      expect(new Set(sources)).toEqual(new Set(['api-1']));
      expect((await get(operator, compose(serverA, '/blog/logs?service=nope'))).statusCode).toBe(404);
      expect((await get(operator, compose(serverA, `/blog/logs?service=${encodeURIComponent('-x;id')}`))).statusCode).toBe(400);
      expect((await get(operator, compose(serverA, '/blog/logs?tail=10001'))).statusCode).toBe(400);
      expect((await get(operator, compose(serverA, '/nope/logs'))).statusCode).toBe(404);
    });

    it('closes every daemon stream when the browser leaves', async () => {
      const logs = await openStream(operator, compose(serverA, '/blog/logs?follow=1&tail=0'));
      const seen = new Set<string>();
      while (seen.size < 2) {
        const e = await logs.next();
        for (const l of (e?.lines as Array<{ source: string }>) ?? []) seen.add(l.source);
      }
      expect(daemon.openStreams()).toBe(2);
      expect(activeDockerStreamCount(operator.userId)).toBe(1);
      logs.close();
      await until(() => daemon.openStreams() === 0 && activeDockerStreamCount(operator.userId) === 0);
    });
  });
});
