import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

/**
 * Proxy upgrades and services (services spec §2, §3.2) against a real
 * server: a throwaway `docker:dind` daemon and an `openssh-server` with the
 * Docker CLI sharing its socket and the deployments folder, as in
 * deploy.integration.test.ts, with the daemon's ports 80 and 443 published on
 * the host's loopback so requests reach the deployed app through the proxy.
 *
 * 1. A server set up by an older bastionctl (`SMT_TEST_OLD_BASTIONCTL`: the
 *    dist folder of a build from before proxy upgrades), with an app
 *    deployed by it. The next request upgrades bastionctl; the next deploy
 *    upgrades the proxy (its container and Caddy) while requests keep coming:
 *    the outage is measured (connections in flight may drop for about a
 *    second), and audited.
 * 2. Caddy alone from an older build: the next restart replaces it behind the
 *    running front while requests keep coming — not one may fail.
 * 3. PostgreSQL 16 from `build.type: image`, recreate strategy, an exclusive
 *    volume, a pg_isready health check and a generated password: an app
 *    container on bastion-apps connects to it by name, and a redeploy
 *    (recreate) keeps the data.
 *
 *   docker network create bastion-svc-net
 *   docker volume create bastion-svc-sock && docker volume create bastion-svc-root
 *   docker run -d --rm --privileged --name bastion-svc-dind --network bastion-svc-net -e DOCKER_TLS_CERTDIR= \
 *     -p 127.0.0.1:28543:443 -p 127.0.0.1:28580:80 -v bastion-svc-sock:/var/run -v bastion-svc-root:/config/bastion docker:dind
 *   docker run -d --rm --name bastion-svc-sshd --network bastion-svc-net -p 127.0.0.1:22622:2222 \
 *     -e USER_NAME=smt -e USER_PASSWORD=bastion-it-pass -e PASSWORD_ACCESS=true -e PUID=1000 -e PGID=1000 \
 *     -v bastion-svc-sock:/sock -v bastion-svc-root:/config/bastion lscr.io/linuxserver/openssh-server
 *   docker exec bastion-svc-dind sh -c 'until [ -S /var/run/docker.sock ]; do sleep 1; done; chmod 666 /var/run/docker.sock; chown 1000:1000 /config/bastion'
 *   docker exec bastion-svc-sshd sh -c 'apk add --no-cache docker-cli && ln -sf /sock/docker.sock /var/run/docker.sock'
 *
 *   SMT_TEST_SERVICES_SSH_PORT=22622 SMT_TEST_OLD_BASTIONCTL=/path/to/old/packages/bastionctl/dist \
 *     pnpm vitest run src/deploy/services.integration.test.ts
 *
 *   docker stop bastion-svc-sshd bastion-svc-dind && docker volume rm bastion-svc-sock bastion-svc-root && docker network rm bastion-svc-net
 */

const port = Number(process.env.SMT_TEST_SERVICES_SSH_PORT ?? 0);
const oldDist = process.env.SMT_TEST_OLD_BASTIONCTL;
const SSHD = process.env.SMT_TEST_SERVICES_SSHD ?? 'bastion-svc-sshd';
const HTTPS_PORT = Number(process.env.SMT_TEST_SERVICES_HTTPS_PORT ?? 28543);
const ROOT = '/config/bastion';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { bastionctlBundle } = await import('./bundle.js');
const { getDb } = await import('../db/index.js');
const { auditLog } = await import('../db/schema.js');
const { eq } = await import('drizzle-orm');

/** A shell command in the SSH server's container, as the SSH user (its Docker CLI talks to the throwaway daemon). */
function sh(command: string, input?: string): string {
  return execFileSync('docker', ['exec', '-i', '-u', '1000', '-e', 'HOME=/tmp', SSHD, 'sh', '-c', command], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

/** Copy a host file into the deployments folder, owned by the SSH user. */
function put(file: string, dest: string, mode = '644') {
  execFileSync('docker', ['cp', file, `${SSHD}:${dest}`]);
  execFileSync('docker', ['exec', SSHD, 'sh', '-c', `chown 1000:1000 '${dest}' && chmod ${mode} '${dest}'`]);
}

function source(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-svc-src-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), `FROM busybox:1.36\nRUN mkdir /www && echo ${body} > /www/index.html\nCMD ["httpd", "-f", "-p", "3000", "-h", "/www"]\n`);
  const file = path.join(dir, 'src.tar.gz');
  execFileSync('tar', ['czf', file, '-C', dir, 'Dockerfile'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return file;
}

const SITE = 'name: site1\ndomains: [site1.test]\ntls: internal\nbuild: { type: dockerfile }\nrun: { port: 3000 }\nhealthcheck: { path: /, timeout: 60s }\n';
const DB = `name: orders-db
service: postgres
domains: []
build: { type: image, image: "postgres:16" }
run:
  port: 5432
  volumes: [{ name: data, path: /var/lib/postgresql/data, exclusive: true }]
  memory: 512m
healthcheck:
  type: command
  command: [pg_isready, -h, 127.0.0.1, -U, app, -d, app]
  timeout: 180s
keep_releases: 3
`;

/** Requests to site1 through the proxy, on new and kept-alive connections, until stopped. */
function load() {
  const served = new WeakSet<object>();
  const failures: Array<{ at: number; error: string }> = [];
  let count = 0;
  let retried = 0;
  let running = true;
  const keepAlive = new https.Agent({ keepAlive: true, maxSockets: 2 });
  const get = (agent: https.Agent | false) =>
    new Promise<number>((resolve, reject) => {
      let socket: object | null = null;
      const req = https.request(
        { host: '127.0.0.1', port: HTTPS_PORT, path: '/', servername: 'site1.test', headers: { host: 'site1.test' }, rejectUnauthorized: false, agent, timeout: 10_000 },
        (res) => {
          res.resume();
          res.on('end', () => {
            if (socket) served.add(socket);
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.on('socket', (s) => (socket = s));
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (err: Error & { reused?: boolean }) => {
        err.reused = !!socket && served.has(socket);
        reject(err);
      });
      req.end();
    });
  const loop = async (agent: https.Agent | false) => {
    while (running) {
      try {
        let status = 0;
        for (let attempt = 1; ; attempt++) {
          try {
            status = await get(agent);
            break;
          } catch (err) {
            // As browsers and curl do: a request on a kept-alive connection the server closed is sent again
            const e = err as NodeJS.ErrnoException & { reused?: boolean };
            if (!e.reused || !['ECONNRESET', 'EPIPE'].includes(e.code ?? '') || attempt > 3) throw err;
            retried++;
          }
        }
        count++;
        if (status !== 200) failures.push({ at: Date.now(), error: `HTTP ${status}` });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        failures.push({ at: Date.now(), error: `${e.code ?? e.message}` });
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };
  const workers = [loop(false), loop(false), loop(false), loop(keepAlive), loop(keepAlive)];
  return {
    async stop() {
      running = false;
      await Promise.all(workers);
      keepAlive.destroy();
      const window = failures.length ? failures.at(-1)!.at - failures[0]!.at : 0;
      return { count, retried, failures, window };
    },
  };
}

describe.skipIf(!port || !oldDist)('proxy upgrades and services against a live server', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let admin: ReturnType<typeof seedUser>;
  let serverId: string;
  const report: Record<string, unknown> = {};

  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: admin.headers, ...(payload && { payload }) });
  const deployApi = (p = '') => `/api/deploy/servers/${serverId}${p}`;
  const audits = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, action))
      .all()
      .map((r) => JSON.parse(r.metadata ?? '{}') as Record<string, unknown>);

  async function stream(url: string, init: RequestInit): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${base}${url}`, { ...init, headers: { ...admin.headers, ...(init.headers as Record<string, string>) } });
    expect(res.headers.get('content-type'), await res.clone().text().catch(() => '')).toBe('text/event-stream');
    return (await res.text())
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
  }
  const outcomeOf = (events: Array<Record<string, unknown>>) => (events.find((e) => e.type === 'result') as { outcome: { result: string; release: string; error: string | null } } | undefined)?.outcome;
  const logOf = (events: Array<Record<string, unknown>>) =>
    events
      .filter((e) => e.type === 'log')
      .flatMap((e) => (e.lines as Array<{ text: string }>).map((l) => l.text))
      .join('\n');

  const deployUpload = (file: string) => {
    const form = new FormData();
    form.append('source', new Blob([fs.readFileSync(file)]), 'src.tar.gz');
    return stream(deployApi('/apps/site1/deploy'), { method: 'POST', body: form });
  };

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('services-it');
    admin = seedUser(orgId, 'admin');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const res = await api('POST', '/api/servers', { name: 'services-it', host: '127.0.0.1', port, username: 'smt', authType: 'password', password: 'bastion-it-pass' });
    expect(res.statusCode, res.body).toBe(201);
    serverId = res.json().id;
  }, 60_000);

  afterAll(async () => {
    if (serverId && !process.env.SMT_TEST_KEEP) {
      await api('DELETE', deployApi('/apps/site1?purge=true')).catch(() => {});
      await api('DELETE', deployApi('/apps/orders-db?purge=true')).catch(() => {});
    }
    await app?.close();
    console.log(`services live report: ${JSON.stringify(report, null, 2)}`);
  });

  it('serves an app from a server set up by an older bastionctl (proxy with Caddy in its image, no labels)', () => {
    sh(`mkdir -p ${ROOT}/bin ${ROOT}/tmp`);
    put(path.join(oldDist!, 'bastionctl.mjs'), `${ROOT}/bin/bastionctl.mjs`, '755');
    put(path.join(oldDist!, 'bastionctl'), `${ROOT}/bin/bastionctl`, '755');
    const old = (args: string) => sh(`BASTION_ACTOR=old-cli ${ROOT}/bin/bastionctl ${args} --json`);
    const setup = JSON.parse(old('setup --proxy caddy').trim().split('\n').pop()!) as { version: string; proxyContainer: { state: string } };
    report.oldVersion = setup.version;
    expect(setup.proxyContainer.state).toBe('running');
    const yml = path.join(os.tmpdir(), `site1-${process.pid}.yml`);
    fs.writeFileSync(yml, SITE);
    put(yml, `${ROOT}/tmp/site1.yml`);
    old('init site1 --config tmp/site1.yml');
    put(source('v1'), `${ROOT}/tmp/v1.tar.gz`);
    const outcome = JSON.parse(old('deploy site1 --source tmp/v1.tar.gz').trim().split('\n').pop()!) as { result: string };
    expect(outcome.result).toBe('success');
    const labels = sh(`docker inspect -f '{{json .Config.Labels}}' bastion-caddy`);
    expect(labels).not.toContain('bastion.build');
  }, 600_000);

  it('upgrades bastionctl on the next request, reports the old proxy, and replaces it at the next deploy while requests keep coming', async () => {
    const bundle = bastionctlBundle()!;
    const state = (await api('GET', deployApi())).json();
    expect(state).toMatchObject({ integrity: 'ok', installedVersion: bundle.version, upgraded: { to: bundle.version }, proxyOutdated: true, proxy: { state: 'outdated', build: 'unknown', outdated: ['caddy', 'front'], pinned: false } });
    // Reading the state never touched the proxy
    expect(audits('deploy.proxy_upgrade')).toEqual([]);

    const traffic = load();
    await new Promise((r) => setTimeout(r, 1500));
    const events = await deployUpload(source('v2'));
    await new Promise((r) => setTimeout(r, 1500));
    const result = await traffic.stop();
    expect(outcomeOf(events)?.result, logOf(events)).toBe('success');
    const log = logOf(events);
    expect(log).toContain(`Upgrading the proxy from bastionctl unknown to ${bundle.version} (front and caddy)`);
    expect(log).toContain('Connections in flight may drop for about a second');
    expect(log).toContain(`Proxy upgraded to bastionctl ${bundle.version}`);
    expect(audits('deploy.proxy_upgrade')).toEqual([{ root: ROOT, from: 'unknown', to: bundle.version, trigger: 'deploy', result: 'success', replaced: ['front', 'caddy'] }]);
    report.frontUpgrade = { requests: result.count, failed: result.failures.length, retried: result.retried, outageMs: result.window, errors: [...new Set(result.failures.map((f) => f.error))] };
    // Connections in flight may drop while the ports move: about a second, never more than a few
    expect(result.window, JSON.stringify(report.frontUpgrade)).toBeLessThan(5000);
    expect(result.count).toBeGreaterThan(20);

    const after = (await api('GET', deployApi())).json();
    expect(after).toMatchObject({ proxyOutdated: false, proxy: { state: 'ok', build: bundle.version } });
    expect(sh(`docker inspect -f '{{index .Config.Labels "bastion.build"}}' bastion-caddy`).trim()).toBe(bundle.version);
    expect(sh('docker ps -a --format "{{.Names}}"')).not.toContain('bastion-caddy-previous');
  }, 900_000);

  it('replaces an older Caddy behind the running front at the next restart without failing one request', async () => {
    const bundle = bastionctlBundle()!;
    // As an older build left it: another Caddy linked (a copy of the binary), and that build recorded
    sh(
      `cd ${ROOT}/proxy/caddy && id=$(readlink caddy | cut -d/ -f1) && mkdir -p 0123456789abcdef && cp "$id/caddy" 0123456789abcdef/caddy && ` +
        `ln -sfn 0123456789abcdef/caddy caddy && printf '{"build":"0.1.0+1111111","caddy":"0123456789abcdef"}' > ../state.json`,
    );
    expect((await api('GET', deployApi())).json()).toMatchObject({ proxyOutdated: true, proxy: { build: '0.1.0+1111111', outdated: ['caddy'] } });
    const containerBefore = sh(`docker inspect -f '{{.Id}}' bastion-caddy`).trim();

    const traffic = load();
    await new Promise((r) => setTimeout(r, 1500));
    const restart = await api('POST', deployApi('/apps/site1/restart'));
    await new Promise((r) => setTimeout(r, 3000));
    const result = await traffic.stop();
    expect(restart.statusCode, restart.body).toBe(200);
    expect(restart.json()).toMatchObject({ proxyUpgrade: { from: '0.1.0+1111111', to: bundle.version, trigger: 'restart', result: 'success', replaced: ['caddy'] } });
    report.caddyUpgrade = { requests: result.count, failed: result.failures.length, retried: result.retried, errors: result.failures.map((f) => f.error) };
    expect(result.failures, JSON.stringify(report.caddyUpgrade)).toEqual([]);
    expect(result.count).toBeGreaterThan(50);
    // The same container: the front started a new Caddy generation with the new binary
    expect(sh(`docker inspect -f '{{.Id}}' bastion-caddy`).trim()).toBe(containerBefore);
    expect(sh(`readlink ${ROOT}/proxy/caddy/caddy`).trim()).not.toContain('0123456789abcdef');
    expect(audits('deploy.proxy_upgrade').at(-1)).toEqual({ root: ROOT, from: '0.1.0+1111111', to: bundle.version, trigger: 'restart', result: 'success', replaced: ['caddy'] });
    expect((await api('GET', deployApi())).json()).toMatchObject({ proxyOutdated: false });
  }, 600_000);

  it('runs PostgreSQL 16 from build.type image with a generated password, recreate and a pg_isready health check', async () => {
    const created = await api('PUT', deployApi('/apps/orders-db/config'), { text: DB });
    expect(created.statusCode, created.body).toBe(200);
    for (const [key, value] of [
      ['POSTGRES_USER', 'app'],
      ['POSTGRES_DB', 'app'],
    ]) {
      expect((await api('PUT', deployApi(`/apps/orders-db/env/${key}`), { value })).statusCode).toBe(200);
    }
    const generated = await api('POST', deployApi('/apps/orders-db/env/POSTGRES_PASSWORD/generate'), { ifMissing: true });
    expect(generated.json()).toEqual({ key: 'POSTGRES_PASSWORD', generated: true });
    const envFile = await app.inject({ method: 'GET', url: `/api/sftp/${serverId}/download?path=${encodeURIComponent(`${ROOT}/apps/orders-db/.env`)}`, headers: admin.headers });
    const password = /^POSTGRES_PASSWORD="([A-Za-z0-9_-]{43})"$/m.exec(envFile.rawPayload.toString('utf8'))?.[1];
    expect(password).toBeDefined();
    expect(JSON.stringify(audits('deploy.env_generate'))).not.toContain(password);

    const started = Date.now();
    const first = await stream(deployApi('/apps/orders-db/deploy'), { method: 'POST' });
    const outcome = outcomeOf(first);
    expect(outcome?.result, logOf(first)).toBe('success');
    report.postgresFirstDeployMs = Date.now() - started;
    expect(logOf(first)).toContain('Pulling postgres:16');
    expect(logOf(first)).toContain('Health check: pg_isready -h 127.0.0.1 -U app -d app');
    expect(logOf(first)).not.toContain(password);
    const releases = (await api('GET', deployApi('/apps/orders-db/releases'))).json() as Array<{ id: string; digest?: string; buildType: string }>;
    expect(releases[0]).toMatchObject({ id: outcome!.release, buildType: 'image', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    report.postgresDigest = releases[0]!.digest;

    // An app container on bastion-apps reaches it by name, with the generated password
    const psql = (sql: string) => sh(`docker run --rm --network bastion-apps -e PGPASSWORD=${password} postgres:16 psql -q -h orders-db -U app -d app -tAc "${sql}"`).trim();
    expect(psql("create table orders (id int primary key, item text); insert into orders values (42, 'book'); select count(*) from orders")).toBe('1');
    expect(() => sh('docker run --rm --network bastion-apps -e PGPASSWORD=wrong postgres:16 psql -h orders-db -U app -d app -tAc "select 1"')).toThrow();
    // Not reachable from outside the network: nothing is published
    expect(sh(`docker inspect -f '{{json .HostConfig.PortBindings}}' bastion-orders-db-${outcome!.release}`).trim()).toMatch(/^(null|\{\})$/);

    // A recreate redeploy: the old container stops first, the new one starts on the same volume, the data stays
    const second = await stream(deployApi('/apps/orders-db/deploy'), { method: 'POST' });
    const again = outcomeOf(second);
    expect(again?.result, logOf(second)).toBe('success');
    expect(logOf(second)).toContain(`Stopping bastion-orders-db-${outcome!.release} before the new container starts (volume data is exclusive)`);
    expect(psql('select item from orders where id = 42')).toBe('book');
    const containers = sh(`docker ps -a --filter label=bastion.app=orders-db --format '{{.Names}} {{.State}}'`).trim().split('\n');
    expect(containers).toEqual([`bastion-orders-db-${again!.release} running`]);
    report.postgres = { firstRelease: outcome!.release, secondRelease: again!.release, dataKept: true };
  }, 900_000);
});
