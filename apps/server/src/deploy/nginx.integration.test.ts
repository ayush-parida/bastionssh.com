import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';

/**
 * nginx mode end to end (deployments spec §2.5, §6) against real software:
 * a throwaway server running its own Docker daemon, sshd and a host nginx
 * that owns ports 80/443 with certbot, and Pebble — Let's Encrypt's ACME test
 * server — as the CA (certbot's `server` points at it; its API certificate is
 * trusted in the server container only, its issuing root by this test only).
 * Through the real routes, SSH, the shipped bastionctl and bastion-nginx:
 * setup detects nginx, the administrator's one-time steps BastionSSH shows
 * are run as shown, a tiny app is deployed on two domains and gets a
 * certificate by webroot, served by nginx over verified TLS; certbot's
 * renewal reloads nginx through the deploy hook; redeploy and rollback;
 * forwarded headers trusted from the host's nginx only; nginx -t refusing a
 * change keeps the previous server block; the server block of an app deleted
 * from a shell goes with the next apply; delete removes block and
 * certificate. Never the host's own Docker.
 *
 *   cd apps/server/src/deploy/nginx-it
 *   docker build -t bastion-ngx-host:test -f host.Dockerfile .
 *   docker build -t bastion-ngx-pebble:test -f pebble.Dockerfile .
 *   docker network create bastion-ngx-net
 *   docker run -d --rm --name bastion-ngx-pebble --network bastion-ngx-net --network-alias pebble \
 *     -p 127.0.0.1:29500:15000 bastion-ngx-pebble:test
 *   docker run -d --rm --privileged --name bastion-ngx-host --network bastion-ngx-net \
 *     --network-alias site1.test --network-alias www.site1.test --network-alias blog1.test \
 *     -p 127.0.0.1:29522:22 -p 127.0.0.1:29480:80 -p 127.0.0.1:29443:443 bastion-ngx-host:test
 *
 *   SMT_TEST_DEPLOY_NGINX=bastion-ngx-host pnpm vitest run src/deploy/nginx.integration.test.ts
 *
 *   docker stop bastion-ngx-host bastion-ngx-pebble && docker network rm bastion-ngx-net
 *   docker rmi bastion-ngx-host:test bastion-ngx-pebble:test
 *
 * The test domains resolve to the server through Docker's DNS (its network
 * aliases), which is how Pebble reaches its port 80 for the HTTP-01
 * challenge. The server's daemon pulls node, caddy and busybox.
 */

const container = process.env.SMT_TEST_DEPLOY_NGINX;
const sshPort = Number(process.env.SMT_TEST_DEPLOY_NGINX_SSH_PORT ?? 29522);
const httpPort = Number(process.env.SMT_TEST_DEPLOY_NGINX_HTTP_PORT ?? 29480);
const httpsPort = Number(process.env.SMT_TEST_DEPLOY_NGINX_HTTPS_PORT ?? 29443);
const pebblePort = Number(process.env.SMT_TEST_DEPLOY_NGINX_PEBBLE_PORT ?? 29500);
const ROOT = '/home/smt/bastion';
/** Where the helper writes server blocks on this Alpine server (its conf.d is outside http { }). */
const CONF = '/etc/nginx/http.d';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');

/** A command on the server as root: what its administrator does by hand. */
function admin(script: string): string {
  return execFileSync('docker', ['exec', container!, 'sh', '-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Exit status of a command on the server as root. */
function adminStatus(script: string): number {
  try {
    admin(script);
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

/**
 * `nginx -s reload` returns before the new workers take over: right after an
 * apply (or certbot's hook) the old ones still answer for a moment.
 */
const settled = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 15_000, interval: 250 });

const XFF_CGI = '#!/bin/sh\nprintf "Content-Type: text/plain\\r\\n\\r\\n%s\\n" "$HTTP_X_FORWARDED_FOR"\n';

/** busybox httpd answering `body` on port 3000, /health, and the X-Forwarded-For it got at /cgi-bin/xff. */
function source(body: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-ngx-src-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(src, 'Dockerfile'),
    [
      'FROM busybox:1.36',
      'COPY xff /www/cgi-bin/xff',
      `RUN chmod 0755 /www/cgi-bin/xff && echo ${body} > /www/index.html && echo ok > /www/health`,
      'CMD ["httpd", "-f", "-p", "3000", "-h", "/www"]',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(src, 'xff'), XFF_CGI);
  const file = path.join(dir, 'src.tar.gz');
  execFileSync('tar', ['czf', file, '-C', src, 'Dockerfile', 'xff'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const data = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return data;
}

const siteConfig = (name: string, domains: string[]) =>
  [
    `name: ${name}`,
    `domains: [${domains.join(', ')}]`,
    'redirect_www: none',
    'tls: auto',
    'build: { type: dockerfile }',
    'run: { port: 3000 }',
    'healthcheck: { path: /health, timeout: 30s }',
    'proxy: nginx',
    '',
  ].join('\n');

interface TlsAnswer {
  status: number;
  body: string;
  serial: string;
  issuer: string;
}

describe.skipIf(!container)('nginx mode against a real nginx, certbot and an ACME CA', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let admin_: ReturnType<typeof seedUser>;
  let serverId: string;
  /** Pebble's issuing root, trusted by this test's TLS requests only. */
  let pebbleRoot: string;

  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: admin_.headers, ...(payload && { payload }) });
  const deployApi = (p = '') => `/api/deploy/servers/${serverId}${p}`;

  async function stream(url: string, init: RequestInit): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${base}${url}`, { ...init, headers: { ...admin_.headers, ...(init.headers as Record<string, string>) } });
    expect(res.headers.get('content-type'), await res.clone().text().catch(() => '')).toBe('text/event-stream');
    const text = await res.text();
    return text
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
  }

  const logText = (events: Array<Record<string, unknown>>) =>
    events
      .filter((e) => e.type === 'log')
      .map((e) => JSON.stringify(e))
      .join('\n');

  async function deploy(name: string, body: string) {
    const form = new FormData();
    form.append('source', new Blob([source(body)]), 'src.tar.gz');
    const events = await stream(deployApi(`/apps/${name}/deploy`), { method: 'POST', body: form });
    const result = events.find((e) => e.type === 'result') as { outcome: { release: string; result: string; previous: string | null } } | undefined;
    expect(result?.outcome.result, JSON.stringify(events)).toBe('success');
    return { outcome: result!.outcome, log: logText(events) };
  }

  /** One request to the host's nginx over TLS for `domain`, verified against Pebble's root only. */
  function tlsGet(domain: string, urlPath = '/', headers: Record<string, string> = {}): Promise<TlsAnswer> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: '127.0.0.1', port: httpsPort, path: urlPath, servername: domain, headers: { host: domain, ...headers }, ca: pebbleRoot, agent: false, timeout: 10_000 },
        (res) => {
          const cert = (res.socket as TLSSocket).getPeerCertificate();
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body.trim(), serial: cert.serialNumber, issuer: String(cert.issuer?.CN ?? '') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  function plainGet(domain: string, urlPath = '/'): Promise<{ status: number; location: string | undefined }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: httpPort, path: urlPath, headers: { host: domain }, agent: false, timeout: 10_000 }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  const conf = (name: string) => admin(`cat ${CONF}/bastion-${name}.conf`);
  const confExists = (name: string) => adminStatus(`test -f ${CONF}/bastion-${name}.conf`) === 0;

  beforeAll(async () => {
    pebbleRoot = await new Promise<string>((resolve, reject) => {
      https
        .get({ hostname: '127.0.0.1', port: pebblePort, path: '/roots/0', rejectUnauthorized: false }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => resolve(body));
        })
        .on('error', reject);
    });
    expect(new X509Certificate(pebbleRoot).subject).toContain('Pebble Root CA');

    await runMigrations();
    const orgId = seedOrg('deploy-nginx-it');
    admin_ = seedUser(orgId, 'admin');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const res = await api('POST', '/api/servers', { name: 'deploy-nginx-it', host: '127.0.0.1', port: sshPort, username: 'smt', authType: 'password', password: 'bastion-it-pass' });
    expect(res.statusCode, res.body).toBe(201);
    serverId = res.json().id;
  }, 60_000);

  afterAll(async () => {
    if (serverId) {
      for (const name of ['blog1', 'site1']) await api('DELETE', deployApi(`/apps/${name}?purge=true`)).catch(() => {});
    }
    await app?.close();
  });

  it("detects the host's nginx, sets up behind it, and lists the administrator's steps until done", async () => {
    const before = (await api('GET', deployApi('/proxy'))).json();
    expect(before, JSON.stringify(before)).toMatchObject({ mode: null, nginx: { detected: true, installed: true, running: true, certbot: true, confInclude: true, helper: 'missing', sudo: false } });

    // No mode asked for: the host's nginx on port 80 picks nginx mode
    const res = await api('POST', deployApi('/setup'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ root: ROOT, proxy: 'nginx', proxyContainer: { state: 'running' } });
    // bastion-caddy is published on loopback only, and nginx still owns port 80
    expect(admin('docker port bastion-caddy')).toMatch(/^80\/tcp -> 127\.0\.0\.1:18480\s*$/);

    const steps = (await api('GET', deployApi('/proxy'))).json() as { mode: string; instructions: string[] };
    expect(steps.mode).toBe('nginx');
    expect(steps.instructions).toEqual([
      `'sudo' 'install' '-o' 'root' '-g' 'root' '-m' '0755' '${ROOT}/bin/bastion-nginx' '/usr/local/sbin/bastion-nginx'`,
      "echo 'smt ALL=(root) NOPASSWD: /usr/local/sbin/bastion-nginx' | sudo tee /etc/sudoers.d/bastion-nginx && sudo chmod 0440 /etc/sudoers.d/bastion-nginx",
    ]);
    // The administrator runs them as shown
    for (const step of steps.instructions) admin(step);
    const after = (await api('GET', deployApi('/proxy'))).json();
    expect(after).toMatchObject({ mode: 'nginx', nginx: { helper: 'ok', sudo: true }, instructions: [] });
    // sudo allows the helper and nothing else
    expect(adminStatus('su smt -s /bin/sh -c "sudo -n /usr/bin/id"')).not.toBe(0);
  }, 600_000);

  let first: string;
  let caddyfile: string;

  it('deploys an app on two domains and serves it with a certificate certbot got by webroot', async () => {
    const put = await api('PUT', deployApi('/apps/site1/config'), { text: siteConfig('site1', ['site1.test', 'www.site1.test']) });
    expect(put.statusCode, put.body).toBe(200);
    // Not deployed yet: no site file, so no server block
    expect(put.json().proxy).toBeUndefined();

    const { outcome, log } = await deploy('site1', 'v1');
    first = outcome.release;
    expect(log, log).toContain('nginx: reloaded with the new server block of site1');
    expect(log, log).toContain('certbot: bastion-site1 for site1.test www.site1.test');

    const text = conf('site1');
    expect(text).toContain('server_name site1.test www.site1.test;');
    expect(text).toContain('ssl_certificate /etc/letsencrypt/live/bastion-site1/fullchain.pem;');
    expect(text).toContain('proxy_pass http://127.0.0.1:18480;');
    expect(admin('nginx -t 2>&1')).toContain('test is successful');

    for (const domain of ['site1.test', 'www.site1.test']) {
      await settled(async () => {
        const r = await tlsGet(domain);
        expect(r, domain).toMatchObject({ status: 200, body: 'v1' });
        expect(r.issuer).toMatch(/^Pebble Intermediate CA/);
        // HTTP goes to HTTPS; the ACME webroot stays on HTTP
        expect(await plainGet(domain, '/x?y=1')).toEqual({ status: 301, location: `https://${domain}/x?y=1` });
      });
    }
    expect((await plainGet('site1.test', '/.well-known/acme-challenge/none')).status).toBe(404);

    // The Domains report reads certbot's certificate through the helper
    const domains = (await api('GET', deployApi('/apps/site1/domains'))).json() as { proxy: string; domains: Array<{ domain: string; certificate: { source: string; issuer: string; notAfter: string; lastError: unknown } }> };
    expect(domains.proxy).toBe('nginx');
    for (const d of domains.domains) {
      expect(d.certificate, d.domain).toMatchObject({ source: 'certbot', issuer: expect.stringMatching(/Pebble Intermediate CA/), lastError: null });
      expect(Date.parse(d.certificate.notAfter)).toBeGreaterThan(Date.now() + 80 * 86_400_000);
    }
  }, 900_000);

  it("trusts forwarded headers from the host's nginx only", async () => {
    caddyfile = admin(`cat ${ROOT}/proxy/Caddyfile`);
    const gateway = admin("docker network inspect bastion-apps -f '{{(index .IPAM.Config 0).Gateway}}'").trim();
    expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(caddyfile).toContain(`\t\ttrusted_proxies static ${gateway}/32 127.0.0.1/32\n`);
    expect(caddyfile).not.toContain('private_ranges');

    // Through nginx: the address nginx saw (never what the client claimed), then the gateway nginx came from
    const viaNginx = await tlsGet('site1.test', '/cgi-bin/xff', { 'x-forwarded-for': '6.6.6.6' });
    expect(viaNginx.status).toBe(200);
    expect(viaNginx.body).not.toContain('6.6.6.6');
    expect(viaNginx.body).toMatch(new RegExp(`^[0-9a-f.:]+, ${gateway.replaceAll('.', '\\.')}$`));

    // A container on the same network talking to Caddy directly cannot claim a client address
    const forged = admin(
      "docker run --rm --network bastion-apps busybox:1.36 sh -c 'hostname -i; wget -q -O- --header \"Host: site1.test\" --header \"X-Forwarded-For: 6.6.6.6\" http://bastion-caddy/cgi-bin/xff'",
    )
      .trim()
      .split('\n');
    expect(forged).toHaveLength(2);
    expect(forged[1]).toBe(forged[0]!.trim());
    expect(forged[1]).not.toContain('6.6.6.6');
  }, 300_000);

  it("renews with certbot's own renewal, which reloads nginx through the deploy hook", async () => {
    expect(admin('cat /etc/letsencrypt/renewal/bastion-site1.conf')).toMatch(/^renew_hook = nginx -s reload$/m);
    const before = await tlsGet('site1.test');
    admin('certbot renew --cert-name bastion-site1 --force-renewal --no-random-sleep-on-renew 2>&1');
    // nginx only serves the renewed certificate once reloaded
    await settled(async () => {
      const after = await tlsGet('site1.test');
      expect(after).toMatchObject({ status: 200, body: 'v1' });
      expect(after.serial).not.toBe(before.serial);
    });
  }, 300_000);

  it('redeploys and rolls back behind nginx without touching its config', async () => {
    const block = conf('site1');
    const { outcome, log } = await deploy('site1', 'v2');
    expect(outcome.previous).toBe(first);
    expect(log).not.toContain('nginx: reloaded');
    expect((await tlsGet('www.site1.test')).body).toBe('v2');

    const back = await stream(deployApi('/apps/site1/rollback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ release: first }),
    });
    expect(back.find((e) => e.type === 'result')).toMatchObject({ outcome: { result: 'success', release: first } });
    expect((await tlsGet('site1.test')).body).toBe('v1');
    expect(conf('site1')).toBe(block);
  }, 900_000);

  it('keeps the previous server block when nginx -t refuses the new config', async () => {
    const block = conf('site1');
    // Something else on the host breaks nginx's config
    admin(`echo 'this is not nginx config' > ${CONF}/zz-broken.conf`);
    try {
      const put = await api('PUT', deployApi('/apps/site1/config'), { text: siteConfig('site1', ['site1.test']) });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json().proxy).toMatchObject({ app: 'site1', result: 'failed', certificate: 'skipped' });
      expect(put.json().proxy.error).toMatch(/^nginx -t refused the server block of site1; the previous one is back/);
      expect(conf('site1')).toBe(block);
      expect(adminStatus(`ls ${CONF}/bastion-site1.conf.*`)).not.toBe(0);
      // Still served on both names
      expect((await tlsGet('www.site1.test')).status).toBe(200);
    } finally {
      admin(`rm -f ${CONF}/zz-broken.conf`);
    }
    // Applied again once the host is fixed (Domains: apply again)
    const again = await api('POST', deployApi('/apps/site1/proxy'));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ result: 'applied', error: null });
    expect(conf('site1')).toContain('server_name site1.test;');
    await settled(async () => expect((await tlsGet('site1.test')).body).toBe('v1'));
  }, 600_000);

  it('removes the server block of an app deleted from a shell with the next apply', async () => {
    expect((await api('PUT', deployApi('/apps/blog1/config'), { text: siteConfig('blog1', ['blog1.test']) })).statusCode).toBe(200);
    await deploy('blog1', 'blog');
    expect(confExists('blog1')).toBe(true);
    await settled(async () => expect((await tlsGet('blog1.test')).body).toBe('blog'));

    // bastionctl run by hand: it cannot touch the host's nginx, so the block stays for now
    admin(`su smt -s /bin/sh -c '${ROOT}/bin/bastionctl delete blog1 --purge'`);
    expect(confExists('blog1')).toBe(true);

    const res = await api('POST', deployApi('/apps/site1/proxy'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().log.join('\n')).toContain(`nginx: removed the server block of blog1, which ${ROOT} no longer serves`);
    expect(confExists('blog1')).toBe(false);
    expect(confExists('site1')).toBe(true);
    expect(admin('nginx -t 2>&1')).toContain('test is successful');
    // Its name falls to the host's default server (Alpine's answers 404)
    await settled(async () => expect((await plainGet('blog1.test')).status).toBe(404));
  }, 900_000);

  it('deletes the app: server block and certificate go, nginx keeps running', async () => {
    const res = await api('DELETE', deployApi('/apps/site1?purge=true'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().proxy).toMatchObject({ result: 'removed', error: null });
    expect(confExists('site1')).toBe(false);
    expect(adminStatus('test -e /etc/letsencrypt/live/bastion-site1')).not.toBe(0);
    expect(admin('nginx -t 2>&1')).toContain('test is successful');
    expect(adminStatus("pgrep -f '^nginx: master process'")).toBe(0);
    expect((await api('GET', deployApi('/apps'))).json()).toEqual([]);
  }, 300_000);
});
