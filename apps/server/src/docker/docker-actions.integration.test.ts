import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { once } from 'node:events';
import WebSocket from 'ws';

/**
 * Actions and exec (D2, D3) against a real Docker daemon behind a real sshd,
 * both throwaway containers — the same harness as docker.integration.test.ts
 * (see there for the `docker run` lines; any free port works). Skipped unless
 * SMT_TEST_DOCKER_SSH_HOST is set. Never touches the host's own Docker socket.
 *
 *   SMT_TEST_DOCKER_SSH_HOST=127.0.0.1 SMT_TEST_DOCKER_SSH_PORT=22422 \
 *     pnpm vitest run src/docker/docker-actions.integration.test.ts
 *
 * Covers: stop and start through the routes, a shell (busybox has no bash, so
 * the /bin/sh fallback) with a TTY resize read back by `stty size`, and a
 * prune of a stopped container. Everything it creates is removed afterwards.
 */

const host = process.env.SMT_TEST_DOCKER_SSH_HOST;
const port = Number(process.env.SMT_TEST_DOCKER_SSH_PORT ?? 22);
const username = process.env.SMT_TEST_DOCKER_SSH_USER ?? 'smt';
const password = process.env.SMT_TEST_DOCKER_SSH_PASSWORD ?? 'smt-it-pass';
const socketPath = process.env.SMT_TEST_DOCKER_SOCKET ?? '/sock/docker.sock';
const image = process.env.SMT_TEST_DOCKER_IMAGE ?? 'busybox:latest';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { withDockerClient } = await import('./service.js');

const until = async (check: () => boolean | Promise<boolean>, ms = 20_000) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe.skipIf(!host)('docker actions and exec against a live daemon over SSH', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let wsBase: string;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let serverId: string;
  const suffix = Date.now().toString(36);
  const running = `smt-it-run-${suffix}`;
  const stopped = `smt-it-stopped-${suffix}`;

  const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: admin.headers, ...(payload && { payload }) });
  const engine = <T>(fn: Parameters<typeof withDockerClient<T>>[2]) =>
    withDockerClient({ orgId, user: { id: admin.userId, email: 'it@test.local', displayName: 'it' } }, serverId, fn);
  const stateOf = async (name: string) => {
    const list = (await api('GET', `/api/docker/servers/${serverId}/containers?all=1`)).json() as Array<{ name: string; state: string }>;
    return list.find((c) => c.name === name)?.state ?? null;
  };

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('docker-actions-it');
    admin = seedUser(orgId, 'admin');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    wsBase = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const res = await api('POST', '/api/servers', { name: 'docker-actions-it', host, port, username, authType: 'password', password });
    expect(res.statusCode).toBe(201);
    serverId = res.json().id;
    expect((await api('PATCH', `/api/servers/${serverId}`, { dockerSocketPath: socketPath })).statusCode).toBe(200);

    // The image, pulled through the route (progress over SSE)
    const [repo, tag] = image.split(':');
    const pull = await api('POST', `/api/docker/servers/${serverId}/images/pull`, { image: repo!, tag: tag ?? 'latest' });
    expect(pull.statusCode).toBe(200);
    expect(pull.body).toContain('"type":"end"');

    await engine(async (ctx) => {
      await ctx.docker.json({ method: 'POST', path: '/containers/create', query: { name: running }, body: { Image: image, Cmd: ['sleep', '600'] } });
      await ctx.docker.text({ method: 'POST', path: `/containers/${running}/start` });
      await ctx.docker.json({ method: 'POST', path: '/containers/create', query: { name: stopped }, body: { Image: image, Cmd: ['true'] } });
    });
  }, 180_000);

  afterAll(async () => {
    if (serverId) {
      for (const name of [running, stopped]) {
        await engine((ctx) => ctx.docker.text({ method: 'DELETE', path: `/containers/${name}`, query: { force: true } })).catch(() => {});
      }
    }
    await app?.close();
  });

  it('stops and starts a container', async () => {
    const stop = await api('POST', `/api/docker/servers/${serverId}/containers/${running}/stop`, { timeout: 1 });
    expect(stop.json()).toEqual({ changed: true });
    expect(await stateOf(running)).toBe('exited');
    // Already stopped: nothing to do, not an error
    expect((await api('POST', `/api/docker/servers/${serverId}/containers/${running}/stop`)).json()).toEqual({ changed: false });
    expect((await api('POST', `/api/docker/servers/${serverId}/containers/${running}/start`)).json()).toEqual({ changed: true });
    expect(await stateOf(running)).toBe('running');
  }, 60_000);

  it('opens a shell with a TTY that follows resizes', async () => {
    const res = await api('POST', `/api/docker/servers/${serverId}/containers/${running}/exec`, { cols: 100, rows: 30 });
    expect(res.statusCode, res.body).toBe(201);
    const session = res.json() as { sessionId: string; cmd: string[] };
    // busybox has no bash
    expect(session.cmd).toEqual(['/bin/sh']);

    const ws = new WebSocket(`${wsBase}/api/ssh-sessions/${session.sessionId}/ws`, { headers: admin.headers });
    let text = '';
    ws.on('message', (d: Buffer) => (text += d.toString()));
    await once(ws, 'open');
    ws.send('stty size\r');
    await until(() => /30 100/.test(text));

    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }));
    await new Promise((r) => setTimeout(r, 500));
    ws.send('stty size\r');
    await until(() => /43 132/.test(text));

    ws.send('exit\r');
    const [code] = (await once(ws, 'close')) as [number];
    expect(code).toBeGreaterThan(0);
  }, 60_000);

  it('ends the shell in the container when the session is closed', async () => {
    const res = await api('POST', `/api/docker/servers/${serverId}/containers/${running}/exec`, { cols: 80, rows: 24 });
    const session = res.json() as { sessionId: string };
    const ws = new WebSocket(`${wsBase}/api/ssh-sessions/${session.sessionId}/ws`, { headers: admin.headers });
    let text = '';
    ws.on('message', (d: Buffer) => (text += d.toString()));
    await once(ws, 'open');
    ws.send('echo ready\r');
    await until(() => text.includes('ready\r\n'));

    expect((await api('DELETE', `/api/ssh-sessions/${session.sessionId}`)).statusCode).toBe(204);
    const { getDb } = await import('../db/index.js');
    const { auditLog } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const ended = async () =>
      getDb()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'docker.exec_end'))
        .all()
        .map((r) => JSON.parse(r.metadata!) as { sessionId: string; exitCode: number | null })
        .find((m) => m.sessionId === session.sessionId);
    await until(async () => !!(await ended()));
    // Not left running in the container: the shell saw its input close and exited
    expect((await ended())!.exitCode).not.toBeNull();
  }, 60_000);

  it('prunes a stopped container, with a dry run first', async () => {
    const preview = (await api('GET', `/api/docker/servers/${serverId}/prune`)).json();
    expect(preview.containers.count).toBeGreaterThanOrEqual(1);
    const res = await api('POST', `/api/docker/servers/${serverId}/prune`, { containers: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().containers.deleted).toBeGreaterThanOrEqual(1);
    expect(await stateOf(stopped)).toBeNull();
    expect(await stateOf(running)).toBe('running');
  }, 60_000);
});
