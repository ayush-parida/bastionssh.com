import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  assertLinkInside as sharedAssertLinkInside,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  DeployBuildError,
  extractTar as sharedExtractTar,
  MAX_SKIPPED_NAMES,
  parsePax,
  safeEntryName as sharedSafeEntryName,
  type ExtractLimits,
  type ExtractResult,
} from '@smt/shared/build';
import { BastionError } from './names.js';

/**
 * Reading uploaded sources and writing build contexts (deployments spec §5
 * step 2, §8). Extraction — every entry checked before anything is written
 * (only files, folders and links that stay inside; no `..`, no absolute
 * names, nothing written through a link; caps on bytes and entries) — lives
 * in @smt/shared (`src/build/tar.ts`), shared with BastionSSH's builder;
 * here its refusals become bastionctl errors. Writing (build contexts,
 * fixtures, a backup copied into a container) is bastionctl's own.
 */

export { DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, MAX_SKIPPED_NAMES, parsePax, type ExtractLimits, type ExtractResult };

const BLOCK = 512;

async function asBastion<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DeployBuildError) throw new BastionError(err.message);
    throw err;
  }
}

function asBastionSync<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DeployBuildError) throw new BastionError(err.message);
    throw err;
  }
}

/** The entry's path relative to the extraction root, or an error naming why it is refused. */
export function safeEntryName(raw: string): string {
  return asBastionSync(() => sharedSafeEntryName(raw));
}

/** Where the link at `link` leads, followed on disk one component at a time; throws when any step leaves `root`. */
export function assertLinkInside(root: string, link: string): void {
  asBastionSync(() => sharedAssertLinkInside(root, link));
}

/**
 * Extract a tar or tar.gz file into `dest` (created; must not exist). On any
 * refusal or error the partial extraction is removed and the error rethrown.
 */
export function extractTar(file: string, dest: string, limits: ExtractLimits = {}): Promise<ExtractResult> {
  return asBastion(() => sharedExtractTar(file, dest, limits));
}

// ── Writing ────────────────────────────────────────────────────────────────

export interface ExtraFile {
  name: string;
  content: string | Buffer;
}

function headerBlock(name: string, opts: { size: number; mode: number; type: string; linkname?: string; mtime: number }): Buffer {
  const block = Buffer.alloc(BLOCK);
  const write = (value: string, start: number, length: number) => block.write(value, start, length, 'utf8');
  const num = (value: number, start: number, length: number) => write(value.toString(8).padStart(length - 1, '0') + '\0', start, length);
  write(name, 0, 100);
  num(opts.mode, 100, 8);
  num(0, 108, 8);
  num(0, 116, 8);
  num(opts.size, 124, 12);
  num(opts.mtime, 136, 12);
  block.fill(0x20, 148, 156);
  write(opts.type, 156, 1);
  if (opts.linkname) write(opts.linkname, 157, 100);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i]!;
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

function* entryBlocks(name: string, opts: { size: number; mode: number; type: string; linkname?: string; mtime: number }): Generator<Buffer> {
  const long = Buffer.byteLength(name) > 99 || (opts.linkname !== undefined && Buffer.byteLength(opts.linkname) > 99);
  if (long) {
    const records = Buffer.from(paxRecord('path', name) + (opts.linkname !== undefined ? paxRecord('linkpath', opts.linkname) : ''));
    yield headerBlock('././@PaxHeader', { size: records.length, mode: 0o644, type: 'x', mtime: opts.mtime });
    yield* padded(records);
  }
  yield headerBlock(long ? name.slice(0, 99) : name, { ...opts, linkname: long ? undefined : opts.linkname });
}

function* padded(data: Buffer): Generator<Buffer> {
  yield data;
  const rest = data.length % BLOCK;
  if (rest) yield Buffer.alloc(BLOCK - rest);
}

/**
 * A tar stream of `dir` (links kept as links, never followed), with `extra`
 * files added at its root (they replace files of the same name) and the
 * top-level names in `exclude` left out. Used as a Docker build context.
 */
export function packDirectory(dir: string, extra: ExtraFile[] = [], exclude: string[] = []): Readable {
  const extraNames = new Set(extra.map((f) => f.name));
  const mtime = Math.floor(Date.now() / 1000);
  async function* generate(): AsyncGenerator<Buffer> {
    const walk = async function* (rel: string): AsyncGenerator<Buffer> {
      const abs = path.join(dir, rel);
      const names = fs.readdirSync(abs).sort();
      for (const name of names) {
        const childRel = rel ? `${rel}/${name}` : name;
        if (!rel && (exclude.includes(name) || extraNames.has(name))) continue;
        const childAbs = path.join(abs, name);
        const stat = fs.lstatSync(childAbs);
        const mode = stat.mode & 0o755;
        if (stat.isSymbolicLink()) {
          yield* entryBlocks(childRel, { size: 0, mode: 0o777, type: '2', linkname: fs.readlinkSync(childAbs), mtime });
        } else if (stat.isDirectory()) {
          yield* entryBlocks(`${childRel}/`, { size: 0, mode: mode | 0o700, type: '5', mtime });
          yield* walk(childRel);
        } else if (stat.isFile()) {
          yield* entryBlocks(childRel, { size: stat.size, mode: mode | 0o600, type: '0', mtime });
          let written = 0;
          for await (const chunk of fs.createReadStream(childAbs) as AsyncIterable<Buffer>) {
            written += chunk.length;
            yield chunk;
          }
          if (written !== stat.size) throw new BastionError(`${childRel} changed while it was being packed`);
          const rest = written % BLOCK;
          if (rest) yield Buffer.alloc(BLOCK - rest);
        }
      }
    };
    yield* walk('');
    for (const file of extra) {
      const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
      yield* entryBlocks(file.name, { size: data.length, mode: 0o644, type: '0', mtime });
      yield* padded(data);
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  return Readable.from(generate());
}

/** Build a tar archive in memory from entries — for tests and small fixtures. */
export function tarBuffer(entries: Array<{ name: string; type?: '0' | '5' | '2' | '1' | '3'; content?: string; linkname?: string; mode?: number }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.content ?? '');
    const type = e.type ?? '0';
    const size = type === '0' ? data.length : 0;
    for (const block of entryBlocks(e.name, { size, mode: e.mode ?? 0o644, type, linkname: e.linkname, mtime: 0 })) parts.push(block);
    if (size) for (const block of padded(data)) parts.push(block);
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/**
 * A tar stream of one regular file named `name`, its bytes read from `file`
 * (a backup copied into a container for a restore): no size limit, nothing
 * held in memory.
 */
export function tarOneFile(name: string, file: string, mode = 0o644): Readable {
  const size = fs.statSync(file).size;
  async function* generate(): AsyncGenerator<Buffer> {
    yield* entryBlocks(name, { size, mode, type: '0', mtime: Math.floor(Date.now() / 1000) });
    let written = 0;
    for await (const chunk of fs.createReadStream(file) as AsyncIterable<Buffer>) {
      written += chunk.length;
      yield chunk;
    }
    if (written !== size) throw new BastionError(`${name} changed while it was being copied`);
    const rest = written % BLOCK;
    if (rest) yield Buffer.alloc(BLOCK - rest);
    yield Buffer.alloc(BLOCK * 2);
  }
  return Readable.from(generate());
}
