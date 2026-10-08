import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DeployAppCertificate,
  DeployAppConfig,
  DeployAppStatus,
  DeployAppSummary,
  DeployAppUsage,
  DeployContainer,
  DeployEnvGenerated,
  DeployOutcome,
  DeployProxyMode,
  DeployProxyStatus,
  DeployRelease,
  DeployRestartResult,
  DeploySetupResult,
  DeployValidation,
  DeployVersion,
} from '@smt/shared';
import { isDeployEnvFile, pickDeployBuildArgs } from '@smt/shared';
import { planBuild, GENERATED_DOCKERFILE } from './build.js';
import {
  appNames,
  durationMs,
  envFilePath,
  formatIssues,
  isDigestPinned,
  loadConfig,
  memoryBytes,
  MAX_CONFIG_BYTES,
  templateConfig,
  tryLoadConfig,
  validateForServer,
} from './config.js';
import { sleep, type Ctx } from './context.js';
import { appCertificates } from './certs.js';
import { ensureCron } from './cron.js';
import { DockerApiError, usageFrom } from './docker.js';
import { containerEnv, MAX_VALUE_BYTES, parseEnv, readEnvFile, setEnv, unsetEnv, writeEnvFile } from './env.js';
import { IMAGES as images, pinnedRef } from './images.js';
import { checkKernel, hostKernel } from './kernel.js';
import { deployedLine, releaseRef, rollbackLineCheck } from './lines.js';
import { acquireLock, lockView, readLock, waitForLock } from './lock.js';
import { envFileMasker } from './mask.js';
import {
  appName,
  BastionError,
  containerName,
  envKey,
  imageName,
  isInside,
  LABEL_APP,
  LABEL_MANAGED,
  LABEL_RELEASE,
  LIVE_NETWORK,
  liveAlias,
  newReleaseId,
  NETWORK,
  PROXY_CONTAINER,
  releaseId,
  volumeName,
} from './names.js';
import { NGINX_UPSTREAM_PORT, proxyMode, readProxyMode, writeProxyMode } from './nginx.js';
import { CADDY_ID, ensureCaddyBinary, ensureProxyImage, linkCaddy, linkedCaddy, pruneProxyImages } from './proxy-image.js';
import { applyProxy, joinLive, proxyContainer, proxyEnv, proxySpec, requireProxy, siteOrNone, switchProxy, withProxyLock, writeInitialCaddyfile } from './proxy.js';
import { ensureProxyCurrent, proxyStatus, readProxyState, recoverPreviousProxy, startProxy, upgradeProxy, upgradeProxyNow, writeProxyState } from './proxy-upgrade.js';
import {
  clearCurrent,
  currentRelease,
  previousRelease,
  pruneCandidates,
  readRelease,
  releaseIds,
  setCurrent,
  writeRelease,
  type ReleaseRecord,
} from './releases.js';
import { extractTar, packDirectory } from './tar.js';
import { BASTIONCTL_VERSION } from './version.js';

/**
 * The commands (deployments spec §5). Each takes a {@link Ctx} and returns
 * what `--json` prints; progress goes to `ctx.log`.
 */

/** Uploads left in `<root>/tmp` longer than this are removed by setup and deploy. */
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long a deploy waits for another app's image build (BastionSSH gives a deploy 30 minutes). */
const BUILD_LOCK_WAIT_MS = 20 * 60_000;
/** How long a setup waits for another one (BastionSSH gives setup 10 minutes; pulling the proxy image is most of it). */
const SETUP_LOCK_WAIT_MS = 8 * 60_000;
/** A restart's new container, until the old one is gone and it takes the release's name. */
const NEXT_SUFFIX = '-next';

// ── Helpers ───────────────────────────────────────────────────────────────────

function containerView(info: Awaited<ReturnType<Ctx['docker']['inspectContainer']>>, name: string): DeployContainer | null {
  if (!info) return null;
  return {
    name,
    id: info.Id.slice(0, 12),
    state: info.State.Status,
    status: info.State.Running ? `running since ${info.State.StartedAt ?? '?'}` : `${info.State.Status} (exit ${info.State.ExitCode ?? '?'})`,
    health: info.State.Health?.Status ?? null,
  };
}

/** A file argument must be inside the root directory (the only folder bastionctl's container sees). */
function fileInRoot(ctx: Ctx, file: string): string {
  const resolved = path.resolve(ctx.layout.root, file);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new BastionError(`${file} does not exist`, 2);
  }
  if (!isInside(fs.realpathSync(ctx.layout.root), real) || !fs.statSync(real).isFile()) {
    throw new BastionError(`${file} must be a file inside ${ctx.layout.root}`, 2);
  }
  return real;
}

function requireApp(ctx: Ctx, app: string) {
  appName(app);
  if (!fs.existsSync(ctx.layout.app(app))) throw new BastionError(`No app named ${app} on this server`);
}

function cleanTmp(ctx: Ctx) {
  let entries: string[];
  try {
    entries = fs.readdirSync(ctx.layout.tmp);
  } catch {
    return;
  }
  const cutoff = ctx.now().getTime() - TMP_MAX_AGE_MS;
  for (const name of entries) {
    const file = path.join(ctx.layout.tmp, name);
    try {
      if (fs.lstatSync(file).mtimeMs < cutoff) fs.rmSync(file, { recursive: true, force: true });
    } catch {
      // gone already
    }
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The container spec of a release (spec §5 step 4; services spec §3.2): on
 * bastion-apps under the app's name, so other apps reach it as
 * `<name>:<port>`; `run.publish` binds the port on the host's loopback
 * address or on every address.
 */
export function appContainerSpec(ctx: Ctx, config: DeployAppConfig, release: string, image: string): Record<string, unknown> {
  const mounts = config.run.volumes.map((v) => ({ Type: 'volume', Source: volumeName(config.name, v.name), Target: v.path, ReadOnly: v.readonly }));
  const { publish } = config.run;
  // The container port published: run.port, or the one run.publish names (MinIO's S3 port beside its console)
  const port = publish.target ?? config.run.port;
  const binding = publish.scope === 'none' || publish.port === null ? null : { HostIp: publish.scope === 'localhost' ? '127.0.0.1' : '0.0.0.0', HostPort: String(publish.port) };
  return {
    Image: image,
    Env: containerEnv(envFilePath(ctx.layout, config.name, config)),
    Labels: { [LABEL_APP]: config.name, [LABEL_RELEASE]: release, [LABEL_MANAGED]: 'app' },
    ...(config.run.command && { Cmd: config.run.command }),
    ...(config.run.entrypoint && { Entrypoint: config.run.entrypoint }),
    ...(binding && { ExposedPorts: { [`${port}/tcp`]: {} } }),
    HostConfig: {
      NetworkMode: NETWORK,
      RestartPolicy: { Name: 'unless-stopped' },
      Mounts: mounts,
      ...(binding && { PortBindings: { [`${port}/tcp`]: [binding] } }),
      ...(config.run.memory && { Memory: memoryBytes(config.run.memory) }),
      ...(config.run.cpus && { NanoCpus: Math.round(config.run.cpus * 1e9) }),
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
    NetworkingConfig: { EndpointsConfig: { [NETWORK]: { Aliases: [config.name] } } },
  };
}

/** A TCP connect from the proxy container (Node.js is its runtime): 0 when something accepts. */
const tcpProbe = (host: string, port: number) =>
  `const s=require('net').connect(${port},${JSON.stringify(host)});s.on('connect',()=>process.exit(0));s.on('error',(e)=>{console.error(e.message);process.exit(1)});setTimeout(()=>{console.error('timed out');process.exit(1)},5000)`;

/** What the health check of `config` does, for the log. */
function healthDescription(config: DeployAppConfig, container: string, port: number): string {
  switch (config.healthcheck.type) {
    case 'tcp':
      return `TCP connect to ${container}:${port}`;
    case 'command':
      return `${(config.healthcheck.command ?? []).join(' ')} in ${container}`;
    default:
      return `http://${container}:${port}${config.healthcheck.path}`;
  }
}

/**
 * Wait until the app is healthy (spec §5 step 5; services spec §3.2), until
 * the configured timeout passes: `http` fetches the path with `wget` from
 * the proxy container, `tcp` connects from there, `command` runs the argv in
 * the new container itself (exit code 0: healthy). A container that stops
 * meanwhile fails at once, with its last log lines.
 */
export async function waitHealthy(ctx: Ctx, config: DeployAppConfig, container: string, port: number): Promise<void> {
  const deadline = ctx.now().getTime() + durationMs(config.healthcheck.timeout);
  const { type } = config.healthcheck;
  ctx.log(`Health check: ${healthDescription(config, container, port)} (up to ${config.healthcheck.timeout})`);
  let last = '';
  for (;;) {
    const info = await ctx.docker.inspectContainer(container);
    // Exited, or crashed and being restarted by its policy: no point waiting
    if (!info || !info.State.Running || info.State.Restarting || (info.RestartCount ?? 0) > 0) {
      const logs = await ctx.docker.logsTail(container);
      throw new BastionError(`The new container stopped (exit ${info?.State.ExitCode ?? '?'})${logs ? `:\n${logs}` : ''}`);
    }
    let probe: { exitCode: number; stdout: string; stderr: string };
    if (type === 'command') {
      probe = await ctx.docker.exec(container, config.healthcheck.command!, 15_000).catch((err: Error) => ({ exitCode: 1, stdout: '', stderr: err.message }));
    } else {
      // By its address on bastion-apps, not its name: a name over 63 characters
      // (an app name over 30) is no valid DNS label, and the proxy's resolver
      // would never find it
      const ip = info.NetworkSettings?.Networks?.[NETWORK]?.IPAddress;
      if (!ip || !/^[0-9.]+$|^[0-9a-f:]+$/i.test(ip)) throw new BastionError(`The new container has no address on ${NETWORK}`);
      probe =
        type === 'tcp'
          ? await ctx.docker.exec(PROXY_CONTAINER, ['node', '-e', tcpProbe(ip, port)], 15_000)
          : await ctx.docker.exec(PROXY_CONTAINER, ['wget', '-q', '-O', '/dev/null', '-T', '5', `http://${ip.includes(':') ? `[${ip}]` : ip}:${port}${config.healthcheck.path}`], 15_000);
    }
    if (probe.exitCode === 0) {
      ctx.log('Health check passed');
      return;
    }
    last = (probe.stderr || probe.stdout).trim().split('\n').slice(-3).join('\n') || (type === 'command' ? `exit code ${probe.exitCode}` : '');
    if (ctx.now().getTime() >= deadline) {
      const logs = await ctx.docker.logsTail(container);
      throw new BastionError(`Health check failed after ${config.healthcheck.timeout}: ${last || 'no answer'}${logs ? `\nContainer log:\n${logs}` : ''}`);
    }
    await sleep(ctx.healthIntervalMs);
  }
}

/** Stop timeout for an old container in recreate mode: a database gets time to shut down cleanly. */
const RECREATE_STOP_S = 30;

/**
 * The new container is healthy: on bastion-live under the app's live alias,
 * the proxy config regenerated and reloaded only if it changed (first
 * deploy, another port or domains), and `current` moved — while the proxy
 * lock is held, so another app's switch builds on it.
 */
async function goLive(ctx: Ctx, config: DeployAppConfig, record: ReleaseRecord, name: string): Promise<void> {
  await requireProxy(ctx);
  await withProxyLock(ctx, async () => {
    // bastion.yml as it is now, read under the lock config changes take: one saved during
    // the build must not have the proxy serve the domains or TLS it had when the deploy began
    const fresh = loadConfig(ctx.layout, config.name);
    await joinLive(ctx, name, liveAlias(config.name, record.port));
    ctx.log(`${name} is live`);
    // An app without domains (a database) has no proxy entry; one that dropped its domains loses it
    await switchProxy(ctx, new Map([[config.name, siteOrNone(fresh, record.id, record.port)]]), { onlyIfChanged: true });
    // Release dirs may be gone for a CLI user who deleted them; the link still moves
    fs.mkdirSync(ctx.layout.release(config.name, record.id), { recursive: true });
    setCurrent(ctx.layout, config.name, record.id);
  });
}

/**
 * Start `record`'s image as the app's live container (spec §5 steps 4–7).
 *
 * `run.strategy: rolling` (the default), with no request lost:
 *
 * 1. a new container next to the old one, on bastion-apps only — out of
 *    the proxy's rotation — and its health check;
 * 2. it goes live ({@link goLive});
 * 3. after the drain delay the app's other containers are stopped (each gets
 *    SIGTERM and time to finish) and removed; a GET one of them drops is
 *    retried by Caddy on the new one.
 *
 * Any failure before step 3 removes the new container (and with it its
 * alias) and leaves the old one serving.
 *
 * `run.strategy: recreate` (services spec §3.2; forced by an exclusive volume
 * or a published port) never runs two containers at once: the app's
 * containers are stopped first (kept, not running), then the new one starts
 * and is health-checked; once it is live the old ones are removed. If the new
 * one fails it is removed and the containers that were running are started
 * again — the previous release serves as before, after a short outage — and
 * the error says so.
 *
 * With `sameRelease` (restart) the new container is the same release as the
 * live one, so it starts under a temporary name and takes the release's
 * name once the old container is gone; Caddy follows the live alias, which
 * a rename keeps.
 */
async function activate(ctx: Ctx, config: DeployAppConfig, record: ReleaseRecord, opts: { sameRelease?: boolean } = {}): Promise<void> {
  const releaseName = containerName(config.name, record.id);
  const name = opts.sameRelease ? `${releaseName}${NEXT_SUFFIX}` : releaseName;
  // A container of this release left from an earlier activation (rollback to it), or a restart cut off
  await ctx.docker.remove(name);
  const listOthers = async () => (await ctx.docker.listContainers([`${LABEL_APP}=${config.name}`])).filter((c) => !c.Names.includes(`/${name}`));
  const label = (c: { Names: string[]; Id: string }) => c.Names[0]?.slice(1) ?? c.Id.slice(0, 12);

  if (config.run.strategy === 'recreate') {
    const running = (await listOthers()).filter((c) => c.State === 'running' || c.State === 'restarting');
    const why = config.run.volumes.find((v) => v.exclusive)
      ? `volume ${config.run.volumes.find((v) => v.exclusive)!.name} is exclusive`
      : config.run.publish.scope !== 'none'
        ? `host port ${config.run.publish.port} is published`
        : 'run.strategy is recreate';
    for (const c of running) {
      ctx.log(`Stopping ${label(c)} before the new container starts (${why}); the app is unavailable until the new one is healthy`);
      await ctx.docker.stop(c.Id, RECREATE_STOP_S);
    }
    ctx.log(`Starting ${name}`);
    try {
      await ctx.docker.createContainer(name, appContainerSpec(ctx, config, record.id, record.image));
      await ctx.docker.start(name);
      await waitHealthy(ctx, config, name, record.port);
      await goLive(ctx, config, record, name);
    } catch (err) {
      ctx.log(`Removing ${name}`);
      await ctx.docker.remove(name).catch(() => {});
      const restored: string[] = [];
      const failed: string[] = [];
      for (const c of running) {
        try {
          await ctx.docker.start(c.Id);
          restored.push(label(c));
        } catch (startErr) {
          failed.push(`${label(c)}: ${(startErr as Error).message}`);
        }
      }
      if (running.length > 0) {
        const note =
          failed.length === 0
            ? `The previous container (${restored.join(', ')}) was started again and serves.`
            : `Starting the previous container again failed (${failed.join('; ')}); the app is down until a deploy, rollback or restart succeeds.`;
        ctx.log(note);
        (err as Error).message = `${(err as Error).message}\n${note}`;
      }
      throw err;
    }
    for (const c of await listOthers()) {
      ctx.log(`Removing ${label(c)}`);
      await ctx.docker.remove(c.Id).catch((err: Error) => ctx.log(`warning: ${err.message}`));
    }
  } else {
    ctx.log(`Starting ${name}`);
    await ctx.docker.createContainer(name, appContainerSpec(ctx, config, record.id, record.image));
    try {
      await ctx.docker.start(name);
      await waitHealthy(ctx, config, name, record.port);
      await goLive(ctx, config, record, name);
    } catch (err) {
      ctx.log(`Removing ${name}; the previous release keeps serving`);
      await ctx.docker.remove(name).catch(() => {});
      throw err;
    }

    const others = await listOthers();
    if (others.length > 0) {
      if (ctx.drainMs > 0) {
        ctx.log(`Both releases serve for ${Math.round(ctx.drainMs / 1000)}s, then the previous container stops`);
        await sleep(ctx.drainMs);
      }
      for (const c of others) {
        ctx.log(`Stopping ${label(c)}`);
        await ctx.docker.stop(c.Id).catch((err: Error) => ctx.log(`warning: ${err.message}`));
        await ctx.docker.remove(c.Id).catch((err: Error) => ctx.log(`warning: ${err.message}`));
      }
    }
  }
  if (opts.sameRelease) {
    // It serves already; a failed rename only leaves the temporary name, which liveContainer finds too
    await ctx.docker.rename(name, releaseName).catch((err: Error) => ctx.log(`warning: could not rename ${name}: ${err.message}`));
  }
}

/**
 * Remove releases (and their images) beyond keep_releases; never current or
 * previous (spec §5 step 8). Then the app's labelled images that no kept
 * release names — left by a release folder deleted by hand, or a deploy cut
 * off between build and record. The caller holds the app's deploy lock, so no
 * build of this app is in flight.
 */
export async function prune(ctx: Ctx, app: string, keep: number): Promise<string[]> {
  const current = currentRelease(ctx.layout, app);
  const previous = previousRelease(ctx.layout, app);
  const removed = pruneCandidates(releaseIds(ctx.layout, app), keep, current, previous);
  for (const id of removed) {
    const record = readRelease(ctx.layout, app, id);
    if (record?.image) {
      await ctx.docker.removeImage(record.image).catch((err: Error) => ctx.log(`warning: could not remove image ${record.image}: ${err.message}`));
    }
    fs.rmSync(ctx.layout.release(app, id), { recursive: true, force: true });
  }
  if (removed.length > 0) ctx.log(`Pruned ${removed.length} old release${removed.length === 1 ? '' : 's'}`);

  const kept = new Set([...releaseIds(ctx.layout, app), current, previous]);
  const repo = `bastion-${app}`;
  let orphans = 0;
  for (const image of await ctx.docker.listImages([`${LABEL_APP}=${app}`])) {
    const release = image.Labels?.[LABEL_RELEASE];
    if (release && kept.has(release)) continue;
    // By tag (only ours, never a kept release's); an untagged image by id
    const tags = (image.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
    const refs = tags.length > 0 ? tags.filter((t) => t.startsWith(`${repo}:`) && !kept.has(t.slice(repo.length + 1))) : [image.Id];
    for (const ref of refs) {
      await ctx.docker
        .removeImage(ref)
        .then(() => orphans++)
        .catch((err: Error) => ctx.log(`warning: could not remove image ${ref}: ${err.message}`));
    }
  }
  if (orphans > 0) ctx.log(`Removed ${orphans} image${orphans === 1 ? '' : 's'} of releases no longer kept`);
  return removed;
}

// ── Commands ──────────────────────────────────────────────────────────────────

export function version(): DeployVersion {
  return { version: BASTIONCTL_VERSION, node: process.version, images };
}

/**
 * Directories, network and proxy container (spec §2.5, §5 `setup`). Safe to
 * run again. `proxy` picks the mode (default: the one set up before, else
 * Caddy); changing it recreates the proxy container with the other ports.
 */
export async function setup(ctx: Ctx, opts: { proxy?: DeployProxyMode } = {}): Promise<DeploySetupResult> {
  // One setup at a time: a second waits, then finds everything in place
  fs.mkdirSync(ctx.layout.root, { recursive: true, mode: 0o755 });
  const release = await waitForLock(ctx.layout.setupLock, { holder: ctx.actor, docker: ctx.docker, now: ctx.now, what: 'setup of this server', waitMs: SETUP_LOCK_WAIT_MS, intervalMs: 500 });
  try {
    return await setupLocked(ctx, opts);
  } finally {
    release();
  }
}

async function setupLocked(ctx: Ctx, opts: { proxy?: DeployProxyMode }): Promise<DeploySetupResult> {
  const { layout, docker } = ctx;
  for (const dir of [layout.bin, layout.apps, layout.tmp, layout.proxy, path.join(layout.proxy, 'data'), path.join(layout.proxy, 'config')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  const mode = opts.proxy ?? readProxyMode(layout) ?? 'caddy';
  writeProxyMode(layout, mode);
  fs.chmodSync(layout.tmp, 0o700);
  cleanTmp(ctx);
  await docker.ping();
  if (await docker.ensureNetwork(NETWORK, { [LABEL_MANAGED]: 'network' })) ctx.log(`Created network ${NETWORK}`);
  // Internal: apps reach the outside over bastion-apps; this one only carries the proxy's traffic to them
  if (await docker.ensureNetwork(LIVE_NETWORK, { [LABEL_MANAGED]: 'network' }, { internal: true })) ctx.log(`Created network ${LIVE_NETWORK}`);
  await ensureProxyImage(ctx);
  // The Caddy the front starts (proxy-image.ts); a first setup links it, an upgrade below moves the link
  await ensureCaddyBinary(ctx);
  if (!linkedCaddy(ctx)) linkCaddy(ctx, CADDY_ID);
  await writeInitialCaddyfile(ctx);

  await withProxyLock(ctx, async () => {
    await recoverPreviousProxy(ctx);
    const info = await docker.inspectContainer(PROXY_CONTAINER);
    if (!info) {
      linkCaddy(ctx, CADDY_ID);
      // From this version's generator: a Caddyfile written before the front would have Caddy take the front's ports
      await writeInitialCaddyfile(ctx, true);
      ctx.log(`Creating ${PROXY_CONTAINER}${mode === 'nginx' ? ` behind the host's nginx (127.0.0.1:${NGINX_UPSTREAM_PORT})` : ''}`);
      await docker.createContainer(PROXY_CONTAINER, proxySpec(ctx, proxyEnv(ctx, parseEnv), mode));
      await joinLive(ctx, PROXY_CONTAINER);
      await startProxy(ctx, mode);
      writeProxyState(ctx);
      return;
    }
    await joinLive(ctx, PROXY_CONTAINER);
    if (!info.State.Running) await startProxy(ctx, mode);
    // An older bastionctl's proxy, or another mode: replaced the safe way (kept until the new one answers)
    const upgrade = await upgradeProxy(ctx, 'setup');
    if (upgrade) {
      if (ctx.report) ctx.report.proxyUpgrade = upgrade;
      if (upgrade.result === 'failed') {
        throw new BastionError(`The proxy could not be brought up to date; the previous one keeps serving: ${upgrade.error}`, 1, { proxyUpgrade: upgrade });
      }
    } else if (!readProxyState(ctx)) writeProxyState(ctx);
  });
  // Every app's current container answers to its live alias (containers from before bastion-live too)
  for (const app of appNames(layout)) {
    const id = currentRelease(layout, app);
    const record = id ? readRelease(layout, app, id) : null;
    if (!record?.port || !(await docker.inspectContainer(containerName(app, record.id)))) continue;
    if (await joinLive(ctx, containerName(app, record.id), liveAlias(app, record.port))) ctx.log(`Put ${app} on ${LIVE_NETWORK}`);
  }
  await pruneProxyImages(ctx);
  // Scheduled backups: bastion-cron when a service has a schedule (and in step with this bastionctl's Node.js image)
  await ensureCron(ctx);
  // Bring the live config up to date with the apps on disk
  if (appNames(layout).some((a) => currentRelease(layout, a))) await applyProxy(ctx);
  return { root: layout.root, proxy: mode, network: NETWORK, proxyContainer: await proxyContainer(ctx), version: BASTIONCTL_VERSION };
}

/** `validate <app> [--file f]`: the config file (default: the app's own), with domains checked across apps. */
export function validate(ctx: Ctx, app: string, file?: string): DeployValidation {
  appName(app);
  const source = file ? fileInRoot(ctx, file) : ctx.layout.config(app);
  let text: string;
  try {
    if (fs.statSync(source).size > MAX_CONFIG_BYTES) return { ok: false, errors: [{ path: '', message: 'Config is larger than 64 KiB' }] };
    text = fs.readFileSync(source, 'utf8');
  } catch {
    return { ok: false, errors: [{ path: '', message: `No config at ${path.relative(ctx.layout.root, source)}` }] };
  }
  const { ok, errors } = validateForServer(ctx.layout, app, text);
  return { ok, errors };
}

/**
 * `init <app> [--config f] [--force]`: create the app folder with a config —
 * the template, or a given file (validated first) — and an empty `.env`.
 * Replacing an existing config needs `force`; the proxy then picks up domain
 * changes, and if it refuses them the old config is put back.
 */
export async function init(ctx: Ctx, app: string, opts: { config?: string; force?: boolean } = {}): Promise<{ app: string; created: boolean }> {
  appName(app);
  const configFile = ctx.layout.config(app);
  const existed = fs.existsSync(configFile);
  if (existed && !opts.force) throw new BastionError(`${app} already has a bastion.yml (use --force to replace it)`);
  const text = opts.config ? fs.readFileSync(fileInRoot(ctx, opts.config), 'utf8') : templateConfig(app, proxyMode(ctx.layout));
  // Under the proxy lock: two configs written at once must not both pass the
  // check for domains another app uses, and the switch must see this one
  await withProxyLock(ctx, async () => {
    const result = validateForServer(ctx.layout, app, text);
    if (!result.ok) throw new BastionError(`Invalid config: ${formatIssues(result.errors)}`, 3);

    fs.mkdirSync(ctx.layout.releases(app), { recursive: true, mode: 0o755 });
    const envFile = envFilePath(ctx.layout, app, result.config!);
    if (!fs.existsSync(envFile)) writeEnvFile(envFile, '');
    const previous = existed ? fs.readFileSync(configFile, 'utf8') : null;
    const tmp = `${configFile}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    fs.renameSync(tmp, configFile);

    if (existed && currentRelease(ctx.layout, app) && (await proxyContainer(ctx))?.state === 'running') {
      try {
        await switchProxy(ctx, new Map());
      } catch (err) {
        if (previous !== null) fs.writeFileSync(configFile, previous, { mode: 0o644 });
        throw err;
      }
    }
  });
  ctx.log(existed ? `Updated the config of ${app}` : `Created app ${app}`);
  // A schedule written in the config editor (backups.schedule) needs bastion-cron as much as one set from the Backups tab
  await ensureCron(ctx).catch((err: Error) => ctx.log(`warning: scheduled backups: ${err.message}`));
  return { app, created: !existed };
}

function summary(ctx: Ctx, app: string, container: DeployContainer | null): DeployAppSummary {
  const { config, error } = tryLoadConfig(ctx.layout, app);
  return {
    name: app,
    domains: config?.domains ?? [],
    buildType: config?.build.type ?? null,
    service: config?.service ?? null,
    currentRelease: currentRelease(ctx.layout, app),
    container,
    configError: error,
    locked: readLock(ctx.layout.lock(app)) !== null,
    permissions: config?.permissions ?? null,
  };
}

/** The live container's CPU and memory (one Docker stats read), or null. */
async function usage(ctx: Ctx, app: string, container: DeployContainer | null): Promise<DeployAppUsage | null> {
  if (container?.state !== 'running') return null;
  try {
    const stats = await ctx.docker.stats(container.name);
    const used = stats ? usageFrom(stats) : null;
    if (!used) return null;
    const { config } = tryLoadConfig(ctx.layout, app);
    const limit = stats?.memory_stats?.limit;
    return { ...used, memoryLimitBytes: config?.run.memory && typeof limit === 'number' && limit > 0 ? limit : null };
  } catch {
    return null;
  }
}

/** Summaries with what the app list shows besides: certificate and usage, read together. */
async function enrich(ctx: Ctx, apps: string[]): Promise<DeployAppSummary[]> {
  const containers = await Promise.all(apps.map((app) => currentContainer(ctx, app)));
  const deployed = apps.flatMap((app) => {
    const { config } = tryLoadConfig(ctx.layout, app);
    return config && currentRelease(ctx.layout, app) ? [{ app, config }] : [];
  });
  const [certificates, usages] = await Promise.all([
    appCertificates(ctx, deployed).catch(() => new Map<string, DeployAppCertificate | null>()),
    Promise.all(apps.map((app, i) => usage(ctx, app, containers[i] ?? null))),
  ]);
  return apps.map((app, i) => ({ ...summary(ctx, app, containers[i] ?? null), certificate: certificates.get(app) ?? null, usage: usages[i] ?? null }));
}

async function currentContainer(ctx: Ctx, app: string): Promise<DeployContainer | null> {
  const current = currentRelease(ctx.layout, app);
  if (!current) return null;
  const name = containerName(app, current);
  return containerView(await ctx.docker.inspectContainer(name), name);
}

export async function list(ctx: Ctx): Promise<DeployAppSummary[]> {
  return enrich(ctx, appNames(ctx.layout));
}

export async function status(ctx: Ctx, app: string): Promise<DeployAppStatus> {
  requireApp(ctx, app);
  // No certificate or usage reads here: the app's page has its Domains tab and the Docker module's live stats
  const base = summary(ctx, app, await currentContainer(ctx, app));
  return {
    ...base,
    config: tryLoadConfig(ctx.layout, app).config,
    previousRelease: previousRelease(ctx.layout, app),
    lock: lockView(readLock(ctx.layout.lock(app))),
  };
}

export async function releases(ctx: Ctx, app: string): Promise<DeployRelease[]> {
  requireApp(ctx, app);
  const current = currentRelease(ctx.layout, app);
  const ids = releaseIds(ctx.layout, app).reverse();
  const out: DeployRelease[] = [];
  // A record kept by a bastionctl from before masking, or edited by hand, is masked as it is read
  const { config } = tryLoadConfig(ctx.layout, app);
  const mask = envFileMasker(config ? envFilePath(ctx.layout, app, config) : ctx.layout.env(app));
  const currentRecord = current ? readRelease(ctx.layout, app, current) : null;
  for (const id of ids) {
    const record = readRelease(ctx.layout, app, id);
    if (!record) continue;
    // A quick service: whether a rollback to it keeps its line (what Roll back offers, and why not)
    const lines =
      config?.service && record.result === 'success' && id !== current
        ? (() => {
            const check = rollbackLineCheck(ctx.layout, config, currentRecord, record);
            return { rollbackRefused: check.ok ? null : check.reason };
          })()
        : {};
    out.push({
      ...record,
      error: record.error === null ? null : mask(record.error),
      current: id === current,
      imagePresent: record.image ? await ctx.docker.imageExists(record.image) : false,
      ...lines,
    });
  }
  return out;
}

/**
 * Pull `build.type: image`'s image (services spec §3.2) and tag it as the
 * release's image; returns the digest it resolved to. A digest-pinned image
 * already on the server is not pulled again; a tag is pulled every time, so
 * a redeploy picks up what the tag points at now.
 */
async function pullImage(ctx: Ctx, app: string, ref: string, id: string): Promise<string | null> {
  const local = pinnedRef(ref);
  if (isDigestPinned(ref) && (await ctx.docker.imageExists(local))) {
    ctx.log(`${ref} is on the server already`);
  } else {
    ctx.log(`Pulling ${ref}`);
    await ctx.docker.pull(ref, (line) => ctx.log(line));
  }
  const info = await ctx.docker.inspectImage(local);
  if (!info) throw new BastionError(`${ref} is not on the server after pulling it`);
  const repo = ref.replace(/@.*$/, '').replace(/:[^/:]*$/, '');
  const short = (r: string) => r.replace(/^docker\.io\//, '').replace(/^library\//, '');
  const digests = (info.RepoDigests ?? []).filter((d) => /@sha256:[a-f0-9]{64}$/.test(d));
  const match = digests.find((d) => short(d.slice(0, d.indexOf('@'))) === short(repo)) ?? digests[0];
  const digest = isDigestPinned(ref) ? ref.slice(ref.indexOf('@') + 1) : (match?.slice(match.indexOf('@') + 1) ?? null);
  await ctx.docker.tagImage(local, `bastion-${app}`, id);
  ctx.log(`Image ${ref}${digest && !isDigestPinned(ref) ? ` (${digest})` : ''} tagged as bastion-${app}:${id}`);
  return digest;
}

/** What `deploy` takes besides the app (cli: `--source`, `--include-env-files`, `--prebuilt`, `--checksum`, `--build-ms`). */
export interface DeployOptions {
  /** An upload under the root: built here. */
  source?: string;
  /** Keep `.env` and `.env.*` files of the upload (left out by default). */
  includeEnvFiles?: boolean;
  /**
   * `bastion-<app>:<release>`: an image BastionSSH built on its side and
   * loaded into this server's Docker; served as release `<release>` with no
   * build here.
   */
  prebuilt?: string;
  /** With `prebuilt`: SHA-256 of the upload it was built from (release.json's checksum). */
  checksum?: string;
  /** With `prebuilt`: how long the build took on the BastionSSH side. */
  buildMs?: number;
}

/** `.env` values a build gets as build args: every `NEXT_PUBLIC_*` and the names `build.args` lists; nothing else. */
export function buildArgs(ctx: Ctx, app: string, config: DeployAppConfig): Record<string, string> {
  return pickDeployBuildArgs(parseEnv(readEnvFile(envFilePath(ctx.layout, app, config))), config.build.args ?? []);
}

/**
 * `env build-args <app>`: the values {@link buildArgs} picks, for a build on
 * the BastionSSH side (`build.where: bastion`), which reads them for the
 * build only and keeps nothing. No other `.env` value is ever printed here.
 */
export function envBuildArgs(ctx: Ctx, app: string): { args: Record<string, string> } {
  requireApp(ctx, app);
  const config = loadConfig(ctx.layout, app);
  if (config.build.type === 'image') throw new BastionError(`build.type of ${app} is image: nothing is built`, 2);
  return { args: buildArgs(ctx, app, config) };
}

/** `bastion-<app>:<release>` → the release id, refused for any other app or form. */
function prebuiltRelease(app: string, tag: string): string {
  const m = /^bastion-([a-z0-9][a-z0-9-]{0,40}):([a-z0-9][a-z0-9-]{0,40})$/.exec(tag);
  if (!m || m[1] !== app) throw new BastionError(`--prebuilt takes bastion-${app}:<release>, not ${JSON.stringify(tag.slice(0, 100))}`, 2);
  return releaseId(m[2]);
}

/** The build log's line naming the environment files an upload was deployed without. */
export function envFilesNote(skipped: readonly string[], count: number): string {
  const more = count > skipped.length ? ` and ${count - skipped.length} more` : '';
  return (
    `Left out ${count === 1 ? 'an environment file' : `${count} environment files`} of the upload: ${skipped.join(', ')}${more}. ` +
    "Runtime values belong in the app's .env on the server (NEXT_PUBLIC_* and build.args reach the build from there); " +
    'to deploy these files anyway, choose "Include environment files" (bastionctl deploy --include-env-files).'
  );
}

/**
 * `deploy <app> --source <file>` (spec §5): lock, new release from the
 * upload, build, start, health check, proxy switch, `current`, prune. A
 * failure after the release folder exists is recorded in its release.json
 * and returned as a failed outcome; the previous release keeps serving.
 *
 * `build.type: image` takes no upload (`deploy <app>`): the image is pulled
 * instead of built, and the release records the digest it resolved to.
 *
 * `--prebuilt bastion-<app>:<release>` (bastion-side builds): the image was
 * built next to BastionSSH and loaded into this server's Docker already;
 * it must be here, labelled for this app and release, and the release flow
 * goes on from there (release.json: `builtOn: bastion`, platform, image id,
 * build time). Refused when the image is missing.
 *
 * Environment files (`.env`, `.env.*` but `.env.example`) of an upload are
 * left out unless `includeEnvFiles`; the log names them. A build gets the
 * app's `NEXT_PUBLIC_*` and `build.args` values from `.env` as build args.
 *
 * An outdated proxy is upgraded first (proxy-upgrade.ts).
 */
export async function deploy(baseCtx: Ctx, app: string, options: DeployOptions | string = {}): Promise<DeployOutcome> {
  // A plain string is the upload (`deploy <app> --source <file>`)
  const opts: DeployOptions = typeof options === 'string' ? { source: options } : options;
  const { source, prebuilt } = opts;
  const config = loadConfig(baseCtx.layout, app);
  const conflicts = validateForServer(baseCtx.layout, app, fs.readFileSync(baseCtx.layout.config(app), 'utf8'));
  if (!conflicts.ok) throw new BastionError(`Invalid config: ${formatIssues(conflicts.errors)}`, 3);
  const imageRef = config.build.type === 'image' ? config.build.image! : null;
  if (imageRef && (source !== undefined || prebuilt !== undefined)) {
    throw new BastionError(`build.type of ${app} is image: ${imageRef} is pulled from its registry, so deploy takes no --source or --prebuilt`, 2);
  }
  if (source !== undefined && prebuilt !== undefined) throw new BastionError('deploy takes --source or --prebuilt, not both', 2);
  if (!imageRef && source === undefined && prebuilt === undefined) throw new BastionError('Usage: bastionctl deploy <app> --source <file> | --prebuilt <image>', 2);
  if (prebuilt === undefined && (opts.checksum !== undefined || opts.buildMs !== undefined)) throw new BastionError('--checksum and --build-ms go with --prebuilt', 2);
  if (opts.checksum !== undefined && !/^[a-f0-9]{64}$/.test(opts.checksum)) throw new BastionError('--checksum is a SHA-256 in hex', 2);
  const sourceFile = source === undefined ? null : fileInRoot(baseCtx, source);
  // The image BastionSSH loaded: it must be here and made for this app and release
  let prebuiltImage: { id: string; tag: string; platform: string | null } | null = null;
  if (prebuilt !== undefined) {
    const id = prebuiltRelease(app, prebuilt);
    const info = await baseCtx.docker.inspectImage(prebuilt);
    if (!info) throw new BastionError(`Image ${prebuilt} is not on this server (it is loaded by BastionSSH before this deploy). Nothing was changed.`);
    const labels = info.Config?.Labels ?? {};
    if (labels[LABEL_APP] !== app || labels[LABEL_RELEASE] !== id) {
      throw new BastionError(`Image ${prebuilt} was not built for ${app} release ${id} (its labels say otherwise). Nothing was changed.`);
    }
    const platform = info.Architecture ? `${info.Os || 'linux'}/${info.Architecture}${info.Variant ? `/${info.Variant}` : ''}` : null;
    prebuiltImage = { id: info.Id, tag: prebuilt, platform };
  }
  // A line that will not start on this kernel is refused before hundreds of megabytes are pulled
  await checkKernel(baseCtx, config, imageRef, 'Nothing was pulled or changed.');
  await ensureProxyCurrent(baseCtx, 'deploy');
  const proxy = await proxyContainer(baseCtx);
  if (proxy?.state !== 'running') throw new BastionError('The proxy is not running on this server (run bastionctl setup)');

  const releaseLock = await acquireLock(baseCtx.layout.lock(app), { holder: baseCtx.actor, docker: baseCtx.docker, now: baseCtx.now, what: `deploy of ${app}` });
  try {
    cleanTmp(baseCtx);
    const checksum = sourceFile
      ? await sha256File(sourceFile)
      : prebuiltImage
        ? (opts.checksum ?? prebuiltImage.id.replace(/^sha256:/, ''))
        : createHash('sha256').update(imageRef!).digest('hex');
    const id = prebuiltImage ? prebuiltRelease(app, prebuiltImage.tag) : newReleaseId(baseCtx.now(), checksum);
    const dir = baseCtx.layout.release(app, id);
    fs.mkdirSync(baseCtx.layout.releases(app), { recursive: true });
    try {
      fs.mkdirSync(dir);
    } catch {
      throw new BastionError(`Release ${id} already exists (the same ${sourceFile ? 'source' : 'image'} deployed within the same second)`);
    }
    const logFd = fs.openSync(path.join(dir, 'build.log'), 'a', 0o644);
    // The app's .env values never reach the deploy log, build.log or release.json
    const mask = envFileMasker(envFilePath(baseCtx.layout, app, config));
    const ctx: Ctx = {
      ...baseCtx,
      log: (line) => {
        const masked = mask(line);
        baseCtx.log(masked);
        fs.writeSync(logFd, masked + '\n');
      },
    };
    const previous = currentRelease(ctx.layout, app);
    let record: ReleaseRecord = {
      id,
      app,
      createdAt: ctx.now().toISOString(),
      finishedAt: null,
      actor: ctx.actor,
      checksum,
      image: imageName(app, id),
      container: containerName(app, id),
      port: config.run.port,
      buildType: config.build.type,
      result: 'building',
      error: null,
      previous,
      builtOn: imageRef ? null : prebuiltImage ? 'bastion' : 'server',
      // A quick service's release says which template line it runs: a rollback keeps Update version's rules (lines.ts)
      ...(imageRef && { digest: null, ref: imageRef, ...deployedLine(config, imageRef) }),
      ...(prebuiltImage && { digest: prebuiltImage.id, platform: prebuiltImage.platform, buildMs: opts.buildMs ?? null }),
    };
    writeRelease(ctx.layout, record);
    ctx.log(`Release ${id} of ${app} by ${ctx.actor}`);

    // A loaded image is the release's own from the start: a failure removes it like one built here
    let built = prebuiltImage !== null;
    try {
      if (imageRef) {
        record = { ...record, digest: await pullImage(ctx, app, imageRef, id) };
        built = true;
        writeRelease(ctx.layout, record);
      } else if (prebuiltImage) {
        const took = opts.buildMs !== undefined ? ` in ${Math.round(opts.buildMs / 1000)} s` : '';
        ctx.log(`Built on BastionSSH${took}: ${prebuiltImage.tag} (${prebuiltImage.platform ?? 'unknown platform'}, ${prebuiltImage.id.slice(0, 19)})`);
      } else {
        const gz = Buffer.alloc(2);
        const fd = fs.openSync(sourceFile!, 'r');
        fs.readSync(fd, gz, 0, 2, 0);
        fs.closeSync(fd);
        const kept = path.join(dir, gz[0] === 0x1f && gz[1] === 0x8b ? 'source.tar.gz' : 'source.tar');
        if (isInside(fs.realpathSync(ctx.layout.tmp), sourceFile!)) fs.renameSync(sourceFile!, kept);
        else fs.copyFileSync(sourceFile!, kept);

        const work = path.join(ctx.layout.tmp, `build-${app}-${id}`);
        try {
          ctx.log('Unpacking the upload');
          const extracted = await extractTar(kept, work, { maxBytes: ctx.maxSourceBytes, ...(!opts.includeEnvFiles && { skip: isDeployEnvFile }) });
          ctx.log(`Unpacked ${extracted.files} entries (${Math.round(extracted.bytes / 1024)} KiB)`);
          if (extracted.skippedCount > 0) ctx.log(envFilesNote(extracted.skipped, extracted.skippedCount));
          else if (opts.includeEnvFiles) ctx.log('Environment files in the upload were kept, as asked (they are part of this release and can end up in the image)');
          const args = buildArgs(ctx, app, config);
          const argNames = Object.keys(args);
          const plan = planBuild(work, config, argNames);
          for (const note of plan.notes) ctx.log(note);
          if (argNames.length > 0) ctx.log(`Build args from .env: ${argNames.join(', ')}`);
          // One build per server at a time: a second deploy waits its turn rather than failing
          const buildOpts = { holder: `${ctx.actor} (${app})`, docker: ctx.docker, now: ctx.now, what: 'image build on this server' };
          const buildLock = await acquireLock(ctx.layout.buildLock, buildOpts).catch(async (err: unknown) => {
            if (!(err instanceof BastionError) || err.exitCode !== 4) throw err;
            ctx.log(`Waiting for another image build to finish (${err.message})`);
            return waitForLock(ctx.layout.buildLock, { ...buildOpts, waitMs: BUILD_LOCK_WAIT_MS, intervalMs: 1000 });
          });
          try {
            await ctx.docker.build(
              packDirectory(plan.context, plan.generated ? [{ name: GENERATED_DOCKERFILE, content: plan.generated }] : [], plan.exclude),
              {
                t: record.image,
                dockerfile: plan.dockerfile,
                labels: JSON.stringify({ [LABEL_APP]: app, [LABEL_RELEASE]: id, [LABEL_MANAGED]: 'app' }),
                ...(argNames.length > 0 && { buildargs: JSON.stringify(args) }),
                rm: true,
                forcerm: true,
              },
              (line) => ctx.log(line),
            );
            built = true;
          } finally {
            buildLock();
          }
        } finally {
          fs.rmSync(work, { recursive: true, force: true });
        }
      }
      await activate(ctx, config, record);
      writeRelease(ctx.layout, { ...record, result: 'success', finishedAt: ctx.now().toISOString() });
      ctx.log(`Deployed ${app} release ${id}`);
      await prune(ctx, app, config.keep_releases);
      return { app, release: id, previous, result: 'success', error: null };
    } catch (err) {
      const message = mask((err as Error).message);
      ctx.log(`Deploy failed: ${message}`);
      writeRelease(ctx.layout, { ...record, result: 'failed', error: message, finishedAt: ctx.now().toISOString() });
      if (built) await ctx.docker.removeImage(record.image).catch(() => {});
      if (!(err instanceof BastionError) && !(err instanceof DockerApiError)) {
        (err as Error).message = message;
        throw err;
      }
      return { app, release: id, previous, result: 'failed', error: message };
    } finally {
      fs.closeSync(logFd);
    }
  } finally {
    releaseLock();
  }
}

/**
 * `rollback <app> <id> [--force-line]`: serve a kept release's image again —
 * no rebuild. A quick service's release on another version line is refused
 * as Update version would refuse the move (another major of a database, an
 * older line of a forward-only template), and so is one whose line cannot be
 * told; `forceLine` serves it anyway, with a warning in the log.
 */
export async function rollback(baseCtx: Ctx, app: string, id: string, opts: { forceLine?: boolean } = {}): Promise<DeployOutcome> {
  releaseId(id);
  const config = loadConfig(baseCtx.layout, app);
  const mask = envFileMasker(envFilePath(baseCtx.layout, app, config));
  const ctx: Ctx = { ...baseCtx, log: (line) => baseCtx.log(mask(line)) };
  await ensureProxyCurrent(ctx, 'rollback');
  const releaseLock = await acquireLock(ctx.layout.lock(app), { holder: ctx.actor, docker: ctx.docker, now: ctx.now, what: `deploy of ${app}` });
  try {
    const current = currentRelease(ctx.layout, app);
    if (id === current) throw new BastionError(`${id} is already the current release of ${app}`);
    const record = readRelease(ctx.layout, app, id);
    if (!record) throw new BastionError(`${app} has no release ${id}`);
    if (record.result !== 'success') throw new BastionError(`Release ${id} did not deploy successfully; it cannot be rolled back to`);
    const line = rollbackLineCheck(ctx.layout, config, current ? readRelease(ctx.layout, app, current) : null, record);
    if (!line.ok) {
      if (!opts.forceLine) throw new BastionError(`${line.reason} Nothing was changed (--force-line rolls back anyway).`, 1, { refused: 'line_change' });
      ctx.log(`warning: ${line.reason} Rolling back anyway (--force-line, by ${ctx.actor}).`);
    }
    await checkKernel(ctx, config, releaseRef(ctx.layout, record), `Release ${id} was not rolled back to.`);
    if (!(await ctx.docker.imageExists(record.image))) throw new BastionError(`The image of release ${id} is gone (pruned); deploy it again instead`);
    ctx.log(`Rolling ${app} back to ${id} (by ${ctx.actor})`);
    try {
      await activate(ctx, config, record);
    } catch (err) {
      const message = mask((err as Error).message);
      if (!(err instanceof BastionError) && !(err instanceof DockerApiError)) {
        (err as Error).message = message;
        throw err;
      }
      return { app, release: id, previous: current, result: 'failed', error: message };
    }
    ctx.log(`${app} now serves release ${id}`);
    return { app, release: id, previous: current, result: 'success', error: null };
  } finally {
    releaseLock();
  }
}

export async function liveContainer(ctx: Ctx, app: string): Promise<string> {
  requireApp(ctx, app);
  const current = currentRelease(ctx.layout, app);
  if (!current) throw new BastionError(`${app} has no current release`);
  const name = containerName(app, current);
  if (await ctx.docker.inspectContainer(name)) return name;
  // A restart whose final rename failed
  if (await ctx.docker.inspectContainer(`${name}${NEXT_SUFFIX}`)) return `${name}${NEXT_SUFFIX}`;
  throw new BastionError(`The container of ${app}'s current release is gone; deploy or roll back to recreate it`);
}

/**
 * `restart <app>`: a fresh container of the current release, so it starts
 * with the `.env`, volumes, limits and domains as they are now — a change to
 * any of them applies without a new build. Same zero-downtime switch as a
 * deploy: the old container serves until the new one is healthy.
 */
export async function restart(baseCtx: Ctx, app: string): Promise<DeployRestartResult> {
  requireApp(baseCtx, app);
  const config = loadConfig(baseCtx.layout, app);
  const mask = envFileMasker(envFilePath(baseCtx.layout, app, config));
  const ctx: Ctx = { ...baseCtx, log: (line) => baseCtx.log(mask(line)) };
  await ensureProxyCurrent(ctx, 'restart');
  const releaseLock = await acquireLock(ctx.layout.lock(app), { holder: ctx.actor, docker: ctx.docker, now: ctx.now, what: `deploy of ${app}` });
  try {
    const current = currentRelease(ctx.layout, app);
    if (!current) throw new BastionError(`${app} has no current release`);
    const record = readRelease(ctx.layout, app, current);
    if (!record) throw new BastionError(`${app} has no record of release ${current}; deploy it again`);
    if (!(await ctx.docker.imageExists(record.image))) throw new BastionError(`The image of release ${current} is gone; deploy it again instead`);
    ctx.log(`Restarting ${app} (release ${current}) with its current settings, by ${ctx.actor}`);
    try {
      await activate(ctx, config, record, { sameRelease: true });
    } catch (err) {
      (err as Error).message = mask((err as Error).message);
      throw err;
    }
    ctx.log(`${app} restarted`);
    return { app, container: await liveContainer(ctx, app) };
  } finally {
    releaseLock();
  }
}

export async function stop(ctx: Ctx, app: string): Promise<{ app: string; container: string }> {
  const name = await liveContainer(ctx, app);
  ctx.log(`Stopping ${name}`);
  await ctx.docker.stop(name);
  return { app, container: name };
}

/**
 * `delete <app> [--purge]`: out of the proxy, containers and images removed,
 * releases deleted. Without `purge` the config, `.env` and named volumes stay
 * (the app can be deployed again); with it they go too.
 */
export async function remove(ctx: Ctx, app: string, opts: { purge?: boolean } = {}): Promise<{ app: string; purged: boolean }> {
  requireApp(ctx, app);
  const releaseLock = await acquireLock(ctx.layout.lock(app), { holder: ctx.actor, docker: ctx.docker, now: ctx.now, what: `deploy of ${app}` });
  try {
    // Out of the proxy, and `current` gone before another app's switch could put it back
    if ((await proxyContainer(ctx))?.state === 'running') await applyProxy(ctx, new Map([[app, null]]), () => clearCurrent(ctx.layout, app));
    else ctx.log('warning: the proxy is not running; its config is updated when it is set up again');
    for (const c of await ctx.docker.listContainers([`${LABEL_APP}=${app}`])) {
      ctx.log(`Removing container ${c.Names[0]?.slice(1) ?? c.Id.slice(0, 12)}`);
      await ctx.docker.remove(c.Id);
    }
    for (const image of await ctx.docker.listImages([`${LABEL_APP}=${app}`])) {
      await ctx.docker.removeImage(image.Id).catch((err: Error) => ctx.log(`warning: could not remove image: ${err.message}`));
    }
    // Pulled images (build.type: image) carry no labels: their release tags go by name (the pulled image itself stays)
    for (const id of releaseIds(ctx.layout, app)) {
      const record = readRelease(ctx.layout, app, id);
      if (record?.buildType === 'image' && record.image === imageName(app, id)) {
        await ctx.docker.removeImage(record.image).catch((err: Error) => ctx.log(`warning: could not remove image ${record.image}: ${err.message}`));
      }
    }
    const { config } = tryLoadConfig(ctx.layout, app);
    clearCurrent(ctx.layout, app);
    fs.rmSync(ctx.layout.releases(app), { recursive: true, force: true });
    if (opts.purge) {
      for (const v of config?.run.volumes ?? []) await ctx.docker.removeVolume(volumeName(app, v.name)).catch((err: Error) => ctx.log(`warning: ${err.message}`));
      fs.rmSync(ctx.layout.app(app), { recursive: true, force: true });
      // Its schedule went with its config: bastion-cron goes when it was the last one
      await ensureCron(ctx).catch((err: Error) => ctx.log(`warning: ${err.message}`));
    }
    ctx.log(opts.purge ? `Deleted ${app} and its data` : `Deleted ${app}'s releases; its config, .env and volumes are kept`);
    return { app, purged: !!opts.purge };
  } finally {
    releaseLock();
  }
}

export async function proxyApply(ctx: Ctx): Promise<{ ok: true }> {
  await ensureProxyCurrent(ctx, 'proxy_apply');
  await applyProxy(ctx);
  return { ok: true };
}

/** `proxy status`: the proxy against what this bastionctl runs. Read-only: never upgrades. */
export async function proxyStatusCommand(ctx: Ctx): Promise<DeployProxyStatus> {
  // The host's kernel too: BastionSSH reads this with the server's state, and marks lines that will not start on it
  return { ...(await proxyStatus(ctx)), kernelVersion: await hostKernel(ctx) };
}

/** `proxy upgrade`: replace an outdated proxy now (pinned or not). */
export function proxyUpgrade(ctx: Ctx) {
  return upgradeProxyNow(ctx);
}

// ── .env ──────────────────────────────────────────────────────────────────────

function envFile(ctx: Ctx, app: string): string {
  requireApp(ctx, app);
  const { config } = tryLoadConfig(ctx.layout, app);
  return config ? envFilePath(ctx.layout, app, config) : ctx.layout.env(app);
}

export function envKeys(ctx: Ctx, app: string): { keys: string[] } {
  return { keys: [...parseEnv(readEnvFile(envFile(ctx, app))).keys()] };
}

export function envSet(ctx: Ctx, app: string, key: string, value: string): { key: string; changed: boolean } {
  envKey(key);
  const file = envFile(ctx, app);
  const text = readEnvFile(file);
  const changed = parseEnv(text).get(key) !== value;
  writeEnvFile(file, setEnv(text, key, value));
  return { key, changed };
}

export function envUnset(ctx: Ctx, app: string, key: string): { key: string; changed: boolean } {
  envKey(key);
  const file = envFile(ctx, app);
  const next = unsetEnv(readEnvFile(file), key);
  if (next !== null) writeEnvFile(file, next);
  return { key, changed: next !== null };
}

/** Bytes of randomness `env generate` takes by default, and the range it accepts. */
export const GENERATE_BYTES = { default: 32, min: 16, max: 512 } as const;

/**
 * `env generate <app> KEY [--bytes N] [--if-missing]`: a crypto-random
 * URL-safe value (base64url of N random bytes) written to `.env` — a
 * database password, a secret key. It is never printed or returned: reveal
 * it with `env get` (BastionSSH's step-up). `ifMissing` leaves a variable
 * that is set already as it is.
 */
export function envGenerate(ctx: Ctx, app: string, key: string, opts: { bytes?: number; ifMissing?: boolean } = {}): DeployEnvGenerated {
  envKey(key);
  const bytes = opts.bytes ?? GENERATE_BYTES.default;
  if (!Number.isInteger(bytes) || bytes < GENERATE_BYTES.min || bytes > GENERATE_BYTES.max) {
    throw new BastionError(`--bytes takes a whole number from ${GENERATE_BYTES.min} to ${GENERATE_BYTES.max}`, 2);
  }
  const file = envFile(ctx, app);
  const text = readEnvFile(file);
  if (opts.ifMissing && parseEnv(text).has(key)) return { key, generated: false };
  const value = randomBytes(bytes).toString('base64url');
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new BastionError('Value too large');
  writeEnvFile(file, setEnv(text, key, value));
  ctx.log(`Generated a new value for ${key} (${bytes} random bytes)`);
  return { key, generated: true };
}

/** The one command that prints a value (BastionSSH's step-up reveal). */
export function envGet(ctx: Ctx, app: string, key: string): { key: string; value: string } {
  envKey(key);
  const value = parseEnv(readEnvFile(envFile(ctx, app))).get(key);
  if (value === undefined) throw new BastionError(`${key} is not set for ${app}`);
  return { key, value };
}

// ── exec ──────────────────────────────────────────────────────────────────────

/** Most arguments, and bytes across them, `exec` passes on. */
export const EXEC_LIMITS = { args: 256, bytes: 128 * 1024 } as const;

/**
 * `exec <app> -- <argv…>`: run a program in the app's live container (no
 * shell unless the argv names one), its output streamed as it comes. The
 * argv is passed to Docker as is; it must not be empty, and no argument may
 * hold a NUL byte. Resolves with the program's exit code.
 */
export async function execInApp(
  ctx: Ctx,
  app: string,
  argv: string[],
  out: { stdout: (chunk: Buffer) => void; stderr: (chunk: Buffer) => void },
  timeoutMs?: number,
): Promise<{ app: string; container: string; exitCode: number }> {
  if (argv.length === 0 || argv[0] === '') throw new BastionError('Usage: bastionctl exec <app> -- <program> [args…]', 2);
  if (argv.length > EXEC_LIMITS.args) throw new BastionError(`At most ${EXEC_LIMITS.args} arguments`, 2);
  if (argv.some((a) => a.includes('\0'))) throw new BastionError('Arguments cannot contain NUL bytes', 2);
  if (argv.reduce((n, a) => n + Buffer.byteLength(a), 0) > EXEC_LIMITS.bytes) throw new BastionError(`The arguments are larger than ${EXEC_LIMITS.bytes / 1024} KiB`, 2);
  const name = await liveContainer(ctx, app);
  const info = await ctx.docker.inspectContainer(name);
  if (!info?.State.Running) throw new BastionError(`${name} is not running (start it with restart)`);
  const exitCode = await ctx.docker.execStream(name, argv, { onStdout: out.stdout, onStderr: out.stderr }, timeoutMs);
  return { app, container: name, exitCode };
}
