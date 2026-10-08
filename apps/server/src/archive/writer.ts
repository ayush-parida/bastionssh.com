import type { EntryMeta } from './types.js';

/**
 * What the zip and tar writers share, so the driver (driver.ts) can feed
 * either from any folder walker.
 */
export interface ArchiveWriter {
  /** False for zip: the driver leaves links out (with a note) rather than follow them. */
  readonly supportsSymlinks: boolean;
  /** `name` ends with `/`. */
  addDirectory(name: string, meta: EntryMeta): Promise<void>;
  addSymlink(name: string, target: string, meta: EntryMeta): Promise<void>;
  /**
   * Stream one file of `size` bytes from `body` (already capped at `size`).
   * A {@link SourceReadError} from `body` does not fail the archive: the
   * entry is closed with what was read (tar pads to `size`) and the error is
   * returned. Anything else — the download connection going away — rejects.
   */
  addFile(name: string, meta: EntryMeta, size: number, body: AsyncIterable<Buffer>): Promise<FileWriteResult>;
  /** Write the trailer (zip central directory, tar end blocks) and flush. */
  finish(): Promise<void>;
  /** Abandon the archive (cancelled): release compression state without flushing. */
  destroy(): void;
}

export interface FileWriteResult {
  /** Content bytes taken from `body`. */
  bytes: number;
  readError?: Error;
}

/** A read failure on the source side, as opposed to the download connection failing. */
export class SourceReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SourceReadError';
  }
}

/** Feed `body` to `onChunk`, turning a source failure into a returned error. */
export async function consume(
  body: AsyncIterable<Buffer>,
  onChunk: (chunk: Buffer) => Promise<void> | void,
): Promise<Error | undefined> {
  try {
    for await (const chunk of body) await onChunk(chunk);
    return undefined;
  } catch (err) {
    if (err instanceof SourceReadError) return err;
    throw err;
  }
}
