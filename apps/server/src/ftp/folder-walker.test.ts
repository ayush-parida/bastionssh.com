import { describe, expect, it, vi } from 'vitest';
import type { FileSession } from './backend.js';
import { childPath, connectionWalker, permissionBits } from './folder-walker.js';

describe('folder walker helpers', () => {
  it('turns a listed name into a child path only when it is one plain segment', () => {
    expect(childPath('/srv', 'index.html')).toBe('/srv/index.html');
    expect(childPath('/', 'etc')).toBe('/etc');
    expect(childPath('/srv', 'with space')).toBe('/srv/with space');
    for (const bad of ['', '.', '..', 'a/b', '../etc', 'a\r\nDELE x', 'nul\0']) {
      expect(childPath('/srv', bad)).toBeNull();
    }
  });

  it('reads permission strings back into bits', () => {
    expect(permissionBits('rwxr-xr-x')).toBe(0o755);
    expect(permissionBits('rw-r-----')).toBe(0o640);
    expect(permissionBits(null)).toBeUndefined();
    expect(permissionBits('drwxr-xr-x')).toBeUndefined();
  });
});

describe('connectionWalker', () => {
  const session = (over: Partial<FileSession> = {}): FileSession =>
    ({
      closed: false,
      close: vi.fn(),
      survives: () => false,
      list: vi.fn(async () => []),
      ...over,
    }) as unknown as FileSession;

  it('logs in again after a session the backend reports broken, and not once closed', async () => {
    const first = session({ list: vi.fn(async () => Promise.reject(new Error('socket hang up'))) });
    const second = session();
    const reconnect = vi.fn(async () => second);
    const walker = connectionWalker({ session: first, reconnect });
    await expect(walker.list('/srv')).rejects.toThrow('socket hang up');
    expect(first.close).toHaveBeenCalled();
    await expect(walker.list('/srv')).resolves.toEqual([]);
    expect(reconnect).toHaveBeenCalledTimes(1);

    await walker.close();
    expect(second.close).toHaveBeenCalled();
    await expect(walker.list('/srv')).rejects.toThrow(/ended/);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('refuses a locator built from an unusable name', async () => {
    const walker = connectionWalker({ session: session(), reconnect: vi.fn() });
    await expect(walker.list('')).rejects.toThrow(/not a plain file name/);
    await expect(walker.open({ name: 'a/b', ref: '', type: 'file', size: 1 }, new AbortController().signal)).rejects.toThrow(
      /not a plain file name/,
    );
  });
});
