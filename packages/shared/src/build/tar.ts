import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { isInside } from './dockerfiles.js';
import { DeployBuildError } from './errors.js';

/**
 * Reading uploaded sources and writing build contexts (deployments spec §5
 * step 2, §8). Extraction is done here rather than with `tar`, so every entry
 * is checked before anything is written:
 *
 * - only files, directories and symbolic links (no hard links, devices or FIFOs);
 * - no absolute names and no `..` segments;
 * - nothing written through a symbolic link — every parent of an entry must be
 *   a real directory we created — and no entry replaces a link;
 * - each symbolic link must, followed on disk, stay inside the extraction;
 * - a cap on total bytes and on the number of entries;
 * - modes keep only rwx bits (no setuid, setgid or sticky), files owned by
 *   whoever runs bastionctl.
 *
 * A failed extraction is removed entirely.
 *
 * Shared by bastionctl (uploads built on the server) and BastionSSH's builder
 * (uploads built on its side). `skip` leaves files out by name — environment
 * files, unless the person deploying included them — and the result names
 * them, for the build log.
 */

export const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
export const DEFAULT_MAX_ENTRIES = 200_000;
const BLOCK = 512;
const MAX_LINK_HOPS = 40;

export interface ExtractLimits {
  maxBytes?: number;
  maxEntries?: number;
  /** Files (and links) to leave out, by their path in the upload: not written, their bytes not counted. */
  skip?: (path: string) => boolean;
}

/** At most this many skipped paths are named in the result (all are counted). */
export const MAX_SKIPPED_NAMES = 50;

export interface ExtractResult {
  files: number;
  bytes: number;
  /** The paths `skip` left out (the first {@link MAX_SKIPPED_NAMES}). */
  skipped: string[];
  skippedCount: number;
}

interface Header {
  name: string;
  mode: number;
  size: number;
  type: string;
  linkname: string;
}

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, length: number): number {
  const field = buf.subarray(start, start + length);
  // GNU base-256 for large values
  if (field[0]! & 0x80) {
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    return value;
  }
  const text = cString(buf, start, length).trim();
  return text ? parseInt(text, 8) : 0;
}

function parseHeader(block: Buffer): Header | null {
  if (block.every((b) => b === 0)) return null;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  if (sum !== octal(block, 148, 8)) throw new DeployBuildError('The upload is not a valid tar archive (bad header checksum)');
  const magic = cString(block, 257, 6);
  const prefix = magic.startsWith('ustar') ? cString(block, 345, 155) : '';
  const name = cString(block, 0, 100);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: octal(block, 100, 8),
    size: octal(block, 124, 12),
    type: String.fromCharCode(block[156]! || 48),
    linkname: cString(block, 157, 100),
  };
}

/** pax extended header records: `<len> key=value\n`. */
export function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const len = parseInt(data.subarray(i, space).toString('utf8'), 10);
    if (!(len > 0)) break;
    const record = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/** The entry's path relative to the extraction root, or an error naming why it is refused. */
export function safeEntryName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  if (raw.length > 4096 || /[\0-\x1f]/.test(raw)) throw new DeployBuildError(`Refused entry with an unusable name: ${JSON.stringify(raw.slice(0, 200))}`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new DeployBuildError(`Refused absolute path in the upload: ${raw}`);
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new DeployBuildError(`Refused path with .. in the upload: ${raw}`);
  return parts.join('/');
}

/** Every directory between `root` and `target` must be a real directory (never a link). */
function assertRealParents(root: string, rel: string) {
  const parts = rel.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      fs.mkdirSync(current, { mode: 0o755 });
      continue;
    }
    if (stat.isSymbolicLink()) throw new DeployBuildError(`Refused entry inside a symbolic link: ${rel}`);
    if (!stat.isDirectory()) throw new DeployBuildError(`Refused entry below a file: ${rel}`);
  }
}

/**
 * Where the link at `link` leads, followed on disk one component at a time;
 * throws when any step leaves `root`. A dangling remainder is resolved by name.
 */
export function assertLinkInside(root: string, link: string): void {
  let hops = 0;
  let current = path.dirname(link);
  const first = fs.readlinkSync(link);
  if (path.isAbsolute(first)) throw new DeployBuildError(`Refused symbolic link to an absolute path: ${path.relative(root, link)} -> ${first}`);
  const queue = first.split('/');
  while (queue.length > 0) {
    const part = queue.shift()!;
    if (part === '' || part === '.') continue;
    current = part === '..' ? path.dirname(current) : path.join(current, part);
    if (!isInside(root, current)) {
      throw new DeployBuildError(`Refused symbolic link leading outside the upload: ${path.relative(root, link)} -> ${first}`);
    }
    if (part === '..') continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue; // dangling from here on: the rest is checked by name
    }
    if (stat.isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) throw new DeployBuildError(`Refused symbolic link loop: ${path.relative(root, link)}`);
      const next = fs.readlinkSync(current);
      if (path.isAbsolute(next)) throw new DeployBuildError(`Refused symbolic link to an absolute path: ${path.relative(root, current)} -> ${next}`);
      current = path.dirname(current);
      queue.unshift(...next.split('/'));
    }
  }
}

/**
 * Extract a tar or tar.gz file into `dest` (created; must not exist). On any
 * refusal or error the partial extraction is removed and the error rethrown.
 */
export async function extractTar(file: string, dest: string, limits: ExtractLimits = {}): Promise<ExtractResult> {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  fs.mkdirSync(dest, { recursive: false, mode: 0o755 });
  const root = fs.realpathSync(dest);

  const head = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  const gz = head[0] === 0x1f && head[1] === 0x8b;

  const links: string[] = [];
  const skipped: string[] = [];
  let skippedCount = 0;
  let entries = 0;
  let bytes = 0;
  let pending: Buffer = Buffer.alloc(0);
  let header: Header | null = null;
  let remaining = 0;
  let padding = 0;
  let out: number | null = null;
  let meta: Buffer[] | null = null;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;
  let ended = false;

  const begin = (h: Header) => {
    if (h.type === 'x' || h.type === 'g' || h.type === 'L' || h.type === 'K') {
      meta = [];
      return;
    }
    if (++entries > maxEntries) throw new DeployBuildError(`The upload has more than ${maxEntries} entries`);
    const rel = safeEntryName(pax.path ?? longName ?? h.name);
    const linkname = pax.linkpath ?? longLink ?? h.linkname;
    pax = {};
    longName = null;
    longLink = null;
    if (rel === '') return; // the archive's own root
    if ((h.type === '0' || h.type === '7' || h.type === '2') && limits.skip?.(rel)) {
      // Its data (if any) is read past, never written
      if (skippedCount++ < MAX_SKIPPED_NAMES) skipped.push(rel);
      return;
    }
    const target = path.join(root, rel);
    assertRealParents(root, rel);
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(target);
    } catch {
      // new
    }
    if (existing?.isSymbolicLink()) throw new DeployBuildError(`Refused entry replacing a symbolic link: ${rel}`);
    const mode = h.mode & 0o777;
    switch (h.type) {
      case '0':
      case '7':
        if (existing?.isDirectory()) throw new DeployBuildError(`Refused file replacing a directory: ${rel}`);
        out = fs.openSync(target, 'w', (mode & 0o755) | 0o600);
        return;
      case '5':
        if (!existing) fs.mkdirSync(target, { mode: 0o755 });
        else if (!existing.isDirectory()) throw new DeployBuildError(`Refused directory replacing a file: ${rel}`);
        return;
      case '2':
        if (existing) throw new DeployBuildError(`Refused symbolic link replacing an entry: ${rel}`);
        if (!linkname || linkname.includes('\0') || path.isAbsolute(linkname)) throw new DeployBuildError(`Refused symbolic link to an absolute path: ${rel} -> ${linkname}`);
        fs.symlinkSync(linkname, target);
        links.push(target);
        return;
      case '1':
        throw new DeployBuildError(`Refused hard link in the upload: ${rel} (archive without hard links, e.g. tar --hard-dereference)`);
      default:
        throw new DeployBuildError(`Refused special file in the upload: ${rel} (type ${h.type})`);
    }
  };

  const finishEntry = () => {
    if (out !== null) {
      fs.closeSync(out);
      out = null;
    }
    if (meta && header) {
      const data = Buffer.concat(meta);
      if (header.type === 'x') pax = parsePax(data);
      else if (header.type === 'L') longName = cString(data, 0, data.length);
      else if (header.type === 'K') longLink = cString(data, 0, data.length);
      meta = null;
    }
    header = null;
  };

  const consume = (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    while (!ended) {
      if (header) {
        if (remaining > 0) {
          const take = Math.min(remaining, pending.length - offset);
          if (take === 0) break;
          const part = pending.subarray(offset, offset + take);
          if (meta) {
            if (meta.reduce((n, b) => n + b.length, 0) + part.length > 1024 * 1024) throw new DeployBuildError('The upload has an oversized extended header');
            meta.push(Buffer.from(part));
          } else if (out !== null) {
            bytes += part.length;
            if (bytes > maxBytes) throw new DeployBuildError(`The upload unpacks to more than ${Math.round(maxBytes / 1024 ** 2)} MiB`);
            fs.writeSync(out, part);
          }
          remaining -= take;
          offset += take;
          continue;
        }
        if (padding > 0) {
          const take = Math.min(padding, pending.length - offset);
          if (take === 0) break;
          padding -= take;
          offset += take;
          continue;
        }
        finishEntry();
        continue;
      }
      if (pending.length - offset < BLOCK) break;
      const block = pending.subarray(offset, offset + BLOCK);
      offset += BLOCK;
      const h = parseHeader(block);
      if (!h) {
        ended = true;
        break;
      }
      header = h;
      // Only regular files and metadata carry data
      remaining = ['0', '7', 'x', 'g', 'L', 'K'].includes(h.type) ? h.size : 0;
      padding = remaining % BLOCK === 0 ? 0 : BLOCK - (remaining % BLOCK);
      begin(h);
    }
    pending = pending.subarray(offset);
  };

  try {
    const source = fs.createReadStream(file);
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        try {
          consume(chunk);
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
    });
    if (gz) await pipeline(source, zlib.createGunzip(), sink);
    else await pipeline(source, sink);
    if (header && (remaining > 0 || padding > 0)) throw new DeployBuildError('The upload is truncated');
    finishEntry();
    if (entries === 0) throw new DeployBuildError('The upload is empty');
    for (const link of links) assertLinkInside(root, link);
    return { files: entries - skippedCount, bytes, skipped, skippedCount };
  } catch (err) {
    if (out !== null) fs.closeSync(out);
    fs.rmSync(dest, { recursive: true, force: true });
    if (err instanceof DeployBuildError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'Z_DATA_ERROR') throw new DeployBuildError('The upload is not a valid gzip file');
    throw err;
  }
}
