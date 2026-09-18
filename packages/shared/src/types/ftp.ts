/**
 * Plain FTP, explicit FTPS (AUTH TLS on the standard port) or implicit FTPS
 * (TLS from the first byte, conventionally port 990).
 */
export type FtpProtocol = 'ftp' | 'ftps' | 'ftps-implicit';

export interface FtpProtocolOption {
  protocol: FtpProtocol;
  label: string;
  defaultPort: number;
  /** One-line help rendered under the form. */
  hint: string;
}

export const FTP_PROTOCOL_OPTIONS: readonly FtpProtocolOption[] = [
  {
    protocol: 'ftps',
    label: 'FTPS (explicit TLS)',
    defaultPort: 21,
    hint: 'Connects on the FTP port and upgrades to TLS before logging in. The safe default — most hosts support it.',
  },
  {
    protocol: 'ftps-implicit',
    label: 'FTPS (implicit TLS)',
    defaultPort: 990,
    hint: 'TLS from the first byte on a dedicated port, usually 990. Older FileZilla Server and IIS setups use this.',
  },
  {
    protocol: 'ftp',
    label: 'FTP (no encryption)',
    defaultPort: 21,
    hint: 'Credentials and file contents travel in the clear. Only use on a trusted network.',
  },
];

/** Protocol ids in option order — the server's accepted enum. */
export const FTP_PROTOCOLS = FTP_PROTOCOL_OPTIONS.map((o) => o.protocol) as [
  FtpProtocol,
  ...FtpProtocol[],
];

export function ftpProtocolOption(protocol: FtpProtocol): FtpProtocolOption {
  return FTP_PROTOCOL_OPTIONS.find((o) => o.protocol === protocol) ?? FTP_PROTOCOL_OPTIONS[0]!;
}

export type FtpTestStatus = 'ok' | 'failed';

export interface FtpConnection {
  id: string;
  orgId: string;
  name: string;
  host: string;
  port: number;
  protocol: FtpProtocol;
  username: string;
  /** Reject self-signed or mismatched certificates (FTPS only). */
  verifyTls: boolean;
  /** Directory the browser opens at; null means the account's login directory. */
  rootPath: string | null;
  /** Result of the last "Test connection", if any. */
  lastStatus: FtpTestStatus | null;
  lastError: string | null;
  lastTestedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** password is never returned to the client */
}

export interface CreateFtpConnectionRequest {
  name: string;
  host: string;
  /** Defaults to the protocol's conventional port. */
  port?: number;
  protocol?: FtpProtocol;
  username: string;
  password: string;
  /** Defaults to true. */
  verifyTls?: boolean;
  rootPath?: string | null;
}

export interface UpdateFtpConnectionRequest {
  name?: string;
  host?: string;
  port?: number;
  protocol?: FtpProtocol;
  username?: string;
  /** Omit to keep the stored password. */
  password?: string;
  verifyTls?: boolean;
  rootPath?: string | null;
}

export interface FtpTestResult {
  ok: boolean;
  error?: string;
  /** The login directory reported by the server. */
  workingDirectory?: string;
  entryCount?: number;
}

export type FtpEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FtpEntry {
  name: string;
  /** Absolute remote path */
  path: string;
  type: FtpEntryType;
  size: number;
  /** `rwxr-xr-x`, or null when the server's listing format carries no mode bits. */
  permissions: string | null;
  /** ISO timestamp when the server gave a machine-readable date (MLSD), else null. */
  modifiedAt: string | null;
  /** The date column exactly as the server printed it, for listings without MLSD. */
  rawModifiedAt: string;
  /** Target of a symlink, when the listing shows it. */
  link: string | null;
}

export interface FtpListResponse {
  /** The absolute directory being listed. */
  path: string;
  /** Parent directory, or null at the filesystem root. */
  parent: string | null;
  entries: FtpEntry[];
}

export interface FtpMkdirRequest {
  path: string;
}

export interface FtpRenameRequest {
  from: string;
  to: string;
}

export interface FtpUploadResponse {
  path: string;
  size: number;
}
