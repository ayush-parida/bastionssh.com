import { once } from 'node:events';
import zlib from 'node:zlib';
import type { ByteSink } from './sink.js';
import { crc32 } from './sink.js';
import type { EntryMeta } from './types.js';
import { consume, type ArchiveWriter, type FileWriteResult } from './writer.js';

/**
 * A streaming ZIP writer: each file goes out as it is read, with a data
 * descriptor after it (CRC and sizes are only known at the end), so nothing is
 * staged. Names are UTF-8 (flag bit 11), modes travel in the external
 * attributes ("made by Unix"), mtimes as DOS time plus the extended-timestamp
 * field. ZIP64 is used per entry when its size might pass 4 GiB, for any
 * offset past 4 GiB, and for the end record past 65 535 entries.
 *
 * Content is deflated unless it looks already compressed — by extension, or
 * because a quick deflate of its first 64 KiB barely shrinks it — in which
 * case it is stored.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_END = 0x06054b50;

const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** "Made by" Unix, spec version 4.5: external attributes carry st_mode. */
const MADE_BY = (3 << 8) | VERSION_ZIP64;

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/**
 * Entries whose declared size comes this close to 4 GiB are written as ZIP64
 * up front: deflate can grow incompressible data a little, and the local
 * header has to commit before the first byte.
 */
const ZIP64_MARGIN = 64 * 1024 * 1024;

const SAMPLE_BYTES = 64 * 1024;
/** A sample that deflates to more than this share of its size is stored. */
const STORE_RATIO = 0.95;

/** Extensions whose content is already compressed: deflating them only costs CPU. */
const COMPRESSED_EXTENSIONS = new Set([
  '7z', 'aac', 'apk', 'avi', 'avif', 'br', 'bz2', 'cab', 'deb', 'docx', 'epub', 'flac', 'gif', 'gz', 'heic',
  'jar', 'jpeg', 'jpg', 'lz', 'lz4', 'lzma', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'odp', 'ods', 'odt',
  'ogg', 'opus', 'png', 'pptx', 'rar', 'rpm', 'tbz', 'tgz', 'txz', 'war', 'webm', 'webp', 'whl', 'woff',
  'woff2', 'xlsx', 'xz', 'zip', 'zst',
]);

interface CentralRecord {
  name: Buffer;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  offset: number;
  externalAttrs: number;
  unixTime: number | null;
  /** Sizes are carried in the ZIP64 extra (they may pass 4 GiB). */
  zip64Sizes: boolean;
}

export class ZipWriter implements ArchiveWriter {
  readonly supportsSymlinks = false;
  private readonly records: CentralRecord[] = [];
  private deflater: zlib.DeflateRaw | null = null;

  constructor(private readonly sink: ByteSink) {}

  async addDirectory(name: string, meta: EntryMeta): Promise<void> {
    const record = this.record(name, meta, 0o040000 | (meta.mode & 0o7777), METHOD_STORE, FLAG_UTF8, false);
    // MS-DOS directory bit too, for extractors that ignore Unix modes
    record.externalAttrs = (record.externalAttrs | 0x10) >>> 0;
    await this.sink.write(localHeader(record));
    this.records.push(record);
  }

  addSymlink(): Promise<void> {
    return Promise.reject(new Error('Zip archives do not store symbolic links'));
  }

  async addFile(name: string, meta: EntryMeta, size: number, body: AsyncIterable<Buffer>): Promise<FileWriteResult> {
    // Read ahead (bounded) to choose deflate or store before the header commits
    const iterator = body[Symbol.asyncIterator]();
    const sample: Buffer[] = [];
    let sampled = 0;
    let ended = false;
    let readError: Error | undefined;
    const rest: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => iterator,
    };
    readError = await consume(
      {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (sampled >= SAMPLE_BYTES) return { done: true, value: undefined };
            const r = await iterator.next();
            if (r.done) ended = true;
            return r;
          },
        }),
      },
      (chunk) => {
        sample.push(chunk);
        sampled += chunk.length;
      },
    );
    const head = Buffer.concat(sample);
    const method = size === 0 || head.length === 0 || !shouldDeflate(name, head) ? METHOD_STORE : METHOD_DEFLATE;
    const zip64 = size >= MAX32 - ZIP64_MARGIN;
    const record = this.record(
      name,
      meta,
      0o100000 | (meta.mode & 0o7777),
      method,
      FLAG_UTF8 | FLAG_DESCRIPTOR,
      zip64,
    );
    await this.sink.write(localHeader(record));
    const start = this.sink.offset;

    let crc = 0;
    let bytes = 0;
    const more = readError || ended ? null : rest;
    if (method === METHOD_STORE) {
      const put = async (chunk: Buffer) => {
        crc = crc32(chunk, crc);
        bytes += chunk.length;
        await this.sink.write(chunk);
      };
      await put(head);
      if (more) readError = await consume(more, put);
    } else {
      const result = await this.deflate(head, more);
      crc = result.crc;
      bytes = result.bytes;
      readError ??= result.readError;
    }

    record.crc = crc;
    record.uncompressed = bytes;
    record.compressed = this.sink.offset - start;
    await this.sink.write(descriptor(record));
    this.records.push(record);
    return { bytes, ...(readError && { readError }) };
  }

  async finish(): Promise<void> {
    const cdStart = this.sink.offset;
    for (const r of this.records) await this.sink.write(centralHeader(r));
    const cdSize = this.sink.offset - cdStart;
    const count = this.records.length;
    if (count >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32) {
      const zip64End = this.sink.offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(SIG_ZIP64_END, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(MADE_BY, 12);
      rec.writeUInt16LE(VERSION_ZIP64, 14);
      rec.writeBigUInt64LE(BigInt(count), 24);
      rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
      locator.writeBigUInt64LE(BigInt(zip64End), 8);
      locator.writeUInt32LE(1, 16);
      await this.sink.write(Buffer.concat([rec, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    await this.sink.write(end);
  }

  destroy(): void {
    this.deflater?.destroy();
    this.deflater = null;
  }

  /** Deflate `head` then `more` into the sink, reading only as fast as the sink takes it. */
  private async deflate(
    head: Buffer,
    more: AsyncIterable<Buffer> | null,
  ): Promise<{ crc: number; bytes: number; readError?: Error }> {
    const deflate = zlib.createDeflateRaw({ level: 6 });
    this.deflater = deflate;
    const pump = (async () => {
      for await (const out of deflate as AsyncIterable<Buffer>) await this.sink.write(out);
    })();
    // Surfaced through the awaits below; this only keeps an early failure from going unhandled
    pump.catch(() => {});
    let crc = 0;
    let bytes = 0;
    const feed = async (chunk: Buffer) => {
      crc = crc32(chunk, crc);
      bytes += chunk.length;
      if (!deflate.write(chunk)) await Promise.race([once(deflate, 'drain'), pump]);
    };
    try {
      await feed(head);
      const readError = more ? await consume(more, feed) : undefined;
      deflate.end();
      await pump;
      return { crc, bytes, ...(readError && { readError }) };
    } finally {
      this.deflater = null;
      if (!deflate.destroyed) deflate.destroy();
    }
  }

  private record(
    name: string,
    meta: EntryMeta,
    mode: number,
    method: number,
    flags: number,
    zip64Sizes: boolean,
  ): CentralRecord {
    const { time, date } = dosDateTime(meta.mtime);
    const seconds = Math.floor(meta.mtime.getTime() / 1000);
    return {
      name: Buffer.from(name, 'utf8'),
      flags,
      method,
      dosTime: time,
      dosDate: date,
      crc: 0,
      compressed: 0,
      uncompressed: 0,
      offset: this.sink.offset,
      externalAttrs: (mode << 16) >>> 0,
      unixTime: seconds >= 0 && seconds <= 0x7fffffff ? seconds : null,
      zip64Sizes,
    };
  }
}

function shouldDeflate(name: string, head: Buffer): boolean {
  const dot = name.lastIndexOf('.');
  if (dot > name.lastIndexOf('/') && COMPRESSED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) return false;
  return zlib.deflateRawSync(head, { level: 1 }).length <= head.length * STORE_RATIO;
}

/** DOS date/time (local time, 2-second resolution), clamped to 1980–2107. */
export function dosDateTime(d: Date): { time: number; date: number } {
  let year = d.getFullYear();
  if (Number.isNaN(year) || year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) year = 2107;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Extended timestamp (0x5455): mtime only, the same in local and central headers. */
function timeExtra(r: CentralRecord): Buffer {
  if (r.unixTime === null) return Buffer.alloc(0);
  const b = Buffer.alloc(9);
  b.writeUInt16LE(0x5455, 0);
  b.writeUInt16LE(5, 2);
  b.writeUInt8(1, 4);
  b.writeUInt32LE(r.unixTime, 5);
  return b;
}

function localHeader(r: CentralRecord): Buffer {
  // ZIP64 local extra: sizes are zero here and live in the (8-byte) descriptor
  const zip64 = r.zip64Sizes ? Buffer.alloc(20) : Buffer.alloc(0);
  if (r.zip64Sizes) {
    zip64.writeUInt16LE(0x0001, 0);
    zip64.writeUInt16LE(16, 2);
  }
  const extra = Buffer.concat([zip64, timeExtra(r)]);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(SIG_LOCAL, 0);
  h.writeUInt16LE(r.zip64Sizes ? VERSION_ZIP64 : VERSION_DEFAULT, 4);
  h.writeUInt16LE(r.flags, 6);
  h.writeUInt16LE(r.method, 8);
  h.writeUInt16LE(r.dosTime, 10);
  h.writeUInt16LE(r.dosDate, 12);
  // CRC and sizes stay zero: the data descriptor carries them (sizes 0xffffffff for ZIP64)
  if (r.zip64Sizes) {
    h.writeUInt32LE(MAX32, 18);
    h.writeUInt32LE(MAX32, 22);
  }
  h.writeUInt16LE(r.name.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, r.name, extra]);
}

function descriptor(r: CentralRecord): Buffer {
  if (r.zip64Sizes) {
    const d = Buffer.alloc(24);
    d.writeUInt32LE(SIG_DESCRIPTOR, 0);
    d.writeUInt32LE(r.crc, 4);
    d.writeBigUInt64LE(BigInt(r.compressed), 8);
    d.writeBigUInt64LE(BigInt(r.uncompressed), 16);
    return d;
  }
  const d = Buffer.alloc(16);
  d.writeUInt32LE(SIG_DESCRIPTOR, 0);
  d.writeUInt32LE(r.crc, 4);
  d.writeUInt32LE(r.compressed, 8);
  d.writeUInt32LE(r.uncompressed, 12);
  return d;
}

function centralHeader(r: CentralRecord): Buffer {
  // ZIP64 extra fields appear in this order, each only when its header field is 0xffffffff
  const big: bigint[] = [];
  if (r.zip64Sizes) big.push(BigInt(r.uncompressed), BigInt(r.compressed));
  const offset64 = r.offset >= MAX32;
  if (offset64) big.push(BigInt(r.offset));
  let zip64 = Buffer.alloc(0);
  if (big.length > 0) {
    zip64 = Buffer.alloc(4 + big.length * 8);
    zip64.writeUInt16LE(0x0001, 0);
    zip64.writeUInt16LE(big.length * 8, 2);
    big.forEach((v, i) => zip64.writeBigUInt64LE(v, 4 + i * 8));
  }
  const extra = Buffer.concat([zip64, timeExtra(r)]);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(SIG_CENTRAL, 0);
  h.writeUInt16LE(MADE_BY, 4);
  h.writeUInt16LE(big.length > 0 ? VERSION_ZIP64 : VERSION_DEFAULT, 6);
  h.writeUInt16LE(r.flags, 8);
  h.writeUInt16LE(r.method, 10);
  h.writeUInt16LE(r.dosTime, 12);
  h.writeUInt16LE(r.dosDate, 14);
  h.writeUInt32LE(r.crc, 16);
  h.writeUInt32LE(r.zip64Sizes ? MAX32 : r.compressed, 20);
  h.writeUInt32LE(r.zip64Sizes ? MAX32 : r.uncompressed, 24);
  h.writeUInt16LE(r.name.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt32LE(r.externalAttrs, 38);
  h.writeUInt32LE(offset64 ? MAX32 : r.offset, 42);
  return Buffer.concat([h, r.name, extra]);
}
