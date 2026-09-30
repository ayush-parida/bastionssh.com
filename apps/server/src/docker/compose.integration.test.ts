import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'ssh2';

/**
 * Compose (D4) against a real daemon behind a real sshd — the same throwaway
 * `docker:dind` + `openssh-server` pair as docker.integration.test.ts, with
 * the Docker CLI and its compose plugin installed in the sshd container (the
 * CLI runs where compose files live, i.e. on the "server"):
 *
 *   (start smt-it-dind and smt-it-sshd as in docker.integration.test.ts, then)
 *   docker exec smt-it-sshd apk add --no-cache docker-cli docker-cli-compose
 *
 *   SMT_TEST_DOCKER_SSH_HOST=127.0.0.1 SMT_TEST_DOCKER_SSH_PORT=22422 \
 *     pnpm vitest run src/docker/compose.integration.test.ts
 *
 * The test writes a one-service project (busybox) into a scratch directory
 * whose name needs quoting, starts it once over SSH (a project must exist to
 * be discovered), then drives it through the API: list, restart, logs, up,
 * down. It takes the project down and removes the directory afterwards.
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
const { shellCommand } = await import('./shell.js');
const { getDb } = await import('../db/index.js');
const { auditLog } = await import('../db/schema.js');
const { and, eq } = await import('drizzle-orm');

/** Run a command on an exec channel; resolves with its output and exit code. */
function exec(ssh: Client, command: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    ssh.exec(command, (err, channel) => {
      if (err) return reject(err);
      let out = '';
      let code: number | null = null;
      channel.on('data', (d: Buffer) => (out += d.toString()));
      channel.stderr.on('data', (d: Buffer) => (out += d.toString()));
      channel.on('exit', (c: number | null) => (code = c));
      channel.on('close', () => resolve({ out, code }));
    });
  });
}

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
}

describe.skipIf(!host)('docker compose against a live daemon over SSH', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let serverId: string;
  const project = `smt-it-${Date.now().toString(36)}`;
  // A space and a quote in the path: it only works if every argument is quoted
  const dir = `/tmp/${project} it's`;

  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers: admin.headers, ...(payload && { payload }) });
  const onServer = (command: string[]) =>
    withDockerClient({ orgId, user: { id: admin.userId, email: 'it@test.local', displayName: 'it' } }, serverId, (ctx) =>
      exec(ctx.ssh, shellCommand(command)),
    );
  const composeOnServer = (...args: string[]) =>
    onServer(['sh', '-c', 'cd -- "$1" && shift && exec "$@"', 'sh', dir, 'env', `DOCKER_HOST=unix://${socketPath}`, 'docker', 'compose', '-p', project, ...args]);

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('docker-compose-it');
    admin = seedUser(orgId, 'admin');
    app = await buildApp();

    const res = await api('POST', '/api/servers', { name: 'compose-it', host, port, username, authType: 'password', password });
    expect(res.statusCode).toBe(201);
    serverId = res.json().id;
    expect((await api('PATCH', `/api/servers/${serverId}`, { dockerSocketPath: socketPath })).statusCode).toBe(200);

    const yaml = [
      'services:',
      '  ticker:',
      `    image: ${image}`,
      '    command: ["sh", "-c", "i=0; while true; do echo tick $$i; i=$$((i+1)); sleep 0.5; done"]',
      '',
    ].join('\n');
    expect((await onServer(['mkdir', '-p', dir])).code).toBe(0);
    expect((await onServer(['sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', yaml, `${dir}/compose.yaml`])).code).toBe(0);
    const up = await composeOnServer('up', '--detach');
    expect(up.code, up.out).toBe(0);
  }, 180_000);

  afterAll(async () => {
    if (serverId) {
      await composeOnServer('down', '--remove-orphans').catch(() => {});
      await onServer(['rm', '-rf', dir]).catch(() => {});
    }
    await app?.close();
  }, 60_000);

  it('discovers the project from its labels', async () => {
    const list = (await api('GET', `/api/docker/servers/${serverId}/compose`)).json() as Array<Record<string, unknown>>;
    const found = list.find((p) => p.name === project);
    expect(found).toMatchObject({
      workingDir: dir,
      configFiles: [`${dir}/compose.yaml`],
      unmanageable: null,
      state: 'running',
      services: [expect.objectContaining({ name: 'ticker', running: 1 })],
    });
  });

  it('restarts it and runs up again, streaming output with exit code 0', async () => {
    for (const verb of ['restart', 'up']) {
      const res = await api('POST', `/api/docker/servers/${serverId}/compose/${project}/${verb}`);
      expect(res.statusCode).toBe(200);
      const got = sseEvents(res.body);
      expect(got.find((e) => e.type === 'exit'), res.body).toMatchObject({ exitCode: 0 });
      expect(got.at(-1)).toEqual({ type: 'end' });
    }
  }, 120_000);

  it('merges the service logs with a source prefix', async () => {
    const res = await api('GET', `/api/docker/servers/${serverId}/compose/${project}/logs?tail=5`);
    const lines = sseEvents(res.body)
      .filter((e) => e.type === 'logs')
      .flatMap((e) => e.lines as Array<{ source: string; text: string }>);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.source === 'ticker-1')).toBe(true);
    expect(lines.some((l) => /^tick \d+$/.test(l.text))).toBe(true);
  }, 60_000);

  it('takes it down: exit 0, audited, and no longer listed', async () => {
    const res = await api('POST', `/api/docker/servers/${serverId}/compose/${project}/down`);
    expect(sseEvents(res.body).find((e) => e.type === 'exit'), res.body).toMatchObject({ exitCode: 0 });
    const audited = getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'docker.compose_down'), eq(auditLog.resourceId, serverId)))
      .get();
    expect(JSON.parse(audited!.metadata!)).toMatchObject({ project, workingDir: dir, exitCode: 0 });
    const list = (await api('GET', `/api/docker/servers/${serverId}/compose`)).json() as Array<{ name: string }>;
    expect(list.map((p) => p.name)).not.toContain(project);
  }, 120_000);
});
