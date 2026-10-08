import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Builds on the BastionSSH side against real services: a rootless BuildKit
 * (the `buildkit` service of deploy/docker/docker-compose.yml, with its
 * mutual-TLS certificates), and a throwaway `docker:dind` server reached
 * through an `openssh-server` (as in deploy/deploy.integration.test.ts).
 * Never the host's own Docker or the running stack.
 *
 *   # BuildKit: a compose project of its own, published on loopback, client certificates in $CLIENT
 *   #   (an override adds ports ["127.0.0.1:21934:1234"] to buildkit and binds $CLIENT to /tls/client in buildkit-tls)
 *   docker compose -p smt-bsb-live -f deploy/docker/docker-compose.yml -f override.yml --env-file dummy.env up -d buildkit
 *   # The server: dind + sshd, as in deploy.integration.test.ts, named smt-bsb-*, sshd on 127.0.0.1:22934
 *
 *   SMT_TEST_DEPLOY_SSH_HOST=127.0.0.1 SMT_TEST_DEPLOY_SSH_PORT=22934 SMT_TEST_DIND_CONTAINER=smt-bsb-dind \
 *   SMT_BUILDKIT_ADDR=tcp://127.0.0.1:21934 SMT_BUILDKIT_TLS_DIR=$CLIENT SMT_BUILDCTL_PATH=<buildctl for this host> \
 *   SMT_BUILD_WORK_DIR=$(mktemp -d) pnpm vitest run src/build/bastion-build.integration.test.ts
 *
 * Builds a small Next.js app (standalone) with `build.where: bastion` for the
 * server's platform: npm and `next build` run in BuildKit, never on the
 * server; the image is loaded into the server's Docker and served with the
 * usual release flow. Checks that a NEXT_PUBLIC_* value from the server's
 * .env is baked in while a value that is not a build arg is nowhere in the
 * image, that the upload's .env.local is left out, and that cancelling
 * mid-build leaves no image and no context folder. Needs registry and npm
 * access from BuildKit.
 */

const host = process.env.SMT_TEST_DEPLOY_SSH_HOST;
const port = Number(process.env.SMT_TEST_DEPLOY_SSH_PORT ?? 22);
const username = process.env.SMT_TEST_DEPLOY_SSH_USER ?? 'smt';
const password = process.env.SMT_TEST_DEPLOY_SSH_PASSWORD ?? 'bastion-it-pass';
const dind = process.env.SMT_TEST_DIND_CONTAINER;
const workDir = process.env.SMT_BUILD_WORK_DIR;
const live = !!(host && dind && process.env.SMT_BUILDKIT_ADDR && workDir);

const GREETING = 'hello-baked-at-build-4242';
const SERVER_SECRET = 'server-only-secret-9931';
const LOCAL_SECRET = 'local-file-secret-7781';

/** Run a command in the throwaway server's Docker (the dind container), never the host's. */
function onServer(script: string): string {
  return execFileSync('docker', ['exec', dind!, 'sh', '-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** A .tar.gz of `files` (path → content). */
function tarball(files: Record<string, string>): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-bsb-src-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const file = path.join(os.tmpdir(), `smt-bsb-${process.pid}-${Date.now()}.tar.gz`);
  execFileSync('tar', ['czf', file, '-C', dir, ...Object.keys(files)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const data = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(file, { force: true });
  return data;
}

const NEXT_APP = {
  'package.json': JSON.stringify({
    name: 'bsb-next',
    private: true,
    scripts: { build: 'next build', start: 'next start' },
    dependencies: { next: '15.5.4', react: '19.1.1', 'react-dom': '19.1.1' },
  }),
  'next.config.js': "module.exports = { output: 'standalone' };\n",
  'app/layout.js': 'export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n',
  'app/page.js': "'use client';\nexport default function Page() { return <p id=\"greeting\">{process.env.NEXT_PUBLIC_GREETING}</p>; }\n",
  // Never uploaded: its secret, and its NEXT_PUBLIC_ value, must not reach the build
  '.env.local': `LOCAL_ONLY_SECRET=${LOCAL_SECRET}\nNEXT_PUBLIC_GREETING=from-the-env-local-file\n`,
  '.env.example': 'NEXT_PUBLIC_GREETING=example\n',
};

describe.skipIf(!live)('builds on the BastionSSH side, live', () => {
  let app: Awaited<ReturnType<typeof import('../api/app.js').buildApp>>;
  let base: string;
  let admin: { headers: Record<string, string> };
  let serverId: string;

  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: admin.headers, ...(payload && { payload }) });
  const deployApi = (p = '') => `/api/deploy/servers/${serverId}${p}`;

  /** Deploy `source` to `name`, reading the stream as it comes; `onEvent` sees each event. */
  async function deploy(name: string, source: Buffer, onEvent?: (e: Record<string, unknown>) => void): Promise<Array<Record<string, unknown>>> {
    const form = new FormData();
    form.append('source', new Blob([source]), `${name}.tar.gz`);
    const res = await fetch(`${base}${deployApi(`/apps/${name}/deploy`)}`, { method: 'POST', body: form, headers: admin.headers });
    // Read the body only on a refusal: awaiting it here would wait for the whole stream
    if (res.headers.get('content-type') !== 'text/event-stream') throw new Error(`Not a stream (${res.status}): ${await res.text()}`);
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (!block.startsWith('data: ')) continue;
        const event = JSON.parse(block.slice(6)) as Record<string, unknown>;
        events.push(event);
        onEvent?.(event);
      }
    }
    return events;
  }
  const logText = (events: Array<Record<string, unknown>>) =>
    events
      .filter((e) => e.type === 'log')
      .flatMap((e) => (e.lines as Array<{ text: string }>).map((l) => l.text))
      .join('\n');

  beforeAll(async () => {
    const { buildApp } = await import('../api/app.js');
    const { runMigrations } = await import('../db/migrate.js');
    const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
    await runMigrations();
    admin = seedUser(seedOrg('bsb-it'), 'admin');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const res = await api('POST', '/api/servers', { name: 'bsb-it', host, port, username, authType: 'password', password });
    expect(res.statusCode, res.body).toBe(201);
    serverId = res.json().id;
    const setup = await api('POST', deployApi('/setup'));
    expect(setup.statusCode, setup.body).toBe(200);
  }, 600_000);

  afterAll(async () => {
    if (serverId) {
      for (const name of ['site1', 'slow1']) await api('DELETE', deployApi(`/apps/${name}?purge=true`)).catch(() => {});
    }
    await app?.close();
  });

  it('sees the builder and the server platform', async () => {
    const builder = (await api('GET', '/api/deploy/builder')).json();
    expect(builder).toMatchObject({ configured: true, reachable: true, error: null });
    const platform = (await api('GET', deployApi('/platform'))).json() as { platform: string };
    console.log(`[live] builder ${builder.platform} (BuildKit ${builder.version}), server ${platform.platform}, cache ${builder.cacheBytes} bytes of ${builder.cacheLimitBytes}`);
    expect(platform.platform).toMatch(/^linux\//);
    expect(builder.platforms).toContain(platform.platform);
  }, 60_000);

  it('builds a Next.js app on BastionSSH for the server, bakes NEXT_PUBLIC_* in, and serves it; the server never runs npm', async () => {
    const config =
      'name: site1\ndomains: [site1.test]\ntls: internal\nbuild: { type: nextjs, where: bastion }\nrun: { port: 3000 }\nhealthcheck: { path: /, timeout: 120s }\n';
    const put = await api('PUT', deployApi('/apps/site1/config'), { text: config });
    expect(put.statusCode, put.body).toBe(200);
    expect((await api('PUT', deployApi('/apps/site1/env/NEXT_PUBLIC_GREETING'), { value: GREETING })).statusCode).toBe(200);
    expect((await api('PUT', deployApi('/apps/site1/env/SERVER_ONLY_SECRET'), { value: SERVER_SECRET })).statusCode).toBe(200);
    const imagesBefore = onServer("docker images --format '{{.Repository}}:{{.Tag}}'");

    const started = Date.now();
    const events = await deploy('site1', tarball(NEXT_APP));
    const took = Date.now() - started;
    const log = logText(events);
    const result = events.find((e) => e.type === 'result') as { outcome: { release: string; result: string } } | undefined;
    expect(result?.outcome.result, log.slice(-4000)).toBe('success');
    const states = events.filter((e) => e.type === 'build').map((e) => e.state);
    expect(states).toEqual(expect.arrayContaining(['building', 'loading', 'deploying']));
    expect(log).toContain('Left out an environment file of the upload: .env.local');
    expect(log).toContain('Build args from .env: NEXT_PUBLIC_GREETING');
    // Build-arg values are masked in the log; the non-build-arg secret never reaches the builder
    expect(log).not.toContain(GREETING);
    expect(log).not.toContain(SERVER_SECRET);
    expect(log).not.toContain(LOCAL_SECRET);

    const release = result!.outcome.release;
    const tag = `bastion-site1:${release}`;
    const releases = (await api('GET', deployApi('/apps/site1/releases'))).json() as Array<Record<string, unknown>>;
    const rel = releases.find((r) => r.id === release)!;
    expect(rel).toMatchObject({ builtOn: 'bastion', current: true, result: 'success' });
    console.log(`[live] deploy took ${(took / 1000).toFixed(1)} s, build ${((rel.buildMs as number) / 1000).toFixed(1)} s, platform ${rel.platform}, image ${tag}`);

    // The server: the image was loaded, not built — no node build image pulled, no build containers or cache
    const images = onServer("docker images --format '{{.Repository}}:{{.Tag}}'");
    expect(images).toContain(tag);
    expect(images).not.toMatch(/^node:20/m);
    expect(imagesBefore).not.toMatch(/^node:20/m);
    expect(onServer("docker ps -a --format '{{.Image}} {{.Command}}'")).not.toMatch(/npm|next build/);
    expect(onServer("docker system df --format '{{.Type}} {{.TotalCount}}'")).toMatch(/Build Cache 0/);

    // Served by the release, with the NEXT_PUBLIC_ value from the server's .env (not .env.local's)
    const container = onServer(`docker ps --filter label=bastion.release=${release} --format '{{.Names}}'`).trim();
    expect(container).toBeTruthy();
    const html = onServer(`docker exec ${container} wget -qO- http://127.0.0.1:3000/`);
    expect(html).toContain(GREETING);
    expect(html).not.toContain('from-the-env-local-file');

    // The image: the baked value is there, the server-only secret and .env.local are not
    const count = (needle: string) => Number(onServer(`cid=$(docker create ${tag}); docker export $cid | grep -a -c '${needle}' || true; docker rm $cid >/dev/null`).trim() || '0');
    expect(count(GREETING)).toBeGreaterThan(0);
    expect(count(SERVER_SECRET)).toBe(0);
    expect(count(LOCAL_SECRET)).toBe(0);
    expect(onServer(`docker image inspect --format '{{json .Config.Env}}' ${tag}`)).not.toContain(SERVER_SECRET);
    expect(fs.readdirSync(workDir!).filter((n) => n.startsWith('build-'))).toEqual([]);
  }, 1_200_000);

  it('cancels mid-build: no image on the server, no context folder, the builder free again', async () => {
    const config = 'name: slow1\ndomains: []\nbuild: { type: dockerfile, where: bastion }\nrun: { port: 3000 }\nhealthcheck: { type: tcp, timeout: 30s }\n';
    const put = await api('PUT', deployApi('/apps/slow1/config'), { text: config });
    expect(put.statusCode, put.body).toBe(200);
    const source = tarball({ Dockerfile: `FROM busybox:1.36\nRUN echo started-${Date.now()} && sleep 300\nCMD ["httpd", "-f", "-p", "3000"]\n` });

    let cancelled: Promise<unknown> | null = null;
    let contextSeen = false;
    const t0 = Date.now();
    const events = await deploy('slow1', source, (e) => {
      if (process.env.SMT_TEST_DEBUG) console.log(`[live] +${Date.now() - t0}ms ${JSON.stringify(e).slice(0, 200)}`);
      if (cancelled || e.type !== 'log' || !JSON.stringify(e).includes('sleep 300')) return;
      // The RUN step is running in BuildKit: the context folder exists now
      contextSeen = fs.readdirSync(workDir!).some((n) => n.startsWith('build-'));
      cancelled = api('POST', deployApi('/apps/slow1/build/cancel'));
    });
    expect(cancelled, logText(events)).not.toBeNull();
    const answer = (await cancelled!) as { statusCode: number; body: string };
    expect(answer.statusCode, answer.body).toBe(200);
    expect(contextSeen).toBe(true);
    const error = events.find((e) => e.type === 'error') as { error: string } | undefined;
    expect(error?.error).toMatch(/cancelled/);
    expect(events.some((e) => e.type === 'result')).toBe(false);

    expect(onServer("docker images --format '{{.Repository}}:{{.Tag}}'")).not.toContain('bastion-slow1');
    expect(fs.readdirSync(workDir!).filter((n) => n.startsWith('build-'))).toEqual([]);
    const builder = (await api('GET', '/api/deploy/builder')).json();
    expect(builder).toMatchObject({ reachable: true, running: null, queued: 0 });
  }, 600_000);
});
