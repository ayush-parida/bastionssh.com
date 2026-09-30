import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Runs only against a real Docker daemon behind a real sshd, both throwaway
 * containers — never the host's own Docker socket. A `docker:dind` daemon
 * listens on a socket in a shared volume, and an `openssh-server` container
 * mounts that volume, so the app reaches the daemon exactly as it would on a
 * server: SSH login, then a streamlocal channel to the socket.
 *
 *   docker network create smt-it-net
 *   docker volume create smt-it-dind-sock
 *   docker run -d --rm --privileged --name smt-it-dind --network smt-it-net \
 *     -e DOCKER_TLS_CERTDIR= -v smt-it-dind-sock:/sock docker:27-dind --host=unix:///sock/docker.sock
 *   docker run -d --rm --name smt-it-sshd --network smt-it-net -p 127.0.0.1:22422:2222 \
 *     -e USER_NAME=smt -e USER_PASSWORD=smt-it-pass -e PASSWORD_ACCESS=true \
 *     -v smt-it-dind-sock:/sock lscr.io/linuxserver/openssh-server
 *   docker exec smt-it-dind sh -c 'until [ -S /sock/docker.sock ]; do sleep 1; done; chmod 666 /sock/docker.sock'
 *   # The image ships with AllowTcpForwarding no, which OpenSSH applies to socket forwards too:
 *   docker exec smt-it-sshd sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /config/sshd/sshd_config
 *   docker restart smt-it-sshd
 *
 *   SMT_TEST_DOCKER_SSH_HOST=127.0.0.1 SMT_TEST_DOCKER_SSH_PORT=22422 \
 *     pnpm vitest run src/docker/docker.integration.test.ts
 *
 * To exercise the dial-stdio fallback instead, keep forwarding off, run
 * `docker exec smt-it-sshd apk add --no-cache docker-cli`, and add
 * SMT_TEST_DOCKER_TRANSPORT=dial-stdio.
 *
 *   docker stop smt-it-sshd smt-it-dind && docker volume rm smt-it-dind-sock && docker network rm smt-it-net
 *
 * Everything goes through the real API routes, pool, host key store, ssh2
 * and the Engine API. The test pulls `busybox` inside the dind daemon (so it
 * needs registry access from there) and removes its container afterwards.
 */

const host = process.env.SMT_TEST_DOCKER_SSH_HOST;
const port = Number(process.env.SMT_TEST_DOCKER_SSH_PORT ?? 22);
const username = process.env.SMT_TEST_DOCKER_SSH_USER ?? 'smt';
const password = process.env.SMT_TEST_DOCKER_SSH_PASSWORD ?? 'smt-it-pass';
const socketPath = process.env.SMT_TEST_DOCKER_SOCKET ?? '/sock/docker.sock';
const image = process.env.SMT_TEST_DOCKER_IMAGE ?? 'busybox:latest';
/** dial-stdio when sshd forbids socket forwarding and the server has the docker CLI. */
const transport = process.env.SMT_TEST_DOCKER_TRANSPORT ?? 'streamlocal';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { withDockerClient } = await import('./service.js');

describe.skipIf(!host)('docker against a live daemon over SSH', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let serverId: string;
  const name = `smt-it-${Date.now().toString(36)}`;

  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers: admin.headers, ...(payload && { payload }) });
  /** Engine calls the D1 API does not offer (pull, create, start, remove), over the same pooled connection. */
  const engine = <T>(fn: Parameters<typeof withDockerClient<T>>[2]) =>
    withDockerClient({ orgId, user: { id: admin.userId, email: 'it@test.local', displayName: 'it' } }, serverId, fn);

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('docker-it');
    admin = seedUser(orgId, 'admin');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const res = await api('POST', '/api/servers', { name: 'docker-it', host, port, username, authType: 'password', password });
    expect(res.statusCode).toBe(201);
    serverId = res.json().id;
    expect((await api('PATCH', `/api/servers/${serverId}`, { dockerSocketPath: socketPath })).statusCode).toBe(200);
  }, 60_000);

  afterAll(async () => {
    if (serverId) {
      await engine((ctx) => ctx.docker.text({ method: 'DELETE', path: `/containers/${name}`, query: { force: true } })).catch(
        () => {},
      );
    }
    await app?.close();
  });

  it(`detects Docker over ${transport} and records the engine and API versions`, async () => {
    const res = await api('POST', `/api/docker/servers/${serverId}/probe`);
    expect(res.statusCode).toBe(200);
    const probe = res.json();
    expect(probe).toMatchObject({ ok: true, transport, socketPath });
    expect(probe.version).toMatch(/^\d+\./);
    expect(probe.apiVersion).toMatch(/^1\.\d+$/);

    const info = (await api('GET', `/api/docker/servers/${serverId}/info`)).json();
    expect(info).toMatchObject({ transport, socketPath, serverVersion: probe.version });
  });

  it('lists a container it started, and follows its logs', async () => {
    await engine(async (ctx) => {
      const [repo, tag] = image.split(':');
      // Pull progress streams as JSON lines; read it to the end
      const pull = await ctx.docker.stream({ method: 'POST', path: '/images/create', query: { fromImage: repo, tag: tag ?? 'latest' } });
      for await (const _chunk of pull) {
        // progress
      }
      await ctx.docker.json({
        method: 'POST',
        path: '/containers/create',
        query: { name },
        body: { Image: image, Cmd: ['sh', '-c', 'i=0; while true; do echo "line $i"; i=$((i+1)); sleep 0.2; done'] },
      });
      await ctx.docker.text({ method: 'POST', path: `/containers/${name}/start` });
    });

    const list = (await api('GET', `/api/docker/servers/${serverId}/containers?all=1`)).json() as Array<{ name: string; state: string }>;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ name, state: 'running' })]));

    const abort = new AbortController();
    const res = await fetch(`${base}/api/docker/servers/${serverId}/containers/${name}/logs?follow=1&tail=5`, {
      headers: admin.headers,
      signal: abort.signal,
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!/line \d+[\s\S]*line \d+[\s\S]*line \d+/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    abort.abort();
    expect(text).toContain('"type":"logs"');
    expect(text).toMatch(/"stream":"stdout".*"text":"line \d+"/);
  }, 120_000);
});
