import type { Readable } from 'node:stream';

/**
 * The source side of a folder download: one implementation per file viewer
 * (SFTP on a managed server, an FTP/SFTP connection, an object-storage
 * prefix). The engine only ever lists folders and opens files through it, so
 * confinement (root-path jail, prefix checks) stays with the source.
 */
export interface FolderWalker {
  /** The children of one folder (`ref` is the walker's own locator: a path, a key prefix). */
  list(ref: string): Promise<WalkEntry[]>;
  /** A read stream for one file; rejecting (or erroring before any data) skips the file. */
  open(entry: WalkEntry, signal: AbortSignal): Promise<Readable>;
  /** Release connections and leases; called once, after the archive is done or abandoned. */
  close(): Promise<void> | void;
}

export interface WalkEntry {
  /** One path segment, as the source names it; the engine sanitises it for the archive. */
  name: string;
  /** Locator handed back to `list` (folders) or `open` (files). */
  ref: string;
  /** `other` covers devices, sockets and FIFOs — never opened. */
  type: 'file' | 'dir' | 'symlink' | 'other';
  /** Bytes, for files; the engine reads at most this many. */
  size: number;
  mtime?: Date;
  /** Permission bits (the low 12 bits are used). */
  mode?: number;
  /** Where a symlink points, verbatim. Without it a link is skipped. */
  linkTarget?: string;
}

export type ArchiveFormat = 'zip' | 'tar.gz';

export interface ArchiveSummary {
  /** Files written (symlinks included, folders not). */
  files: number;
  /** Bytes of file content written (before compression). */
  bytes: number;
  /** Entries left out (unreadable, vanished, symlinks in a zip, unsafe names…), listed in _skipped.txt. */
  skipped: number;
  /** A limit was reached; the archive ends with _TRUNCATED.txt. */
  truncated: boolean;
  /** The download was cancelled (client disconnect, revoked access) and the archive is incomplete. */
  aborted: boolean;
}

/** Metadata the writers take for one entry. */
export interface EntryMeta {
  mtime: Date;
  /** Permission bits only; the writers add the file-type bits. */
  mode: number;
}
