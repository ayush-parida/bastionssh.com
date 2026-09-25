import { FileInfo, FileType, FTPError, type Client } from 'basic-ftp';
import type { Readable, Writable } from 'node:stream';
import type { FtpEntry, FtpEntryType, FtpTestResult } from '@smt/shared';
import { openClient, type FtpTarget } from './client.js';
import { FtpError, toFtpError } from './errors.js';
import { baseName, joinPath, normalizeRemotePath, parentOf } from './paths.js';

/** Every basic-ftp call goes through here so callers only ever see an FtpError. */
async function run<T>(fallback: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toFtpError(err, fallback);
  }
}

// ── Listing ──────────────────────────────────────────────────────────────────

function entryType(type: FileType): FtpEntryType {
  switch (type) {
    case FileType.File:
      return 'file';
    case FileType.Directory:
      return 'directory';
    case FileType.SymbolicLink:
      return 'symlink';
    default:
      return 'other';
  }
}

/** Render basic-ftp's three permission triplets as `rwxr-xr-x`. */
export function permissionString(perm: FileInfo['permissions']): string | null {
  if (!perm) return null;
  const { Read, Write, Execute } = FileInfo.UnixPermission;
  const triplet = (bits: number) =>
    `${bits & Read ? 'r' : '-'}${bits & Write ? 'w' : '-'}${bits & Execute ? 'x' : '-'}`;
  return `${triplet(perm.user)}${triplet(perm.group)}${triplet(perm.world)}`;
}

/** Shape one listing row into what the browser renders. Pure. */
export function toEntry(dir: string, info: FileInfo): FtpEntry {
  return {
    name: info.name,
    path: joinPath(dir, info.name),
    type: entryType(info.type),
    size: info.size ?? 0,
    permissions: permissionString(info.permissions),
    modifiedAt: info.modifiedAt?.toISOString() ?? null,
    rawModifiedAt: info.rawModifiedAt ?? '',
    link: info.link ?? null,
    targetType: null,
  };
}

/** Directories first, then case-insensitive by name. */
export function sortEntries(entries: FtpEntry[]): FtpEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'directory' ? 0 : 1;
    const bDir = b.type === 'directory' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function listRaw(client: Client, dir: string): Promise<FtpEntry[]> {
  return run('Could not list directory', async () => {
    const infos = await client.list(dir);
    return sortEntries(
      infos.filter((f) => f.name !== '.' && f.name !== '..').map((f) => toEntry(dir, f)),
    );
  });
}

/**
 * Each probe is a serial round trip on the user's one connection, so a folder
 * full of links (/etc/alternatives) would stall the listing. Links past this
 * many stay unresolved (targetType null).
 */
export const MAX_RESOLVED_LINKS = 50;

/**
 * FTP has no way to ask what a link points at, and listing a link to a file
 * succeeds on most servers (LIST <file> prints that one file). CWD is the one
 * probe every server answers the same way: it only succeeds on a directory.
 * The working directory is put back afterwards, so `home` stays correct.
 */
export async function resolveLinks(client: Client, entries: FtpEntry[]): Promise<void> {
  const links = entries.filter((e) => e.type === 'symlink').slice(0, MAX_RESOLVED_LINKS);
  if (links.length === 0) return;
  await run('Could not resolve symlinks', async () => {
    const cwd = await client.pwd();
    try {
      for (const link of links) {
        try {
          await client.cd(link.path);
          link.targetType = 'directory';
        } catch (err) {
          // Anything that is not an FTP reply, such as a dropped connection,
          // is a real failure.
          if (!(err instanceof FTPError)) throw err;
          // A 5xx reply means "not a directory" (or dangling). A 4xx is
          // transient and says nothing about the target, so leave it unknown.
          if (err.code >= 500) link.targetType = 'file';
        }
      }
    } finally {
      await client.cd(cwd);
    }
  });
}

export async function list(client: Client, dir: string): Promise<FtpEntry[]> {
  const entries = await listRaw(client, dir);
  await resolveLinks(client, entries);
  return entries;
}

/**
 * The directory the browser opens at: the connection's configured root, else
 * whatever the server put us in at login. Every other path is absolute, so the
 * working directory never moves and `pwd` keeps answering the login directory.
 */
export function home(client: Client, rootPath: string | null): Promise<string> {
  return run('Could not resolve the login directory', async () => {
    if (rootPath) return normalizeRemotePath(rootPath);
    const cwd = await client.pwd();
    return normalizeRemotePath(cwd.startsWith('/') ? cwd : `/${cwd}`);
  });
}

/**
 * FTP has no stat. Listing the parent and picking the entry by name works on
 * every server, unlike SIZE and MDTM which are optional extensions.
 */
export async function stat(client: Client, path: string): Promise<FtpEntry> {
  const parent = parentOf(path);
  if (parent === null) {
    return {
      name: '/',
      path: '/',
      type: 'directory',
      size: 0,
      permissions: null,
      modifiedAt: null,
      rawModifiedAt: '',
      link: null,
      targetType: null,
    };
  }
  const name = baseName(path);
  const entry = (await listRaw(client, parent)).find((e) => e.name === name);
  if (!entry) throw new FtpError(`No such file or directory: ${path}`, 404);
  return entry;
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function mkdir(client: Client, path: string): Promise<void> {
  return run('Could not create directory', async () => {
    await client.send(`MKD ${path}`);
  });
}

export function rename(client: Client, from: string, to: string): Promise<void> {
  return run('Could not rename', async () => {
    await client.rename(from, to);
  });
}

export function removeFile(client: Client, path: string): Promise<void> {
  return run('Could not delete file', async () => {
    await client.remove(path);
  });
}

export function removeEmptyDir(client: Client, path: string): Promise<void> {
  return run('Could not delete directory', async () => {
    await client.removeEmptyDir(path);
  });
}

/** Depth-first recursive delete. Used only when the caller opts in. */
export function removeDirRecursive(client: Client, path: string): Promise<void> {
  return run('Could not delete directory', async () => {
    await client.removeDir(path);
  });
}

// ── Transfers ────────────────────────────────────────────────────────────────

/** Resolves once the whole file has been written to `destination`. */
/**
 * Size of the file a symlink points at. The listing row only describes the link
 * itself, so ask the server with SIZE, which follows links and refuses anything
 * that is not a regular file — a link to a directory lands here as a 400.
 */
export async function linkTargetSize(client: Client, path: string): Promise<number> {
  try {
    return await client.size(path);
  } catch (err) {
    if (err instanceof FTPError && err.code >= 500) {
      throw new FtpError('Link does not point to a downloadable file', 400);
    }
    throw toFtpError(err, 'Could not download file');
  }
}

export function download(client: Client, path: string, destination: Writable): Promise<void> {
  return run('Could not download file', async () => {
    await client.downloadTo(destination, path);
  });
}

/** Resolves once the server has acknowledged the whole upload. */
export function upload(client: Client, source: Readable, path: string): Promise<void> {
  return run('Could not upload file', async () => {
    await client.uploadFrom(source, path);
  });
}

// ── Connection test ──────────────────────────────────────────────────────────

/** A login plus one listing proves host, TLS mode and credentials all line up. */
export async function testConnection(target: FtpTarget, password: string): Promise<FtpTestResult> {
  let client: Client | undefined;
  try {
    client = await openClient(target, password);
    const workingDirectory = await home(client, null);
    const entries = await list(client, workingDirectory);
    return { ok: true, workingDirectory, entryCount: entries.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client?.close();
  }
}
