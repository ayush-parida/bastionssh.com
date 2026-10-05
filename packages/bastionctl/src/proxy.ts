import fs from 'node:fs';
import path from 'node:path';
import type { DeployAppConfig, DeployContainer } from '@smt/shared';
import images from './images.json' with { type: 'json' };
import { appNames, tryLoadConfig } from './config.js';
import type { Ctx } from './context.js';
import { certPaths, generateCaddyfile, PROXY_MOUNT, type ProxySite } from './caddy.js';
import { waitForLock } from './lock.js';
import { BastionError, containerName, isInside, LABEL_MANAGED, LIVE_NETWORK, liveAlias, NETWORK, PROXY_CONTAINER } from './names.js';
import { currentRelease, readRelease } from './releases.js';

/**
 * The Caddy proxy (deployments spec §2.5, §5 step 6): one `bastion-caddy`
 * container owning ports 80 and 443 on the `bastion-apps` network, with
 * `<root>/proxy` mounted at /bastion-proxy. Applying a new Caddyfile writes it
 * beside the old one, has Caddy validate it, swaps it in and reloads
 * gracefully; a failed reload puts the previous file back and reloads that.
 *
 * Caddy reaches each app by its live alias on `bastion-live` (names.ts
 * liveAlias), not by container name. A deploy moves traffic by attaching the
 * healthy new container under that alias and stopping the old one, with no
 * reload at all: even a graceful reload drops the odd connection Caddy had
 * just accepted (Go's server shutdown closes a connection whose request
 * arrives after it began), and on a busy site that is a failed request on
 * every deploy of any app. Only config changes (domains, TLS, port, apps
 * added or removed) reload.
 */

/** Pinned image reference for creating the container (`repo@sha256:…`). */
export const CADDY_IMAGE = images.caddy.replace(/:[^/@]*@/, '@');

/** An app whose entry in the proxy changes: a new upstream, or null to drop it. */
export type ProxyOverride = Map<string, ProxySite | null>;

export function siteFor(config: DeployAppConfig, release: string, port: number): ProxySite {
  return { app: config.name, release, domains: config.domains, redirect_www: config.redirect_www, tls: config.tls, upstream: `${liveAlias(config.name, port)}:${port}` };
}

/** The sites of every app with a current release, apps in `overrides` replaced. Apps in nginx mode are not Caddy's. */
export function collectSites(ctx: Pick<Ctx, 'layout' | 'log'>, overrides: ProxyOverride = new Map()): ProxySite[] {
  const sites: ProxySite[] = [];
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
    if (config.proxy !== 'caddy') continue;
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

async function caddy(ctx: Pick<Ctx, 'docker'>, args: string[]) {
  return ctx.docker.exec(PROXY_CONTAINER, ['caddy', ...args, '--adapter', 'caddyfile'], 60_000);
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

/** The switch itself; the caller holds `proxy.lock` and checked the proxy runs. */
export async function switchProxy(ctx: Pick<Ctx, 'layout' | 'docker' | 'log'>, overrides: ProxyOverride, opts: SwitchOptions = {}): Promise<void> {
  const sites = collectSites(ctx, overrides);
  const certificatesChanged = copyCertificates(ctx, sites);
  const text = generateCaddyfile(sites);
  const file = ctx.layout.caddyfile;
  if (opts.onlyIfChanged && !certificatesChanged && readText(file) === text) {
    ctx.log('Proxy config unchanged; traffic moves over the live network');
    return;
  }
  const next = `${file}.next`;
  const prev = `${file}.prev`;
  fs.writeFileSync(next, text, { mode: 0o644 });

  const validated = await caddy(ctx, ['validate', '--config', `${PROXY_MOUNT}/Caddyfile.next`]);
  if (validated.exitCode !== 0) {
    fs.rmSync(next, { force: true });
    throw new BastionError(`The new proxy config was refused; nothing changed:\n${lastLines(validated.stderr || validated.stdout)}`);
  }

  const hadPrevious = fs.existsSync(file);
  if (hadPrevious) fs.copyFileSync(file, prev);
  fs.renameSync(next, file);
  // Caddy skips a reload whose config is unchanged, and would keep serving the old certificate
  const reloaded = await caddy(ctx, ['reload', '--config', `${PROXY_MOUNT}/Caddyfile`, ...(certificatesChanged ? ['--force'] : [])]);
  if (reloaded.exitCode === 0) {
    ctx.log(`Proxy reloaded (${sites.length} app${sites.length === 1 ? '' : 's'})`);
    return;
  }
  const reason = lastLines(reloaded.stderr || reloaded.stdout);
  if (hadPrevious) {
    fs.renameSync(prev, file);
    const restored = await caddy(ctx, ['reload', '--config', `${PROXY_MOUNT}/Caddyfile`]);
    if (restored.exitCode !== 0) ctx.log(`warning: reloading the previous proxy config failed too: ${lastLines(restored.stderr)}`);
  }
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

/** Write the Caddyfile without a running proxy (first setup). */
export function writeInitialCaddyfile(ctx: Pick<Ctx, 'layout' | 'log'>): void {
  if (fs.existsSync(ctx.layout.caddyfile)) return;
  fs.writeFileSync(ctx.layout.caddyfile, generateCaddyfile(collectSites(ctx)), { mode: 0o644 });
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

/** The proxy container's create spec (spec §2.5). */
export function proxySpec(ctx: Pick<Ctx, 'layout'>, env: string[]): Record<string, unknown> {
  const proxy = ctx.layout.proxy;
  return {
    Image: CADDY_IMAGE,
    Cmd: ['caddy', 'run', '--config', `${PROXY_MOUNT}/Caddyfile`, '--adapter', 'caddyfile'],
    Env: env,
    Labels: { [LABEL_MANAGED]: 'proxy' },
    ExposedPorts: { '80/tcp': {}, '443/tcp': {}, '443/udp': {} },
    HostConfig: {
      Binds: [`${proxy}:${PROXY_MOUNT}`, `${path.join(proxy, 'data')}:/data`, `${path.join(proxy, 'config')}:/config`],
      PortBindings: {
        '80/tcp': [{ HostPort: '80' }],
        '443/tcp': [{ HostPort: '443' }],
        '443/udp': [{ HostPort: '443' }],
      },
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: NETWORK,
    },
  };
}
