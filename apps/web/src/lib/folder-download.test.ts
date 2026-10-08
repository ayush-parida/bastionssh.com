import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncompleteDownloadError, archiveFileName, downloadFolderArchive, type SaveTarget } from './folder-download.js';

function target() {
  const chunks: Uint8Array[] = [];
  const state = { closed: false, aborted: false };
  const t: SaveTarget = {
    streaming: true,
    write: async (c) => {
      chunks.push(c);
    },
    close: async () => {
      state.closed = true;
    },
    abort: async () => {
      state.aborted = true;
    },
  };
  return { t, chunks, state };
}

/** A response body that sends `parts`, then ends — or breaks, like a connection the server cut. */
function body(parts: string[], breakAtEnd = false) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(new TextEncoder().encode(p));
      if (breakAtEnd) controller.error(new TypeError('network error'));
      else controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('folder downloads', () => {
  it('names the archive after the folder', () => {
    expect(archiveFileName('www', 'zip')).toBe('www.zip');
    expect(archiveFileName('', 'tar.gz')).toBe('root.tar.gz');
    expect(archiveFileName('a/b\\c', 'zip')).toBe('a_b_c.zip');
  });

  it('streams the body into the target, reporting progress, and closes it', async () => {
    const fetchMock = vi.fn(async () => new Response(body(['abc', 'defg'])));
    vi.stubGlobal('fetch', fetchMock);
    const { t, chunks, state } = target();
    const progress: number[] = [];
    const res = await downloadFolderArchive('/sftp/s1/folder?path=%2Fx&format=zip', t, {
      signal: new AbortController().signal,
      onProgress: (n) => progress.push(n),
    });
    expect(res).toEqual({ bytes: 7 });
    expect(progress).toEqual([3, 7]);
    expect(Buffer.concat(chunks).toString()).toBe('abcdefg');
    expect(state).toEqual({ closed: true, aborted: false });
    expect(fetchMock).toHaveBeenCalledWith('/api/sftp/s1/folder?path=%2Fx&format=zip', expect.objectContaining({ credentials: 'include' }));
  });

  it('rejects with the server’s message before anything arrives, and discards the target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Not a folder' }), { status: 400 })));
    const { t, state } = target();
    await expect(downloadFolderArchive('/x', t, { signal: new AbortController().signal })).rejects.toThrow('Not a folder');
    expect(state.aborted).toBe(true);
  });

  it('calls a connection broken part-way an incomplete download, and saves nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body(['partial'], true))));
    const { t, state } = target();
    await expect(downloadFolderArchive('/x', t, { signal: new AbortController().signal })).rejects.toBeInstanceOf(
      IncompleteDownloadError,
    );
    expect(state).toEqual({ closed: false, aborted: true });
  });
});
