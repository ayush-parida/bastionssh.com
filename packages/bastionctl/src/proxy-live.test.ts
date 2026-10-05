import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCaddyfile, PROXY_MOUNT, type ProxySite } from './caddy.js';
import { DockerApi } from './docker.js';
import { CADDY_IMAGE, NODE_IMAGE } from './images.js';
import { probeNames } from './proxy.js';
import { FRONT_PATH, frontSource, proxyDockerfile } from './proxy-image.js';
import { tarBuffer } from './tar.js';

/**
 * The real proxy under load (deployments spec §5 step 6), against the local
 * Docker daemon: the proxy image built from the pinned images, run with
 * throwaway names on unusual ports next to two busybox upstreams, and the
 * Caddyfile bastionctl generates switched — new domains, another upstream
 * port, another TLS setting — the way switchProxy does it (caddy validate,
 * then the front's reload with the names to check), while requests keep
 * coming on new and kept-alive connections. Not one may fail. Everything it
 * creates (containers with their anonymous volumes, network, image) is
 * removed afterwards.
 *
 *   BASTION_TEST_DOCKER=1 pnpm vitest run src/proxy-live.test.ts
 *
 * Needs Docker, the pinned images (pulled if missing) and openssl.
 */

const live = process.env.BASTION_TEST_DOCKER === '1';
const SOCKET = process.env.BASTION_TEST_DOCKER_SOCKET ?? (fs.existsSync(`${os.homedir()}/.docker/run/docker.sock`) ? `${os.homedir()}/.docker/run/docker.sock` : '/var/run/docker.sock');
const NAME = `bastion-proxytest-${process.pid}`;
const IMAGE = `${NAME}:test`;
const HTTPS_PORT = 28943;
const HTTP_PORT = 28980;

describe.skipIf(!live)('the proxy, live: config switches under load', () => {
  const docker = new DockerApi(SOCKET);
  let dir: string;
  let log = '';

  const site = (over: Partial<ProxySite>): ProxySite => ({
    app: 'web',
    release: 'r1',
    domains: ['web.test'],
    redirect_www: 'none',
    tls: 'internal',
    upstream: 'bastion-web-live-3000:3000',
    ...over,
  });

  /** As switchProxy: write, validate, reload with the names the new Caddy must serve first. */
  async function apply(sites: ProxySite[]) {
    const file = path.join(dir, 'Caddyfile');
    const text = generateCaddyfile(sites, 'caddy');
    fs.writeFileSync(`${file}.next`, text);
    const validated = await docker.exec(NAME, ['caddy', 'validate', '--config', `${PROXY_MOUNT}/Caddyfile.next`, '--adapter', 'caddyfile'], 60_000);
    expect(validated.exitCode, validated.stderr).toBe(0);
    fs.renameSync(`${file}.next`, file);
    const sha256 = createHash('sha256').update(text).digest('hex');
    const reloaded = await docker.exec(NAME, ['node', FRONT_PATH, 'reload', '--sha256', sha256, ...probeNames(sites)], 120_000);
    log += reloaded.stderr;
    expect(reloaded.exitCode, reloaded.stderr).toBe(0);
  }

  /** Sockets that have carried a whole response: a request on one of them is on a kept-alive connection. */
  const served = new WeakSet<object>();

  function get(domain: string, agent: https.Agent | false): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      let socket: object | null = null;
      const req = https.request(
        { host: '127.0.0.1', port: HTTPS_PORT, path: '/', servername: domain, headers: { host: domain }, rejectUnauthorized: false, agent, timeout: 10_000 },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => {
            if (socket) served.add(socket);
            resolve({ status: res.statusCode ?? 0, body: body.trim() });
          });
        },
      );
      // Node's req.reusedSocket misses a socket handed to a request that waited for one; this does not
      req.on('socket', (s) => (socket = s));
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (err: Error & { reused?: boolean }) => {
        err.reused = !!socket && served.has(socket);
        reject(err);
      });
      req.end();
    });
  }

  async function run(name: string, spec: Record<string, unknown>) {
    await docker.createContainer(name, spec);
    await docker.start(name);
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bastion-proxytest-'));
    for (const sub of ['data', 'config', 'certs/web']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=web.test',
      '-addext', 'subjectAltName=DNS:web.test,DNS:alt.test', '-keyout', path.join(dir, 'certs/web/key.pem'), '-out', path.join(dir, 'certs/web/cert.pem'),
    ], { stdio: 'ignore' });
    for (const ref of [NODE_IMAGE, CADDY_IMAGE, 'busybox:1.36']) {
      if (!(await docker.imageExists(ref))) await docker.pull(ref, () => {});
    }
    await docker.build(Readable.from([tarBuffer([{ name: 'Dockerfile', content: proxyDockerfile() }, { name: 'bastion-proxy.mjs', content: frontSource() }])]), { t: IMAGE, rm: true, forcerm: true }, () => {});
    await docker.json('POST', '/networks/create', { body: { Name: NAME, Driver: 'bridge' } });
    // Two upstreams, as two releases on two ports
    for (const port of [3000, 4000]) {
      await run(`${NAME}-up${port}`, {
        Image: 'busybox:1.36',
        Cmd: ['sh', '-c', `mkdir /www && echo up${port} > /www/index.html && exec httpd -f -p ${port} -h /www`],
        HostConfig: { NetworkMode: NAME },
        NetworkingConfig: { EndpointsConfig: { [NAME]: { Aliases: [`bastion-web-live-${port}`] } } },
      });
    }
    fs.writeFileSync(path.join(dir, 'Caddyfile'), generateCaddyfile([site({})], 'caddy'));
    await run(NAME, {
      Image: IMAGE,
      Env: ['BASTION_PROXY_LISTEN=80:http,443:https', `BASTION_PROXY_CONFIG=${PROXY_MOUNT}/Caddyfile`, 'BASTION_PROXY_DRAIN_MS=3000'],
      ExposedPorts: { '80/tcp': {}, '443/tcp': {} },
      HostConfig: {
        Binds: [`${dir}:${PROXY_MOUNT}`, `${path.join(dir, 'data')}:/data`, `${path.join(dir, 'config')}:/config`],
        PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(HTTP_PORT) }], '443/tcp': [{ HostIp: '127.0.0.1', HostPort: String(HTTPS_PORT) }] },
        NetworkMode: NAME,
      },
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ok = await get('web.test', false).then((r) => r.status === 200, () => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`The proxy did not come up:\n${await docker.logsTail(NAME, 50)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 600_000);

  afterAll(async () => {
    if (process.env.BASTION_TEST_KEEP) return;
    for (const name of [NAME, `${NAME}-up3000`, `${NAME}-up4000`]) {
      await docker.request('DELETE', `/containers/${name}`, { query: { force: true, v: true } }).catch(() => {});
    }
    await docker.request('DELETE', `/networks/${NAME}`).catch(() => {});
    await docker.removeImage(IMAGE).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('switches domains, upstream port and TLS without failing one request', async () => {
    const keepAlive = new https.Agent({ keepAlive: true, maxSockets: 2 });
    let running = true;
    let count = 0;
    let retried = 0;
    const bodies = new Set<string>();
    const failures: string[] = [];
    const loop = async (agent: https.Agent | false) => {
      while (running) {
        try {
          let res;
          for (let attempt = 1; ; attempt++) {
            try {
              res = await get('web.test', agent);
              break;
            } catch (err) {
              // As browsers, curl and Node's docs do: a request on a kept-alive connection the server
              // closed is sent again (each pooled connection may be one; a fresh connection never is)
              const e = err as NodeJS.ErrnoException & { reused?: boolean };
              if (!e.reused || !['ECONNRESET', 'EPIPE'].includes(e.code ?? '') || attempt > 3) throw err;
              retried++;
            }
          }
          count++;
          if (res.status === 200) bodies.add(res.body);
          else failures.push(`HTTP ${res.status}: ${res.body.slice(0, 100)}`);
        } catch (err) {
          const e = err as NodeJS.ErrnoException & { reused?: boolean };
          failures.push(`${e.message} (${e.code ?? 'no code'}, ${e.reused ? 'kept-alive' : 'new'} connection)`);
        }
      }
    };
    const workers = [loop(false), loop(false), loop(false), loop(keepAlive), loop(keepAlive)];
    const pause = () => new Promise((r) => setTimeout(r, 1500));

    await pause();
    await apply([site({ domains: ['web.test', 'alt.test'] })]); // a domain added
    await pause();
    await apply([site({ domains: ['web.test', 'alt.test'], upstream: 'bastion-web-live-4000:4000' })]); // another port
    await pause();
    await apply([site({ domains: ['web.test', 'alt.test'], upstream: 'bastion-web-live-4000:4000', tls: { cert: 'cert.pem', key: 'key.pem' } })]); // certificate files
    await pause();
    await apply([site({ upstream: 'bastion-web-live-4000:4000', tls: 'internal' })]); // back to Caddy's CA, a domain removed
    await new Promise((r) => setTimeout(r, 4000));
    running = false;
    await Promise.all(workers);
    keepAlive.destroy();

    expect(failures, `${failures.length} of ${count} requests failed (${retried} retried)\n${log}`).toEqual([]);
    // Only an idle kept-alive connection the old Caddy closes as its drain ends is retried: at most
    // one per pooled socket (the agent keeps 2) per switch, never a request on a new connection
    expect(retried, `${retried} retries over 4 switches`).toBeLessThanOrEqual(2 * 4);
    // Requests through every switch (how many depends on the machine)
    expect(count).toBeGreaterThan(50);
    expect([...bodies].sort()).toEqual(['up3000', 'up4000']);
    expect(await docker.logsTail(NAME, 400)).toContain('generation 5 serves');
    expect(await get('alt.test', false).then(() => 'served', () => 'refused')).toBe('refused');
  }, 300_000);

  it('redirects plain HTTP to HTTPS on the public port', async () => {
    const res = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/x?y=1', headers: { host: 'web.test' } }, (r) => {
        r.resume();
        resolve({ status: r.statusCode ?? 0, location: r.headers.location });
      }).on('error', reject);
    });
    expect(res).toEqual({ status: 301, location: 'https://web.test/x?y=1' });
  });

  it('refuses a config Caddy cannot start, the running one serving on', async () => {
    fs.writeFileSync(path.join(dir, 'Caddyfile'), generateCaddyfile([site({ upstream: 'bastion-web-live-4000:4000', tls: { cert: 'missing.pem', key: 'missing.pem' }, app: 'nocert' })], 'caddy'));
    const reloaded = await docker.exec(NAME, ['node', FRONT_PATH, 'reload', 'web.test'], 120_000);
    expect(reloaded.exitCode).toBe(1);
    expect(reloaded.stderr).toMatch(/Caddy did not start with the new config \(exit code 1\):\nloading initial config: .*open \/bastion-proxy\/certs\/nocert\/cert.pem: no such file/);
    expect(await get('web.test', false)).toEqual({ status: 200, body: 'up4000' });
  }, 120_000);
});
