import { execFileSync, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import zlib from 'node:zlib';
import type { FolderWalker, WalkEntry } from './types.js';

/**
 * Test-only helpers for the archive engine: an in-memory folder walker with
 * synthetic (generated, never buffered) file contents, independent pure-JS
 * zip and tar.gz readers, a streaming zip verifier for archives too large to
 * hold, and wrappers for the system's unzip / zipinfo / tar.
 */

// ── In-memory source ──

export type FakeNode =
  | { type: 'dir'; children: Record<string, FakeNode>; mode?: number; mtime?: Date; failList?: string }
  | {
      type: 'file';
      /** Literal content, or a generated stream of `size` bytes. */
      data?: Buffer;
      size?: number;
      /** Fill byte pattern for generated content (repeated). */
      pattern?: Buffer;
      mode?: number;
      mtime?: Date;
      /** `open` rejects with this. */
      failOpen?: string;
      /** The stream errors after this many bytes (0 = before any data). */
      failAfter?: number;
      /** Bytes actually produced, when the listing's size is stale. */
      actualSize?: number;
      /** Called with each chunk as it is produced (read-ahead tracking). */
      onRead?: (n: number) => void;
      /** Never produce more data after this many bytes (a stalled remote). */
      stallAfter?: number;
      chunkSize?: number;
    }
  | { type: 'symlink'; target?: string }
  | { type: 'other' };

export const dir = (children: Record<string, FakeNode>, extra: Partial<Extract<FakeNode, { type: 'dir' }>> = {}): FakeNode => ({
  type: 'dir',
  children,
  ...extra,
});
export const file = (data: string | Buffer, extra: Partial<Extract<FakeNode, { type: 'file' }>> = {}): FakeNode => ({
  type: 'file',
  data: typeof data === 'string' ? Buffer.from(data) : data,
  ...extra,
});

export interface FakeWalkerStats {
  opened: string[];
  destroyed: string[];
  closed: boolean;
}

export function fakeWalker(root: FakeNode): FolderWalker & { stats: FakeWalkerStats } {
  const stats: FakeWalkerStats = { opened: [], destroyed: [], closed: false };
  const find = (ref: string): FakeNode => {
    let node = root;
    for (const part of ref.split('\u0001').filter(Boolean)) {
      if (node.type !== 'dir' || !(part in node.children)) throw new Error(`No such file: ${ref}`);
      node = node.children[part]!;
    }
    return node;
  };
  return {
    stats,
    list(ref) {
      const node = find(ref);
      if (node.type !== 'dir') return Promise.reject(new Error('Not a folder'));
      if (node.failList) return Promise.reject(new Error(node.failList));
      return Promise.resolve(
        Object.entries(node.children).map(([name, child]): WalkEntry => {
          const base = { name, ref: `${ref}\u0001${name}` };
          switch (child.type) {
            case 'dir':
              return { ...base, type: 'dir', size: 0, mtime: child.mtime, mode: child.mode };
            case 'file':
              return { ...base, type: 'file', size: child.data?.length ?? child.size ?? 0, mtime: child.mtime, mode: child.mode };
            case 'symlink':
              return { ...base, type: 'symlink', size: 0, linkTarget: child.target };
            default:
              return { ...base, type: 'other', size: 0 };
          }
        }),
      );
    },
    open(entry) {
      const node = find(entry.ref);
      if (node.type !== 'file') return Promise.reject(new Error('Not a file'));
      if (node.failOpen) return Promise.reject(new Error(node.failOpen));
      stats.opened.push(entry.name);
      const stream = generated(node);
      stream.once('close', () => stats.destroyed.push(entry.name));
      return Promise.resolve(stream);
    },
    close() {
      stats.closed = true;
    },
  };
}

/** A pull-based stream: it only produces when read, so a writer that ignores backpressure shows up as read-ahead. */
function generated(node: Extract<FakeNode, { type: 'file' }>): Readable {
  const total = node.actualSize ?? node.data?.length ?? node.size ?? 0;
  const pattern = node.data ?? node.pattern ?? Buffer.alloc(64 * 1024);
  const chunkSize = node.chunkSize ?? 64 * 1024;
  let pos = 0;
  return new Readable({
    highWaterMark: chunkSize,
    read() {
      if (node.failAfter !== undefined && pos >= node.failAfter) {
        this.destroy(new Error('Permission denied (simulated)'));
        return;
      }
      if (node.stallAfter !== undefined && pos >= node.stallAfter) return;
      if (pos >= total) {
        this.push(null);
        return;
      }
      let n = Math.min(chunkSize, total - pos);
      if (node.failAfter !== undefined) n = Math.min(n, node.failAfter - pos);
      if (node.stallAfter !== undefined) n = Math.min(n, node.stallAfter - pos);
      const chunk = Buffer.allocUnsafe(n);
      for (let off = 0; off < n; ) {
        const from = (pos + off) % pattern.length;
        off += pattern.copy(chunk, off, from, Math.min(pattern.length, from + (n - off)));
      }
      pos += n;
      node.onRead?.(n);
      this.push(chunk);
    },
  });
}

/** Expected bytes of a generated file (for comparing with what an archive holds). */
export function expectedContent(node: FakeNode): Buffer {
  if (node.type !== 'file') throw new Error('not a file');
  if (node.data) return node.data.subarray(0, node.actualSize ?? node.data.length);
  const total = node.actualSize ?? node.size ?? 0;
  const pattern = node.pattern ?? Buffer.alloc(64 * 1024);
  const out = Buffer.alloc(total);
  for (let off = 0; off < total; off += pattern.length) pattern.copy(out, off);
  return out;
}

// ── Output capture ──

/** Collects everything written. */
export function collector(): Writable & { result: () => Buffer } {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  }) as Writable & { result: () => Buffer };
  w.result = () => Buffer.concat(chunks);
  return w;
}

// ── Pure-JS zip reader ──

export interface ZipEntryRead {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  offset: number;
  externalAttrs: number;
  madeBy: number;
  versionNeeded: number;
  /** Unix mode from the external attributes. */
  mode: number;
  /** From the extended-timestamp field. */
  mtime?: number;
  /** The entry used the ZIP64 extra in its central header. */
  zip64: boolean;
  data?: Buffer;
}

export interface ZipRead {
  entries: ZipEntryRead[];
  zip64End: boolean;
  centralOffset: number;
}

function parseExtras(extra: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  for (let p = 0; p + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    out.set(id, extra.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  return out;
}

/**
 * Parse the end records and central directory of `tail`, the last bytes of a
 * `total`-byte archive. Throws on any structural inconsistency.
 */
export function readZipCentral(tail: Buffer, total: number): ZipRead {
  const base = total - tail.length;
  const eocd = tail.length - 22;
  if (tail.readUInt32LE(eocd) !== 0x06054b50) throw new Error('no end of central directory at the end');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let zip64End = false;
  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === 0x07064b50) {
    zip64End = true;
    const recOffset = Number(tail.readBigUInt64LE(locator + 8)) - base;
    if (tail.readUInt32LE(recOffset) !== 0x06064b50) throw new Error('ZIP64 locator points at no ZIP64 end record');
    if (recOffset + 56 !== locator) throw new Error('ZIP64 end record is not right before its locator');
    count = Number(tail.readBigUInt64LE(recOffset + 32));
    if (Number(tail.readBigUInt64LE(recOffset + 24)) !== count) throw new Error('ZIP64 entry counts disagree');
    cdSize = Number(tail.readBigUInt64LE(recOffset + 40));
    cdOffset = Number(tail.readBigUInt64LE(recOffset + 48));
    if (cdOffset + cdSize !== recOffset + base) throw new Error('central directory does not end at the ZIP64 end record');
  } else if (cdOffset + cdSize !== eocd + base) {
    throw new Error('central directory does not end at the end record');
  }
  const entries: ZipEntryRead[] = [];
  let p = cdOffset - base;
  for (let i = 0; i < count; i++) {
    if (tail.readUInt32LE(p) !== 0x02014b50) throw new Error(`central header ${i} has a bad signature`);
    const nameLen = tail.readUInt16LE(p + 28);
    const extraLen = tail.readUInt16LE(p + 30);
    const commentLen = tail.readUInt16LE(p + 32);
    const name = tail.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const extras = parseExtras(tail.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
    let compressed = tail.readUInt32LE(p + 20);
    let uncompressed = tail.readUInt32LE(p + 24);
    let offset = tail.readUInt32LE(p + 42);
    const z = extras.get(0x0001);
    let zp = 0;
    const next64 = () => {
      if (!z || zp + 8 > z.length) throw new Error(`${name}: 0xffffffff field without its ZIP64 value`);
      const v = Number(z.readBigUInt64LE(zp));
      zp += 8;
      return v;
    };
    if (uncompressed === 0xffffffff) uncompressed = next64();
    if (compressed === 0xffffffff) compressed = next64();
    if (offset === 0xffffffff) offset = next64();
    if (z && zp !== z.length) throw new Error(`${name}: ZIP64 extra has unexpected fields`);
    const ut = extras.get(0x5455);
    const externalAttrs = tail.readUInt32LE(p + 38);
    entries.push({
      name,
      flags: tail.readUInt16LE(p + 8),
      method: tail.readUInt16LE(p + 10),
      crc: tail.readUInt32LE(p + 16),
      compressed,
      uncompressed,
      offset,
      externalAttrs,
      madeBy: tail.readUInt16LE(p + 4),
      versionNeeded: tail.readUInt16LE(p + 6),
      mode: externalAttrs >>> 16,
      ...(ut && ut.length >= 5 && ut[0]! & 1 ? { mtime: ut.readUInt32LE(1) } : {}),
      zip64: Boolean(z),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== cdOffset - base + cdSize) throw new Error('central directory size does not match its headers');
  return { entries, zip64End, centralOffset: cdOffset };
}

async function inflateCheck(data: Buffer, method: number, keep: boolean): Promise<{ crc: number; size: number; out?: Buffer }> {
  if (method === 0) return { crc: zlib.crc32(data), size: data.length, ...(keep && { out: data }) };
  if (method !== 8) throw new Error(`unknown method ${method}`);
  const inflate = zlib.createInflateRaw();
  let crc = 0;
  let size = 0;
  const kept: Buffer[] = [];
  inflate.on('data', (c: Buffer) => {
    crc = zlib.crc32(c, crc);
    size += c.length;
    if (keep) kept.push(c);
  });
  await new Promise<void>((resolve, reject) => {
    inflate.on('end', resolve);
    inflate.on('error', reject);
    // Fed in slices so a huge inflated output is never held
    for (let off = 0; off < data.length; off += 1 << 20) inflate.write(data.subarray(off, off + (1 << 20)));
    inflate.end();
  });
  return { crc, size, ...(keep && { out: Buffer.concat(kept) }) };
}

/**
 * Read a whole zip held in memory: the central directory, then every local
 * header, data (inflated and CRC-checked) and data descriptor, checking each
 * against the central record and that entries sit back to back.
 * `keepData` holds contents up to that many bytes per entry.
 */
export async function readZip(buf: Buffer, keepData = 16 * 1024 * 1024): Promise<ZipRead> {
  const read = readZipCentral(buf, buf.length);
  let expectedOffset = 0;
  for (const e of read.entries) {
    if (e.offset !== expectedOffset) throw new Error(`${e.name}: local header at ${e.offset}, expected ${expectedOffset}`);
    const p = e.offset;
    if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`${e.name}: bad local signature`);
    const flags = buf.readUInt16LE(p + 6);
    if (flags !== e.flags) throw new Error(`${e.name}: local flags differ`);
    if (buf.readUInt16LE(p + 8) !== e.method) throw new Error(`${e.name}: local method differs`);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    if (buf.subarray(p + 30, p + 30 + nameLen).toString('utf8') !== e.name) throw new Error(`${e.name}: local name differs`);
    const localZip64 = parseExtras(buf.subarray(p + 30 + nameLen, p + 30 + nameLen + extraLen)).has(0x0001);
    const start = p + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.compressed);
    const checked = await inflateCheck(data, e.method, e.uncompressed <= keepData);
    if (checked.size !== e.uncompressed) throw new Error(`${e.name}: inflated to ${checked.size}, expected ${e.uncompressed}`);
    if (checked.crc !== e.crc) throw new Error(`${e.name}: CRC mismatch`);
    if (checked.out) e.data = checked.out;
    let q = start + e.compressed;
    if (flags & 0x0008) {
      if (buf.readUInt32LE(q) !== 0x08074b50) throw new Error(`${e.name}: missing data descriptor`);
      const crc = buf.readUInt32LE(q + 4);
      const [c, u] = localZip64
        ? [Number(buf.readBigUInt64LE(q + 8)), Number(buf.readBigUInt64LE(q + 16))]
        : [buf.readUInt32LE(q + 8), buf.readUInt32LE(q + 12)];
      if (crc !== e.crc || c !== e.compressed || u !== e.uncompressed) throw new Error(`${e.name}: descriptor disagrees`);
      q += localZip64 ? 24 : 16;
    } else if (buf.readUInt32LE(p + 14) !== e.crc) {
      throw new Error(`${e.name}: local CRC differs`);
    }
    expectedOffset = q;
  }
  if (expectedOffset !== read.centralOffset) throw new Error('central directory does not follow the last entry');
  return read;
}

/**
 * Verifies a zip as it streams past, holding only the current header and the
 * central directory: for archives too large to keep. Every entry's stored
 * size must be given in `sizes` (by name) since stored data with a descriptor
 * has no in-band length; only stored (method 0) entries are supported.
 */
export function streamingZipVerifier(sizes: Map<string, number>): Writable & { done: () => ZipRead } {
  let state: 'header' | 'data' | 'descriptor' | 'tail' = 'header';
  let pending: Buffer = Buffer.alloc(0);
  let total = 0;
  let current: { name: string; offset: number; left: number; crc: number; zip64: boolean; size: number } | null = null;
  const seen: { name: string; offset: number; crc: number; size: number }[] = [];
  let tail: Buffer[] = [];
  let failure: Error | null = null;

  const step = (): boolean => {
    if (state === 'header') {
      if (pending.length < 4) return false;
      if (pending.readUInt32LE(0) !== 0x04034b50) {
        state = 'tail';
        tail = [pending];
        pending = Buffer.alloc(0);
        return false;
      }
      if (pending.length < 30) return false;
      const nameLen = pending.readUInt16LE(26);
      const extraLen = pending.readUInt16LE(28);
      if (pending.length < 30 + nameLen + extraLen) return false;
      if (pending.readUInt16LE(8) !== 0) throw new Error('streaming verifier handles stored entries only');
      const name = pending.subarray(30, 30 + nameLen).toString('utf8');
      const size = sizes.get(name);
      if (size === undefined) throw new Error(`unexpected entry ${name}`);
      const zip64 = parseExtras(pending.subarray(30 + nameLen, 30 + nameLen + extraLen)).has(0x0001);
      current = { name, offset: total - pending.length, left: size, crc: 0, zip64, size };
      pending = pending.subarray(30 + nameLen + extraLen);
      state = 'data';
      return true;
    }
    if (state === 'data') {
      const take = Math.min(current!.left, pending.length);
      current!.crc = zlib.crc32(pending.subarray(0, take), current!.crc);
      current!.left -= take;
      pending = pending.subarray(take);
      if (current!.left > 0) return false;
      state = 'descriptor';
      return true;
    }
    const need = current!.zip64 ? 24 : 16;
    if (pending.length < need) return false;
    if (pending.readUInt32LE(0) !== 0x08074b50) throw new Error(`${current!.name}: missing descriptor`);
    if (pending.readUInt32LE(4) !== current!.crc) throw new Error(`${current!.name}: descriptor CRC differs from the data`);
    seen.push({ name: current!.name, offset: current!.offset, crc: current!.crc, size: current!.size });
    pending = pending.subarray(need);
    state = 'header';
    return true;
  };

  const w = new Writable({
    write(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (failure) return cb();
      try {
        if (state === 'tail') {
          tail.push(chunk);
        } else {
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          // `step` moves the state on; TypeScript cannot see that
          while ((state as string) !== 'tail' && step());
        }
      } catch (err) {
        failure = err as Error;
      }
      cb();
    },
  }) as Writable & { done: () => ZipRead };
  w.done = () => {
    if (failure) throw failure;
    const read = readZipCentral(Buffer.concat(tail), total);
    if (read.entries.length !== seen.length) throw new Error('central directory and stream disagree on entry count');
    read.entries.forEach((e, i) => {
      const s = seen[i]!;
      if (e.name !== s.name || e.offset !== s.offset || e.crc !== s.crc || e.uncompressed !== s.size || e.compressed !== s.size) {
        throw new Error(`${e.name}: central record disagrees with the stream`);
      }
    });
    return read;
  };
  return w;
}

// ── Pure-JS tar.gz reader ──

export interface TarEntryRead {
  name: string;
  type: string;
  size: number;
  mode: number;
  mtime: number;
  linkName: string;
  data: Buffer;
}

export function readTarGz(gz: Buffer): TarEntryRead[] {
  const buf = zlib.gunzipSync(gz);
  const entries: TarEntryRead[] = [];
  const str = (b: Buffer) => {
    const nul = b.indexOf(0);
    return b.subarray(0, nul === -1 ? b.length : nul).toString('utf8');
  };
  const num = (b: Buffer) => (b[0]! & 0x80 ? Number(b.readBigUInt64BE(b.length - 8)) : parseInt(str(b).trim() || '0', 8));
  let pax: Record<string, string> = {};
  let p = 0;
  let sawEnd = false;
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) {
      if (buf.subarray(p + 512, p + 1024).every((b) => b === 0) && p + 1024 <= buf.length) sawEnd = true;
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== parseInt(str(h.subarray(148, 156)).trim(), 8)) throw new Error(`bad checksum at ${p}`);
    if (str(h.subarray(257, 263)) !== 'ustar') throw new Error('not ustar');
    const type = String.fromCharCode(h[156]!);
    let size = num(h.subarray(124, 136));
    if (pax.size) size = Number(pax.size);
    const data = buf.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = {};
      let q = 0;
      const text = data;
      while (q < text.length) {
        const sp = text.indexOf(0x20, q);
        const len = parseInt(text.subarray(q, sp).toString('ascii'), 10);
        const rec = text.subarray(sp + 1, q + len - 1).toString('utf8');
        if (text[q + len - 1] !== 0x0a) throw new Error('PAX record length is wrong');
        const eq = rec.indexOf('=');
        pax[rec.slice(0, eq)] = rec.slice(eq + 1);
        q += len;
      }
      continue;
    }
    entries.push({
      name: pax.path ?? str(h.subarray(0, 100)),
      type,
      size,
      mode: num(h.subarray(100, 108)),
      mtime: pax.mtime ? Number(pax.mtime) : num(h.subarray(136, 148)),
      linkName: pax.linkpath ?? str(h.subarray(157, 257)),
      data: Buffer.from(data),
    });
    pax = {};
  }
  if (!sawEnd) throw new Error('no end-of-archive blocks');
  return entries;
}

// ── System tools ──

export function hasTool(name: string): boolean {
  return spawnSync('which', [name], { stdio: 'ignore' }).status === 0;
}

/** Run a tool, returning stdout; throws with its output on a non-zero exit. */
export function run(cmd: string, args: string[], opts: { cwd?: string; maxBuffer?: number } = {}): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    ...(opts.cwd && { cwd: opts.cwd }),
  });
}
