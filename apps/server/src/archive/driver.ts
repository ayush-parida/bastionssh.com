import type { Readable, Writable } from 'node:stream';
import { NameRegistry, sanitizeSegment } from './names.js';
import { ByteSink, abortError } from './sink.js';
import { TarGzWriter } from './tar.js';
import type { ArchiveFormat, ArchiveSummary, EntryMeta, FolderWalker, WalkEntry } from './types.js';
import { SourceReadError, type ArchiveWriter } from './writer.js';
import { ZipWriter } from './zip.js';

/**
 * Walks a folder through a {@link FolderWalker} and streams it into `out` as
 * a zip or tar.gz: depth-first, one file at a time, folders in name order.
 *
 * - Limits: once the next file would pass `maxBytes`, or `maxFiles` entries
 *   are written, the walk stops and the archive ends with `_TRUNCATED.txt`.
 * - A file that cannot be listed, opened or read is left out (or, when it
 *   failed part-way, kept as far as it got) and listed in `_skipped.txt`; the
 *   download carries on.
 * - Symlinks are never followed: tar stores them as links, zip leaves them
 *   out with a note. Devices, sockets and FIFOs are never opened.
 * - `signal` (client disconnect, revoked access) stops everything — the open
 *   remote read included — and the summary comes back with `aborted`.
 *
 * `out` is not ended here; the caller does that.
 */

export interface FolderArchiveOptions {
  format: ArchiveFormat;
  /** The chosen folder, in the walker's terms. */
  rootRef: string;
  /** The folder's listing, when the caller already has it (it listed first to validate the folder). */
  rootEntries?: WalkEntry[];
  maxBytes: number;
  maxFiles: number;
  signal: AbortSignal;
}

export const SKIPPED_NOTE = '_skipped.txt';
export const TRUNCATED_NOTE = '_TRUNCATED.txt';
/** Lines kept for `_skipped.txt`; the rest are counted. */
const MAX_SKIP_LINES = 10_000;

export function createArchiveWriter(format: ArchiveFormat, out: Writable, signal: AbortSignal): ArchiveWriter {
  return format === 'zip' ? new ZipWriter(new ByteSink(out, signal)) : new TarGzWriter(out, signal);
}

class Truncated extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export async function writeFolderArchive(
  walker: FolderWalker,
  out: Writable,
  opts: FolderArchiveOptions,
): Promise<ArchiveSummary> {
  const { signal } = opts;
  const writer = createArchiveWriter(opts.format, out, signal);
  const names = new NameRegistry();
  const summary: ArchiveSummary = { files: 0, bytes: 0, skipped: 0, truncated: false, aborted: false };
  const skipLines: string[] = [];
  let entries = 0;
  let truncation = '';

  const skip = (path: string, reason: string) => {
    summary.skipped++;
    // Remote names may hold tabs and newlines: keep one line per entry
    // eslint-disable-next-line no-control-regex
    const line = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '?');
    if (skipLines.length < MAX_SKIP_LINES) skipLines.push(`${line(path)}\t${line(reason)}`);
  };

  const takeEntry = () => {
    if (entries >= opts.maxFiles) {
      throw new Truncated(`the limit of ${opts.maxFiles} files and folders (SMT_FOLDER_DOWNLOAD_MAX_FILES)`);
    }
    entries++;
  };

  const walk = async (dir: string, list: WalkEntry[]): Promise<void> => {
    for (const entry of [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (signal.aborted) throw abortError(signal);
      const shown = dir + entry.name;
      const segment = sanitizeSegment(entry.name);
      if (segment === null) {
        skip(shown, 'name cannot be stored in an archive');
        continue;
      }
      const meta: EntryMeta = {
        mtime: entry.mtime && !Number.isNaN(entry.mtime.getTime()) ? entry.mtime : new Date(),
        // setuid / setgid dropped: tar extracted as root would otherwise recreate them on root-owned files
        mode: (entry.mode ?? (entry.type === 'dir' ? 0o755 : 0o644)) & 0o1777,
      };
      if (entry.type === 'dir') {
        takeEntry();
        const path = names.claim(dir, segment, true);
        await writer.addDirectory(path, meta);
        let children: WalkEntry[];
        try {
          children = await raceAbort(walker.list(entry.ref), signal);
        } catch (err) {
          if (signal.aborted) throw abortError(signal);
          skip(path, `folder could not be listed: ${message(err)}`);
          continue;
        }
        await walk(path, children);
      } else if (entry.type === 'symlink') {
        if (!writer.supportsSymlinks) {
          skip(shown, `symbolic link${entry.linkTarget ? ` to ${entry.linkTarget}` : ''} (zip archives cannot hold links; download as .tar.gz to keep them)`);
        } else if (entry.linkTarget === undefined) {
          skip(shown, 'symbolic link whose target could not be read');
        } else {
          takeEntry();
          await writer.addSymlink(names.claim(dir, segment, false), entry.linkTarget.replace(/\0/g, ''), meta);
          summary.files++;
        }
      } else if (entry.type === 'other') {
        skip(shown, 'not a regular file (device, socket or pipe)');
      } else {
        const size = Math.max(0, Math.floor(entry.size || 0));
        if (summary.bytes + size > opts.maxBytes) {
          throw new Truncated(`the limit of ${opts.maxBytes} bytes (SMT_FOLDER_DOWNLOAD_MAX_BYTES)`);
        }
        takeEntry();
        await addFile(dir, segment, shown, entry, size, meta);
      }
    }
  };

  const addFile = async (dir: string, segment: string, shown: string, entry: WalkEntry, size: number, meta: EntryMeta) => {
    let stream: Readable;
    const opening = walker.open(entry, signal);
    try {
      stream = await raceAbort(opening, signal);
    } catch (err) {
      entries--;
      if (signal.aborted) {
        // A walker that ignores the signal may still hand over a stream (an open SFTP handle): close it
        opening.then((late) => late.destroy(), () => {});
        throw abortError(signal);
      }
      skip(shown, `could not be opened: ${message(err)}`);
      return;
    }
    const onAbort = () => stream.destroy(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      // Wait for the first bytes: a file that fails before any data is left out cleanly
      let first: IteratorResult<Buffer>;
      try {
        first = size === 0 ? { done: true, value: undefined } : await iterator.next();
      } catch (err) {
        entries--;
        if (signal.aborted) throw abortError(signal);
        skip(shown, `could not be read: ${message(err)}`);
        return;
      }
      const result = await writer.addFile(names.claim(dir, segment, false), meta, size, capped(first, iterator, size));
      if (signal.aborted) throw abortError(signal);
      summary.files++;
      summary.bytes += result.bytes;
      if (result.readError) {
        skip(shown, `read failed after ${result.bytes} of ${size} bytes, the archived copy is incomplete: ${result.readError.message}`);
      } else if (result.bytes < size && opts.format === 'tar.gz') {
        skip(shown, `ended after ${result.bytes} of ${size} bytes (changed while being read); padded with zeros`);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      stream.destroy();
    }
  };

  try {
    try {
      const root = opts.rootEntries ?? (await raceAbort(walker.list(opts.rootRef), signal));
      await walk('', root);
    } catch (err) {
      if (!(err instanceof Truncated)) throw err;
      summary.truncated = true;
      truncation = err.reason;
    }
    if (skipLines.length > 0) {
      const extra = summary.skipped - skipLines.length;
      const text =
        `Left out of this archive, or incomplete in it (path, then why):\n\n${skipLines.join('\n')}\n` +
        (extra > 0 ? `… and ${extra} more\n` : '');
      await note(writer, names.claim('', SKIPPED_NOTE, false), text);
    }
    if (summary.truncated) {
      const text =
        `This archive is incomplete: it stopped at ${truncation}, after ${summary.files} files ` +
        `(${summary.bytes} bytes).\nDownload the remaining folders separately, or ask an administrator to raise the limit.\n`;
      await note(writer, names.claim('', TRUNCATED_NOTE, false), text);
    }
    await writer.finish();
  } catch (err) {
    writer.destroy();
    // The connection went away (or access was revoked): nothing more can be sent
    if (signal.aborted || isConnectionGone(out)) {
      summary.aborted = true;
      return summary;
    }
    throw err;
  }
  return summary;
}

/** A small text file written by the engine itself (outside the limits). */
async function note(writer: ArchiveWriter, name: string, text: string): Promise<void> {
  const body = Buffer.from(text, 'utf8');
  await writer.addFile(name, { mtime: new Date(), mode: 0o644 }, body.length, (async function* () {
    yield body;
  })());
}

/**
 * The file's bytes: the chunk already read, then the rest, stopping at `size`
 * (a file that grew while being read is cut at its listed size). Source
 * errors surface as {@link SourceReadError}.
 */
async function* capped(first: IteratorResult<Buffer>, iterator: AsyncIterator<Buffer>, size: number): AsyncGenerator<Buffer> {
  let left = size;
  let current = first;
  while (!current.done && left > 0) {
    const chunk = Buffer.isBuffer(current.value) ? current.value : Buffer.from(current.value);
    const take = chunk.length > left ? chunk.subarray(0, left) : chunk;
    left -= take.length;
    yield take;
    if (left === 0) break;
    try {
      current = await iterator.next();
    } catch (err) {
      throw new SourceReadError(err);
    }
  }
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function isConnectionGone(out: Writable): boolean {
  return out.destroyed || out.writableEnded;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
