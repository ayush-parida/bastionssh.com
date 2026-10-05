import fs from 'node:fs';
import path from 'node:path';
import type { DeployProxyMode } from '@smt/shared';
import type { ProxySite } from './caddy.js';
import { appName, BastionError, NAME_PATTERN, type Layout } from './names.js';

/**
 * nginx mode (deployments spec §2.5, §6), bastionctl's half. On a server
 * whose own nginx owns ports 80 and 443, that nginx terminates TLS with
 * certbot's certificates and forwards every app domain to the bastion-caddy
 * container, which in this mode listens only on 127.0.0.1:{@link
 * NGINX_UPSTREAM_PORT}, speaks plain HTTP and routes by Host header as in
 * Caddy mode. Deploys, health checks, zero-downtime switches and rollbacks
 * are therefore the same in both modes, and nginx's config only changes when
 * an app's domains or TLS setting do.
 *
 * bastionctl runs in a container that cannot touch the host, so for each app
 * Caddy serves it writes `<root>/proxy/nginx/<app>.site`: the validated facts
 * (domains, tls, upstream port) the root-owned helper `bastion-nginx`
 * (../bastion-nginx.sh) builds `/etc/nginx/conf.d/bastion-<app>.conf` from.
 * BastionSSH runs the helper with sudo after a deploy, a config change or a
 * delete; from a shell it is `sudo bastion-nginx apply <root> <app>`.
 *
 * The server's mode is the file `<root>/proxy/mode`, written by `setup`.
 */

/** Where bastion-caddy listens on the host in nginx mode (loopback only). */
export const NGINX_UPSTREAM_PORT = 18480;
/** Where an administrator installs the helper, root-owned (see the setup instructions). */
export const NGINX_HELPER_PATH = '/usr/local/sbin/bastion-nginx';
/** The TLS settings certbot's webroot challenge can serve; everything else needs Caddy. */
export const NGINX_TLS = ['auto', 'staging'] as const;

export const modeFile = (layout: Layout) => path.join(layout.proxy, 'mode');
export const nginxDir = (layout: Layout) => path.join(layout.proxy, 'nginx');
export const siteFile = (layout: Layout, app: string) => path.join(nginxDir(layout), `${appName(app)}.site`);

/** The mode `setup` chose, or null before setup. */
export function readProxyMode(layout: Layout): DeployProxyMode | null {
  let text: string;
  try {
    text = fs.readFileSync(modeFile(layout), 'utf8').trim();
  } catch {
    return null;
  }
  return text === 'caddy' || text === 'nginx' ? text : null;
}

/** The server's proxy mode; Caddy until setup says otherwise. */
export function proxyMode(layout: Layout): DeployProxyMode {
  return readProxyMode(layout) ?? 'caddy';
}

export function writeProxyMode(layout: Layout, mode: DeployProxyMode): void {
  fs.writeFileSync(modeFile(layout), `${mode}\n`, { mode: 0o644 });
}

/** The site file of one app: `key=value` lines the helper checks again before using them. */
export function siteText(site: ProxySite): string {
  if (typeof site.tls !== 'string' || !(NGINX_TLS as readonly string[]).includes(site.tls)) {
    throw new BastionError(`${site.app}: with the nginx proxy, tls must be auto or staging (certbot)`);
  }
  return [
    `# Written by bastionctl for bastion-nginx; regenerated with the proxy config.`,
    `app=${site.app}`,
    `tls=${site.tls}`,
    `upstream=${NGINX_UPSTREAM_PORT}`,
    ...site.domains.map((d) => `domain=${d}`),
    '',
  ].join('\n');
}

/**
 * Bring `<root>/proxy/nginx/` in line with the sites Caddy serves: write a
 * site file per app (only when it changed) and remove those of apps that are
 * gone. Returns the apps whose file changed or went away — the ones the
 * helper must apply or remove.
 */
export function syncSiteFiles(layout: Layout, sites: readonly ProxySite[]): { changed: string[]; removed: string[] } {
  const dir = nginxDir(layout);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const changed: string[] = [];
  const keep = new Set<string>();
  for (const site of sites) {
    const file = siteFile(layout, site.app);
    const text = siteText(site);
    keep.add(path.basename(file));
    let old: string | null = null;
    try {
      old = fs.readFileSync(file, 'utf8');
    } catch {
      // new
    }
    if (old === text) continue;
    fs.writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
    fs.renameSync(`${file}.tmp`, file);
    changed.push(site.app);
  }
  const removed: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const app = name.endsWith('.site') ? name.slice(0, -'.site'.length) : null;
    if (!app || !NAME_PATTERN.test(app) || keep.has(name)) continue;
    fs.rmSync(path.join(dir, name), { force: true });
    removed.push(app);
  }
  return { changed: changed.sort(), removed: removed.sort() };
}
