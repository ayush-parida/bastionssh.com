import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateCaddyfile, type ProxySite } from './caddy.js';
import { checkConfigText, validateForServer } from './config.js';
import type { Ctx } from './context.js';
import { DockerApi } from './docker.js';
import { startFakeDocker, type FakeDocker } from './fake-docker.test-helper.js';
import { Layout, PROXY_CONTAINER } from './names.js';
import { NGINX_UPSTREAM_PORT, proxyMode, readProxyMode, siteFile, siteText, syncSiteFiles } from './nginx.js';
import * as ops from './ops.js';
import { LABEL_PROXY_MODE } from './proxy.js';
import { tarBuffer } from './tar.js';

/**
 * nginx mode, bastionctl's half: the mode chosen at setup (and the proxy
 * container recreated for it, on loopback only), Caddy behind nginx (plain
 * HTTP, trusted forwarded headers), configs that must match the server's
 * mode and use certbot-compatible TLS, and the site files the root helper
 * builds server blocks from — written after a switch, removed with the app.
 */

let fake: FakeDocker;
let root: string;
let layout: Layout;
let logs: string[];
let clock: number;

beforeAll(async () => {
  fake = await startFakeDocker();
});
afterAll(() => fake.close());

function ctx(): Ctx {
  return {
    layout,
    docker: new DockerApi(fake.socket),
    log: (line) => logs.push(line),
    actor: 'ann@example.com',
    now: () => new Date((clock += 1000)),
    drainMs: 0,
    healthIntervalMs: 1,
  };
}

const NGINX_SITE = 'name: site1\ndomains: [site1.com, www.site1.com]\nredirect_www: apex\nbuild: { type: dockerfile }\nproxy: nginx\n';

const site = (over: Partial<ProxySite> = {}): ProxySite => ({
  app: 'site1',
  release: 'r1',
  domains: ['site1.com', 'www.site1.com'],
  redirect_www: 'apex',
  tls: 'auto',
  upstream: 'bastion-site1-r1:3000',
  ...over,
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-nginx-')));
  layout = new Layout(root);
  logs = [];
  clock = Date.parse('2026-10-05T12:00:00Z');
  fake.containers.clear();
  fake.images.clear();
  fake.networks.clear();
  fake.execs.length = 0;
  fake.exec = () => ({ exitCode: 0 });
});

describe('Caddy behind nginx', () => {
  it('serves plain HTTP with automatic HTTPS off and trusts the forwarded headers of the proxy in front', () => {
    const text = generateCaddyfile([site()], 'nginx');
    expect(text).toContain('\tauto_https off\n\tservers {\n\t\ttrusted_proxies static private_ranges\n\t}\n}');
    expect(text).toContain('http://site1.com {\n\tencode zstd gzip\n\treverse_proxy bastion-site1-r1:3000 {\n\t\tlb_try_duration 5s\n\t}\n}');
    // The www redirect still happens in Caddy, to HTTPS (nginx terminates TLS)
    expect(text).toContain('http://www.site1.com {\n\tredir https://site1.com{uri} permanent\n}');
    expect(text).not.toContain('tls');
  });
});

describe('config in nginx mode', () => {
  it('allows only certbot-compatible tls', () => {
    expect(checkConfigText(NGINX_SITE, 'site1').issues).toEqual([]);
    expect(checkConfigText(`${NGINX_SITE}tls: staging\n`, 'site1').issues).toEqual([]);
    for (const tls of ['internal', 'dns:cloudflare', '{ cert: c.pem, key: k.pem }']) {
      expect(checkConfigText(`${NGINX_SITE}tls: ${tls}\n`, 'site1').issues, tls).toEqual([
        { path: 'tls', message: 'With proxy: nginx, tls must be auto or staging (certificates come from certbot on the host)' },
      ]);
    }
  });

  it("must match the server's mode", async () => {
    fs.mkdirSync(layout.proxy, { recursive: true });
    expect(proxyMode(layout)).toBe('caddy');
    expect(validateForServer(layout, 'site1', NGINX_SITE).errors).toEqual([{ path: 'proxy', message: "This server's proxy is set up for caddy; use proxy: caddy" }]);
    fs.writeFileSync(path.join(layout.proxy, 'mode'), 'nginx\n');
    expect(validateForServer(layout, 'site1', NGINX_SITE).ok).toBe(true);
    expect(validateForServer(layout, 'site1', 'name: site1\ndomains: [a.com]\nbuild: { type: dockerfile }\n').errors[0]!.path).toBe('proxy');
  });
});

describe('site files', () => {
  it('lists the validated facts the helper needs, and refuses TLS certbot cannot do', () => {
    expect(siteText(site())).toBe(
      `# Written by bastionctl for bastion-nginx; regenerated with the proxy config.\napp=site1\ntls=auto\nupstream=${NGINX_UPSTREAM_PORT}\ndomain=site1.com\ndomain=www.site1.com\n`,
    );
    expect(() => siteText(site({ tls: 'internal' }))).toThrow(/tls must be auto or staging/);
  });

  it('writes changed files only and removes those of apps no longer served', () => {
    fs.mkdirSync(layout.proxy, { recursive: true });
    expect(syncSiteFiles(layout, [site(), site({ app: 'blog', domains: ['blog.io'] })])).toEqual({ changed: ['blog', 'site1'], removed: [] });
    expect(syncSiteFiles(layout, [site(), site({ app: 'blog', domains: ['blog.io'] })])).toEqual({ changed: [], removed: [] });
    expect(syncSiteFiles(layout, [site({ domains: ['site1.com'] })])).toEqual({ changed: ['site1'], removed: ['blog'] });
    expect(fs.existsSync(siteFile(layout, 'blog'))).toBe(false);
    expect(fs.readFileSync(siteFile(layout, 'site1'), 'utf8')).not.toContain('www.site1.com');
  });
});

describe('setup and deploy in nginx mode', () => {
  it('runs the proxy on loopback only, switches modes by recreating it, and writes site files on deploy', async () => {
    const caddy = await ops.setup(ctx());
    expect(caddy.proxy).toBe('caddy');
    const caddyId = fake.containers.get(PROXY_CONTAINER)!.Id;

    const r = await ops.setup(ctx(), { proxy: 'nginx' });
    expect(r.proxy).toBe('nginx');
    expect(readProxyMode(layout)).toBe('nginx');
    const proxy = fake.containers.get(PROXY_CONTAINER)!;
    expect(proxy.Id).not.toBe(caddyId);
    expect(proxy.Labels[LABEL_PROXY_MODE]).toBe('nginx');
    expect(proxy.HostConfig.PortBindings).toEqual({ '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(NGINX_UPSTREAM_PORT) }] });
    expect(logs).toContain('Replacing bastion-caddy (proxy mode is now nginx)');

    // Setup again keeps the mode and the container
    await ops.setup(ctx());
    expect(fake.containers.get(PROXY_CONTAINER)!.Id).toBe(proxy.Id);

    // The template follows the server's mode
    await ops.init(ctx(), 'blank');
    expect(fs.readFileSync(layout.config('blank'), 'utf8')).toContain('proxy: nginx');

    fs.writeFileSync(path.join(layout.tmp, 'site1.yml'), NGINX_SITE);
    await ops.init(ctx(), 'site1', { config: 'tmp/site1.yml' });
    const source = path.join(layout.tmp, 'up.tgz');
    fs.writeFileSync(source, zlib.gzipSync(tarBuffer([{ name: 'Dockerfile', content: 'FROM busybox\n' }])));
    const outcome = await ops.deploy(ctx(), 'site1', source);
    expect(outcome.result).toBe('success');
    expect(fs.readFileSync(layout.caddyfile, 'utf8')).toContain('http://site1.com {');
    expect(fs.readFileSync(siteFile(layout, 'site1'), 'utf8')).toContain('domain=www.site1.com');
    expect(logs).toContain(`nginx: the server block of site1 changed; run: sudo /usr/local/sbin/bastion-nginx apply ${root} site1`);

    await ops.remove(ctx(), 'site1');
    expect(fs.existsSync(siteFile(layout, 'site1'))).toBe(false);
    expect(logs).toContain('nginx: site1 is no longer served; run: sudo /usr/local/sbin/bastion-nginx remove site1');
  });

  it('refuses to deploy an app whose config asks for the other proxy', async () => {
    await ops.setup(ctx());
    fs.mkdirSync(layout.app('site1'), { recursive: true });
    fs.writeFileSync(layout.config('site1'), NGINX_SITE);
    await expect(ops.deploy(ctx(), 'site1', 'tmp/none.tgz')).rejects.toThrow("proxy: This server's proxy is set up for caddy; use proxy: caddy");
  });
});
