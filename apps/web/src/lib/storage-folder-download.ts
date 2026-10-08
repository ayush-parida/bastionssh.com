import type { StorageFolderEstimate } from '@smt/shared';
import { ApiError, api } from '@/lib/api.js';
import { formatBytes } from '@/lib/utils.js';

/**
 * Object Storage → Download folder, in the browser. The server builds the
 * archive while the objects stream down, so its size is only known at the
 * end. How the bytes reach the disk depends on what the browser can do:
 *
 * - `picker`: the File System Access API (Chromium) — the user picks where
 *   to save, the archive streams straight into that file, with progress and
 *   cancel here, whatever its size.
 * - `memory`: fetched into memory with progress and cancel, then saved —
 *   only when the estimate says the folder is small.
 * - `browser`: a plain navigation to the archive URL; the browser's own
 *   downloads list shows progress and can cancel it.
 */

export type ArchiveFormat = 'zip' | 'tar.gz';
export type FolderDownloadMode = 'picker' | 'memory' | 'browser';

/** Where the app points for help with folder downloads (checked by the docs tests). */
export const STORAGE_FOLDER_DOCS = '/docs/files/object-storage#download-a-folder';

/** Above this (estimated) size an archive is not held in memory. */
export const MEMORY_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/** The parts of the File System Access API used here (not in TypeScript's DOM types yet). */
interface WritableTarget {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface SaveFilePicker {
  showSaveFilePicker(options: { suggestedName: string }): Promise<{ createWritable(): Promise<WritableTarget> }>;
}

function picker(): SaveFilePicker | null {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window ? (window as unknown as SaveFilePicker) : null;
}

export function chooseMode(estimate: StorageFolderEstimate | undefined, canPick: boolean): FolderDownloadMode {
  if (canPick) return 'picker';
  if (estimate?.complete && estimate.bytes <= MEMORY_DOWNLOAD_BYTES) return 'memory';
  return 'browser';
}

export function browserCanPick(): boolean {
  return picker() !== null;
}

export function folderArchivePath(base: string, prefix: string, format: ArchiveFormat): string {
  return `${base}/folder?prefix=${encodeURIComponent(prefix)}&format=${encodeURIComponent(format)}`;
}

export function archiveName(bucket: string, prefix: string, format: ArchiveFormat): string {
  const name = prefix.replace(/\/+$/, '').split('/').pop() || bucket;
  return `${name.replace(/[/\\]/g, '_')}.${format}`;
}

/** "12 files, 3.4 MB" — or "at least …" when the count stopped early. */
export function describeEstimate(e: StorageFolderEstimate): string {
  const files = `${e.files.toLocaleString()} ${e.files === 1 ? 'file' : 'files'}`;
  const text = `${files}, ${formatBytes(e.bytes, 1)}`;
  return e.complete ? text : `at least ${text}`;
}

/** Why the archive will stop early, or null when the estimate fits the server's limits. */
export function limitWarning(e: StorageFolderEstimate): string | null {
  const over: string[] = [];
  if (e.files > e.maxFiles) over.push(`${e.maxFiles.toLocaleString()} files`);
  if (e.bytes > e.maxBytes) over.push(formatBytes(e.maxBytes, 1));
  if (over.length === 0) return null;
  return `This is more than a folder download may hold (${over.join(' or ')}). The archive will stop there and end with _TRUNCATED.txt; download the subfolders separately to get the rest.`;
}

async function failure(res: Response): Promise<never> {
  const text = await res.text().catch(() => '');
  let message = text || res.statusText;
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    message = body.error ?? body.message ?? message;
  } catch {
    // Not JSON — the raw body is the best message there is
  }
  throw new ApiError(message, res.status);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Download the archive at `path` as `filename`. Resolves `false` when the
 * user backed out of the save dialog, `true` once the file is saved (or, in
 * `browser` mode, handed to the browser). A server error before the archive
 * starts rejects with its message; the archive being cut short midway
 * rejects too, and the partial file is discarded.
 */
export async function downloadArchive(
  path: string,
  filename: string,
  mode: FolderDownloadMode,
  opts: { signal: AbortSignal; onProgress: (bytes: number) => void },
): Promise<boolean> {
  if (mode === 'browser') {
    const a = document.createElement('a');
    a.href = api.url(path);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  // The save dialog first: it must open while the click still counts as a user gesture
  let target: WritableTarget | null = null;
  if (mode === 'picker') {
    try {
      const handle = await picker()!.showSaveFilePicker({ suggestedName: filename });
      target = await handle.createWritable();
    } catch (err) {
      if (isAbortError(err)) return false;
      throw err;
    }
  }

  const chunks: Uint8Array[] = [];
  try {
    const res = await fetch(api.url(path), { credentials: 'include', signal: opts.signal });
    if (!res.ok) await failure(res);
    if (!res.body) throw new Error('The browser gave no response body to read');
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (target) await target.write(value);
      else chunks.push(value);
      opts.onProgress(received);
    }
  } catch (err) {
    await target?.abort().catch(() => {});
    if (isAbortError(err) || opts.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
    // A body cut short: the server stopped (an error, or access was revoked) after the archive began
    if (err instanceof TypeError) throw new Error('The download was cut short before the archive was complete. Try again.');
    throw err;
  }

  if (target) {
    await target.close();
    return true;
  }
  const url = URL.createObjectURL(new Blob(chunks as BlobPart[]));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
