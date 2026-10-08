import posix from 'node:path/posix';
import zlib from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ClientChannel } from 'ssh2';
import { reserveStream } from '../api/sse.js';
import {
  TOO_MANY_DOWNLOADS,
  contentDisposition,
  sendFolderArchive,
  type ArchiveFormat,
  type ArchiveSummary,
  type FolderDownloadResult,
  type FolderWalker,
  type WalkEntry,
} from '../archive/index.js';
import { raceAbort } from '../archive/driver.js';
import { RelayNotStarted, relayTar, type RemoteTar } from '../archive/tar-relay.js';
import { config } from '../config/index.js';
import { shellCommand } from '../docker/shell.js';
import logger from '../logger.js';
import * as sftp from './sftp.js';

/**
 * Servers → Files folder downloads. A `.zip` (and a `.tar.gz` from an account
 * without a shell) is built by the archive engine over the pooled SFTP
 * channel, one file at a time. A `.tar.gz` from an account with a shell runs
 * `tar -cz` on the server instead, over the same SSH connection — one stream
 * rather than a request per file — and relays it (archive/tar-relay.ts), so
 * limits, `_skipped.txt` and `_TRUNCATED.txt` work the same either way.
 */

export type FolderDownloadMethod = 'tar' | 'sftp';

export interface ServerFolderResult extends FolderDownloadResult {
  method: FolderDownloadMethod;
  /** What the server's tar reported on stderr (first lines), for the audit entry. */
  tarMessages?: string[];
}

export interface ServerFolderOptions {
  serverId: string;
  /** Released here, however the download ends. */
  lease: sftp.SftpLease;
  /** Normalised absolute path of a folder. */
  path: string;
  format: ArchiveFormat;
  onDone: (result: ServerFolderResult) => Promise<void> | void;
  maxBytes?: number;
  maxFiles?: number;
}

const ACCESS_CHANGED = 'Your access has changed. This download was stopped.';
/** stderr lines kept from the server's tar (each also lands in _skipped.txt). */
const MAX_TAR_MESSAGES = 10_000;
const AUDITED_TAR_MESSAGES = 20;

/**
 * `tar` for one folder: every member named relative to it (`./…`), links kept
 * as links, compressed on the server. The path is the only variable and goes
 * in as one single-quoted argument after `-C`; `LC_ALL=C` keeps tar's messages
 * (copied into `_skipped.txt`) in English. `env` rather than an assignment
 * prefix, which not every login shell understands.
 */
export function tarCommand(dir: string): string {
  return shellCommand(['env', 'LC_ALL=C', 'tar', '-czf', '-', '-C', dir, '.']);
}

/** The engine's source over a pooled SFTP channel: readdir / lstat-style attributes, links never followed. */
export function sftpFolderWalker(lease: sftp.SftpLease, opts: { readLinks: boolean }): FolderWalker {
  return {
    async list(ref) {
      const rows = await sftp.readdir(lease.sftp, ref);
      return Promise.all(
        rows.map(async (row): Promise<WalkEntry> => {
          const mode = row.attrs.mode ?? 0;
          const path = ref === '/' ? `/${row.filename}` : `${ref}/${row.filename}`;
          const type = entryType(mode);
          let linkTarget: string | undefined;
          // Only a tar can hold a link; a zip leaves it out without asking where it points
          if (type === 'symlink' && opts.readLinks) {
            linkTarget = await sftp.readlink(lease.sftp, path).catch(() => undefined);
          }
          return {
            name: row.filename,
            ref: path,
            type,
            size: row.attrs.size ?? 0,
            mtime: row.attrs.mtime ? new Date(row.attrs.mtime * 1000) : undefined,
            mode: mode & 0o7777,
            ...(linkTarget !== undefined && { linkTarget }),
          };
        }),
      );
    },
    async open(entry) {
      return sftp.createReadStream(lease.sftp, entry.ref);
    },
    close() {
      lease.release();
    },
  };
}

function entryType(mode: number): WalkEntry['type'] {
  switch (mode & 0o170000) {
    case 0o040000:
      return 'dir';
    case 0o120000:
      return 'symlink';
    case 0o100000:
      return 'file';
    default:
      return 'other';
  }
}

/**
 * Stream the folder at `opts.path` as an archive (see the module comment for
 * which way). The pooled connection closing under the download — the user's
 * access was revoked, or the server's credentials changed — cuts it.
 */
export async function sendServerFolder(req: FastifyRequest, reply: FastifyReply, opts: ServerFolderOptions): Promise<void> {
  const { lease } = opts;
  const cut = () => reply.raw.destroy();
  if (lease.closed.aborted) cut();
  else lease.closed.addEventListener('abort', cut, { once: true });
  try {
    if (opts.format === 'tar.gz' && quotesEverywhere(opts.path) && (await lease.hasShell())) {
      if (await sendWithTar(req, reply, opts)) return;
    }
    await sendFolderArchive(req, reply, {
      resourceId: opts.serverId,
      walker: sftpFolderWalker(lease, { readLinks: opts.format === 'tar.gz' }),
      rootRef: opts.path,
      folderName: folderName(opts.path),
      format: opts.format,
      maxBytes: opts.maxBytes,
      maxFiles: opts.maxFiles,
      onDone: (result) => opts.onDone({ ...result, method: 'sftp' }),
    });
  } finally {
    lease.closed.removeEventListener('abort', cut);
    lease.release();
  }
}

/**
 * Whether single quotes keep `path` literal in any login shell: fish reads
 * `\'` inside them as a quote, csh refuses a newline. Such folders go over SFTP.
 */
function quotesEverywhere(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\\\u0000-\u001f\u007f]/.test(path);
}

function folderName(path: string): string {
  return posix.basename(path) || 'root';
}

/**
 * The tar fast path, with sendFolderArchive's conventions (stream slot,
 * headers only once the first member is in, cancellation, one outcome).
 * False when nothing was sent and the engine should serve the folder instead:
 * the command could not start, or its output was not a tar stream.
 */
async function sendWithTar(req: FastifyRequest, reply: FastifyReply, opts: ServerFolderOptions): Promise<boolean> {
  const slot = reserveStream(req, { feature: 'files', resourceId: opts.serverId });
  if (!slot) {
    await reply.status(429).send({ error: TOO_MANY_DOWNLOADS });
    return true;
  }
  const started = Date.now();
  const controller = new AbortController();
  let finished = false;
  const onRevoke = () => controller.abort(slot.signal.reason);
  if (slot.signal.aborted) onRevoke();
  else slot.signal.addEventListener('abort', onRevoke, { once: true });
  const onClose = () => {
    if (!finished) controller.abort(new Error('The download was cancelled'));
  };
  reply.raw.on('close', onClose);
  const accessChanged = () => Object.assign(new Error(ACCESS_CHANGED), { statusCode: 403 });

  let remote: RemoteTar | undefined;
  try {
    let channel: ClientChannel;
    try {
      channel = await raceAbort(opts.lease.exec(tarCommand(opts.path)), controller.signal);
    } catch (err) {
      if (slot.signal.aborted) throw accessChanged();
      if (controller.signal.aborted) throw err;
      logger.info({ err, serverId: opts.serverId }, 'Folder download: tar could not start, using SFTP');
      return false;
    }
    remote = remoteTar(channel);

    let hijacked = false;
    let summary: ArchiveSummary;
    let error: string | undefined;
    try {
      summary = await relayTar(remote, {
        maxBytes: opts.maxBytes ?? config.folderDownload.maxBytes,
        maxFiles: opts.maxFiles ?? config.folderDownload.maxFiles,
        signal: controller.signal,
        begin: () => {
          hijacked = true;
          const filename = `${folderName(opts.path).replace(/[/\\]/g, '_')}.tar.gz`;
          reply.hijack();
          reply.raw.writeHead(200, {
            ...(reply.getHeaders() as Record<string, string>),
            'Content-Type': 'application/gzip',
            'Content-Disposition': contentDisposition(filename),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Accel-Buffering': 'no',
            Trailer: 'X-Archive-Summary',
          });
          return reply.raw;
        },
      });
    } catch (err) {
      if (err instanceof RelayNotStarted) {
        logger.info({ serverId: opts.serverId, reason: err.message }, 'Folder download: tar output unusable, using SFTP');
        return false;
      }
      if (!hijacked) throw slot.signal.aborted ? accessChanged() : err;
      error = err instanceof Error ? err.message : String(err);
      summary = (err as { summary?: ArchiveSummary }).summary ?? { files: 0, bytes: 0, skipped: 0, truncated: false, aborted: false };
    }
    finished = true;
    if (summary.aborted || error) {
      reply.raw.destroy();
    } else {
      reply.raw.addTrailers({
        'X-Archive-Summary': `files=${summary.files}; bytes=${summary.bytes}; skipped=${summary.skipped}; truncated=${summary.truncated}`,
      });
      reply.raw.end();
    }
    const messages = remote.messages();
    await opts.onDone({
      ...summary,
      format: 'tar.gz',
      method: 'tar',
      durationMs: Date.now() - started,
      ...(error && { error }),
      ...(messages.length > 0 && { tarMessages: messages.slice(0, AUDITED_TAR_MESSAGES) }),
    });
    return true;
  } finally {
    finished = true;
    reply.raw.off('close', onClose);
    slot.signal.removeEventListener('abort', onRevoke);
    slot.release();
    remote?.stop();
  }
}

/** The remote tar as the relay sees it: gunzipped stdout, exit status, stderr lines, a way to stop it. */
function remoteTar(channel: ClientChannel): RemoteTar {
  const source = zlib.createGunzip();
  channel.on('error', (err: Error) => source.destroy(err));
  channel.pipe(source);
  // tar reads nothing; a forced command that would wait on input exits instead
  channel.end();

  const lines: string[] = [];
  let partial = '';
  const keep = (line: string) => {
    // tar's closing summary of the errors it already reported one by one (GNU tar, then bsdtar)
    if (!line || /Exiting with failure status due to previous errors|Error exit delayed from previous errors/.test(line)) return;
    if (lines.length < MAX_TAR_MESSAGES) lines.push(line.length > 1000 ? `${line.slice(0, 1000)}…` : line);
  };
  channel.stderr.on('data', (data: Buffer) => {
    partial += data.toString('utf8');
    const parts = partial.split('\n');
    partial = parts.pop() ?? '';
    if (partial.length > 4096) partial = partial.slice(0, 4096);
    parts.forEach(keep);
  });

  let exitCode: number | null = null;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => {
    channel.on('exit', (code: number | null) => {
      exitCode = typeof code === 'number' ? code : null;
    });
    channel.on('close', () => {
      keep(partial);
      partial = '';
      resolve({ exitCode });
    });
  });

  let stopped = false;
  return {
    source,
    exited,
    messages: () => [...lines],
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        // Not every sshd delivers signals; closing the channel ends tar on its next write
        channel.signal('KILL');
      } catch {
        // The channel is already gone
      }
      channel.close();
    },
  };
}
