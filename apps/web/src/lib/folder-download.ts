import { api } from './api.js';

/**
 * Downloading a folder as one archive (zip or tar.gz), built by the server
 * while it streams. The size is not known up front, so the page counts bytes
 * as they arrive. Where the browser can write to a file the user picked
 * (Chromium's File System Access API) the archive streams straight to disk;
 * elsewhere it is collected in memory and saved at the end — fine for most
 * folders, and the dialog offers the browser's own download for huge ones.
 */

export type FolderArchiveFormat = 'zip' | 'tar.gz';

export const FOLDER_ARCHIVE_FORMATS: { value: FolderArchiveFormat; label: string; hint: string }[] = [
  { value: 'zip', label: '.zip', hint: 'Opens with a double-click on macOS and Windows. Symbolic links are left out.' },
  { value: 'tar.gz', label: '.tar.gz', hint: 'Keeps symbolic links and permissions.' },
];

/** Where the archive's bytes go. */
export interface SaveTarget {
  /** True when bytes go straight to a file on disk (nothing held in memory). */
  readonly streaming: boolean;
  write(chunk: Uint8Array): Promise<void>;
  /** All bytes are in: finish the file (or hand the collected archive to the browser to save). */
  close(): Promise<void>;
  /** Give up: discard what was written. */
  abort(): Promise<void>;
}

interface WritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
type SavePicker = (opts: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableFile> }>;

/** The archive's file name: the folder's, `/` for the root becoming `root`. */
export function archiveFileName(folderName: string, format: FolderArchiveFormat): string {
  return `${folderName.replace(/[/\\]/g, '_') || 'root'}.${format}`;
}

/** Whether this browser can stream a download into a file the user picks. */
export function canStreamToDisk(): boolean {
  return typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

/**
 * Ask where to save (must run inside the click that started the download).
 * Null when the user closed the picker. Without the picker, a target that
 * collects the archive in memory.
 */
export async function chooseSaveTarget(filename: string): Promise<SaveTarget | null> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    let file: WritableFile;
    try {
      file = await (await picker({ suggestedName: filename })).createWritable();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      throw err;
    }
    return {
      streaming: true,
      write: (chunk) => file.write(chunk),
      close: () => file.close(),
      abort: () => file.abort().catch(() => {}),
    };
  }
  return memoryTarget(filename);
}

export function memoryTarget(filename: string): SaveTarget {
  let parts: BlobPart[] = [];
  return {
    streaming: false,
    async write(chunk) {
      parts.push(chunk as BlobPart);
    },
    async close() {
      const url = URL.createObjectURL(new Blob(parts));
      parts = [];
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a moment to start reading the blob before it goes
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async abort() {
      parts = [];
    },
  };
}

/** The connection broke after the archive had started: whatever arrived is not a usable archive. */
export class IncompleteDownloadError extends Error {
  constructor() {
    super('The download stopped before the archive was complete. Nothing was saved; try again.');
    this.name = 'IncompleteDownloadError';
  }
}

/**
 * Fetch `path` (an API path) into `target`, reporting bytes received. Errors
 * before the archive starts (no access, not a folder, too many downloads)
 * reject with the server's message; a connection that breaks part-way
 * rejects with {@link IncompleteDownloadError}. Aborting `signal` stops the
 * server's work too. The target is closed on success and aborted otherwise.
 */
export async function downloadFolderArchive(
  path: string,
  target: SaveTarget,
  opts: { signal: AbortSignal; onProgress?: (received: number) => void },
): Promise<{ bytes: number }> {
  let received = 0;
  try {
    const res = await api.getStream(path, { signal: opts.signal, headers: { Accept: '*/*' } });
    if (!res.body) throw new IncompleteDownloadError();
    const reader = res.body.getReader();
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        if (opts.signal.aborted) throw err;
        throw new IncompleteDownloadError();
      }
      if (next.done) break;
      received += next.value.byteLength;
      await target.write(next.value);
      opts.onProgress?.(received);
    }
    await target.close();
    return { bytes: received };
  } catch (err) {
    await target.abort();
    throw err;
  }
}
