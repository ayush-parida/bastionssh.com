/** Why a backup of the app's own database was taken. */
export type DbBackupReason = 'scheduled' | 'pre-migration' | 'manual' | 'pre-restore';

export interface DbBackup {
  /** File name inside the backup directory, e.g. smt-20260928T031500Z-scheduled.db.gz */
  name: string;
  reason: DbBackupReason;
  /** ISO time the backup was taken (UTC, to the second). */
  createdAt: string;
  size: number;
  compressed: boolean;
}

export interface DbBackupSettings {
  directory: string;
  /** 0 = scheduled backups are off. */
  intervalHours: number;
  /** Newest backups kept per reason. */
  keep: number;
  gzip: boolean;
  preMigration: boolean;
  /** Where new backups are copied, when configured. */
  upload: { bucket: string; prefix: string } | null;
}

export interface DbBackupList {
  backups: DbBackup[];
  settings: DbBackupSettings;
}

export interface CreatedDbBackup {
  backup: DbBackup;
  /** null when no upload is configured. */
  uploaded: boolean | null;
}
