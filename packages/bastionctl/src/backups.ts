import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  SERVICE_BACKUP_FILE,
  serviceTemplate,
  type DeployAppConfig,
  type DeployBackup,
  type DeployBackupKind,
  type DeployBackupList,
  type DeployBackupResult,
  type DeployBackupRun,
  type DeployRestoreResult,
  type ServiceBackupSpec,
} from '@smt/shared';
import { appNames, envFilePath, loadConfig, tryLoadConfig } from './config.js';
import type { Ctx } from './context.js';
import { cronContainer } from './cron.js';
import { acquireLock } from './lock.js';
import { envFileMasker } from './mask.js';
import { appName, BastionError } from './names.js';
import { liveContainer, waitHealthy } from './ops.js';
import { currentRelease } from './releases.js';
import { tarOneFile } from './tar.js';

/**
 * Backups of quick services (services spec §3.4). A backup is the
 * template's dump command run inside the service's live container (`docker
 * exec`), its output streamed straight into
 * `<root>/apps/<name>/backups/<UTC timestamp>[-kind].<ext>` on the server —
 * nothing passes through BastionSSH. Backups and restores hold the app's
 * deploy lock, so neither runs during a deploy (or another backup).
 *
 * A restore first backs up the data it is about to replace
 * (`<timestamp>-pre-restore.<ext>`), then restores in place: the file is
 * copied into the container and the template's restore command reads it, or
 * (Redis, Valkey) the container is stopped, its data file replaced and the
 * container started again. Apps using the service are not stopped; the docs
 * say what that means.
 */

/** How long one dump may take. */
const DUMP_TIMEOUT_MS = 2 * 60 * 60_000;
/** A schedule that failed is tried again after this long, not every minute. */
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
/** A schedule runs when the newest backup is this close to one period old (the timer wakes every minute). */
const DUE_SLACK_MS = 60_000;
const PERIOD_MS = { hourly: 60 * 60_000, daily: 24 * 60 * 60_000 } as const;

export const backupDir = (ctx: Pick<Ctx, 'layout'>, app: string) => path.join(ctx.layout.app(app), 'backups');
const lastRunFile = (ctx: Pick<Ctx, 'layout'>, app: string) => path.join(backupDir(ctx, app), '.last-scheduled.json');

/** `20261007T120000Z` → `2026-10-07T12:00:00.000Z`. */
function stampTime(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(stamp)!;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)).toISOString();
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function kindOf(file: string): DeployBackupKind {
  return file.includes('-pre-restore.') ? 'pre-restore' : file.includes('-scheduled.') ? 'scheduled' : 'manual';
}

/** A backup file name from a request: the pattern bastionctl writes, nothing else (no paths). */
export function backupFileName(value: unknown): string {
  if (typeof value !== 'string' || !SERVICE_BACKUP_FILE.test(value)) throw new BastionError(`Invalid backup file ${JSON.stringify(value)}`, 2);
  return value;
}

/** The template's backup spec for `app`, or why there is none. */
function backupSpec(config: DeployAppConfig): ServiceBackupSpec {
  const template = serviceTemplate(config.service);
  if (!config.service) throw new BastionError(`${config.name} is not a quick service (bastion.yml has no service:), so it has no backup command`);
  if (!template) throw new BastionError(`${config.name} is a ${config.service} service, which this bastionctl does not know`);
  if (!template.backup) throw new BastionError(`${template.name} has no backup command; see the docs for backing it up`);
  return template.backup;
}

/** The app's backups, newest first (partial files of a running dump are not listed). */
export function listBackups(ctx: Pick<Ctx, 'layout'>, app: string): DeployBackup[] {
  let names: string[];
  try {
    names = fs.readdirSync(backupDir(ctx, app));
  } catch {
    return [];
  }
  const out: DeployBackup[] = [];
  for (const file of names) {
    if (!SERVICE_BACKUP_FILE.test(file)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(backupDir(ctx, app), file));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({ file, bytes: stat.size, createdAt: stampTime(file), kind: kindOf(file) });
  }
  return out.sort((a, b) => b.file.localeCompare(a.file));
}

function readLastRun(ctx: Pick<Ctx, 'layout'>, app: string): DeployBackupRun | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lastRunFile(ctx, app), 'utf8')) as Partial<DeployBackupRun>;
    if (typeof raw.at !== 'string' || (raw.result !== 'success' && raw.result !== 'failed')) return null;
    return { at: raw.at, result: raw.result, file: typeof raw.file === 'string' ? raw.file : null, error: typeof raw.error === 'string' ? raw.error : null };
  } catch {
    return null;
  }
}

function writeLastRun(ctx: Pick<Ctx, 'layout'>, app: string, run: DeployBackupRun): void {
  fs.mkdirSync(backupDir(ctx, app), { recursive: true, mode: 0o700 });
  const file = lastRunFile(ctx, app);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(run) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** `backups list <app>`. */
export async function backupsList(ctx: Ctx, app: string): Promise<DeployBackupList> {
  appName(app);
  if (!fs.existsSync(ctx.layout.app(app))) throw new BastionError(`No app named ${app} on this server`);
  const { config } = tryLoadConfig(ctx.layout, app);
  const template = serviceTemplate(config?.service);
  return {
    app,
    service: config?.service ?? null,
    supported: !!template?.backup,
    backups: listBackups(ctx, app),
    settings: config?.backups ?? { schedule: 'off', keep: 7 },
    lastScheduled: readLastRun(ctx, app),
    cron: await cronContainer(ctx),
  };
}

/** Run the dump into a new file (no lock: the caller holds the app's deploy lock). */
async function dump(ctx: Ctx, config: DeployAppConfig, kind: DeployBackupKind): Promise<DeployBackup> {
  const spec = backupSpec(config);
  const app = config.name;
  const container = await liveContainer(ctx, app);
  const info = await ctx.docker.inspectContainer(container);
  if (!info?.State.Running) throw new BastionError(`${container} is not running: start ${app} (restart) before backing it up`);
  const dir = backupDir(ctx, app);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = `${stamp(ctx.now())}${kind === 'manual' ? '' : `-${kind}`}.${spec.ext}`;
  const target = path.join(dir, file);
  if (fs.existsSync(target)) throw new BastionError(`A backup named ${file} exists already; try again in a second`);
  const partial = path.join(dir, `.${file}.${randomBytes(4).toString('hex')}.partial`);
  const mask = envFileMasker(envFilePath(ctx.layout, app, config));
  ctx.log(`Backing up ${app} (${spec.format}) to backups/${file}`);
  const started = ctx.now().getTime();
  try {
    const result = await ctx.docker.execToFile(container, spec.dump, partial, DUMP_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      const detail = mask(result.stderr.trim().split('\n').slice(-5).join('\n'));
      throw new BastionError(`The dump failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`);
    }
    if (result.bytes === 0) throw new BastionError('The dump wrote nothing; no backup was kept');
    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, target);
    ctx.log(`Backed up ${app}: ${result.bytes} bytes in ${Math.max(0, Math.round((ctx.now().getTime() - started) / 1000))}s`);
    return { file, bytes: result.bytes, createdAt: stampTime(file), kind };
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

/**
 * Remove the oldest backups beyond `keep` (manual and scheduled count);
 * returns the names removed. Pre-restore backups — the data a restore
 * replaced — are never pruned: an hourly schedule would otherwise remove the
 * only copy of it within hours. They are deleted by hand.
 */
export function pruneBackups(ctx: Pick<Ctx, 'layout' | 'log'>, app: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw new BastionError('--keep takes a whole number from 1 to 100', 2);
  const removed = listBackups(ctx, app)
    .filter((b) => b.kind !== 'pre-restore')
    .slice(keep)
    .map((b) => b.file);
  for (const file of removed) fs.rmSync(path.join(backupDir(ctx, app), file), { force: true });
  if (removed.length > 0) ctx.log(`Removed ${removed.length} old backup${removed.length === 1 ? '' : 's'} (keeping ${keep})`);
  return removed;
}

async function withAppLock<T>(ctx: Ctx, app: string, what: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(ctx.layout.lock(app), { holder: `${ctx.actor} (${what})`, docker: ctx.docker, now: ctx.now, what: `deploy of ${app}` });
  try {
    return await fn();
  } finally {
    release();
  }
}

/** `backup <app> [--keep N]`: a backup now, then the oldest beyond `keep` (default bastion.yml's backups.keep) removed. */
export async function backup(ctx: Ctx, app: string, opts: { keep?: number; kind?: 'manual' | 'scheduled' } = {}): Promise<DeployBackupResult> {
  const config = loadConfig(ctx.layout, app);
  backupSpec(config);
  return withAppLock(ctx, app, 'backup', async () => {
    const made = await dump(ctx, config, opts.kind ?? 'manual');
    const pruned = pruneBackups(ctx, app, opts.keep ?? config.backups?.keep ?? 7);
    return { app, backup: made, pruned };
  });
}

/** `backups prune <app> [--keep N]`. */
export function prune(ctx: Ctx, app: string, keep?: number): { app: string; pruned: string[] } {
  const config = loadConfig(ctx.layout, app);
  return { app, pruned: pruneBackups(ctx, app, keep ?? config.backups?.keep ?? 7) };
}

export function backupPath(ctx: Pick<Ctx, 'layout'>, app: string, file: string): string {
  const full = path.join(backupDir(ctx, app), backupFileName(file));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch {
    throw new BastionError(`${app} has no backup ${file}`);
  }
  if (!stat.isFile()) throw new BastionError(`backups/${file} of ${app} is not a regular file`);
  return full;
}

/** `backups delete <app> <file>`. */
export function deleteBackup(ctx: Ctx, app: string, file: string): { app: string; file: string } {
  appName(app);
  fs.rmSync(backupPath(ctx, app, file));
  ctx.log(`Deleted backups/${file} of ${app}`);
  return { app, file };
}

/**
 * `restore <app> <file>`: put a backup's data back into the running service
 * (see the module comment). The data it replaces is backed up first; a
 * failure of that backup stops the restore before anything changed.
 */
export async function restore(ctx: Ctx, app: string, file: string): Promise<DeployRestoreResult> {
  const config = loadConfig(ctx.layout, app);
  const spec = backupSpec(config);
  const source = backupPath(ctx, app, file);
  if (!file.endsWith(`.${spec.ext}`)) throw new BastionError(`${file} is not a ${spec.format} backup (.${spec.ext})`);
  const mask = envFileMasker(envFilePath(ctx.layout, app, config));
  return withAppLock(ctx, app, 'restore', async () => {
    ctx.log(`Restoring ${app} from backups/${file} (by ${ctx.actor})`);
    const safety = await dump(ctx, config, 'pre-restore');
    ctx.log(`The data being replaced is kept as backups/${safety.file}`);
    const container = await liveContainer(ctx, app);
    if (spec.restore.type === 'exec') {
      const inside = `bastion-restore-${randomBytes(6).toString('hex')}.${spec.ext}`;
      ctx.log(`Copying ${file} into ${container}`);
      await ctx.docker.putArchive(container, '/tmp', tarOneFile(inside, source));
      const argv = spec.restore.command.map((a) => a.replaceAll('{file}', `/tmp/${inside}`));
      let stderr = '';
      try {
        const exitCode = await ctx.docker.execStream(
          container,
          argv,
          {
            onStdout: (c) => ctx.log(mask(c.toString('utf8').trimEnd())),
            onStderr: (c) => {
              stderr = (stderr + c.toString('utf8')).slice(-16 * 1024);
            },
          },
          DUMP_TIMEOUT_MS,
        );
        if (exitCode !== 0) {
          const detail = mask(stderr.trim().split('\n').slice(-8).join('\n'));
          throw new BastionError(`The restore command failed (exit ${exitCode})${detail ? `: ${detail}` : ''}. The data before the restore is in backups/${safety.file}.`);
        }
      } finally {
        await ctx.docker.exec(container, ['rm', '-f', `/tmp/${inside}`], 30_000).catch(() => {});
      }
    } else {
      const target = spec.restore.path;
      ctx.log(`Stopping ${container} to replace ${target}`);
      await ctx.docker.stop(container, 30);
      try {
        await ctx.docker.putArchive(container, path.posix.dirname(target), tarOneFile(path.posix.basename(target), source));
      } finally {
        ctx.log(`Starting ${container}`);
        await ctx.docker.start(container);
      }
      await waitHealthy(ctx, config, container, config.run.port);
    }
    ctx.log(`Restored ${app} from ${file}`);
    return { app, file, safety, method: spec.restore.type };
  });
}

/**
 * `backups run-due` (bastion-cron, every minute): a scheduled backup of
 * every service whose newest backup is a period old, then its retention. A
 * service being deployed (its lock held) is tried again at the next tick; a
 * failed run is recorded and retried after a quarter of an hour.
 */
export async function runDue(ctx: Ctx): Promise<{ ran: Array<{ app: string; file: string | null; error: string | null }>; skipped: Array<{ app: string; reason: string }> }> {
  const ran: Array<{ app: string; file: string | null; error: string | null }> = [];
  const skipped: Array<{ app: string; reason: string }> = [];
  const now = ctx.now().getTime();
  for (const app of appNames(ctx.layout)) {
    const { config } = tryLoadConfig(ctx.layout, app);
    const schedule = config?.backups?.schedule ?? 'off';
    if (!config || schedule === 'off' || !serviceTemplate(config.service)?.backup) continue;
    if (!currentRelease(ctx.layout, app)) {
      skipped.push({ app, reason: 'not deployed' });
      continue;
    }
    const newest = listBackups(ctx, app)[0];
    if (newest && now - Date.parse(newest.createdAt) < PERIOD_MS[schedule] - DUE_SLACK_MS) continue;
    const last = readLastRun(ctx, app);
    if (last?.result === 'failed' && now - Date.parse(last.at) < RETRY_AFTER_FAILURE_MS) {
      skipped.push({ app, reason: 'failed recently; retried later' });
      continue;
    }
    try {
      const result = await backup(ctx, app, { kind: 'scheduled' });
      writeLastRun(ctx, app, { at: ctx.now().toISOString(), result: 'success', file: result.backup.file, error: null });
      ran.push({ app, file: result.backup.file, error: null });
    } catch (err) {
      if (err instanceof BastionError && err.exitCode === 4) {
        skipped.push({ app, reason: 'busy (a deploy, backup or restore is running)' });
        continue;
      }
      const error = (err as Error).message.split('\n')[0]!.slice(0, 500);
      ctx.log(`Scheduled backup of ${app} failed: ${error}`);
      writeLastRun(ctx, app, { at: ctx.now().toISOString(), result: 'failed', file: null, error });
      ran.push({ app, file: null, error });
    }
  }
  return { ran, skipped };
}
