import type { Readable, Writable } from 'node:stream';
import type { FtpEntry, FtpTestResult } from '@smt/shared';
import type { ftpConnections } from '../db/schema.js';

export type FtpConnectionRow = typeof ftpConnections.$inferSelect;

/** What a backend logs in with: the stored password, or (SFTP only) an org SSH key. */
export interface FileCredentials {
  password?: string;
  privateKey?: string;
}

/**
 * One logged-in session on a file connection. The routes only talk to this, so
 * the same handlers serve FTP/FTPS (basic-ftp) and SFTP (ssh2). Every path is
 * already normalized and absolute; every failure is an FtpError.
 */
export interface FileSession {
  readonly closed: boolean;
  close(): void;
  /**
   * Whether the session is still usable after `err` — a plain refusal from the
   * server leaves it fine; a dropped socket or aborted transfer does not.
   */
  survives(err: unknown): boolean;

  /** The configured root, else the login directory. */
  home(rootPath: string | null): Promise<string>;
  /**
   * The directory every path is confined to, or null when unrestricted. Only
   * the jail (ftp/jail.ts) sets one; listings stop offering a parent there.
   */
  jailRoot?(): Promise<string | null>;
  /**
   * Canonical absolute form of an existing path as the server resolves it,
   * symlinks included. SFTP only; FTP has no way to ask.
   */
  realpath?(path: string): Promise<string>;
  list(dir: string): Promise<FtpEntry[]>;
  /** Describes a symlink itself, never what it points at. */
  stat(path: string): Promise<FtpEntry>;
  /** Size of the file a symlink leads to; a 400 when it is not a regular file. */
  linkTargetSize(path: string): Promise<number>;
  /** Resolves once the whole file has been written to `destination`. */
  download(path: string, destination: Writable): Promise<void>;
  /** Resolves once the server has acknowledged the whole upload. */
  upload(source: Readable, path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file or a symlink (the link, not its target). */
  removeFile(path: string): Promise<void>;
  removeEmptyDir(path: string): Promise<void>;
  /** Depth-first; symlinks inside are unlinked, never followed. */
  removeDirRecursive(path: string): Promise<void>;
}

export interface FileBackend {
  /** Connect and log in. The caller owns the session and must `close()` it. */
  open(connection: FtpConnectionRow, credentials: FileCredentials): Promise<FileSession>;
  /** A throwaway login plus a listing; failures come back as `{ ok: false }`. */
  testConnection(connection: FtpConnectionRow, credentials: FileCredentials): Promise<FtpTestResult>;
}
