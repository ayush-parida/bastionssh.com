import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageFolderEstimate } from '@smt/shared';
import { ApiError } from './api.js';
import { findDoc } from './docs.js';
import {
  MEMORY_DOWNLOAD_BYTES,
  STORAGE_FOLDER_DOCS,
  archiveName,
  chooseMode,
  describeEstimate,
  downloadArchive,
  folderArchivePath,
  limitWarning,
} from './storage-folder-download.js';

const estimate = (over: Partial<StorageFolderEstimate> = {}): StorageFolderEstimate => ({
  bucket: 'b',
  prefix: 'p/',
  files: 12,
  folders: 2,
  bytes: 3 * 1024 * 1024,
  complete: true,
  maxBytes: 10 * 1024 ** 3,
  maxFiles: 100_000,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('folder download helpers', () => {
  it('saves through the file picker when there is one, in memory only when the folder is known to be small', () => {
    expect(chooseMode(undefined, true)).toBe('picker');
    expect(chooseMode(estimate({ bytes: 10 * 1024 ** 3 }), true)).toBe('picker');
    expect(chooseMode(estimate(), false)).toBe('memory');
    expect(chooseMode(estimate({ bytes: MEMORY_DOWNLOAD_BYTES + 1 }), false)).toBe('browser');
    expect(chooseMode(estimate({ complete: false, bytes: 10 }), false)).toBe('browser');
    expect(chooseMode(undefined, false)).toBe('browser');
  });

  it('names the archive after the folder, or the bucket at its root', () => {
    expect(archiveName('photos', 'trip/2024/', 'zip')).toBe('2024.zip');
    expect(archiveName('photos', '', 'tar.gz')).toBe('photos.tar.gz');
    expect(archiveName('photos', 'données/', 'zip')).toBe('données.zip');
    expect(folderArchivePath('/storage/connections/c/buckets/b', 'a b/', 'tar.gz')).toBe(
      '/storage/connections/c/buckets/b/folder?prefix=a%20b%2F&format=tar.gz',
    );
  });

  it('says "at least" for a count that stopped early, and warns past the limits', () => {
    // Counts are shown in the browser's own number format
    const n = (v: number) => v.toLocaleString();
    expect(describeEstimate(estimate({ files: 1, bytes: 2048 }))).toBe('1 file, 2 KB');
    expect(describeEstimate(estimate({ files: 10_000, complete: false }))).toBe(`at least ${n(10_000)} files, 3 MB`);
    expect(limitWarning(estimate())).toBeNull();
    const files = limitWarning(estimate({ files: 200_000 }))!;
    expect(files).toContain(`(${n(100_000)} files and folders)`);
    expect(files).toContain('_TRUNCATED.txt');
    expect(limitWarning(estimate({ files: 200_000, bytes: 11 * 1024 ** 3 }))).toContain(`${n(100_000)} files and folders or 10 GB`);
    // Under the limit in files alone, over it once the folders are counted too
    expect(limitWarning(estimate({ files: 90_000, folders: 20_000 }))).toContain('files and folders');
    expect(limitWarning(estimate({ files: 90_000, folders: 9_000 }))).toBeNull();
  });

  it('points at a docs heading that exists', () => {
    const [path, hash] = STORAGE_FOLDER_DOCS.split('#') as [string, string];
    const doc = findDoc(path.split('/')[2]!, path.split('/')[3]!);
    expect(doc).toBeTruthy();
    expect(doc!.headings.map((h) => h.id)).toContain(hash);
  });
});

describe('downloadArchive', () => {
  /** A response whose body arrives in `parts`, then fails with `failWith` if given. */
  function response(parts: string[], failWith?: Error): Response {
    const enc = new TextEncoder();
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < parts.length) controller.enqueue(enc.encode(parts[i++]!));
        else if (failWith) controller.error(failWith);
        else controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  function stubPicker() {
    const written: string[] = [];
    const file = {
      closed: false,
      aborted: false,
      write: vi.fn(async (chunk: Uint8Array) => {
        written.push(new TextDecoder().decode(chunk));
      }),
      close: vi.fn(async () => {
        file.closed = true;
      }),
      abort: vi.fn(async () => {
        file.aborted = true;
      }),
    };
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => file }));
    vi.stubGlobal('window', { showSaveFilePicker });
    return { file, written, showSaveFilePicker };
  }

  it('streams into the picked file, reporting the bytes received', async () => {
    const { file, written, showSaveFilePicker } = stubPicker();
    vi.stubGlobal('fetch', vi.fn(async () => response(['abc', 'defg'])));
    const progress: number[] = [];
    const saved = await downloadArchive('/x/folder?prefix=a%2F&format=zip', 'a.zip', 'picker', {
      signal: new AbortController().signal,
      onProgress: (n) => progress.push(n),
    });
    expect(saved).toBe(true);
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.zip' });
    expect(written.join('')).toBe('abcdefg');
    expect(progress).toEqual([3, 7]);
    expect(file.closed).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/x/folder?prefix=a%2F&format=zip', expect.objectContaining({ credentials: 'include' }));
  });

  it('does nothing when the save dialog is dismissed', async () => {
    vi.stubGlobal('window', {
      showSaveFilePicker: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
    });
    vi.stubGlobal('fetch', vi.fn());
    expect(await downloadArchive('/x', 'a.zip', 'picker', { signal: new AbortController().signal, onProgress: () => {} })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the server's error, and discards the partial file when the archive is cut short", async () => {
    const { file } = stubPicker();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Nothing is stored under "x/"' }), { status: 404 })));
    const opts = { signal: new AbortController().signal, onProgress: () => {} };
    const err = await downloadArchive('/x', 'a.zip', 'picker', opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Nothing is stored under "x/"');
    expect((err as ApiError).status).toBe(404);
    expect(file.aborted).toBe(true);

    stubPicker();
    vi.stubGlobal('fetch', vi.fn(async () => response(['abc'], new TypeError('network error'))));
    await expect(downloadArchive('/x', 'a.zip', 'picker', opts)).rejects.toThrow(/cut short/);
  });

  it('cancels: the fetch is aborted and the partial file discarded', async () => {
    const { file } = stubPicker();
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
            init.signal!.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
          },
        });
        return new Response(body);
      }),
    );
    const pending = downloadArchive('/x', 'a.zip', 'picker', {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(file.aborted).toBe(true);
    expect(file.closed).toBe(false);
  });
});
