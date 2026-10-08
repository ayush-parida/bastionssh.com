import fs from 'node:fs';
import { parseDocument } from 'yaml';
import type { DeployBackupSchedule, DeployBackupSettings } from '@smt/shared';
import { formatIssues, isImageRef, MAX_CONFIG_BYTES, tryLoadConfig, validateForServer } from './config.js';
import type { Ctx } from './context.js';
import { ensureCron } from './cron.js';
import { checkKernel } from './kernel.js';
import { appName, BastionError } from './names.js';
import { withProxyLock } from './proxy.js';

/**
 * The two changes the service page makes to a quick service's `bastion.yml`
 * (services spec §3.3, §3.4): its image (Update version) and its backup
 * schedule. The file is edited in place — comments and the rest of the
 * config kept — validated like any config, and written atomically under the
 * lock config writes take.
 */

async function editConfig(ctx: Ctx, app: string, edit: (doc: ReturnType<typeof parseDocument>) => void): Promise<{ before: string; after: string }> {
  appName(app);
  const file = ctx.layout.config(app);
  let before: string;
  try {
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) throw new BastionError('bastion.yml is larger than 64 KiB');
    before = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof BastionError) throw err;
    throw new BastionError(`No app named ${app} on this server`);
  }
  const doc = parseDocument(before, { uniqueKeys: true, strict: true, schema: 'core' });
  if (doc.errors.length > 0) throw new BastionError(`bastion.yml of ${app} cannot be read: ${doc.errors[0]!.message.split('\n')[0]}`, 3);
  edit(doc);
  // No folding: a long image reference or command stays on its line
  const after = doc.toString({ lineWidth: 0 });
  await withProxyLock(ctx, async () => {
    const result = validateForServer(ctx.layout, app, after);
    if (!result.ok) throw new BastionError(`Invalid config: ${formatIssues(result.errors)}`, 3);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, after, { mode: 0o644 });
    fs.renameSync(tmp, file);
  });
  return { before, after };
}

/**
 * `set-image <app> <ref>`: `build.image` of a `build.type: image` app. The
 * next deploy pulls it (BastionSSH deploys right away). Which images a
 * quick service may move to is BastionSSH's to decide (its catalog's lines);
 * one whose line will not start on this host's kernel is refused here.
 */
export async function setImage(ctx: Ctx, app: string, ref: string): Promise<{ app: string; from: string | null; to: string; changed: boolean }> {
  if (!isImageRef(ref)) throw new BastionError(`Not an image reference: ${JSON.stringify(ref)}`, 2);
  // Not a line that will not start on this kernel (MongoDB 8 on 6.19+): the deploy that follows would only fail
  const { config } = tryLoadConfig(ctx.layout, appName(app));
  if (config) await checkKernel(ctx, config, ref, `${app} keeps its image; nothing was changed.`);
  const seen: { from: string | null } = { from: null };
  const { before, after } = await editConfig(ctx, app, (doc) => {
    if (doc.getIn(['build', 'type']) !== 'image') throw new BastionError(`${app} is not built from an image (build.type: image)`, 3);
    const current = doc.getIn(['build', 'image']);
    seen.from = typeof current === 'string' ? current : null;
    doc.setIn(['build', 'image'], ref);
  });
  const { from } = seen;
  const changed = before !== after;
  ctx.log(changed ? `${app} now uses ${ref} (was ${from ?? 'none'}); deploy it to switch` : `${app} uses ${ref} already`);
  return { app, from, to: ref, changed };
}

/** `backups schedule <app> off|hourly|daily [--keep N]`, then bastion-cron as the schedules now need it. */
export async function setBackupSchedule(ctx: Ctx, app: string, schedule: DeployBackupSchedule, keep?: number): Promise<{ app: string; settings: DeployBackupSettings }> {
  if (!['off', 'hourly', 'daily'].includes(schedule)) throw new BastionError('The schedule is off, hourly or daily', 2);
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1 || keep > 100)) throw new BastionError('--keep takes a whole number from 1 to 100', 2);
  await editConfig(ctx, app, (doc) => {
    doc.setIn(['backups', 'schedule'], schedule);
    if (keep !== undefined) doc.setIn(['backups', 'keep'], keep);
  });
  const settings = validateForServer(ctx.layout, app, fs.readFileSync(ctx.layout.config(app), 'utf8')).config?.backups ?? { schedule, keep: keep ?? 7 };
  ctx.log(`Backups of ${app}: ${settings.schedule === 'off' ? 'not scheduled' : settings.schedule}, keeping ${settings.keep}`);
  await ensureCron(ctx);
  return { app, settings };
}
