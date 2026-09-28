import path from 'path';
import type { DbBackupReason } from '@smt/shared';

/**
 * Backup file naming. Names are generated here and nowhere else, and anything
 * arriving from outside (an API path parameter, a CLI argument) is accepted
 * only when it matches the same shape exactly — no separators, no dot
 * segments — so a name can never point outside the backup directory.
 *
 *   smt-20260928T031500Z-scheduled.db
 *   smt-20260928T031500Z-manual-2.db.gz   (second manual backup in that second)
 */

export const BACKUP_REASONS = ['scheduled', 'pre-migration', 'manual', 'pre-restore'] as const;

const NAME_RE = /^smt-(\d{8}T\d{6}Z)-(scheduled|pre-migration|manual|pre-restore)(?:-(\d{1,3}))?\.db(\.gz)?$/;

/** Where backups go when SMT_BACKUP_DIR is unset: `backups/` next to the database (/data/backups). */
export function defaultBackupDir(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

/** 2026-09-28T03:15:00.123Z → 20260928T031500Z */
export function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function backupFileName(date: Date, reason: DbBackupReason, gzip: boolean, sequence = 0): string {
  const suffix = sequence > 0 ? `-${sequence}` : '';
  return `smt-${compactTimestamp(date)}-${reason}${suffix}.db${gzip ? '.gz' : ''}`;
}

export interface ParsedBackupName {
  name: string;
  reason: DbBackupReason;
  /** From the name, to the second (UTC). */
  createdAt: Date;
  /** The -N suffix of several backups taken in one second; 0 for the first. */
  sequence: number;
  compressed: boolean;
}

export function parseBackupName(name: string): ParsedBackupName | null {
  if (typeof name !== 'string' || name.length > 80) return null;
  const match = NAME_RE.exec(name);
  if (!match) return null;
  const [, stamp, reason, seq, gz] = match;
  const iso = `${stamp!.slice(0, 4)}-${stamp!.slice(4, 6)}-${stamp!.slice(6, 8)}T${stamp!.slice(9, 11)}:${stamp!.slice(11, 13)}:${stamp!.slice(13, 15)}Z`;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString().slice(0, 19) + 'Z' !== iso) return null;
  return { name, reason: reason as DbBackupReason, createdAt, sequence: seq ? Number(seq) : 0, compressed: gz === '.gz' };
}

export function isValidBackupName(name: string): boolean {
  return parseBackupName(name) !== null;
}

/**
 * The absolute path of backup `name` inside `dir`, or null when the name is
 * not one this module could have produced.
 */
export function resolveBackupPath(dir: string, name: string): string | null {
  if (!isValidBackupName(name)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  // Belt and braces: the regex already rules out separators
  if (path.dirname(full) !== root) return null;
  return full;
}
