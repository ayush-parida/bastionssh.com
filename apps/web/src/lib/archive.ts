/**
 * Deploy sources packed in the browser (deployments spec §7): the server
 * takes one `.tar` / `.tar.gz` upload, so a chosen folder or a `.zip` is
 * turned into a gzipped tar here first. Dependencies and build output a
 * server builds again (`node_modules`, `.next`, `.git`) are left out, and a
 * single top-level folder (a zip of `my-app/`, or the folder picked itself)
 * is dropped so the project root is the upload's root, where `build.dir: .`
 * looks.
 *
 * Only regular files go in. bastionctl checks every entry again when it
 * extracts (no absolute names, no `..`, size and count caps).
 */

import { checkDeploySource, deploySourceViewFromPaths, joinSourcePath, type DeployAppConfig, type DeploySourceProblem } from '@smt/shared';

/** Folders never uploaded, at any depth. */
export const EXCLUDED_DIRS = ['node_modules', '.next', '.git'] as const;

export interface SourceEntry {
  /** Relative, `/`-separated. */
  path: string;
  data: Blob;
  /** Unix permission bits; 0644 when unknown. */
  mode: number;
}

export interface PackedSource {
  blob: Blob;
  files: number;
  /** Bytes before compression. */
  bytes: number;
  /** Entries left out (excluded folders, links). */
  skipped: number;
}

/** True for a path inside one of {@link EXCLUDED_DIRS}. */
export function isExcluded(path: string): boolean {
  return path.split('/').some((seg) => (EXCLUDED_DIRS as readonly string[]).includes(seg));
}

const clean = (path: string) => path.replace(/\\/g, '/').replace(/^\.?\/+/, '');

/**
 * macOS metadata a Finder-made zip carries next to the folder itself
 * (`__MACOSX/my-app/._package.json`). Left out before the top-level folder is
 * looked for, or `my-app/` would stay and the project root be one level down.
 */
const isMacMetadata = (path: string) => path.split('/')[0] === '__MACOSX';

/**
 * Drop a top-level folder every entry shares, and anything excluded.
 * `others` are paths already left out, which still count when deciding
 * whether there is a single top-level folder.
 */
export function normalizeEntries<T extends SourceEntry>(entries: T[], others: string[] = []): { entries: T[]; skipped: number } {
  const files = entries.map((e) => ({ ...e, path: clean(e.path) })).filter((e) => e.path && !e.path.endsWith('/'));
  const cleaned = files.filter((e) => !isMacMetadata(e.path));
  const all = [...cleaned.map((e) => e.path), ...others.map(clean).filter((path) => path && !isMacMetadata(path))];
  const tops = new Set(all.map((path) => path.split('/')[0]));
  const strip = tops.size === 1 && all.every((path) => path.includes('/'));
  const out: T[] = [];
  let skipped = files.length - cleaned.length;
  for (const e of cleaned) {
    const path = strip ? e.path.slice(e.path.indexOf('/') + 1) : e.path;
    if (isExcluded(path)) skipped++;
    else out.push({ ...e, path });
  }
  return { entries: out, skipped };
}

// ── tar (ustar, with a PAX header for names ustar cannot hold) ────────────────

const BLOCK = 512;
const encoder = new TextEncoder();

function writeString(buf: Uint8Array, offset: number, length: number, value: string) {
  buf.set(encoder.encode(value).subarray(0, length), offset);
}

function writeOctal(buf: Uint8Array, offset: number, length: number, value: number) {
  writeString(buf, offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
}

function header(name: string, size: number, mode: number, type: '0' | 'x', mtime: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(BLOCK);
  writeString(buf, 0, 100, name);
  writeOctal(buf, 100, 8, mode & 0o777);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, mtime);
  buf.fill(0x20, 148, 156);
  buf[156] = type.charCodeAt(0);
  writeString(buf, 257, 6, 'ustar\0');
  writeString(buf, 263, 2, '00');
  let sum = 0;
  for (const b of buf) sum += b;
  writeString(buf, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return buf;
}

/** One PAX record: `<len> path=<name>\n`, where len counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const base = encoder.encode(body).length;
  let len = base + String(base).length;
  // Adding the digits can add a digit (98 + 2 → 100)
  if (String(len).length > String(base).length) len = base + String(len).length;
  return `${len}${body}`;
}

const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** The entries as a tar archive (not compressed). File data is referenced, not copied. */
export function tarBlob(entries: SourceEntry[], mtime = Math.floor(Date.now() / 1000)): Blob {
  const parts: BlobPart[] = [];
  for (const e of entries) {
    const nameBytes = encoder.encode(e.path).length;
    // Plain ASCII up to 100 bytes fits the ustar name field; anything else gets a PAX path
    if (nameBytes > 100 || /[^\x20-\x7e]/.test(e.path)) {
      const pax = encoder.encode(paxRecord('path', e.path));
      parts.push(header('PaxHeader', pax.length, 0o644, 'x', mtime), pax, padding(pax.length));
    }
    parts.push(header(e.path.slice(0, 100), e.data.size, e.mode, '0', mtime), e.data, padding(e.data.size));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return new Blob(parts, { type: 'application/x-tar' });
}

async function gzip(blob: Blob): Promise<Blob> {
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

async function pack(entries: SourceEntry[], skipped: number, others: string[] = []): Promise<PackedSource> {
  const normal = normalizeEntries(entries, others);
  if (normal.entries.length === 0) throw new Error('Nothing to upload: every file is in node_modules, .next or .git, or the source is empty');
  const tar = tarBlob(normal.entries);
  return {
    blob: await gzip(tar),
    files: normal.entries.length,
    bytes: normal.entries.reduce((n, e) => n + e.data.size, 0),
    skipped: skipped + normal.skipped,
  };
}

/** A folder from `<input webkitdirectory>`: paths come from `webkitRelativePath`. */
export function packFolder(files: File[]): Promise<PackedSource> {
  return pack(
    files.map((f) => ({ path: f.webkitRelativePath || f.name, data: f, mode: 0o644 })),
    0,
  );
}

// ── zip (read only: stored and deflated entries, no zip64) ────────────────────

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

async function inflate(data: Blob): Promise<Blob> {
  return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
}

interface ZipRecord {
  name: string;
  /** Unix file type and mode bits, 0 when the zip was not made on Unix. */
  unixMode: number;
  method: number;
  compressed: number;
  localOffset: number;
}

/** The central directory of a zip: every entry's name and where its data is, without reading any. */
async function zipDirectory(file: Blob): Promise<ZipRecord[]> {
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes
  const tailStart = Math.max(0, file.size - (0xffff + 22));
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not a zip file (or it is damaged)');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported; upload a .tar.gz instead');

  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const decoder = new TextDecoder();
  const records: ZipRecord[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged');
    const madeBy = cd.getUint16(p + 4, true) >> 8;
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const external = cd.getUint32(p + 38, true);
    records.push({
      name: decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen)),
      // Unix-made zips keep the file type and mode in the high bits
      unixMode: madeBy === 3 ? external >>> 16 : 0,
      method: cd.getUint16(p + 10, true),
      compressed: cd.getUint32(p + 20, true),
      localOffset: cd.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return records;
}

/** Folders are skipped; links, devices and excluded paths are left out (their names kept in `left`). */
function zipFiles(records: ZipRecord[]): { files: ZipRecord[]; left: string[] } {
  const files: ZipRecord[] = [];
  const left: string[] = [];
  for (const r of records) {
    const type = r.unixMode & S_IFMT;
    if (r.name.endsWith('/') || type === S_IFDIR) continue;
    if ((r.unixMode && type !== S_IFREG) || isExcluded(r.name)) left.push(r.name);
    else files.push(r);
  }
  return { files, left };
}

async function zipData(file: Blob, r: ZipRecord): Promise<Blob> {
  const local = new DataView(await file.slice(r.localOffset, r.localOffset + 30).arrayBuffer());
  if (local.getUint32(0, true) !== 0x04034b50) throw new Error('The zip file is damaged');
  const dataStart = r.localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const raw = file.slice(dataStart, dataStart + r.compressed);
  if (r.method === 0) return raw;
  if (r.method === 8) return inflate(raw);
  throw new Error(`${r.name} uses a zip compression method this browser cannot read; upload a .tar.gz instead`);
}

/** The files of a zip archive, decompressed. Links and folders are left out. */
export async function readZip(file: Blob): Promise<{ entries: SourceEntry[]; skipped: number; left: string[] }> {
  const { files, left } = zipFiles(await zipDirectory(file));
  const entries: SourceEntry[] = [];
  // Left out before reading their data; still part of the layout
  for (const r of files) entries.push({ path: r.name, data: await zipData(file, r), mode: r.unixMode ? r.unixMode & 0o777 : 0o644 });
  return { entries, skipped: left.length, left };
}

export async function packZip(file: File): Promise<PackedSource> {
  const { entries, skipped, left } = await readZip(file);
  return pack(entries, skipped, left);
}

/** `.tar`, `.tar.gz` and `.tgz` go up as they are. */
export function isTarball(name: string): boolean {
  return /\.(tar|tar\.gz|tgz)$/i.test(name);
}

// ── Sanity check before uploading ─────────────────────────────────────────────

/**
 * What a folder or zip would upload, checked against the app's build settings
 * before anything is packed or sent (the shared check bastionctl runs again on
 * the server): Next's `.next` folder as a static site, a package.json without
 * a build script, an output folder that is not there. Only package.json is
 * read, and only when the check needs it.
 */
export async function checkSource(
  source: { kind: 'folder'; files: File[] } | { kind: 'zip'; file: File },
  build: Pick<DeployAppConfig['build'], 'type' | 'dir' | 'output'>,
): Promise<DeploySourceProblem | null> {
  type Listed = SourceEntry & { read: () => Promise<Blob> };
  let listed: Listed[];
  let others: string[] = [];
  if (source.kind === 'folder') {
    listed = source.files.map((f) => ({ path: f.webkitRelativePath || f.name, data: f, mode: 0o644, read: async () => f }));
  } else {
    const { files, left } = zipFiles(await zipDirectory(source.file));
    others = left;
    listed = files.map((r) => ({ path: r.name, data: new Blob(), mode: 0o644, read: () => zipData(source.file, r) }));
  }
  const { entries } = normalizeEntries(listed, others);
  const packageJson = joinSourcePath(build.dir, 'package.json');
  const texts: Record<string, string> = {};
  const pkg = entries.find((e) => e.path === packageJson);
  // A package.json too large to be one is reported as unreadable rather than read
  if (pkg) {
    const blob = await pkg.read();
    texts[packageJson] = blob.size <= 1024 * 1024 ? await blob.text() : '';
  }
  return checkDeploySource(deploySourceViewFromPaths(entries.map((e) => e.path), texts), build);
}
