import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config/index.js';
import { MAX_STREAMS_PER_USER, abortEventStreams, reserveStream } from '../api/sse.js';
import { raceAbort, writeFolderArchive } from './driver.js';
import { contentDisposition } from './names.js';
import { abortError } from './sink.js';
import type { ArchiveFormat, ArchiveSummary, FolderWalker } from './types.js';

/**
 * Serving a folder download from a route: the per-user stream cap (a download
 * holds one of the user's {@link MAX_STREAMS_PER_USER} places for as long as
 * it runs, like a log stream), the folder listed before any header goes out
 * (so a bad path is still a JSON error), attachment headers, cancellation
 * when the browser goes away or access is revoked, and one outcome for the
 * route to audit.
 */

export const archiveFormatSchema = z.enum(['zip', 'tar.gz']).default('zip');

export const TOO_MANY_DOWNLOADS = `Too many downloads and live views open (at most ${MAX_STREAMS_PER_USER}); wait for one to finish`;

const ACCESS_CHANGED = 'Your access has changed. This download was stopped.';

const CONTENT_TYPES: Record<ArchiveFormat, string> = {
  zip: 'application/zip',
  'tar.gz': 'application/gzip',
};

export interface FolderDownloadResult extends ArchiveSummary {
  format: ArchiveFormat;
  durationMs: number;
  /** Set when the archive failed for a reason other than cancellation (the response was cut). */
  error?: string;
}

export interface FolderDownloadOptions {
  /** The server or connection the folder is on (revocation can end its downloads). */
  resourceId: string;
  walker: FolderWalker;
  rootRef: string;
  /** The download is named `<folderName>.zip` / `.tar.gz`. */
  folderName: string;
  format: ArchiveFormat;
  /** Called once the download has ended, however it ended — audit it here. */
  onDone: (result: FolderDownloadResult) => Promise<void> | void;
  /** Defaults to SMT_FOLDER_DOWNLOAD_MAX_BYTES / SMT_FOLDER_DOWNLOAD_MAX_FILES. */
  maxBytes?: number;
  maxFiles?: number;
  /**
   * Ends the download from outside, like revoked access: for sources that
   * track their own revocations (an FTP connection edited or deleted, or
   * access to it removed).
   */
  signal?: AbortSignal;
}

/**
 * Stream `walker`'s folder as an archive. The walker is closed when this is
 * done with it. Answers 429 when the user is at the stream cap; a failure
 * listing the folder itself rejects before anything is sent, for the route's
 * error handler. After that the response is hijacked and this resolves once
 * the archive has ended.
 */
export async function sendFolderArchive(req: FastifyRequest, reply: FastifyReply, opts: FolderDownloadOptions): Promise<void> {
  const slot = reserveStream(req, { feature: 'files', resourceId: opts.resourceId });
  if (!slot) {
    await closeQuietly(opts.walker);
    await reply.status(429).send({ error: TOO_MANY_DOWNLOADS });
    return;
  }
  const started = Date.now();
  const controller = new AbortController();
  let finished = false;
  // Wired before the folder is listed: access revoked (or the browser gone) while it lists must stop the download too
  const revoked = opts.signal ? AbortSignal.any([slot.signal, opts.signal]) : slot.signal;
  const onRevoke = () => controller.abort(revoked.reason);
  if (revoked.aborted) onRevoke();
  else revoked.addEventListener('abort', onRevoke, { once: true });
  reply.raw.on('close', () => {
    if (!finished) controller.abort(new Error('The download was cancelled'));
  });
  try {
    const accessChanged = () => Object.assign(new Error(ACCESS_CHANGED), { statusCode: 403 });
    const rootEntries = await raceAbort(opts.walker.list(opts.rootRef), controller.signal).catch((err: unknown) => {
      throw revoked.aborted ? accessChanged() : err;
    });
    if (revoked.aborted) throw accessChanged();
    if (controller.signal.aborted) throw abortError(controller.signal);

    const filename = `${opts.folderName.replace(/[/\\]/g, '_') || 'folder'}.${opts.format}`;
    // Taken over from Fastify: headers set by hooks so far (CORS, security) are kept
    reply.hijack();
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'Content-Type': CONTENT_TYPES[opts.format],
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // nginx and similar proxies would otherwise buffer the whole archive
      'X-Accel-Buffering': 'no',
      Trailer: 'X-Archive-Summary',
    });

    let summary: ArchiveSummary;
    let error: string | undefined;
    try {
      summary = await writeFolderArchive(opts.walker, reply.raw, {
        format: opts.format,
        rootRef: opts.rootRef,
        rootEntries,
        maxBytes: opts.maxBytes ?? config.folderDownload.maxBytes,
        maxFiles: opts.maxFiles ?? config.folderDownload.maxFiles,
        signal: controller.signal,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      summary = { files: 0, bytes: 0, skipped: 0, truncated: false, aborted: false };
    }
    finished = true;
    if (summary.aborted || error) {
      // Cut short: a truncated body is the only way left to say so
      reply.raw.destroy();
    } else {
      reply.raw.addTrailers({
        'X-Archive-Summary': `files=${summary.files}; bytes=${summary.bytes}; skipped=${summary.skipped}; truncated=${summary.truncated}`,
      });
      reply.raw.end();
    }
    await opts.onDone({ ...summary, format: opts.format, durationMs: Date.now() - started, ...(error && { error }) });
  } finally {
    finished = true;
    slot.release();
    await closeQuietly(opts.walker);
  }
}

/** End a user's folder downloads — in one org when `orgId` is given, sparing `keepResourceIds`. */
export function abortFolderDownloads(
  userId: string,
  scope: { orgId?: string; keepResourceIds?: Iterable<string> } = {},
): number {
  return abortEventStreams(userId, 'files', scope);
}

async function closeQuietly(walker: FolderWalker): Promise<void> {
  try {
    await walker.close();
  } catch {
    // Releasing a connection must not turn a finished download into an error
  }
}
