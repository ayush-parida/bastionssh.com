import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DeployAppConfig,
  DeployAppStatus,
  DeployAppSummary,
  DeployContainer,
  DeployOutcome,
  DeployRelease,
  DeploySetupResult,
  DeployValidation,
  DeployVersion,
} from '@smt/shared';
import images from './images.json' with { type: 'json' };
import { planBuild, GENERATED_DOCKERFILE } from './build.js';
import { appNames, durationMs, envFilePath, formatIssues, loadConfig, memoryBytes, MAX_CONFIG_BYTES, templateConfig, tryLoadConfig, validateForServer } from './config.js';
import { sleep, type Ctx } from './context.js';
import { DockerApiError } from './docker.js';
import { containerEnv, parseEnv, readEnvFile, setEnv, unsetEnv, writeEnvFile } from './env.js';
import { acquireLock, lockView, readLock, waitForLock } from './lock.js';
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
import {
  applyProxy,
  CADDY_IMAGE,
  joinLive,
  proxyContainer,
  proxyEnv,
  proxySpec,
  requireProxy,
  siteFor,
  switchProxy,
  withProxyLock,
  writeInitialCaddyfile,
} from './proxy.js';
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

/** The container spec of a release (spec §5 step 4). */
export function appContainerSpec(ctx: Ctx, config: DeployAppConfig, release: string, image: string): Record<string, unknown> {
  const mounts = config.run.volumes.map((v) => {
    const [name, target, ro] = v.split(':') as [string, string, string | undefined];
    return { Type: 'volume', Source: volumeName(config.name, name), Target: target, ReadOnly: ro === 'ro' };
  });
  return {
    Image: image,
    Env: containerEnv(envFilePath(ctx.layout, config.name, config)),
    Labels: { [LABEL_APP]: config.name, [LABEL_RELEASE]: release, [LABEL_MANAGED]: 'app' },
    HostConfig: {
      NetworkMode: NETWORK,
      RestartPolicy: { Name: 'unless-stopped' },
      Mounts: mounts,
      ...(config.run.memory && { Memory: memoryBytes(config.run.memory) }),
      ...(config.run.cpus && { NanoCpus: Math.round(config.run.cpus * 1e9) }),
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  };
}

/**
 * Wait until the app answers over HTTP from inside the network (spec §5 step
 * 5): `wget` in the proxy container, until it succeeds or the configured
 * timeout passes. A container that stops meanwhile fails at once, with its
 * last log lines.
 */
async function waitHealthy(ctx: Ctx, config: DeployAppConfig, container: string, port: number): Promise<void> {
  const deadline = ctx.now().getTime() + durationMs(config.healthcheck.timeout);
  const url = `http://${container}:${port}${config.healthcheck.path}`;
  ctx.log(`Health check: ${url} (up to ${config.healthcheck.timeout})`);
  let last = '';
  for (;;) {
    const info = await ctx.docker.inspectContainer(container);
    // Exited, or crashed and being restarted by its policy: no point waiting
    if (!info || !info.State.Running || info.State.Restarting || (info.RestartCount ?? 0) > 0) {
      const logs = await ctx.docker.logsTail(container);
      throw new BastionError(`The new container stopped (exit ${info?.State.ExitCode ?? '?'})${logs ? `:\n${logs}` : ''}`);
    }
    const probe = await ctx.docker.exec(PROXY_CONTAINER, ['wget', '-q', '-O', '/dev/null', '-T', '5', url], 15_000);
    if (probe.exitCode === 0) {
      ctx.log('Health check passed');
      return;
    }
    last = (probe.stderr || probe.stdout).trim();
    if (ctx.now().getTime() >= deadline) {
      const logs = await ctx.docker.logsTail(container);
      throw new BastionError(`Health check failed after ${config.healthcheck.timeout}: ${last || 'no answer'}${logs ? `\nContainer log:\n${logs}` : ''}`);
    }
    await sleep(ctx.healthIntervalMs);
  }
}

/**
 * Start `record`'s image as the app's live container (spec §5 steps 4–7),
 * with no request lost:
 *
 * 1. a new container next to the old one, on bastion-apps only — out of
 *    the proxy's rotation — and its health check;
 * 2. the new container joins bastion-live under the app's live alias, so it
 *    serves next to the old one; the proxy config is regenerated and
 *    reloaded only if it changed (first deploy, another port), and
 *    `current` moves;
 * 3. after the drain delay the app's other containers are stopped (each gets
 *    SIGTERM and time to finish) and removed; a GET one of them drops is
 *    retried by Caddy on the new one.
 *
 * Any failure before step 3 removes the new container (and with it its
 * alias) and leaves the old one serving.
 */
async function activate(ctx: Ctx, config: DeployAppConfig, record: ReleaseRecord): Promise<void> {
  const name = containerName(config.name, record.id);
  // A container of this release left from an earlier activation (rollback to it)
  await ctx.docker.remove(name);
  ctx.log(`Starting ${name}`);
  await ctx.docker.createContainer(name, appContainerSpec(ctx, config, record.id, record.image));
  try {
    await ctx.docker.start(name);
    await waitHealthy(ctx, config, name, record.port);
    await requireProxy(ctx);
    // `current` moves while the proxy lock is still held, so another app's switch builds on it
    await withProxyLock(ctx, async () => {
      await joinLive(ctx, name, liveAlias(config.name, record.port));
      ctx.log(`${name} is live`);
      await switchProxy(ctx, new Map([[config.name, siteFor(config, record.id, record.port)]]), { onlyIfChanged: true });
      // Release dirs may be gone for a CLI user who deleted them; the link still moves
      fs.mkdirSync(ctx.layout.release(config.name, record.id), { recursive: true });
      setCurrent(ctx.layout, config.name, record.id);
    });
  } catch (err) {
    ctx.log(`Removing ${name}; the previous release keeps serving`);
    await ctx.docker.remove(name).catch(() => {});
    throw err;
  }

  const others = (await ctx.docker.listContainers([`${LABEL_APP}=${config.name}`])).filter((c) => !c.Names.includes(`/${name}`));
  if (others.length > 0) {
    if (ctx.drainMs > 0) {
      ctx.log(`Both releases serve for ${Math.round(ctx.drainMs / 1000)}s, then the previous container stops`);
      await sleep(ctx.drainMs);
    }
    for (const c of others) {
      ctx.log(`Stopping ${c.Names[0]?.slice(1) ?? c.Id.slice(0, 12)}`);
      await ctx.docker.stop(c.Id).catch((err: Error) => ctx.log(`warning: ${err.message}`));
      await ctx.docker.remove(c.Id).catch((err: Error) => ctx.log(`warning: ${err.message}`));
    }
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

/** Directories, network and proxy container (spec §2.5, §5 `setup`). Safe to run again. */
export async function setup(ctx: Ctx): Promise<DeploySetupResult> {
  const { layout, docker } = ctx;
  for (const dir of [layout.bin, layout.apps, layout.tmp, layout.proxy, path.join(layout.proxy, 'data'), path.join(layout.proxy, 'config')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  fs.chmodSync(layout.tmp, 0o700);
  cleanTmp(ctx);
  await docker.ping();
  if (await docker.ensureNetwork(NETWORK, { [LABEL_MANAGED]: 'network' })) ctx.log(`Created network ${NETWORK}`);
  // Internal: apps reach the outside over bastion-apps; this one only carries the proxy's traffic to them
  if (await docker.ensureNetwork(LIVE_NETWORK, { [LABEL_MANAGED]: 'network' }, { internal: true })) ctx.log(`Created network ${LIVE_NETWORK}`);
  if (!(await docker.imageExists(CADDY_IMAGE))) {
    ctx.log(`Pulling ${images.caddy}`);
    await docker.pull(images.caddy, (line) => ctx.log(line));
  }
  writeInitialCaddyfile(ctx);

  let info = await docker.inspectContainer(PROXY_CONTAINER);
  if (info && info.Config.Image !== CADDY_IMAGE) {
    ctx.log(`Replacing ${PROXY_CONTAINER} (image changed)`);
    await docker.remove(PROXY_CONTAINER);
    info = null;
  }
  if (!info) {
    ctx.log(`Creating ${PROXY_CONTAINER}`);
    await docker.createContainer(PROXY_CONTAINER, proxySpec(ctx, proxyEnv(ctx, parseEnv)));
  }
  await joinLive(ctx, PROXY_CONTAINER);
  if (!info?.State.Running) {
    try {
      await docker.start(PROXY_CONTAINER);
    } catch (err) {
      const message = (err as Error).message;
      if (/address already in use|port is already allocated/i.test(message)) {
        throw new BastionError(`Ports 80/443 are taken by something else on this server (${message}). Stop it, or use proxy: nginx (coming later).`);
      }
      throw err;
    }
  }
  // Every app's current container answers to its live alias (containers from before bastion-live too)
  for (const app of appNames(layout)) {
    const id = currentRelease(layout, app);
    const record = id ? readRelease(layout, app, id) : null;
    if (!record?.port || !(await docker.inspectContainer(containerName(app, record.id)))) continue;
    if (await joinLive(ctx, containerName(app, record.id), liveAlias(app, record.port))) ctx.log(`Put ${app} on ${LIVE_NETWORK}`);
  }
  // Bring the live config up to date with the apps on disk
  if (appNames(layout).some((a) => currentRelease(layout, a))) await applyProxy(ctx);
  return { root: layout.root, proxy: 'caddy', network: NETWORK, proxyContainer: await proxyContainer(ctx), version: BASTIONCTL_VERSION };
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
  const text = opts.config ? fs.readFileSync(fileInRoot(ctx, opts.config), 'utf8') : templateConfig(app);
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
  return { app, created: !existed };
}

function summary(ctx: Ctx, app: string, container: DeployContainer | null): DeployAppSummary {
  const { config, error } = tryLoadConfig(ctx.layout, app);
  return {
    name: app,
    domains: config?.domains ?? [],
    buildType: config?.build.type ?? null,
    currentRelease: currentRelease(ctx.layout, app),
    container,
    configError: error,
    locked: readLock(ctx.layout.lock(app)) !== null,
  };
}

async function currentContainer(ctx: Ctx, app: string): Promise<DeployContainer | null> {
  const current = currentRelease(ctx.layout, app);
  if (!current) return null;
  const name = containerName(app, current);
  return containerView(await ctx.docker.inspectContainer(name), name);
}

export async function list(ctx: Ctx): Promise<DeployAppSummary[]> {
  const apps = appNames(ctx.layout);
  return Promise.all(apps.map(async (app) => summary(ctx, app, await currentContainer(ctx, app))));
}

export async function status(ctx: Ctx, app: string): Promise<DeployAppStatus> {
  requireApp(ctx, app);
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
  for (const id of ids) {
    const record = readRelease(ctx.layout, app, id);
    if (!record) continue;
    out.push({ ...record, current: id === current, imagePresent: record.image ? await ctx.docker.imageExists(record.image) : false });
  }
  return out;
}

/**
 * `deploy <app> --source <file>` (spec §5): lock, new release from the
 * upload, build, start, health check, proxy switch, `current`, prune. A
 * failure after the release folder exists is recorded in its release.json
 * and returned as a failed outcome; the previous release keeps serving.
 */
export async function deploy(baseCtx: Ctx, app: string, source: string): Promise<DeployOutcome> {
  const config = loadConfig(baseCtx.layout, app);
  const conflicts = validateForServer(baseCtx.layout, app, fs.readFileSync(baseCtx.layout.config(app), 'utf8'));
  if (!conflicts.ok) throw new BastionError(`Invalid config: ${formatIssues(conflicts.errors)}`, 3);
  if (config.proxy !== 'caddy') throw new BastionError('proxy: nginx is not available yet; use proxy: caddy');
  const sourceFile = fileInRoot(baseCtx, source);
  const proxy = await proxyContainer(baseCtx);
  if (proxy?.state !== 'running') throw new BastionError('The proxy is not running on this server (run bastionctl setup)');

  const releaseLock = await acquireLock(baseCtx.layout.lock(app), { holder: baseCtx.actor, docker: baseCtx.docker, now: baseCtx.now, what: `deploy of ${app}` });
  try {
    cleanTmp(baseCtx);
    const checksum = await sha256File(sourceFile);
    const id = newReleaseId(baseCtx.now(), checksum);
    const dir = baseCtx.layout.release(app, id);
    fs.mkdirSync(baseCtx.layout.releases(app), { recursive: true });
    try {
      fs.mkdirSync(dir);
    } catch {
      throw new BastionError(`Release ${id} already exists (the same source deployed within the same second)`);
    }
    const logFd = fs.openSync(path.join(dir, 'build.log'), 'a', 0o644);
    const ctx: Ctx = {
      ...baseCtx,
      log: (line) => {
        baseCtx.log(line);
        fs.writeSync(logFd, line + '\n');
      },
    };
    const previous = currentRelease(ctx.layout, app);
    const record: ReleaseRecord = {
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
    };
    writeRelease(ctx.layout, record);
    ctx.log(`Release ${id} of ${app} by ${ctx.actor}`);

    const gz = Buffer.alloc(2);
    const fd = fs.openSync(sourceFile, 'r');
    fs.readSync(fd, gz, 0, 2, 0);
    fs.closeSync(fd);
    const kept = path.join(dir, gz[0] === 0x1f && gz[1] === 0x8b ? 'source.tar.gz' : 'source.tar');
    if (isInside(fs.realpathSync(ctx.layout.tmp), sourceFile)) fs.renameSync(sourceFile, kept);
    else fs.copyFileSync(sourceFile, kept);

    const work = path.join(ctx.layout.tmp, `build-${app}-${id}`);
    let built = false;
    try {
      ctx.log('Unpacking the upload');
      const extracted = await extractTar(kept, work, { maxBytes: ctx.maxSourceBytes });
      ctx.log(`Unpacked ${extracted.files} entries (${Math.round(extracted.bytes / 1024)} KiB)`);
      const plan = planBuild(work, config);
      for (const note of plan.notes) ctx.log(note);
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
            rm: true,
            forcerm: true,
          },
          (line) => ctx.log(line),
        );
        built = true;
      } finally {
        buildLock();
        fs.rmSync(work, { recursive: true, force: true });
      }
      await activate(ctx, config, record);
      writeRelease(ctx.layout, { ...record, result: 'success', finishedAt: ctx.now().toISOString() });
      ctx.log(`Deployed ${app} release ${id}`);
      await prune(ctx, app, config.keep_releases);
      return { app, release: id, previous, result: 'success', error: null };
    } catch (err) {
      const message = (err as Error).message;
      ctx.log(`Deploy failed: ${message}`);
      writeRelease(ctx.layout, { ...record, result: 'failed', error: message, finishedAt: ctx.now().toISOString() });
      if (built) await ctx.docker.removeImage(record.image).catch(() => {});
      if (!(err instanceof BastionError) && !(err instanceof DockerApiError)) throw err;
      return { app, release: id, previous, result: 'failed', error: message };
    } finally {
      fs.closeSync(logFd);
    }
  } finally {
    releaseLock();
  }
}

/** `rollback <app> <id>`: serve a kept release's image again — no rebuild. */
export async function rollback(ctx: Ctx, app: string, id: string): Promise<DeployOutcome> {
  releaseId(id);
  const config = loadConfig(ctx.layout, app);
  const releaseLock = await acquireLock(ctx.layout.lock(app), { holder: ctx.actor, docker: ctx.docker, now: ctx.now, what: `deploy of ${app}` });
  try {
    const current = currentRelease(ctx.layout, app);
    if (id === current) throw new BastionError(`${id} is already the current release of ${app}`);
    const record = readRelease(ctx.layout, app, id);
    if (!record) throw new BastionError(`${app} has no release ${id}`);
    if (record.result !== 'success') throw new BastionError(`Release ${id} did not deploy successfully; it cannot be rolled back to`);
    if (!(await ctx.docker.imageExists(record.image))) throw new BastionError(`The image of release ${id} is gone (pruned); deploy it again instead`);
    ctx.log(`Rolling ${app} back to ${id} (by ${ctx.actor})`);
    try {
      await activate(ctx, config, record);
    } catch (err) {
      if (!(err instanceof BastionError)) throw err;
      return { app, release: id, previous: current, result: 'failed', error: err.message };
    }
    ctx.log(`${app} now serves release ${id}`);
    return { app, release: id, previous: current, result: 'success', error: null };
  } finally {
    releaseLock();
  }
}

async function liveContainer(ctx: Ctx, app: string): Promise<string> {
  requireApp(ctx, app);
  const current = currentRelease(ctx.layout, app);
  if (!current) throw new BastionError(`${app} has no current release`);
  const name = containerName(app, current);
  if (!(await ctx.docker.inspectContainer(name))) throw new BastionError(`The container of ${app}'s current release is gone; deploy or roll back to recreate it`);
  return name;
}

export async function restart(ctx: Ctx, app: string): Promise<{ app: string; container: string }> {
  const name = await liveContainer(ctx, app);
  ctx.log(`Restarting ${name}`);
  await ctx.docker.restart(name);
  return { app, container: name };
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
    const { config } = tryLoadConfig(ctx.layout, app);
    clearCurrent(ctx.layout, app);
    fs.rmSync(ctx.layout.releases(app), { recursive: true, force: true });
    if (opts.purge) {
      for (const v of config?.run.volumes ?? []) await ctx.docker.removeVolume(volumeName(app, v.split(':')[0]!)).catch((err: Error) => ctx.log(`warning: ${err.message}`));
      fs.rmSync(ctx.layout.app(app), { recursive: true, force: true });
    }
    ctx.log(opts.purge ? `Deleted ${app} and its data` : `Deleted ${app}'s releases; its config, .env and volumes are kept`);
    return { app, purged: !!opts.purge };
  } finally {
    releaseLock();
  }
}

export async function proxyApply(ctx: Ctx): Promise<{ ok: true }> {
  await applyProxy(ctx);
  return { ok: true };
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

/** The one command that prints a value (BastionSSH's step-up reveal). */
export function envGet(ctx: Ctx, app: string, key: string): { key: string; value: string } {
  envKey(key);
  const value = parseEnv(readEnvFile(envFile(ctx, app))).get(key);
  if (value === undefined) throw new BastionError(`${key} is not set for ${app}`);
  return { key, value };
}
