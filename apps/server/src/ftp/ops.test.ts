import { describe, it, expect, vi } from 'vitest';
import { FileInfo, FileType, FTPError, type Client } from 'basic-ftp';
import {
  MAX_RESOLVED_LINKS,
  linkTargetSize,
  permissionString,
  resolveLinks,
  sortEntries,
  toEntry,
} from './ops.js';

function info(name: string, patch: Partial<FileInfo>): FileInfo {
  return Object.assign(new FileInfo(name), patch);
}

describe('toEntry', () => {
  it('maps a unix LIST row', () => {
    const entry = toEntry(
      '/var/www',
      info('index.html', {
        type: FileType.File,
        size: 1234,
        rawModifiedAt: 'Sep 18 10:22',
        permissions: { user: 6, group: 4, world: 4 },
      }),
    );
    expect(entry).toEqual({
      name: 'index.html',
      path: '/var/www/index.html',
      type: 'file',
      size: 1234,
      permissions: 'rw-r--r--',
      modifiedAt: null,
      rawModifiedAt: 'Sep 18 10:22',
      link: null,
      targetType: null,
    });
  });

  it('keeps a machine-readable MLSD date and a symlink target', () => {
    const when = new Date('2026-09-18T10:22:00Z');
    const entry = toEntry(
      '/',
      info('current', { type: FileType.SymbolicLink, modifiedAt: when, link: 'releases/3' }),
    );
    expect(entry.path).toBe('/current');
    expect(entry.type).toBe('symlink');
    expect(entry.modifiedAt).toBe(when.toISOString());
    expect(entry.link).toBe('releases/3');
    expect(entry.permissions).toBeNull();
  });

  it('renders permission triplets', () => {
    expect(permissionString({ user: 7, group: 5, world: 0 })).toBe('rwxr-x---');
    expect(permissionString(undefined)).toBeNull();
  });

  it('sorts directories first, then by name case-insensitively', () => {
    const sorted = sortEntries([
      toEntry('/', info('zeta.txt', { type: FileType.File })),
      toEntry('/', info('Alpha.txt', { type: FileType.File })),
      toEntry('/', info('logs', { type: FileType.Directory })),
      toEntry('/', info('Backup', { type: FileType.Directory })),
    ]).map((e) => e.name);
    expect(sorted).toEqual(['Backup', 'logs', 'Alpha.txt', 'zeta.txt']);
  });
});

describe('resolveLinks', () => {
  function fakeClient(dirs: string[]) {
    const cd = vi.fn(async (path: string) => {
      if (!dirs.includes(path)) throw new FTPError({ code: 550, message: '550 Not a directory' });
      return { code: 250, message: '250 OK' };
    });
    const pwd = vi.fn(async () => '/home/deploy');
    return { client: { cd, pwd } as unknown as Client, cd, pwd };
  }

  it('marks links to directories and to files, then restores the working directory', async () => {
    const { client, cd } = fakeClient(['/etc/nginx/sites-available', '/home/deploy']);
    const entries = [
      toEntry('/etc/nginx', info('sites-enabled', { type: FileType.SymbolicLink })),
      toEntry('/etc/nginx', info('default', { type: FileType.SymbolicLink })),
      toEntry('/etc/nginx', info('nginx.conf', { type: FileType.File })),
    ];
    entries[0]!.path = '/etc/nginx/sites-available';
    await resolveLinks(client, entries);
    expect(entries.map((e) => e.targetType)).toEqual(['directory', 'file', null]);
    expect(cd).toHaveBeenLastCalledWith('/home/deploy');
  });

  it('leaves a link unknown on a transient 4xx reply', async () => {
    const { client, cd } = fakeClient(['/home/deploy']);
    cd.mockImplementationOnce(async () => {
      throw new FTPError({ code: 450, message: '450 Try again' });
    });
    const entries = [toEntry('/srv', info('data', { type: FileType.SymbolicLink }))];
    await resolveLinks(client, entries);
    expect(entries[0]!.targetType).toBeNull();
    expect(cd).toHaveBeenLastCalledWith('/home/deploy');
  });

  it('rethrows a non-FTP failure and still restores the working directory', async () => {
    const { client, cd } = fakeClient(['/home/deploy']);
    cd.mockImplementationOnce(async () => {
      throw new Error('socket closed');
    });
    const entries = [
      toEntry('/srv', info('a', { type: FileType.SymbolicLink })),
      toEntry('/srv', info('b', { type: FileType.SymbolicLink })),
    ];
    await expect(resolveLinks(client, entries)).rejects.toThrow();
    expect(entries.map((e) => e.targetType)).toEqual([null, null]);
    expect(cd).toHaveBeenCalledTimes(2);
    expect(cd).toHaveBeenLastCalledWith('/home/deploy');
  });

  it('resolves at most MAX_RESOLVED_LINKS links per listing', async () => {
    const { client, cd } = fakeClient(['/home/deploy']);
    const entries = Array.from({ length: MAX_RESOLVED_LINKS + 5 }, (_, i) =>
      toEntry('/etc/alternatives', info(`l${i}`, { type: FileType.SymbolicLink })),
    );
    await resolveLinks(client, entries);
    // One probe per resolved link, plus the restore.
    expect(cd).toHaveBeenCalledTimes(MAX_RESOLVED_LINKS + 1);
    expect(entries[MAX_RESOLVED_LINKS - 1]!.targetType).toBe('file');
    expect(entries[MAX_RESOLVED_LINKS]!.targetType).toBeNull();
  });

  it('sends nothing when there are no links', async () => {
    const { client, cd, pwd } = fakeClient([]);
    await resolveLinks(client, [toEntry('/', info('a.txt', { type: FileType.File }))]);
    expect(cd).not.toHaveBeenCalled();
    expect(pwd).not.toHaveBeenCalled();
  });
});

describe('linkTargetSize', () => {
  const clientWith = (size: () => Promise<number>) => ({ size: vi.fn(size) }) as unknown as Client;

  it('returns the size of the file behind the link', async () => {
    await expect(linkTargetSize(clientWith(async () => 5), '/current')).resolves.toBe(5);
  });

  it('turns a permanent refusal (link to a directory) into a 400', async () => {
    const client = clientWith(async () => {
      throw new FTPError({ code: 550, message: '550 /current: not a regular file' });
    });
    await expect(linkTargetSize(client, '/current')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps a transient failure transient', async () => {
    const client = clientWith(async () => {
      throw new FTPError({ code: 421, message: '421 Service not available' });
    });
    await expect(linkTargetSize(client, '/current')).rejects.toMatchObject({ statusCode: 502 });
  });
});
