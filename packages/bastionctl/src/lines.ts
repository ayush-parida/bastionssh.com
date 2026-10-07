import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { serviceLineChangeAllowed, serviceLineOfImage, serviceTemplate, type DeployAppConfig, type ServiceTemplate } from '@smt/shared';
import type { Layout } from './names.js';
import type { ReleaseRecord } from './releases.js';

/**
 * The version line of a quick service's releases (services spec §3.3), and
 * the rule a rollback keeps: the same as Update version's. Serving an older
 * release again must not move a database to another major line (its data
 * files are not that line's) nor a forward-only template back to an older
 * line (Grafana 13 → 12: the newer release migrated its data).
 *
 * A release records its line at deploy (`line`, with `ref` and `service`).
 * One deployed by an older bastionctl has neither: its line is read from the
 * image it pulled, which its build log names (`Pulling <ref>`) and its
 * checksum proves (a pulled release's checksum is the SHA-256 of the
 * reference). When the line still cannot be told the rollback is refused —
 * `--force-line` overrides it.
 */

/** How much of a build log is read for the reference (it is in the first lines). */
const LOG_HEAD_BYTES = 64 * 1024;
const LOG_REF = /^(?:Pulling (\S+)|(\S+) is on the server already)$/;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function logHead(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(LOG_HEAD_BYTES);
    return buf.subarray(0, fs.readSync(fd, buf, 0, LOG_HEAD_BYTES, 0)).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The image reference a pulled release ran: recorded, or (older releases) named by its build log and proved by its checksum. */
export function releaseRef(layout: Layout, record: ReleaseRecord): string | null {
  if (record.buildType !== 'image') return null;
  if (record.ref) return record.ref;
  for (const line of logHead(path.join(layout.release(record.app, record.id), 'build.log')).split('\n')) {
    const m = LOG_REF.exec(line.trim());
    const ref = m?.[1] ?? m?.[2];
    if (ref && sha256(ref) === record.checksum) return ref;
  }
  return null;
}

/** The line of `t` a release runs, or null when it cannot be told. */
export function releaseLine(layout: Layout, record: ReleaseRecord, t: ServiceTemplate): string | null {
  // Recorded at deploy, for this template (a release of another template's image says nothing about this one)
  if (record.line && (record.service ?? t.id) === t.id) return record.line;
  const ref = releaseRef(layout, record);
  return ref ? serviceLineOfImage(t, ref) : null;
}

/** What a deploy records: the template and line of the image it pulls. */
export function deployedLine(config: DeployAppConfig, ref: string): { service: string; line: string | null } | null {
  if (!config.service) return null;
  const t = serviceTemplate(config.service);
  return { service: config.service, line: t ? serviceLineOfImage(t, ref) : null };
}

export type LineCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `target` may be served again where `current` serves now (or, with
 * no current release, the image bastion.yml names). Apps without `service:`
 * have no lines: always allowed.
 */
export function rollbackLineCheck(layout: Layout, config: DeployAppConfig, current: ReleaseRecord | null, target: ReleaseRecord): LineCheck {
  if (!config.service) return { ok: true };
  const t = serviceTemplate(config.service);
  if (!t) {
    return { ok: false, reason: `${config.name} is a ${config.service} service, a template this bastionctl does not know: whether release ${target.id} is on the same version line cannot be told.` };
  }
  const to = releaseLine(layout, target, t);
  if (!to) {
    return {
      ok: false,
      reason: `The ${t.name} line of release ${target.id} cannot be told (it was deployed before bastionctl recorded lines, and its build log no longer names its image): a rollback to it could move ${config.name} to another line.`,
    };
  }
  const from = current ? releaseLine(layout, current, t) : config.build.image ? serviceLineOfImage(t, config.build.image) : null;
  if (!from) {
    return { ok: false, reason: `The ${t.name} line ${config.name} runs now cannot be told: whether release ${target.id} (${t.name} ${to}) is on the same line cannot be checked.` };
  }
  const allowed = serviceLineChangeAllowed(t, from, to);
  return allowed.ok ? allowed : { ok: false, reason: `Release ${target.id} runs another line: ${allowed.reason}` };
}
