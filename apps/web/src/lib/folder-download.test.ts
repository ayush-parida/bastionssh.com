import { describe, expect, it } from 'vitest';
import { archiveName, filenameFromDisposition, readWithProgress } from './folder-download.js';

describe('folder downloads', () => {
  it('names the archive after the folder', () => {
    expect(archiveName('/var/www/site', 'zip')).toBe('site.zip');
    expect(archiveName('/var/www/site/', 'tar.gz')).toBe('site.tar.gz');
    expect(archiveName('/', 'zip', 'shared host')).toBe('shared host.zip');
    expect(archiveName('/', 'zip')).toBe('folder.zip');
  });

  it("prefers the server's UTF-8 file name", () => {
    expect(
      filenameFromDisposition(`attachment; filename="donn_es.zip"; filename*=UTF-8''donn%C3%A9es.zip`),
    ).toBe('données.zip');
    expect(filenameFromDisposition('attachment; filename="a.zip"')).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A`)).toBeNull();
  });

  it('reports the running total while reading the body', async () => {
    const seen: number[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(3));
        c.enqueue(new Uint8Array(5));
        c.close();
      },
    });
    const { chunks, bytes } = await readWithProgress(body, (n) => seen.push(n));
    expect(seen).toEqual([3, 8]);
    expect(bytes).toBe(8);
    expect(chunks).toHaveLength(2);
  });

  it('rejects a body that breaks off', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(3));
        c.error(new Error('network error'));
      },
    });
    await expect(readWithProgress(body, () => {})).rejects.toThrow('network error');
  });
});
