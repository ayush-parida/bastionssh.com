import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeployProxyMode, DeployProxyStatus, DeployProxyUpgrade, DeployProxyUpgradeTrigger } from '@smt/shared';
import { PROXY_MOUNT } from './caddy.js';
import { sleep, type Ctx } from './context.js';
import { parseEnv } from './env.js';
import { BastionError, PROXY_CONTAINER } from './names.js';
import { NGINX_UPSTREAM_PORT, readProxyMode } from './nginx.js';
import { CADDY_ID, caddyBinary, ensureCaddyBinary, ensureProxyImage, linkCaddy, linkedCaddy, PROXY_IMAGE, pruneCaddyBinaries, pruneProxyImages } from './proxy-image.js';
import {
  caddyfileFor,
  collectSites,
  frontReload,
  joinLive,
  LABEL_BUILD,
  LABEL_PROXY_MODE,
  LABEL_PROXY_SPEC,
  probeNames,
  proxyEnv,
  proxySpec,
  proxySpecHash,
  validateCaddyfile,
  withProxyLock,
} from './proxy.js';
import { BASTIONCTL_VERSION } from './version.js';

/**
 * Automatic proxy upgrades (services spec §2). The proxy is two parts with
 * their own lifetimes:
 *
 * - **Caddy**, a binary under `<root>/proxy/caddy/<id>/` the front starts
 *   through a link. A new one is linked and the front starts a new Caddy
 *   generation with it, moving new connections over once it serves the
 *   running one's certificates; the old generation finishes its connections.
 *   Nothing is dropped. If the new Caddy refuses the config or does not
 *   start, the link goes back and the old generation never stopped.
 * - **The front**, the `bastion-caddy` container itself (front.ts in the
 *   `bastion-proxy` image, its ports and mounts). Replaced only when its
 *   image or create spec changed: the old container is renamed aside and
 *   stopped, the new one created and started, and it must accept connections
 *   before the old one is removed — otherwise the new one goes and the old
 *   one is put back and started. The ports move between containers, so
 *   connections in flight can drop for about a second.
 *
 * `<root>/proxy/state.json` records the build that last brought the proxy up
 * to date and the Caddy it serves; the container is labelled with the build
 * that created it and a hash of its spec (proxy.ts). Every command that
 * changes traffic (deploy, rollback, restart, config change, delete, proxy
 * apply, setup) upgrades an outdated proxy first, unless the server is
 * pinned (`<root>/bin/.pinned`; setup and `proxy upgrade` still do). Read-only
 * commands never do. What happened is reported in the command's JSON
 * (`proxyUpgrade`) for BastionSSH's audit.
 */

/** The previous proxy container while a new one starts. */
export const PROXY_PREVIOUS = `${PROXY_CONTAINER}-previous`;
const DEFAULT_READY_MS = 30_000;
/** How long the replaced proxy container may take to stop before Docker kills it. */
const PREVIOUS_STOP_S = 1;

interface ProxyStateFile {
  build: string;
  caddy: string;
}

const stateFile = (ctx: Pick<Ctx, 'layout'>) => path.join(ctx.layout.proxy, 'state.json');

export function readProxyState(ctx: Pick<Ctx, 'layout'>): ProxyStateFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(ctx), 'utf8')) as Partial<ProxyStateFile>;
    return typeof raw.build === 'string' && typeof raw.caddy === 'string' ? { build: raw.build.slice(0, 100), caddy: raw.caddy } : null;
  } catch {
    return null;
  }
}

export function writeProxyState(ctx: Pick<Ctx, 'layout'>): void {
  const file = stateFile(ctx);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ build: BASTIONCTL_VERSION, caddy: CADDY_ID }) + '\n', { mode: 0o644 });
  fs.renameSync(`${file}.tmp`, file);
}

/** `<root>/bin/.pinned`: neither bastionctl nor the proxy is upgraded automatically. */
export function isPinned(ctx: Pick<Ctx, 'layout'>): boolean {
  return fs.existsSync(path.join(ctx.layout.bin, '.pinned'));
}

/** The mode the proxy is (to be) set up for: the server's setting, else the container's label. */
function modeOf(ctx: Pick<Ctx, 'layout'>, labels: Record<string, string> | null | undefined): DeployProxyMode {
  return readProxyMode(ctx.layout) ?? (labels?.[LABEL_PROXY_MODE] === 'nginx' ? 'nginx' : 'caddy');
}

/** The proxy against what this bastionctl runs (`proxy status`). */
export async function proxyStatus(ctx: Pick<Ctx, 'layout' | 'docker'>): Promise<DeployProxyStatus> {
  const pinned = isPinned(ctx);
  const info = await ctx.docker.inspectContainer(PROXY_CONTAINER);
  if (!info) return { state: 'missing', build: null, target: BASTIONCTL_VERSION, outdated: [], pinned };
  const labels = info.Config.Labels ?? {};
  const frontOk = info.Config.Image === PROXY_IMAGE && labels[LABEL_PROXY_SPEC] === proxySpecHash(ctx, modeOf(ctx, labels));
  const state = readProxyState(ctx);
  const caddyOk = state?.caddy === CADDY_ID && linkedCaddy(ctx) === CADDY_ID;
  const outdated: DeployProxyStatus['outdated'] = [...(caddyOk ? [] : (['caddy'] as const)), ...(frontOk ? [] : (['front'] as const))];
  return {
    state: !info.State.Running ? 'stopped' : outdated.length > 0 ? 'outdated' : 'ok',
    build: state?.build ?? labels[LABEL_BUILD] ?? 'unknown',
    target: BASTIONCTL_VERSION,
    outdated,
    pinned,
  };
}

/**
 * A run cut off between moving the proxy container aside and putting its
 * replacement in place leaves only {@link PROXY_PREVIOUS}: put it back.
 */
export async function recoverPreviousProxy(ctx: Pick<Ctx, 'docker' | 'log'>): Promise<void> {
  if (await ctx.docker.inspectContainer(PROXY_CONTAINER)) return;
  const previous = await ctx.docker.inspectContainer(PROXY_PREVIOUS);
  if (!previous) return;
  ctx.log(`Putting back ${PROXY_PREVIOUS} (an upgrade was cut off before its replacement was in place)`);
  await ctx.docker.rename(PROXY_PREVIOUS, PROXY_CONTAINER);
  await ctx.docker.start(PROXY_CONTAINER);
}

/** Note the upgrade for the command's JSON (see {@link Ctx.report}). */
function report(ctx: Ctx, upgrade: DeployProxyUpgrade): void {
  if (ctx.report) ctx.report.proxyUpgrade = upgrade;
}

/**
 * At the start of a command that changes traffic: upgrade an outdated proxy
 * (see the module comment) unless the server is pinned. Null when nothing
 * was tried. A failed upgrade does not fail the command: the previous proxy
 * was restored and serves, the command goes on with it, and the result says
 * `failed` (the next such command tries again).
 */
export async function ensureProxyCurrent(ctx: Ctx, trigger: DeployProxyUpgradeTrigger): Promise<DeployProxyUpgrade | null> {
  let status = await proxyStatus(ctx);
  if (status.state === 'missing' && (await ctx.docker.inspectContainer(PROXY_PREVIOUS))) {
    await withProxyLock(ctx, () => recoverPreviousProxy(ctx));
    status = await proxyStatus(ctx);
  }
  if (status.state !== 'outdated') return null;
  if (status.pinned) {
    ctx.log(`warning: the proxy is from bastionctl ${status.build} (this is ${BASTIONCTL_VERSION}); this server is pinned, so it is not upgraded automatically`);
    return null;
  }
  const upgrade = await withProxyLock(ctx, () => upgradeProxy(ctx, trigger));
  if (!upgrade) return null;
  report(ctx, upgrade);
  if (upgrade.result === 'failed') ctx.log(`warning: the proxy upgrade failed; the previous proxy serves and ${trigger.replace('_', ' ')} goes on with it (${upgrade.error})`);
  return upgrade;
}

/**
 * `proxy upgrade`: bring the proxy up to date now, pinned or not (an
 * explicit request, like setup). Throws when it failed, the previous proxy
 * restored; the error's details carry the attempt for the audit.
 */
export async function upgradeProxyNow(ctx: Ctx): Promise<{ proxyUpgrade: DeployProxyUpgrade | null; status: DeployProxyStatus }> {
  const upgrade = await withProxyLock(ctx, async () => {
    await recoverPreviousProxy(ctx);
    const status = await proxyStatus(ctx);
    if (status.state === 'missing') throw new BastionError('The proxy is not set up on this server (run bastionctl setup)');
    return upgradeProxy(ctx, 'manual');
  });
  if (upgrade) report(ctx, upgrade);
  if (upgrade?.result === 'failed') {
    throw new BastionError(`The proxy could not be upgraded to bastionctl ${BASTIONCTL_VERSION}; the previous one keeps serving: ${upgrade.error}`, 1, { proxyUpgrade: upgrade });
  }
  if (!upgrade) ctx.log(`The proxy is up to date (bastionctl ${BASTIONCTL_VERSION})`);
  return { proxyUpgrade: upgrade, status: await proxyStatus(ctx) };
}

/** Start the proxy container, explaining ports someone else holds. */
export async function startProxy(ctx: Pick<Ctx, 'docker'>, mode: DeployProxyMode): Promise<void> {
  try {
    await ctx.docker.start(PROXY_CONTAINER);
  } catch (err) {
    const message = (err as Error).message;
    if (/address already in use|port is already allocated/i.test(message)) {
      throw new BastionError(
        mode === 'nginx'
          ? `Port ${NGINX_UPSTREAM_PORT} on 127.0.0.1 is taken by something else on this server (${message}).`
          : `Ports 80/443 are taken by something else on this server (${message}). Stop it, or set up in nginx mode (setup --proxy nginx) when it is the host's nginx.`,
      );
    }
    throw err;
  }
}

/** A connect to port 80 inside the proxy container: the front listens only once its first Caddy does. */
const READY_SCRIPT =
  "const s=require('net').connect(80,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000)";

/** Wait until the new proxy container runs and accepts connections. */
async function waitProxyReady(ctx: Ctx): Promise<void> {
  const deadline = Date.now() + (ctx.proxyReadyMs ?? DEFAULT_READY_MS);
  let last = 'no answer';
  for (;;) {
    const info = await ctx.docker.inspectContainer(PROXY_CONTAINER);
    if (!info?.State.Running || info.State.Restarting) {
      const logs = await ctx.docker.logsTail(PROXY_CONTAINER, 15);
      throw new BastionError(`The new proxy container stopped (exit ${info?.State.ExitCode ?? '?'})${logs ? `:\n${logs}` : ''}`);
    }
    const probe = await ctx.docker.exec(PROXY_CONTAINER, ['node', '-e', READY_SCRIPT], 10_000).catch((err: Error) => ({ exitCode: 1, stdout: '', stderr: err.message }));
    if (probe.exitCode === 0) return;
    last = (probe.stderr || probe.stdout).trim() || 'not accepting connections';
    if (Date.now() >= deadline) {
      const logs = await ctx.docker.logsTail(PROXY_CONTAINER, 15);
      throw new BastionError(`The new proxy did not accept connections in time (${last})${logs ? `:\n${logs}` : ''}`);
    }
    await sleep(Math.min(Math.max(ctx.healthIntervalMs, 1), 500));
  }
}

/** Replace Caddy behind the running front: no connection is dropped. */
async function replaceCaddy(ctx: Ctx): Promise<void> {
  const before = linkedCaddy(ctx);
  ctx.log(`Starting Caddy ${CADDY_ID} behind the running proxy front (no connection is dropped)`);
  linkCaddy(ctx, CADDY_ID);
  try {
    if (!fs.existsSync(ctx.layout.caddyfile)) fs.writeFileSync(ctx.layout.caddyfile, await caddyfileFor(ctx, collectSites(ctx)), { mode: 0o644 });
    const validated = await validateCaddyfile(ctx, `${PROXY_MOUNT}/Caddyfile`, caddyBinary(CADDY_ID));
    if (validated.exitCode !== 0) throw new BastionError(`The new Caddy refuses the proxy config:\n${(validated.stderr || validated.stdout).trim().split('\n').slice(-6).join('\n')}`);
    const text = fs.readFileSync(ctx.layout.caddyfile);
    const sha256 = createHash('sha256').update(text).digest('hex');
    const probe = readProxyMode(ctx.layout) === 'nginx' ? [] : probeNames(collectSites(ctx));
    const reloaded = await frontReload(ctx, sha256, caddyBinary(CADDY_ID), probe);
    if (reloaded.exitCode !== 0) throw new BastionError(`The new Caddy did not take over:\n${(reloaded.stderr || reloaded.stdout).trim().split('\n').slice(-6).join('\n')}`);
  } catch (err) {
    // The running generation never stopped; the next one starts from the old binary again
    if (before) linkCaddy(ctx, before);
    throw err;
  }
}

/** Replace the proxy container (the front changed), keeping the old one until the new one accepts connections. */
async function replaceFront(ctx: Ctx, mode: DeployProxyMode, wasRunning: boolean, reason: string): Promise<void> {
  const { docker } = ctx;
  await ensureProxyImage(ctx);
  const beforeLink = linkedCaddy(ctx);
  const file = ctx.layout.caddyfile;
  const backup = `${file}.before-upgrade`;
  const hadFile = fs.existsSync(file);
  if (hadFile) fs.copyFileSync(file, backup);
  // Until the old container is renamed it keeps serving: a failure up to there puts the link and the file back,
  // or the next reload would run the new Caddy (and its file) under the old front
  try {
    linkCaddy(ctx, CADDY_ID);
    // From this version's generator: an older proxy's file may be for Caddy owning the ports itself
    fs.writeFileSync(file, await caddyfileFor(ctx, collectSites(ctx)), { mode: 0o644 });
    ctx.log(`Replacing ${PROXY_CONTAINER} (${reason})`);
    ctx.log('Connections in flight may drop for about a second while the ports move to the new container; the previous one is kept until the new one answers');
    await docker.remove(PROXY_PREVIOUS);
    await docker.rename(PROXY_CONTAINER, PROXY_PREVIOUS);
  } catch (err) {
    if (hadFile) fs.renameSync(backup, file);
    if (beforeLink) linkCaddy(ctx, beforeLink);
    throw err;
  }
  try {
    // The ports stay with the old container until it has stopped (Docker publishes them per
    // container), so it gets a second for requests in flight, not Caddy's whole grace period
    await docker.stop(PROXY_PREVIOUS, PREVIOUS_STOP_S);
    await docker.createContainer(PROXY_CONTAINER, proxySpec(ctx, proxyEnv(ctx, parseEnv), mode));
    await joinLive(ctx, PROXY_CONTAINER);
    await startProxy(ctx, mode);
    await waitProxyReady(ctx);
  } catch (err) {
    const reason = (err as Error).message;
    ctx.log(`The new proxy did not come up; restoring the previous one: ${reason.split('\n')[0]}`);
    try {
      await docker.remove(PROXY_CONTAINER);
      if (hadFile) fs.renameSync(backup, file);
      if (beforeLink) linkCaddy(ctx, beforeLink);
      await docker.rename(PROXY_PREVIOUS, PROXY_CONTAINER);
      if (wasRunning) await docker.start(PROXY_CONTAINER);
    } catch (restoreErr) {
      throw new BastionError(`${reason}\nRestoring the previous proxy failed too: ${(restoreErr as Error).message} (run bastionctl setup)`);
    }
    throw err;
  }
  fs.rmSync(backup, { force: true });
  await docker.remove(PROXY_PREVIOUS).catch((err: Error) => ctx.log(`warning: could not remove ${PROXY_PREVIOUS}: ${err.message}`));
  await pruneProxyImages(ctx);
}

/**
 * Bring an outdated proxy up to date (the caller holds `proxy.lock`). Null
 * when it already is (another run upgraded it meanwhile) or there is none to
 * upgrade (setup creates it). A failure is returned (`result: failed`), the
 * previous proxy restored and serving.
 */
export async function upgradeProxy(ctx: Ctx, trigger: DeployProxyUpgradeTrigger): Promise<DeployProxyUpgrade | null> {
  const status = await proxyStatus(ctx);
  if (status.state === 'missing' || status.outdated.length === 0) return null;
  const info = await ctx.docker.inspectContainer(PROXY_CONTAINER);
  const mode = modeOf(ctx, info?.Config.Labels);
  const from = status.build ?? 'unknown';
  const front = status.outdated.includes('front');
  const replaced: DeployProxyUpgrade['replaced'] = front ? ['front', ...(linkedCaddy(ctx) === CADDY_ID ? [] : (['caddy'] as const))] : ['caddy'];
  const previousCaddy = linkedCaddy(ctx);
  ctx.log(`Upgrading the proxy from bastionctl ${from} to ${BASTIONCTL_VERSION} (${replaced.join(' and ')})`);
  try {
    await ensureCaddyBinary(ctx);
    const labelled = info?.Config.Labels?.[LABEL_PROXY_MODE] ?? 'caddy';
    const reason = labelled !== mode ? `proxy mode is now ${mode}` : `its front or settings changed with bastionctl ${BASTIONCTL_VERSION}`;
    if (front) await replaceFront(ctx, mode, info?.State.Running === true, reason);
    else await replaceCaddy(ctx);
  } catch (err) {
    const error = (err as Error).message.split('\n')[0]!.slice(0, 300);
    ctx.log(`The proxy upgrade failed: ${(err as Error).message}`);
    return { from, to: BASTIONCTL_VERSION, trigger, result: 'failed', replaced, error };
  }
  writeProxyState(ctx);
  pruneCaddyBinaries(ctx, [CADDY_ID, previousCaddy]);
  ctx.log(`Proxy upgraded to bastionctl ${BASTIONCTL_VERSION}`);
  return { from, to: BASTIONCTL_VERSION, trigger, result: 'success', replaced };
}
