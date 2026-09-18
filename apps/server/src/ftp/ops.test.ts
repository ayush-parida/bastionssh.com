import { describe, it, expect } from 'vitest';
import { FileInfo, FileType } from 'basic-ftp';
import { permissionString, sortEntries, toEntry } from './ops.js';

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
