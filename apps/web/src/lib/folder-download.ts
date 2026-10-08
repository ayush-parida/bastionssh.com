import { api } from '@/lib/api.js';

/**
 * Folder downloads: the server builds a .zip or .tar.gz of a remote folder
 * while it streams (folder download spec). The browser reads it here so the
 * page can show bytes received and cancel; the archive is handed to the
 * browser to save once it is complete. A body cut short (the server stopped:
 * access revoked, the connection edited, a failure) rejects instead of saving
 * a broken archive.
 */

export type ArchiveFormat = 'zip' | 'tar.gz';

export const ARCHIVE_FORMATS: { value: ArchiveFormat; label: string }[] = [
  { value: 'zip', label: '.zip' },
  { value: 'tar.gz', label: '.tar.gz' },
];

const FORMAT_KEY = 'smt.folderDownloadFormat';

/** The format last chosen in this browser (zip when none, or storage is blocked). */
export function recallFormat(): ArchiveFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === 'tar.gz' ? 'tar.gz' : 'zip';
  } catch {
    return 'zip';
  }
}

export function rememberFormat(format: ArchiveFormat): void {
  try {
    localStorage.setItem(FORMAT_KEY, format);
  } catch {
    // Only a convenience
  }
}

/** `site.zip` for a folder path; `fallback` names `/`. */
export function archiveName(path: string, format: ArchiveFormat, fallback = 'folder'): string {
  const base = path.split('/').filter(Boolean).pop() ?? '';
  return `${base.replace(/[\\/]/g, '_') || fallback}.${format}`;
}

/** The UTF-8 file name from a Content-Disposition header, if it has one. */
export function filenameFromDisposition(header: string | null): string | null {
  const match = header?.match(/filename\*=UTF-8''([^;]+)/i);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Read a whole body, reporting the running total of bytes. */
export async function readWithProgress(
  body: ReadableStream<Uint8Array>,
  onProgress: (bytes: number) => void,
): Promise<{ chunks: Uint8Array[]; bytes: number }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.byteLength;
    onProgress(bytes);
  }
  return { chunks, bytes };
}

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the save before the blob goes
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * GET a folder archive from `path` (an API path) and save it. Resolves with
 * the bytes saved; rejects with an AbortError when `signal` aborts.
 */
export async function downloadArchive(
  path: string,
  fallbackName: string,
  opts: { signal: AbortSignal; onProgress?: (bytes: number) => void },
): Promise<number> {
  const res = await api.getStream(path, {
    signal: opts.signal,
    headers: { Accept: 'application/zip, application/gzip, application/json' },
  });
  if (!res.body) throw new Error('The server sent no archive');
  let chunks: Uint8Array[];
  let bytes: number;
  try {
    ({ chunks, bytes } = await readWithProgress(res.body, opts.onProgress ?? (() => {})));
  } catch (err) {
    if (opts.signal.aborted) throw err;
    throw new Error('The download was cut off before the archive was complete. Try again, or download smaller folders.');
  }
  const filename = filenameFromDisposition(res.headers.get('Content-Disposition')) ?? fallbackName;
  save(new Blob(chunks as BlobPart[], { type: res.headers.get('Content-Type') ?? 'application/octet-stream' }), filename);
  return bytes;
}
