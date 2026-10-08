import { once } from 'node:events';
import type { Writable } from 'node:stream';
import zlib from 'node:zlib';
import { ByteSink } from './sink.js';
import type { EntryMeta } from './types.js';
import { consume, type ArchiveWriter, type FileWriteResult } from './writer.js';

/**
 * A streaming tar.gz writer: ustar headers, with a PAX extended header in
 * front of any entry whose name or link target is not short plain ASCII, or
 * whose size or mtime does not fit the octal fields. Symlinks are stored as
 * links. The size is in the header before the data, so a file that comes up
 * short (it shrank, or a read failed) is padded with zeros to that size.
 */

const BLOCK = 512;
const ZEROS = Buffer.alloc(BLOCK * 2);
/** Largest value of an 11-digit octal field (8 GiB − 1 for sizes). */
const MAX_OCTAL_11 = 0o77777777777;

const TYPE_FILE = '0';
const TYPE_SYMLINK = '2';
const TYPE_DIR = '5';
const TYPE_PAX = 'x';

export interface HeaderFields {
  name: string;
  type: string;
  size: number;
  meta: EntryMeta;
  linkName?: string;
}

export class TarGzWriter implements ArchiveWriter {
  readonly supportsSymlinks = true;
  private readonly gzip: zlib.Gzip;
  private readonly sink: ByteSink;

  /** Gzip output is piped into `out`, which is left open for the caller to end. */
  constructor(
    out: Writable,
    private readonly signal: AbortSignal,
  ) {
    this.gzip = zlib.createGzip();
    this.gzip.pipe(out, { end: false });
    // Without this a write would wait for a drain that never comes once the download is gone
    out.once('close', () => {
      if (!this.gzip.readableEnded) this.gzip.destroy(new Error('The download connection closed'));
    });
    this.sink = new ByteSink(this.gzip, signal);
  }

  async addDirectory(name: string, meta: EntryMeta): Promise<void> {
    await this.header({ name, type: TYPE_DIR, size: 0, meta });
  }

  async addSymlink(name: string, target: string, meta: EntryMeta): Promise<void> {
    await this.header({ name, type: TYPE_SYMLINK, size: 0, meta, linkName: target });
  }

  async addFile(name: string, meta: EntryMeta, size: number, body: AsyncIterable<Buffer>): Promise<FileWriteResult> {
    await this.header({ name, type: TYPE_FILE, size, meta });
    let bytes = 0;
    const readError = await consume(body, async (chunk) => {
      // The body is capped at `size` already; this keeps the header honest regardless
      const take = chunk.length > size - bytes ? chunk.subarray(0, size - bytes) : chunk;
      bytes += take.length;
      await this.sink.write(take);
    });
    let pad = size - bytes;
    while (pad > 0) {
      const n = Math.min(pad, ZEROS.length);
      await this.sink.write(ZEROS.subarray(0, n));
      pad -= n;
    }
    await this.blockPad(size);
    return { bytes, ...(readError && { readError }) };
  }

  async finish(): Promise<void> {
    await this.sink.write(ZEROS);
    const ended = once(this.gzip, 'end', { signal: this.signal });
    this.gzip.end();
    await ended;
  }

  destroy(): void {
    this.gzip.destroy();
  }

  private async blockPad(size: number): Promise<void> {
    const rem = size % BLOCK;
    if (rem) await this.sink.write(ZEROS.subarray(0, BLOCK - rem));
  }

  private async header(f: HeaderFields): Promise<void> {
    const pax: [string, string][] = [];
    if (!fitsUstar(f.name)) pax.push(['path', f.name]);
    if (f.linkName !== undefined && !fitsUstar(f.linkName)) pax.push(['linkpath', f.linkName]);
    if (f.size > MAX_OCTAL_11) pax.push(['size', String(f.size)]);
    const mtime = Math.floor(f.meta.mtime.getTime() / 1000);
    if (!(mtime >= 0 && mtime <= MAX_OCTAL_11)) pax.push(['mtime', String(Number.isFinite(mtime) ? mtime : 0)]);
    if (pax.length > 0) {
      const body = Buffer.concat(pax.map(([k, v]) => paxRecord(k, v)));
      const paxName = `PaxHeader/${asciiName(f.name)}`;
      await this.sink.write(ustarHeader({ name: paxName, type: TYPE_PAX, size: body.length, meta: f.meta }));
      await this.sink.write(body);
      await this.blockPad(body.length);
    }
    await this.sink.write(ustarHeader(f));
  }
}

/** Plain printable ASCII that fits the 100-byte name field. */
function fitsUstar(s: string): boolean {
  return s.length <= 100 && /^[\x20-\x7e]*$/.test(s);
}

/** What goes in the ustar name field when PAX carries the real name: ASCII, at most 100 bytes. */
function asciiName(s: string): string {
  const dir = s.endsWith('/');
  let out = s.replace(/[^\x20-\x7e]/g, '_');
  if (out.length > 100) out = out.slice(0, dir ? 99 : 100) + (dir ? '/' : '');
  return out;
}

/** One `"<len> key=value\n"` record; the length counts its own digits. */
export function paxRecord(key: string, value: string): Buffer {
  const base = Buffer.byteLength(` ${key}=${value}\n`, 'utf8');
  let len = base + String(base).length;
  if (String(len).length !== String(base).length) len = base + String(len).length;
  return Buffer.from(`${len} ${key}=${value}\n`, 'utf8');
}

export function ustarHeader(f: HeaderFields): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(asciiName(f.name), 0, 100, 'ascii');
  octal(h, 100, 8, f.meta.mode & 0o7777);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  if (f.size > MAX_OCTAL_11) {
    // GNU base-256 for readers without PAX; PAX `size` is authoritative
    h[124] = 0x80;
    h.writeBigUInt64BE(BigInt(f.size), 124 + 4);
  } else {
    octal(h, 124, 12, f.size);
  }
  const mtime = Math.floor(f.meta.mtime.getTime() / 1000);
  octal(h, 136, 12, mtime >= 0 && mtime <= MAX_OCTAL_11 ? mtime : 0);
  h.write(f.type, 156, 1, 'ascii');
  if (f.linkName !== undefined) h.write(asciiName(f.linkName), 157, 100, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  // Checksum: computed with its own field as spaces, written as 6 octal digits, NUL, space
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/** Zero-padded octal and a NUL terminator, filling `len` bytes. */
function octal(buf: Buffer, offset: number, len: number, value: number): void {
  buf.write(value.toString(8).padStart(len - 1, '0') + '\0', offset, len, 'ascii');
}
