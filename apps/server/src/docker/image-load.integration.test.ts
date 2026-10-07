import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'ssh2';

/**
 * Uploading an image and putting it into service, against a real daemon
 * behind a real sshd — the same throwaway `docker:dind` + `openssh-server`
 * pair as docker.integration.test.ts, with the Docker CLI and its compose
 * plugin in the sshd container (as for compose.integration.test.ts):
 *
 *   (start smt-it-dind and smt-it-sshd as in docker.integration.test.ts, then)
 *   docker exec smt-it-sshd apk add --no-cache docker-cli docker-cli-compose
 *
 *   SMT_TEST_DOCKER_SSH_HOST=127.0.0.1 SMT_TEST_DOCKER_SSH_PORT=22422 \
 *     pnpm vitest run src/docker/image-load.integration.test.ts
 *
 * What the user's old one-liner did (`docker save | gzip`, copy, `gunzip |
 * docker load`, `compose up -d <service>`), through the API: a one-service
 * compose project runs `smt-it-upload:latest` (busybox, tagged); a second
 * image is made from it on the server, saved and gzipped there and
 * downloaded here, then removed from the engine — so the only way back in is
 * the upload. It is uploaded through the route, the service is recreated with
 * `up -d --no-deps`, and its container must run the uploaded image's id.
 * Also: an image saved for another architecture is flagged, and the cleanup
 * of the image a tag replaced keeps one that is still tagged elsewhere.
 * Everything it created is removed afterwards.
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

/** Run a command on an exec channel; resolves with its stdout as bytes, all output as text, and the exit code. */
function exec(ssh: Client, command: string): Promise<{ stdout: Buffer; out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    ssh.exec(command, (err, channel) => {
      if (err) return reject(err);
      const stdout: Buffer[] = [];
      let out = '';
      let code: number | null = null;
      channel.on('data', (d: Buffer) => stdout.push(d));
      channel.stderr.on('data', (d: Buffer) => (out += d.toString()));
      channel.on('exit', (c: number | null) => (code = c));
      channel.on('close', () => {
        const bytes = Buffer.concat(stdout);
        resolve({ stdout: bytes, out: out + (bytes.length < 4096 ? bytes.toString() : ''), code });
      });
    });
  });
}

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
}

describe.skipIf(!host)('image upload and service update against a live daemon over SSH', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let serverId: string;
  const project = `smt-it-up-${Date.now().toString(36)}`;
  const dir = `/tmp/${project}`;
  const tag = `smt-it-upload-${Date.now().toString(36)}:latest`;
  const foreignTag = `smt-it-foreign-${Date.now().toString(36)}:latest`;
  let baseId = '';
  let archive: Buffer;

  const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: admin.headers, ...(payload && { payload }) });
  const onServer = (command: string[]) =>
    withDockerClient({ orgId, user: { id: admin.userId, email: 'it@test.local', displayName: 'it' } }, serverId, (ctx) =>
      exec(ctx.ssh, shellCommand(command)),
    );
  const docker = (...args: string[]) => onServer(['env', `DOCKER_HOST=unix://${socketPath}`, 'docker', ...args]);
  const composeOnServer = (...args: string[]) =>
    onServer(['sh', '-c', 'cd -- "$1" && shift && exec "$@"', 'sh', dir, 'env', `DOCKER_HOST=unix://${socketPath}`, 'docker', 'compose', '-p', project, ...args]);
  /** `docker save <ref> | gzip`, run on the server; the archive as bytes. */
  const saveGzipped = async (ref: string) => {
    const saved = await onServer(['sh', '-c', 'env DOCKER_HOST="$1" docker save "$2" | gzip', 'sh', `unix://${socketPath}`, ref]);
    expect(saved.code, saved.out).toBe(0);
    return saved.stdout;
  };
  const upload = async (body: Buffer, name: string) => {
    const res = await fetch(`${base}/api/docker/servers/${serverId}/images/load?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { ...admin.headers, 'content-type': 'application/octet-stream' },
      body,
    });
    return { status: res.status, events: sseEvents(await res.text()) };
  };

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('docker-load-it');
    admin = seedUser(orgId, 'admin');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const res = await api('POST', '/api/servers', { name: 'load-it', host, port, username, authType: 'password', password });
    expect(res.statusCode).toBe(201);
    serverId = res.json().id;
    expect((await api('PATCH', `/api/servers/${serverId}`, { dockerSocketPath: socketPath })).statusCode).toBe(200);

    // The running version: busybox under the project's tag
    const pulled = await docker('pull', image);
    expect(pulled.code, pulled.out).toBe(0);
    expect((await docker('tag', image, tag)).code).toBe(0);
    baseId = (await docker('image', 'inspect', '--format', '{{.Id}}', tag)).stdout.toString().trim();

    const yaml = ['services:', '  web:', `    image: ${tag}`, '    command: ["sleep", "3600"]', ''].join('\n');
    expect((await onServer(['mkdir', '-p', dir])).code).toBe(0);
    expect((await onServer(['sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', yaml, `${dir}/compose.yaml`])).code).toBe(0);
    const up = await composeOnServer('up', '--detach');
    expect(up.code, up.out).toBe(0);

    // The new version, built "elsewhere": committed from the old one with a label, saved under the
    // project's tag, then taken out of the engine again — the upload is the only way back in
    const tmp = `${project}-build`;
    expect((await docker('create', '--name', tmp, tag, 'true')).code).toBe(0);
    const committed = await docker('commit', '--change', 'LABEL smt.it.version=2', tmp);
    expect(committed.code, committed.out).toBe(0);
    const newId = committed.stdout.toString().trim();
    await docker('rm', tmp);
    expect((await docker('tag', newId, tag)).code).toBe(0);
    archive = await saveGzipped(tag);
    expect((await docker('tag', baseId, tag)).code).toBe(0);
    const removed = await docker('rmi', newId);
    expect(removed.code, removed.out).toBe(0);
  }, 300_000);

  afterAll(async () => {
    if (serverId) {
      await composeOnServer('down', '--remove-orphans').catch(() => {});
      await onServer(['rm', '-rf', dir]).catch(() => {});
      await docker('rmi', '--force', tag, foreignTag).catch(() => {});
    }
    await app?.close();
  }, 120_000);

  it('uploads a gzipped docker save archive straight into the engine', async () => {
    const res = await upload(archive, 'web.tar.gz');
    expect(res.status).toBe(200);
    expect(res.events[0]).toEqual({ type: 'uploaded', bytes: archive.length, format: 'gzip' });
    expect(res.events.some((e) => e.type === 'load' && (e.progress as { status: string }).status === `Loaded image: ${tag}`)).toBe(true);
    const result = res.events.find((e) => e.type === 'loaded')!.result as {
      images: Array<{ ref: string; id: string; replacedId: string | null; platformMismatch: boolean }>;
      warnings: string[];
    };
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ ref: tag, replacedId: baseId, platformMismatch: false });
    expect(result.images[0]!.id).not.toBe(baseId);
    expect(result.warnings).toEqual([]);
    expect(res.events.at(-1)).toEqual({ type: 'end' });

    const audited = getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'docker.image_load'), eq(auditLog.resourceId, serverId)))
      .get();
    expect(JSON.parse(audited!.metadata!)).toMatchObject({ file: 'web.tar.gz', bytes: archive.length, format: 'gzip', outcome: 'loaded' });
  }, 120_000);

  it('recreates just that service with up -d --no-deps, on the uploaded image', async () => {
    const loadedId = (await docker('image', 'inspect', '--format', '{{.Id}}', tag)).stdout.toString().trim();
    expect(loadedId).not.toBe(baseId);

    // The service's configured image is still read correctly after the tag moved
    const images = (await api('GET', `/api/docker/servers/${serverId}/compose/service-images`)).json() as Array<Record<string, unknown>>;
    expect(images).toContainEqual({ project, service: 'web', image: tag });

    const res = await api('POST', `/api/docker/servers/${serverId}/compose/${project}/services/web/up`);
    expect(res.statusCode).toBe(200);
    const got = sseEvents(res.body);
    expect(got.find((e) => e.type === 'exit'), res.body).toMatchObject({ exitCode: 0 });

    const containers = (await api('GET', `/api/docker/servers/${serverId}/containers?all=1`)).json() as Array<{
      composeProject: string | null;
      composeService: string | null;
      imageId: string;
      state: string;
    }>;
    const web = containers.filter((c) => c.composeProject === project && c.composeService === 'web');
    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({ imageId: loadedId, state: 'running' });
  }, 180_000);

  it('keeps the replaced image when another tag still names it', async () => {
    // busybox:latest still points at the image the project's tag used to
    const res = await api('DELETE', `/api/docker/servers/${serverId}/images/${encodeURIComponent(baseId)}?unused=1`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/still tagged/);
    expect((await docker('image', 'inspect', baseId)).code).toBe(0);
  }, 60_000);

  it('flags an image built for another architecture', async () => {
    const info = (await api('GET', `/api/docker/servers/${serverId}/info`)).json() as { architecture: string };
    const foreign = /^(x86_64|amd64)$/.test(info.architecture) ? 'linux/arm64' : 'linux/amd64';
    const pulled = await docker('pull', '--platform', foreign, image);
    expect(pulled.code, pulled.out).toBe(0);
    expect((await docker('tag', image, foreignTag)).code).toBe(0);
    const saved = await saveGzipped(foreignTag);
    // Back to the server's own busybox for everything else
    await docker('rmi', foreignTag);
    await docker('pull', image);

    const res = await upload(saved, 'foreign.tar.gz');
    expect(res.status).toBe(200);
    const result = res.events.find((e) => e.type === 'loaded')!.result as {
      images: Array<{ ref: string; architecture: string; platformMismatch: boolean }>;
      warnings: string[];
      serverPlatform: string;
    };
    expect(result.images[0]).toMatchObject({ ref: foreignTag, platformMismatch: true, architecture: foreign.split('/')[1] });
    expect(result.warnings[0]).toContain(`but this server is ${result.serverPlatform}`);
    expect(result.warnings[0]).toContain('exec format error');
  }, 180_000);
});
