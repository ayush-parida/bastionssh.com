import posix from 'node:path/posix';
import { isIP } from 'node:net';
import { FtpError } from './errors.js';

/**
 * Normalize a client-supplied remote path. Only absolute POSIX paths are
 * accepted — `..` segments are collapsed by `normalize`, and a traversal that
 * would escape the root simply resolves to `/`.
 */
export function normalizeRemotePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new FtpError('Path is required', 400);
  }
  if (input.includes('\0')) throw new FtpError('Path contains a null byte', 400);
  if (/[\r\n]/.test(input)) throw new FtpError('Path must not contain line breaks', 400);
  if (!input.startsWith('/')) throw new FtpError('Path must be absolute', 400);
  const normalized = posix.normalize(input);
  // Strip a trailing slash except on the root itself
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : '/';
}

export function parentOf(path: string): string | null {
  if (path === '/') return null;
  return posix.dirname(path);
}

export function baseName(path: string): string {
  return posix.basename(path);
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * A bare hostname or IP — not a URL, so a scheme, path or embedded credential
 * is refused rather than silently stripped. The cloud metadata addresses are
 * refused for the same reason the storage endpoint refuses them; a hostname
 * that resolves to a private address still passes, and it has to: an FTP box
 * on the LAN is the primary use case.
 */
export function assertSafeHost(raw: string): string {
  if (typeof raw !== 'string') throw new FtpError('Host is required', 400);
  const host = raw.trim().toLowerCase();
  if (host.length === 0) throw new FtpError('Host is required', 400);
  if (host.length > 253) throw new FtpError('Host is too long', 400);
  if (/[/@\s]/.test(host) || host.includes('://')) {
    throw new FtpError('Host must be a hostname or IP address, not a URL', 400);
  }
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    throw new FtpError('That address is not allowed', 400);
  }
  if (isIP(host) === 0 && !HOSTNAME.test(host)) {
    throw new FtpError('Host is not a valid hostname or IP address', 400);
  }
  return host;
}
