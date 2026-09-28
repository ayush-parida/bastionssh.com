import { describe, it, expect, vi } from 'vitest';
import posix from 'node:path/posix';
import { Readable, Writable } from 'node:stream';
import type { FtpEntry } from '@smt/shared';
import { FtpError } from './errors.js';
import { FtpPathRefusedError, isWithin, jailSession } from './jail.js';
import { normalizeRemotePath } from './paths.js';
import type { FileSession } from './backend.js';

/**
 * A FileSession over a tiny tree. `links` maps a path to where it points; with
 * `sftp` the session has realpath (resolving those links), without it the
 * session is FTP-like and can only be checked lexically.
 */
function fakeSession({
  sftp = true,
  links = {} as Record<string, string>,
  existing = new Set<string>(['/', '/srv', '/srv/site', '/srv/site/docs', '/etc', '/etc/passwd']),
} = {}) {
  const resolve = (path: string): string => {
    let cur = '/';
    for (const part of path.split('/').filter(Boolean)) {
      const next = cur === '/' ? `/${part}` : `${cur}/${part}`;
      const target = links[next];
      if (target !== undefined) cur = resolve(posix.resolve(cur, target));
      else if (existing.has(next)) cur = next;
      else throw new FtpError('No such file', 404);
    }
    return cur;
  };
  const entry = (path: string, type: FtpEntry['type']): FtpEntry => ({
    name: posix.basename(path),
    path,
    type,
    size: 0,
    permissions: null,
    modifiedAt: null,
    rawModifiedAt: '',
    link: null,
    targetType: null,
  });
  const session = {
    closed: false,
    close: vi.fn(),
    survives: vi.fn(() => false),
    home: vi.fn(async (rootPath: string | null) => rootPath ?? '/srv/site'),
    ...(sftp && { realpath: vi.fn(async (p: string) => resolve(p)) }),
    list: vi.fn(async () => []),
    stat: vi.fn(async (p: string) => {
      if (links[p] !== undefined) return entry(p, 'symlink');
      if (existing.has(p)) return entry(p, 'file');
      throw new FtpError('No such file', 404);
    }),
    linkTargetSize: vi.fn(async () => 1),
    download: vi.fn(async () => {}),
    upload: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    removeEmptyDir: vi.fn(async () => {}),
    removeDirRecursive: vi.fn(async () => {}),
  } satisfies FileSession;
  return session;
}

const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
const refused = { name: 'FtpPathRefusedError', statusCode: 403 };

describe('isWithin', () => {
  it('matches the root and paths below it, not siblings sharing a prefix', () => {
    expect(isWithin('/srv/site', '/srv/site')).toBe(true);
    expect(isWithin('/srv/site', '/srv/site/a/b')).toBe(true);
    expect(isWithin('/srv/site', '/srv/site2')).toBe(false);
    expect(isWithin('/srv/site', '/srv')).toBe(false);
    expect(isWithin('/', '/anything')).toBe(true);
  });
});

describe('jailSession (lexical)', () => {
  it('uses the configured root, else the login directory', async () => {
    const inner = fakeSession({ sftp: false });
    expect(await jailSession(inner, '/srv/site/docs').home(null)).toBe('/srv/site/docs');
    expect(await jailSession(inner, '/srv/site/docs').jailRoot!()).toBe('/srv/site/docs');
    expect(await jailSession(inner, null).home('/ignored')).toBe('/srv/site');
  });

  it('refuses .. traversal once the route has normalized it', async () => {
    const inner = fakeSession({ sftp: false });
    const jail = jailSession(inner, '/srv/site');
    const path = normalizeRemotePath('/srv/site/../../etc/passwd');
    expect(path).toBe('/etc/passwd');
    await expect(jail.download(path, sink())).rejects.toMatchObject(refused);
    await expect(jail.list(normalizeRemotePath('/srv/site/docs/../..'))).rejects.toMatchObject(refused);
    await expect(jail.list('/srv/site2')).rejects.toMatchObject(refused);
    expect(inner.download).not.toHaveBeenCalled();
    expect(inner.list).not.toHaveBeenCalled();
  });

  it('checks every path parameter', async () => {
    const inner = fakeSession({ sftp: false });
    const jail = jailSession(inner, '/srv/site');
    const outside = '/etc/passwd';
    await expect(jail.stat(outside)).rejects.toMatchObject(refused);
    await expect(jail.linkTargetSize(outside)).rejects.toMatchObject(refused);
    await expect(jail.upload(Readable.from([]), outside)).rejects.toMatchObject(refused);
    await expect(jail.mkdir('/etc/new')).rejects.toMatchObject(refused);
    await expect(jail.rename('/srv/site/a', outside)).rejects.toMatchObject(refused);
    await expect(jail.rename(outside, '/srv/site/a')).rejects.toMatchObject(refused);
    await expect(jail.removeFile(outside)).rejects.toMatchObject(refused);
    await expect(jail.removeEmptyDir('/etc')).rejects.toMatchObject(refused);
    await expect(jail.removeDirRecursive('/etc')).rejects.toMatchObject(refused);
    for (const fn of ['stat', 'upload', 'mkdir', 'rename', 'removeFile', 'removeEmptyDir', 'removeDirRecursive'] as const) {
      expect(inner[fn], fn).not.toHaveBeenCalled();
    }
  });

  it('allows the root itself to be listed but never removed or moved', async () => {
    const inner = fakeSession({ sftp: false });
    const jail = jailSession(inner, '/srv/site');
    await jail.list('/srv/site');
    expect(inner.list).toHaveBeenCalledWith('/srv/site');
    await expect(jail.removeDirRecursive('/srv/site')).rejects.toMatchObject(refused);
    await expect(jail.rename('/srv/site', '/srv/site/x')).rejects.toMatchObject(refused);
    await expect(jail.rename('/srv/site/docs', '/srv/site')).rejects.toMatchObject(refused);
  });

  it('passes paths inside the root through untouched, and FTP never asks for a realpath', async () => {
    const inner = fakeSession({ sftp: false, links: { '/srv/site/out': '/etc' } });
    const jail = jailSession(inner, '/srv/site');
    // FTP cannot see where a link leads: lexical only
    await jail.list('/srv/site/out');
    await jail.rename('/srv/site/docs', '/srv/site/docs2');
    expect(inner.rename).toHaveBeenCalledWith('/srv/site/docs', '/srv/site/docs2');
    expect(jail.realpath).toBeUndefined();
  });

  it('treats its own refusals as survivable and retries a failed root lookup', async () => {
    const inner = fakeSession({ sftp: false });
    const jail = jailSession(inner, null);
    expect(jail.survives(new FtpPathRefusedError('/x'))).toBe(true);
    expect(jail.survives(new Error('socket'))).toBe(false);

    inner.home.mockRejectedValueOnce(new FtpError('dropped', 502));
    await expect(jail.list('/srv/site')).rejects.toMatchObject({ statusCode: 502 });
    await jail.list('/srv/site');
    expect(inner.home).toHaveBeenCalledTimes(2);
  });
});

describe('jailSession (SFTP symlink checks)', () => {
  const links = {
    '/srv/site/escape': '/etc',
    '/srv/site/passwd': '/etc/passwd',
    '/srv/site/inside': '/srv/site/docs',
    '/srv/site/dangling': '/nowhere',
  };

  it('refuses to follow a link that leads out of the root', async () => {
    const inner = fakeSession({ links });
    const jail = jailSession(inner, '/srv/site');
    await expect(jail.list('/srv/site/escape')).rejects.toMatchObject({
      ...refused,
      message: expect.stringMatching(/leads outside/),
    });
    await expect(jail.download('/srv/site/passwd', sink())).rejects.toMatchObject(refused);
    await expect(jail.linkTargetSize('/srv/site/passwd')).rejects.toMatchObject(refused);
    expect(inner.list).not.toHaveBeenCalled();
    expect(inner.download).not.toHaveBeenCalled();

    await jail.list('/srv/site/inside');
    expect(inner.list).toHaveBeenCalledWith('/srv/site/inside');
  });

  it('refuses entries reached through a link out of the root', async () => {
    const inner = fakeSession({ links });
    const jail = jailSession(inner, '/srv/site');
    await expect(jail.stat('/srv/site/escape/passwd')).rejects.toMatchObject(refused);
    await expect(jail.mkdir('/srv/site/escape/new')).rejects.toMatchObject(refused);
    await expect(jail.upload(Readable.from([]), '/srv/site/escape/new.txt')).rejects.toMatchObject(refused);
    await expect(jail.removeFile('/srv/site/escape/passwd')).rejects.toMatchObject(refused);
    await expect(jail.rename('/srv/site/docs', '/srv/site/escape/moved')).rejects.toMatchObject(refused);
    await expect(jail.rename('/srv/site/escape/passwd', '/srv/site/docs/p')).rejects.toMatchObject(refused);
    expect(inner.mkdir).not.toHaveBeenCalled();
    expect(inner.upload).not.toHaveBeenCalled();
    expect(inner.rename).not.toHaveBeenCalled();
  });

  it('lets the link itself be inspected, removed and renamed', async () => {
    const inner = fakeSession({ links });
    const jail = jailSession(inner, '/srv/site');
    await jail.stat('/srv/site/escape');
    await jail.removeFile('/srv/site/escape');
    await jail.rename('/srv/site/escape', '/srv/site/old-escape');
    expect(inner.removeFile).toHaveBeenCalledWith('/srv/site/escape');
    expect(inner.rename).toHaveBeenCalledWith('/srv/site/escape', '/srv/site/old-escape');
  });

  it('refuses to upload through an existing link that points out, or nowhere', async () => {
    const inner = fakeSession({ links });
    const jail = jailSession(inner, '/srv/site');
    await expect(jail.upload(Readable.from([]), '/srv/site/passwd')).rejects.toMatchObject(refused);
    await expect(jail.upload(Readable.from([]), '/srv/site/dangling')).rejects.toMatchObject({
      ...refused,
      message: expect.stringMatching(/cannot be resolved/),
    });
    expect(inner.upload).not.toHaveBeenCalled();

    await jail.upload(Readable.from([]), '/srv/site/docs/new.txt');
    expect(inner.upload).toHaveBeenCalledTimes(1);
  });

  it('compares against where the root really is when the root is itself a link', async () => {
    const inner = fakeSession({
      links: { '/srv/current': '/srv/site', '/srv/site/up': '/srv' },
      existing: new Set(['/', '/srv', '/srv/site', '/srv/site/docs']),
    });
    const jail = jailSession(inner, '/srv/current');
    await jail.list('/srv/current/docs');
    expect(inner.list).toHaveBeenCalledWith('/srv/current/docs');
    await expect(jail.list('/srv/current/up')).rejects.toMatchObject(refused);
  });
});
