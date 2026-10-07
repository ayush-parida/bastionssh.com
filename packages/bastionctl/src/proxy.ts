import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DeployAppConfig, DeployContainer, DeployProxyMode } from '@smt/shared';
import { appNames, tryLoadConfig } from './config.js';
import type { Ctx } from './context.js';
import { certPaths, generateCaddyfile, NGINX_LOOPBACK, PROXY_MOUNT, splitRedirects, type ProxySite } from './caddy.js';
import { CADDY_IMAGE } from './images.js';
import { waitForLock } from './lock.js';
import { BastionError, containerName, isInside, LABEL_MANAGED, LIVE_NETWORK, liveAlias, NETWORK, PROXY_CONTAINER } from './names.js';
import { NGINX_HELPER_PATH, NGINX_UPSTREAM_PORT, proxyMode, syncSiteFiles } from './nginx.js';
import { CADDY_ID, caddyBinary, FRONT_PATH, linkedCaddy, PROXY_IMAGE } from './proxy-image.js';
import { currentRelease, readRelease } from './releases.js';
import { BASTIONCTL_VERSION } from './version.js';

/**
 * The Caddy proxy (deployments spec §2.5, §5 step 6): one `bastion-caddy`
 * container owning ports 80 and 443 on the `bastion-apps` network, with
 * `<root>/proxy` mounted at /bastion-proxy. Its image (proxy-image.ts) runs
 * the proxy front (front.ts), which owns the ports and runs Caddy behind
 * them. Applying a new Caddyfile writes it beside the old one, has Caddy
 * validate it, swaps it in and has the front start a Caddy with it and move
 * new connections over once it serves every certificate the old one did —
 * the old Caddy finishes its open connections first, so no request is lost.
 * A refused switch puts the previous file back; the old Caddy never stopped.
 *
 * Caddy reaches each app by its live alias on `bastion-live` (names.ts
 * liveAlias), not by container name. A deploy moves traffic by attaching the
 * healthy new container under that alias and stopping the old one, with no
 * switch of Caddy at all; only config changes (domains, TLS, port, apps added
 * or removed) start a new one.
 */

export { CADDY_IMAGE };

/** An app whose entry in the proxy changes: a new upstream, or null to drop it. */
export type ProxyOverride = Map<string, ProxySite | null>;

export function siteFor(config: DeployAppConfig, release: string, port: number): ProxySite {
  return { app: config.name, release, domains: config.domains, redirect_www: config.redirect_www, tls: config.tls, upstream: `${liveAlias(config.name, port)}:${port}` };
}

/** The app's site, or null for an app without domains (no proxy entry). */
export function siteOrNone(config: DeployAppConfig, release: string, port: number): ProxySite | null {
  return config.domains.length > 0 ? siteFor(config, release, port) : null;
}

/** The sites of every app with a current release, apps in `overrides` replaced. Apps asking for the other proxy mode are left out. */
export function collectSites(ctx: Pick<Ctx, 'layout' | 'log'>, overrides: ProxyOverride = new Map()): ProxySite[] {
  const sites: ProxySite[] = [];
  const mode = proxyMode(ctx.layout);
  for (const app of new Set([...appNames(ctx.layout), ...overrides.keys()])) {
    if (overrides.has(app)) {
      const site = overrides.get(app);
      if (site) sites.push(site);
      continue;
    }
    const { config, error } = tryLoadConfig(ctx.layout, app);
    const current = currentRelease(ctx.layout, app);
    if (!current) continue;
    if (!config) {
      ctx.log(`warning: ${app} is left out of the proxy: ${error}`);
      continue;
    }
    // A service reached on bastion-apps only
    if (config.domains.length === 0) continue;
    if (config.proxy !== mode) {
      ctx.log(`warning: ${app} is left out of the proxy: it asks for proxy: ${config.proxy}, but this server is set up for ${mode}`);
      continue;
    }
    const record = readRelease(ctx.layout, app, current);
    if (!record || !record.container || !record.port) {
      ctx.log(`warning: ${app} is left out of the proxy: release ${current} has no release.json`);
      continue;
    }
    // Only ever our own name and a port go into the Caddyfile, whatever release.json says
    if (record.container !== containerName(app, current) || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
      ctx.log(`warning: ${app} is left out of the proxy: release.json of ${current} names another container or port`);
      continue;
    }
    sites.push(siteFor(config, current, record.port));
  }
  return sites;
}

/**
 * Copy `tls: { cert, key }` files from the app folder to
 * `<root>/proxy/certs/<app>/` for Caddy. True when any copy differs from the
 * file Caddy loaded: the Caddyfile names the same paths, so only a forced
 * reload makes Caddy read a renewed certificate.
 */
function copyCertificates(ctx: Pick<Ctx, 'layout'>, sites: ProxySite[]): boolean {
  let changed = false;
  for (const site of sites) {
    if (typeof site.tls === 'string') continue;
    const appDir = ctx.layout.app(site.app);
    const dest = certPaths(site.app);
    fs.mkdirSync(path.join(ctx.layout.proxy, 'certs', site.app), { recursive: true, mode: 0o700 });
    for (const kind of ['cert', 'key'] as const) {
      const from = path.resolve(appDir, site.tls[kind]);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(from);
      } catch {
        // reported below
      }
      if (!isInside(appDir, from) || !stat?.isFile()) throw new BastionError(`tls.${kind} of ${site.app} (${site.tls[kind]}) is not a file in the app folder`);
      const to = path.join(ctx.layout.proxy, dest[kind]);
      const before = readBytes(to);
      fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o600);
      if (!before?.equals(fs.readFileSync(to))) changed = true;
    }
  }
  return changed;
}

function readBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export async function proxyContainer(ctx: Pick<Ctx, 'docker'>): Promise<DeployContainer | null> {
  const info = await ctx.docker.inspectContainer(PROXY_CONTAINER);
  if (!info) return null;
  return {
    name: PROXY_CONTAINER,
    id: info.Id.slice(0, 12),
    state: info.State.Status,
    status: info.State.Status,
    health: info.State.Health?.Status ?? null,
  };
}

export async function requireProxy(ctx: Pick<Ctx, 'docker'>) {
  const proxy = await proxyContainer(ctx);
  if (!proxy) throw new BastionError('The proxy is not set up on this server (run bastionctl setup)');
  if (proxy.state !== 'running') throw new BastionError(`The proxy container ${PROXY_CONTAINER} is ${proxy.state} (run bastionctl setup)`);
}

/** Labels on the proxy container: the bastionctl build that created it, and a hash of its create spec. */
export const LABEL_BUILD = 'bastion.build';
export const LABEL_PROXY_SPEC = 'bastion.proxy-spec';

/**
 * The Caddy program the running proxy starts generations with: the linked
 * binary for a container from this generation (it has the build label), else
 * the one in its image (a container from before Caddy came out of the image,
 * on a pinned server). Null for the latter: its front takes no `--caddy`.
 */
export function caddyProgram(ctx: Pick<Ctx, 'layout'>, info: { Config: { Labels: Record<string, string> | null } } | null): string | null {
  return info?.Config.Labels?.[LABEL_BUILD] ? caddyBinary(linkedCaddy(ctx) ?? CADDY_ID) : null;
}

/** Validate `file` (a path in the proxy container) with Caddy `program`. */
export async function validateCaddyfile(ctx: Pick<Ctx, 'docker'>, file: string, program: string | null) {
  return ctx.docker.exec(PROXY_CONTAINER, [program ?? 'caddy', 'validate', '--config', file, '--adapter', 'caddyfile'], 60_000);
}

/** The front's `reload`: a new Caddy generation with the config whose text hashes to `sha256`, running `program` when given. */
export async function frontReload(ctx: Pick<Ctx, 'docker'>, sha256: string, program: string | null, probe: string[]) {
  return ctx.docker.exec(PROXY_CONTAINER, ['node', FRONT_PATH, 'reload', '--sha256', sha256, ...(program ? ['--caddy', program] : []), ...probe], 120_000);
}

/** The names whose certificates a new Caddy must serve before it takes traffic (those the running one has). */
export function probeNames(sites: readonly ProxySite[]): string[] {
  const names = sites.flatMap((s) => {
    const { served, redirects } = splitRedirects(s.domains, s.redirect_www);
    return [...served, ...redirects.map(([from]) => from)];
  });
  return [...new Set(names.filter((d) => !d.startsWith('*.')))].slice(0, 200);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function lastLines(text: string, n = 6): string {
  return text.trim().split('\n').slice(-n).join('\n');
}

/** How long a run waits for another run's proxy switch to finish. */
export const PROXY_LOCK_WAIT_MS = 5 * 60_000;

/**
 * Regenerate the Caddyfile from every app (with `overrides`), validate it,
 * swap it in and reload. On a failed validation nothing changes; on a failed
 * reload the previous file is restored and reloaded. Throws in both cases.
 *
 * The whole switch holds `proxy.lock`, and so does `applied` — what makes the
 * change permanent on disk (moving `current`): the config is built from every
 * app's `current`, so two apps switching at once must not each write a config
 * that leaves out the other's new release, or one built before the other's
 * link moved.
 */
export async function applyProxy(
  ctx: Pick<Ctx, 'layout' | 'docker' | 'log' | 'actor' | 'now'>,
  overrides: ProxyOverride = new Map(),
  applied?: () => void,
): Promise<void> {
  await requireProxy(ctx);
  await withProxyLock(ctx, async () => {
    await switchProxy(ctx, overrides);
    applied?.();
  });
}

export interface SwitchOptions {
  /** Leave Caddy alone when the generated file is the one it runs (a deploy that only moved the live alias). */
  onlyIfChanged?: boolean;
}

/** Run `fn` holding `proxy.lock` (see {@link applyProxy}); waits for another run's switch to finish. */
export async function withProxyLock<T>(ctx: Pick<Ctx, 'layout' | 'docker' | 'actor' | 'now'>, fn: () => Promise<T>): Promise<T> {
  const release = await waitForLock(ctx.layout.proxyLock, {
    holder: ctx.actor,
    docker: ctx.docker,
    now: ctx.now,
    what: 'proxy config',
    waitMs: PROXY_LOCK_WAIT_MS,
  });
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * In nginx mode, the addresses the host's nginx reaches Caddy from, whose
 * X-Forwarded-For Caddy keeps: the port published on 127.0.0.1 is forwarded
 * into the container from the gateway of {@link NETWORK} (Docker's proxy, or
 * its NAT), and 127.0.0.1 itself. Not the private ranges: every app container
 * on the network is in them, and could claim any client address.
 */
export async function nginxTrustedProxies(ctx: Pick<Ctx, 'docker' | 'log'>): Promise<string[]> {
  const network = await ctx.docker.inspectNetwork(NETWORK);
  const gateways = (network?.IPAM?.Config ?? []).map((c) => c.Gateway?.split('/')[0] ?? '').filter((g) => net.isIPv4(g));
  if (gateways.length === 0) ctx.log(`warning: no gateway address for ${NETWORK}; forwarded headers are trusted from 127.0.0.1 only`);
  return [...gateways.map((g) => `${g}/32`), NGINX_LOOPBACK];
}

/** The Caddyfile for `sites` in the server's mode. */
export async function caddyfileFor(ctx: Pick<Ctx, 'layout' | 'docker' | 'log'>, sites: ProxySite[]): Promise<string> {
  const mode = proxyMode(ctx.layout);
  return generateCaddyfile(sites, mode, mode === 'nginx' ? await nginxTrustedProxies(ctx) : undefined);
}

/** The switch itself; the caller holds `proxy.lock` and checked the proxy runs. */
export async function switchProxy(ctx: Pick<Ctx, 'layout' | 'docker' | 'log'>, overrides: ProxyOverride, opts: SwitchOptions = {}): Promise<void> {
  const sites = collectSites(ctx, overrides);
  const mode = proxyMode(ctx.layout);
  const certificatesChanged = copyCertificates(ctx, sites);
  const text = await caddyfileFor(ctx, sites);
  const file = ctx.layout.caddyfile;
  if (opts.onlyIfChanged && !certificatesChanged && readText(file) === text) {
    ctx.log('Proxy config unchanged; traffic moves over the live network');
    return;
  }
  const info = await ctx.docker.inspectContainer(PROXY_CONTAINER);
  // Only a proxy from before the front cannot switch configs (an unpinned server's is replaced before any command gets here)
  if (info && !info.Config.Image.startsWith('bastion-proxy:')) {
    throw new BastionError(
      `${PROXY_CONTAINER} runs a proxy from before bastionctl's proxy front, and this server is pinned (${ctx.layout.bin}/.pinned), so it is not upgraded automatically; ` +
        'run bastionctl proxy upgrade (Update proxy now in BastionSSH) or setup, then try again',
    );
  }
  const next = `${file}.next`;
  const prev = `${file}.prev`;
  fs.writeFileSync(next, text, { mode: 0o644 });

  const program = caddyProgram(ctx, info);
  const validated = await validateCaddyfile(ctx, `${PROXY_MOUNT}/Caddyfile.next`, program);
  if (validated.exitCode !== 0) {
    fs.rmSync(next, { force: true });
    throw new BastionError(`The new proxy config was refused; nothing changed:\n${lastLines(validated.stderr || validated.stdout)}`);
  }

  const hadPrevious = fs.existsSync(file);
  if (hadPrevious) fs.copyFileSync(file, prev);
  fs.renameSync(next, file);
  // A new Caddy reads the file (and any renewed certificate files); the running one serves until it is ready
  const sha256 = createHash('sha256').update(text).digest('hex');
  const reloaded = await frontReload(ctx, sha256, program, mode === 'caddy' ? probeNames(sites) : []);
  if (reloaded.exitCode === 0) {
    ctx.log(`Proxy switched to the new config (${sites.length} app${sites.length === 1 ? '' : 's'}); open connections finish on the previous one`);
    if (mode === 'nginx') {
      // The host's nginx follows through the helper (BastionSSH runs it; see nginx.ts)
      const { changed, removed } = syncSiteFiles(ctx.layout, sites);
      for (const app of changed) ctx.log(`nginx: the server block of ${app} changed; run: sudo ${NGINX_HELPER_PATH} apply ${ctx.layout.root} ${app}`);
      for (const app of removed) ctx.log(`nginx: ${app} is no longer served; run: sudo ${NGINX_HELPER_PATH} remove ${app}`);
    }
    return;
  }
  const reason = lastLines(reloaded.stderr || reloaded.stdout);
  // The running Caddy never stopped: putting the file back is all there is to undo
  if (hadPrevious) fs.renameSync(prev, file);
  else fs.rmSync(file, { force: true });
  throw new BastionError(`Reloading the proxy failed; the previous config was restored:\n${reason}`);
}

/** Attach `container` to the live network under `alias` unless it already answers to it there. */
export async function joinLive(ctx: Pick<Ctx, 'docker'>, container: string, alias?: string): Promise<boolean> {
  const info = await ctx.docker.inspectContainer(container);
  if (!info) throw new BastionError(`No container ${container}`);
  const endpoint = info.NetworkSettings?.Networks?.[LIVE_NETWORK];
  if (endpoint && (!alias || endpoint.Aliases?.includes(alias))) return false;
  // Attached under other aliases (a container from before this release's port): not ours to fix here
  if (endpoint) throw new BastionError(`${container} is on ${LIVE_NETWORK} without the alias ${alias}`);
  await ctx.docker.connectNetwork(LIVE_NETWORK, container, alias ? [alias] : []);
  return true;
}

/** Write the Caddyfile without a running proxy: at first setup, or (`replace`) for a proxy container being created anew. The network exists. */
export async function writeInitialCaddyfile(ctx: Pick<Ctx, 'layout' | 'docker' | 'log'>, replace = false): Promise<void> {
  if (!replace && fs.existsSync(ctx.layout.caddyfile)) return;
  fs.writeFileSync(ctx.layout.caddyfile, await caddyfileFor(ctx, collectSites(ctx)), { mode: 0o644 });
}

/** Read `<root>/proxy/.env` (DNS provider tokens) for the proxy container's environment. */
export function proxyEnv(ctx: Pick<Ctx, 'layout'>, parse: (text: string) => Map<string, string>): string[] {
  try {
    const text = fs.readFileSync(path.join(ctx.layout.proxy, '.env'), 'utf8');
    return [...parse(text)].map(([k, v]) => `${k}=${v}`);
  } catch {
    return [];
  }
}

/** Label on the proxy container naming the mode it was created for; a change of mode recreates it. */
export const LABEL_PROXY_MODE = 'bastion.proxy-mode';

/**
 * The proxy container's create spec (spec §2.5): ports 80 and 443 on every
 * address, or in nginx mode plain HTTP on the loopback port the host's nginx
 * forwards to. Labelled with this bastionctl's build and a hash of the spec
 * itself (without DNS provider tokens), so a proxy created by another build
 * with another spec is known to be outdated.
 */
export function proxySpec(ctx: Pick<Ctx, 'layout'>, env: string[], mode: DeployProxyMode = 'caddy'): Record<string, unknown> {
  const base = baseSpec(ctx, mode);
  return { ...base, Env: [...env, ...base.Env], Labels: { [LABEL_MANAGED]: 'proxy', [LABEL_PROXY_MODE]: mode, [LABEL_BUILD]: BASTIONCTL_VERSION, [LABEL_PROXY_SPEC]: proxySpecHash(ctx, mode) } };
}

function baseSpec(ctx: Pick<Ctx, 'layout'>, mode: DeployProxyMode) {
  const proxy = ctx.layout.proxy;
  const ports =
    mode === 'nginx'
      ? { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(NGINX_UPSTREAM_PORT) }] }
      : {
          '80/tcp': [{ HostPort: '80' }],
          '443/tcp': [{ HostPort: '443' }],
        };
  return {
    Image: PROXY_IMAGE,
    Env: [`BASTION_PROXY_LISTEN=${mode === 'nginx' ? '80:http' : '80:http,443:https'}`, `BASTION_PROXY_CONFIG=${PROXY_MOUNT}/Caddyfile`],
    ExposedPorts: mode === 'nginx' ? { '80/tcp': {} } : { '80/tcp': {}, '443/tcp': {} },
    HostConfig: {
      Binds: [`${proxy}:${PROXY_MOUNT}`, `${path.join(proxy, 'data')}:/data`, `${path.join(proxy, 'config')}:/config`],
      PortBindings: ports,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: NETWORK,
    },
  };
}

/** What {@link LABEL_PROXY_SPEC} holds: the spec for `mode` without labels and provider tokens, hashed. */
export function proxySpecHash(ctx: Pick<Ctx, 'layout'>, mode: DeployProxyMode): string {
  return createHash('sha256').update(JSON.stringify(baseSpec(ctx, mode))).digest('hex').slice(0, 16);
}
