import { describe, it, expect } from 'vitest';
import type { SFTPWrapper } from 'ssh2';
import { list, normalizeRemotePath, parentOf, removeRecursive, SftpError } from './sftp.js';

describe('normalizeRemotePath', () => {
  it('keeps a plain absolute path', () => {
    expect(normalizeRemotePath('/var/www/html')).toBe('/var/www/html');
  });

  it('collapses redundant separators and dot segments', () => {
    expect(normalizeRemotePath('/var//www/./html')).toBe('/var/www/html');
  });

  it('strips a trailing slash but preserves the root', () => {
    expect(normalizeRemotePath('/var/www/')).toBe('/var/www');
    expect(normalizeRemotePath('/')).toBe('/');
  });

  it('resolves .. within the path', () => {
    expect(normalizeRemotePath('/var/www/../log')).toBe('/var/log');
  });

  it('clamps traversal at the root rather than escaping it', () => {
    expect(normalizeRemotePath('/../../../etc/passwd')).toBe('/etc/passwd');
    expect(normalizeRemotePath('/..')).toBe('/');
  });

  it('rejects relative paths', () => {
    expect(() => normalizeRemotePath('etc/passwd')).toThrow(SftpError);
    expect(() => normalizeRemotePath('../etc')).toThrow(SftpError);
  });

  it('rejects empty input and null bytes', () => {
    expect(() => normalizeRemotePath('')).toThrow(SftpError);
    expect(() => normalizeRemotePath('/etc/passwd\0.png')).toThrow(SftpError);
  });

  it('reports a 400 for bad input', () => {
    expect.assertions(1);
    try {
      normalizeRemotePath('relative');
    } catch (err) {
      expect((err as SftpError).statusCode).toBe(400);
    }
  });
});

describe('parentOf', () => {
  it('returns null at the root', () => {
    expect(parentOf('/')).toBeNull();
  });

  it('returns the containing directory', () => {
    expect(parentOf('/var/www/html')).toBe('/var/www');
    expect(parentOf('/etc')).toBe('/');
  });
});

// A tiny in-memory filesystem behind the handful of SFTP calls these helpers
// use. `links` maps a symlink path to its (absolute) target.
function fakeSftp(dirs: string[], files: string[], links: Record<string, string>) {
  const DIR = 0o040755;
  const FILE = 0o100644;
  const LINK = 0o120777;
  const fs = new Map<string, number>([
    ...dirs.map((d) => [d, DIR] as const),
    ...files.map((f) => [f, FILE] as const),
    ...Object.keys(links).map((l) => [l, LINK] as const),
  ]);
  const removed: string[] = [];
  const noent = () => Object.assign(new Error('No such file'), { code: 2 });
  const stats = (mode: number) => ({
    mode,
    isDirectory: () => (mode & 0o170000) === 0o040000,
  });
  const resolve = (p: string): string => {
    for (const [link, target] of Object.entries(links)) {
      if (p === link) return fs.has(link) ? resolve(target) : p;
      if (p.startsWith(`${link}/`)) return resolve(target + p.slice(link.length));
    }
    return p;
  };
  const sftp = {
    lstat: (p: string, cb: (err: unknown, s?: unknown) => void) =>
      fs.has(p) ? cb(undefined, stats(fs.get(p)!)) : cb(noent()),
    stat: (p: string, cb: (err: unknown, s?: unknown) => void) => {
      const real = resolve(p);
      return fs.has(real) && fs.get(real) !== LINK
        ? cb(undefined, stats(fs.get(real)!))
        : cb(noent());
    },
    readdir: (p: string, cb: (err: unknown, e?: unknown) => void) => {
      const dir = resolve(p);
      if (fs.get(dir) !== DIR) return cb(noent());
      const entries = [...fs.keys()]
        .filter((k) => k !== dir && parentOf(k) === dir)
        .map((k) => ({ filename: k.slice(dir.length + 1), attrs: { mode: fs.get(k) } }));
      cb(undefined, entries);
    },
    unlink: (p: string, cb: (err?: unknown) => void) => {
      // Links along the way are followed; the last component is not.
      const dir = resolve(parentOf(p)!);
      const real = `${dir === '/' ? '' : dir}/${p.slice(p.lastIndexOf('/') + 1)}`;
      if (!fs.has(real)) return cb(noent());
      if (fs.get(real) === DIR) return cb(new Error('EISDIR'));
      removed.push(real);
      fs.delete(real);
      cb();
    },
    rmdir: (p: string, cb: (err?: unknown) => void) => {
      if (fs.get(p) !== DIR) return cb(new Error('ENOTDIR'));
      removed.push(p);
      fs.delete(p);
      cb();
    },
  };
  return { sftp: sftp as unknown as SFTPWrapper, fs, removed };
}

describe('removeRecursive', () => {
  it('unlinks a symlink to a directory without touching the target', async () => {
    const { sftp, fs, removed } = fakeSftp(
      ['/var', '/var/www', '/var/www/releases', '/var/www/releases/42'],
      ['/var/www/releases/42/index.html'],
      { '/var/www/current': '/var/www/releases/42' },
    );
    await removeRecursive(sftp, '/var/www/current');
    expect(removed).toEqual(['/var/www/current']);
    expect(fs.has('/var/www/releases/42/index.html')).toBe(true);
  });

  it('unlinks nested links but still clears real contents', async () => {
    const { sftp, fs } = fakeSftp(
      ['/srv', '/srv/app', '/srv/app/sub', '/srv/keep'],
      ['/srv/app/a.txt', '/srv/app/sub/b.txt', '/srv/keep/c.txt'],
      { '/srv/app/shared': '/srv/keep' },
    );
    await removeRecursive(sftp, '/srv/app');
    expect([...fs.keys()].filter((k) => k.startsWith('/srv/app'))).toEqual([]);
    expect(fs.has('/srv/keep/c.txt')).toBe(true);
  });
});

describe('list', () => {
  it('reports what each symlink points at, and null for a dangling one', async () => {
    const { sftp } = fakeSftp(['/etc', '/etc/nginx', '/data'], ['/etc/nginx/site.conf'], {
      '/etc/default': '/etc/nginx/site.conf',
      '/etc/data': '/data',
      '/etc/gone': '/nowhere',
    });
    const entries = await list(sftp, '/etc');
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.nginx!.type).toBe('directory');
    expect(byName.nginx!.targetType).toBeNull();
    expect(byName.default!.type).toBe('symlink');
    expect(byName.default!.targetType).toBe('file');
    expect(byName.data!.targetType).toBe('directory');
    expect(byName.gone!.targetType).toBeNull();
  });
});
