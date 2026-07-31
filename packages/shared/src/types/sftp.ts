export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SftpEntry {
  name: string;
  /** Absolute remote path */
  path: string;
  type: SftpEntryType;
  size: number;
  /** Raw POSIX mode bits */
  mode: number;
  /** Human-readable rendering of `mode`, e.g. "rwxr-xr-x" */
  permissions: string;
  uid: number;
  gid: number;
  modifiedAt: string;
}

export interface SftpListResponse {
  /** The resolved (realpath'd) directory being listed */
  path: string;
  /** Parent directory, or null when at the filesystem root */
  parent: string | null;
  entries: SftpEntry[];
}

export interface SftpReadResponse {
  path: string;
  /** UTF-8 decoded file contents */
  content: string;
  size: number;
  /** True when the file was longer than the editable limit and was cut short */
  truncated: boolean;
}

export interface SftpMkdirRequest {
  path: string;
}

export interface SftpRenameRequest {
  from: string;
  to: string;
}

export interface SftpDeleteRequest {
  path: string;
  /** Required to remove a non-empty directory */
  recursive?: boolean;
}
