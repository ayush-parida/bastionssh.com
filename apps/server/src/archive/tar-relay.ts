import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import zlib from 'node:zlib';
import { SKIPPED_NOTE, TRUNCATED_NOTE } from './driver.js';
import { NameRegistry } from './names.js';
import { ByteSink, abortError } from './sink.js';
import { ustarHeader } from './tar.js';
import type { ArchiveSummary } from './types.js';

/**
 * Relays a tar stream made elsewhere — `tar -cz` run on a server, gunzipped
 * here — into a tar.gz download, entry by entry, so the download keeps the
 * engine's guarantees although tar walked the folder:
 *
 * - The folder's own `./` entry, devices, FIFOs and sockets, and any member
 *   whose name is absolute or climbs out with `..` (a backslash counting as a
 *   separator, as Windows extractors read it) are left out, the last two
 *   listed in `_skipped.txt`. So are members that would land inside a
 *   symbolic link stored earlier, and hard links to anything but a file
 *   already in the archive: extracted, either would write outside the folder.
 *   setuid / setgid bits are dropped.
 * - SMT_FOLDER_DOWNLOAD_MAX_BYTES / _MAX_FILES are counted on the members
 *   themselves; at a limit the remote tar is stopped and the archive ends
 *   cleanly with `_TRUNCATED.txt`.
 * - What tar reported on stderr (unreadable files, files that changed) goes
 *   into `_skipped.txt` at the end — the relay writes its own end blocks, so
 *   notes can still follow tar's last member.
 *
 * Members are copied byte for byte (links, hard links and long-name records
 * included) and re-compressed, so nothing about the tar dialect matters
 * beyond ustar headers. Nothing is sent until the first member has been read:
 * a stream that is not tar at all (a login script printed something, gzip is
 * missing, the folder could not be opened) rejects with
 * {@link RelayNotStarted} and the caller can fall back to SFTP.
 */

const BLOCK = 512;
const ZEROS = Buffer.alloc(BLOCK * 2);
/** Long-name and PAX records held in front of a member; real ones are tiny. */
const MAX_PREAMBLE_BYTES = 1024 * 1024;
const MAX_SKIP_LINES = 10_000;
/** After tar's end blocks, how long to wait for its exit status and last stderr lines. */
const EXIT_WAIT_MS = 10_000;

export interface RemoteTar {
  /** Gunzipped tar bytes. */
  source: Readable;
  /** Settles when the remote command has exited; `exitCode` null when unknown (killed). */
  exited: Promise<{ exitCode: number | null }>;
  /** What tar has written to stderr so far, one message per line. */
  messages: () => string[];
  /** Stop the remote command (a limit was reached, or the download was cancelled). */
  stop: () => void;
}

export interface TarRelayOptions {
  maxBytes: number;
  maxFiles: number;
  signal: AbortSignal;
  /** Called once, just before the first byte goes out: send the headers, return the body. */
  begin: () => Writable;
}

/** Nothing was sent: the remote output was not a usable tar stream. */
export class RelayNotStarted extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RelayNotStarted';
  }
}

class Truncated extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

interface Header {
  block: Buffer;
  name: string;
  type: string;
  size: number;
  linkName: string;
}

export async function relayTar(remote: RemoteTar, opts: TarRelayOptions): Promise<ArchiveSummary> {
  const { signal } = opts;
  const summary: ArchiveSummary = { files: 0, bytes: 0, skipped: 0, truncated: false, aborted: false };
  const skipLines: string[] = [];
  const names = new NameRegistry();
  const reader = new BlockReader(remote.source);
  let gzip: zlib.Gzip | undefined;
  let sink: ByteSink | undefined;
  let entries = 0;
  let truncation = '';
  /** Kept members that are not folders (what a hard link may point at), and the symbolic links among them. */
  const keptFiles = new Set<string>();
  const keptLinks = new Set<string>();

  const onAbort = () => {
    remote.stop();
    remote.source.destroy(abortError(signal));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  const skip = (path: string, reason: string) => {
    summary.skipped++;
    if (skipLines.length < MAX_SKIP_LINES) skipLines.push(`${oneLine(path)}\t${oneLine(reason)}`);
  };

  const start = (): ByteSink => {
    if (sink) return sink;
    const out = opts.begin();
    gzip = zlib.createGzip();
    gzip.pipe(out, { end: false });
    out.once('close', () => {
      if (!gzip!.readableEnded) gzip!.destroy(new Error('The download connection closed'));
    });
    sink = new ByteSink(gzip, signal);
    return sink;
  };

  /** Copy (or, without a sink, discard) a member's data blocks. */
  const body = async (size: number, to: ByteSink | null) => {
    let left = padded(size);
    while (left > 0) {
      const chunk = await reader.chunk(left);
      if (!chunk) throw new Error('The server’s tar output ended inside a file');
      left -= chunk.length;
      if (to) await to.write(chunk);
    }
  };

  try {
    let preamble: Buffer[] = [];
    let preambleBytes = 0;
    let longName: string | undefined;
    let longLink: string | undefined;
    let pax: Record<string, string> = {};
    let sawEnd = false;

    try {
      for (;;) {
        if (signal.aborted) throw abortError(signal);
        let block: Buffer;
        try {
          block = await reader.read(BLOCK);
        } catch (err) {
          if (signal.aborted) throw abortError(signal);
          if (!sink) throw new RelayNotStarted(`unreadable tar output: ${message(err)}`);
          throw err;
        }
        if (block.length === 0) break;
        if (block.length < BLOCK) {
          if (!sink) throw new RelayNotStarted('tar output ended part-way through a block');
          throw new Error('The server’s tar output ended part-way through a block');
        }
        if (isZero(block)) {
          sawEnd = true;
          break;
        }
        const h = parseHeader(block);
        if (!h) {
          if (!sink) throw new RelayNotStarted('the server did not send a tar stream');
          throw new Error('The server’s tar output is damaged');
        }

        // Records describing the next member: hold them until it is decided whether it goes in
        if ('xgLK'.includes(h.type)) {
          if (preambleBytes + BLOCK + padded(h.size) > MAX_PREAMBLE_BYTES) {
            throw new Error('The server’s tar output has an oversized header');
          }
          const data = await reader.read(padded(h.size));
          if (data.length < padded(h.size)) throw new Error('The server’s tar output ended inside a header');
          preambleBytes += BLOCK + data.length;
          preamble.push(block, data);
          const content = data.subarray(0, h.size);
          if (h.type === 'L') longName = cString(content);
          else if (h.type === 'K') longLink = cString(content);
          else if (h.type === 'x') pax = { ...pax, ...parsePax(content) };
          continue;
        }

        const rawName = longName ?? pax.path ?? h.name;
        const linkName = longLink ?? pax.linkpath ?? h.linkName;
        const size = pax.size !== undefined && /^\d+$/.test(pax.size) ? Number(pax.size) : h.size;
        const held = preamble;
        preamble = [];
        preambleBytes = 0;
        longName = longLink = undefined;
        pax = {};

        const name = memberPath(rawName);
        const isDir = h.type === '5';
        const isContent = !'123456'.includes(h.type);
        const linkTarget = h.type === '1' ? memberPath(linkName) : null;
        const throughLink = name ? insideLink(name, keptLinks) : undefined;
        let keep = true;
        if (name === '') {
          // The folder itself (`./`): extracting it would re-permission the user's current directory
          keep = false;
        } else if (name === null) {
          skip(rawName, 'name is absolute or leaves the folder');
          keep = false;
        } else if (throughLink !== undefined) {
          skip(rawName, `inside the symbolic link ${throughLink}`);
          keep = false;
        } else if (h.type === '1' && (linkTarget === null || !keptFiles.has(linkTarget))) {
          skip(rawName, `hard link to ${linkName}, which is not in this archive`);
          keep = false;
        } else if ('346'.includes(h.type)) {
          skip(rawName, 'not a regular file (device, socket or pipe)');
          keep = false;
        }

        if (keep) {
          if (isContent && summary.bytes + size > opts.maxBytes) {
            throw new Truncated(`the limit of ${opts.maxBytes} bytes (SMT_FOLDER_DOWNLOAD_MAX_BYTES)`);
          }
          if (entries >= opts.maxFiles) {
            throw new Truncated(`the limit of ${opts.maxFiles} files and folders (SMT_FOLDER_DOWNLOAD_MAX_FILES)`);
          }
          entries++;
          if (!name!.includes('/')) names.claim('', name!, isDir);
          const out = start();
          for (const b of held) await out.write(b);
          await out.write(withoutSetId(h.block));
          await body(size, out);
          if (!isDir) {
            summary.files++;
            keptFiles.add(name!);
            if (h.type === '2') keptLinks.add(name!);
          }
          if (isContent) summary.bytes += size;
        } else {
          await body(size, null);
        }
      }
    } catch (err) {
      if (!(err instanceof Truncated)) throw err;
      summary.truncated = true;
      truncation = err.reason;
      remote.stop();
      remote.source.destroy();
    }

    if (!summary.truncated) {
      // Let tar finish (its last record, its exit status, its last stderr lines)
      await reader.drain();
      const exited = await waitExit(remote.exited, signal);
      if (!sink && !(sawEnd && exited.exitCode === 0)) {
        const said = remote.messages().slice(0, 3).join('; ');
        throw new RelayNotStarted(`tar exited with ${exited.exitCode ?? 'no status'}${said ? `: ${said}` : ''}`);
      }
      if (!sawEnd) throw new Error('The server’s tar output ended without its end blocks');
    }

    const out = start();
    const messages = remote.messages();
    if (skipLines.length > 0 || messages.length > 0) {
      const extra = summary.skipped - skipLines.length;
      let text = '';
      if (skipLines.length > 0) {
        text +=
          `Left out of this archive (path, then why):\n\n${skipLines.join('\n')}\n` +
          (extra > 0 ? `… and ${extra} more\n` : '');
      }
      if (messages.length > 0) {
        summary.skipped += messages.length;
        text +=
          `${text ? '\n' : ''}Reported by tar on the server — files it could not read are not in this archive:\n\n` +
          `${messages.map(oneLine).join('\n')}\n`;
      }
      await note(out, names.claim('', SKIPPED_NOTE, false), text);
    }
    if (summary.truncated) {
      const text =
        `This archive is incomplete: it stopped at ${truncation}, after ${summary.files} files ` +
        `(${summary.bytes} bytes).\nDownload the remaining folders separately, or ask an administrator to raise the limit.\n`;
      await note(out, names.claim('', TRUNCATED_NOTE, false), text);
    }
    await out.write(ZEROS);
    const ended = once(gzip!, 'end', { signal });
    gzip!.end();
    await ended;
    return summary;
  } catch (err) {
    remote.stop();
    remote.source.destroy();
    gzip?.destroy();
    if (err instanceof RelayNotStarted && !signal.aborted) throw err;
    if (signal.aborted) {
      if (!sink) throw abortError(signal);
      summary.aborted = true;
      return summary;
    }
    // What had gone out before it broke, for the audit entry
    if (sink && err instanceof Error) throw Object.assign(err, { summary });
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The member's path inside the folder: `./a/b/` → `a/b`, '' for the folder
 * itself, null for an absolute name or one with a `..` segment.
 */
function memberPath(raw: string): string | null {
  // A backslash is a separator, and `C:` a drive, to Windows extractors
  if (raw.startsWith('/') || raw.startsWith('\\') || raw.split(/[\\/]/).includes('..')) return null;
  const path = raw
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .join('/');
  return /^[A-Za-z]:/.test(path) ? null : path;
}

/** The kept symbolic link that `path` would be extracted through, if any. */
function insideLink(path: string, links: Set<string>): string | undefined {
  if (links.size === 0) return undefined;
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const ancestor = path.slice(0, i);
    if (links.has(ancestor)) return ancestor;
  }
  return undefined;
}

function parseHeader(block: Buffer): Header | null {
  const stored = parseInt(cString(block.subarray(148, 156)).trim() || 'x', 8);
  if (!Number.isFinite(stored) || stored !== checksum(block)) return null;
  const magic = block.subarray(257, 263).toString('latin1');
  let name = cString(block.subarray(0, 100));
  // POSIX ustar splits long names over `prefix` (GNU's own format keeps other fields there)
  if (magic === 'ustar\0') {
    const prefix = cString(block.subarray(345, 500));
    if (prefix) name = `${prefix}/${name}`;
  }
  const size = parseNumber(block.subarray(124, 136));
  if (size === null) return null;
  return {
    block,
    name,
    type: block[156] === 0 ? '0' : String.fromCharCode(block[156]!),
    size,
    linkName: cString(block.subarray(157, 257)),
  };
}

/** Octal, or GNU base-256 (high bit set) for values past the octal field. */
function parseNumber(field: Buffer): number | null {
  if (field[0]! & 0x80) {
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    return Number.isSafeInteger(n) ? n : null;
  }
  const text = cString(field).trim();
  if (text === '') return 0;
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : null;
}

function checksum(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum;
}

/** The header with setuid and setgid cleared (as the engine does), checksum redone when it changed. */
function withoutSetId(block: Buffer): Buffer {
  const mode = parseNumber(block.subarray(100, 108));
  if (mode === null || (mode & 0o6000) === 0 || block[100]! & 0x80) return block;
  const copy = Buffer.from(block);
  copy.write((mode & ~0o6000 & 0o7777).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  copy.fill(0x20, 148, 156);
  copy.write(checksum(copy).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return copy;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p < data.length) {
    const space = data.indexOf(0x20, p);
    if (space === -1) break;
    const len = parseInt(data.subarray(p, space).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0 || p + len > data.length) break;
    const record = data.subarray(space + 1, p + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    p += len;
  }
  return out;
}

async function note(out: ByteSink, name: string, text: string): Promise<void> {
  const body = Buffer.from(text, 'utf8');
  await out.write(ustarHeader({ name, type: '0', size: body.length, meta: { mtime: new Date(), mode: 0o644 } }));
  await out.write(body);
  const rem = body.length % BLOCK;
  if (rem) await out.write(ZEROS.subarray(0, BLOCK - rem));
}

function waitExit(exited: RemoteTar['exited'], signal: AbortSignal): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(() => resolve({ exitCode: null })), EXIT_WAIT_MS);
    const onAbort = () => done(() => reject(abortError(signal)));
    const done = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    exited.then(
      (v) => done(() => resolve(v)),
      () => done(() => resolve({ exitCode: null })),
    );
  });
}

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;
const isZero = (b: Buffer) => b.every((x) => x === 0);

function cString(b: Buffer): string {
  const nul = b.indexOf(0);
  return b.subarray(0, nul === -1 ? b.length : nul).toString('utf8');
}

function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '?');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exact-size reads, and bounded chunks for file data, over a byte stream. */
class BlockReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffered: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: Readable) {
    this.iterator = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  /** Exactly `n` bytes, or fewer once the source has ended. */
  async read(n: number): Promise<Buffer> {
    while (this.buffered.length < n && (await this.fill()));
    const out = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(out.length);
    return out;
  }

  /** Up to `max` bytes, as soon as any are there; null at the end. */
  async chunk(max: number): Promise<Buffer | null> {
    if (this.buffered.length === 0 && !(await this.fill())) return null;
    const out = this.buffered.subarray(0, max);
    this.buffered = this.buffered.subarray(out.length);
    return out;
  }

  /** Read and discard whatever is left (tar pads its output to a whole record). */
  async drain(): Promise<void> {
    this.buffered = Buffer.alloc(0);
    while (await this.fill()) this.buffered = Buffer.alloc(0);
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    return true;
  }
}
