import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import {
  collector,
  dir,
  expectedContent,
  fakeWalker,
  file,
  hasTool,
  readTarGz,
  readZip,
  run,
  streamingZipVerifier,
  type FakeNode,
} from './archive.test-helper.js';
import { SKIPPED_NOTE, TRUNCATED_NOTE, writeFolderArchive, type FolderArchiveOptions } from './driver.js';
import { contentDisposition, sanitizeSegment } from './names.js';
import type { ArchiveFormat } from './types.js';
import { paxRecord } from './tar.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const HAS_UNZIP = hasTool('unzip') && hasTool('zipinfo');
const HAS_TAR = hasTool('tar');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-archive-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const tmpFile = (buf: Buffer, ext: string) => {
  const p = path.join(tmp, `a${++seq}.${ext}`);
  fs.writeFileSync(p, buf);
  return p;
};

async function build(root: FakeNode, format: ArchiveFormat, opts: Partial<FolderArchiveOptions> = {}) {
  const walker = fakeWalker(root);
  const out = collector();
  const summary = await writeFolderArchive(walker, out, {
    format,
    rootRef: '',
    maxBytes: 10 * GiB,
    maxFiles: 100_000,
    signal: new AbortController().signal,
    ...opts,
  });
  return { summary, buf: out.result(), stats: walker.stats };
}

const MTIME = new Date('2024-05-06T07:08:10Z');
const UNICODE = 'résumé – 日本語 🚀.txt';

/** A tree with nesting, an empty folder, unicode, modes and mtimes. */
function sampleTree(): FakeNode {
  return dir({
    'readme.md': file('# hello\n'.repeat(500), { mtime: MTIME, mode: 0o644 }),
    'run.sh': file('#!/bin/sh\necho hi\n', { mode: 0o755, mtime: MTIME }),
    [UNICODE]: file('unicode content'),
    empty: dir({}, { mode: 0o700, mtime: MTIME }),
    'empty-file.txt': file(''),
    nested: dir({
      deeper: dir({ 'data.bin': file(randomBytes(100_000)) }),
      'photo.jpg': file(Buffer.alloc(50_000, 7)),
    }),
  });
}

describe('names', () => {
  it('keeps ordinary names and neutralises separators, control characters and dot segments', () => {
    expect(sanitizeSegment('report 2024.pdf')).toBe('report 2024.pdf');
    expect(sanitizeSegment(UNICODE)).toBe(UNICODE);
    expect(sanitizeSegment('a/b')).toBe('a_b');
    expect(sanitizeSegment('..\\..\\evil')).toBe('.._.._evil');
    expect(sanitizeSegment('nul\0byte\n')).toBe('nul_byte_');
    expect(sanitizeSegment('..')).toBeNull();
    expect(sanitizeSegment('.')).toBeNull();
    expect(sanitizeSegment('')).toBeNull();
  });

  it('builds an RFC 5987 Content-Disposition with an ASCII fallback', () => {
    expect(contentDisposition('logs.zip')).toBe(`attachment; filename="logs.zip"; filename*=UTF-8''logs.zip`);
    expect(contentDisposition('été "x".tar.gz')).toBe(
      `attachment; filename="_t_ _x_.tar.gz"; filename*=UTF-8''%C3%A9t%C3%A9%20%22x%22.tar.gz`,
    );
  });

  it('writes PAX records whose length counts its own digits', () => {
    for (const v of ['a', 'x'.repeat(90), 'x'.repeat(94), 'x'.repeat(995)]) {
      const rec = paxRecord('path', v);
      expect(Number(rec.toString().split(' ')[0])).toBe(rec.length);
    }
  });
});

describe('zip writer', () => {
  it('writes a valid archive: nesting, empty folders, unicode names, modes and mtimes', async () => {
    const tree = sampleTree();
    const { summary, buf } = await build(tree, 'zip');
    expect(summary).toEqual({ files: 6, bytes: expect.any(Number), skipped: 0, truncated: false, aborted: false });

    const zip = await readZip(buf);
    const byName = new Map(zip.entries.map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual(
      ['empty-file.txt', 'empty/', 'nested/', 'nested/deeper/', 'nested/deeper/data.bin', 'nested/photo.jpg', 'readme.md', UNICODE, 'run.sh'].sort(),
    );
    expect(zip.zip64End).toBe(false);
    for (const e of zip.entries) {
      expect(e.flags & 0x0800).toBe(0x0800);
      expect(e.madeBy >> 8).toBe(3);
    }
    expect(byName.get('run.sh')!.mode).toBe(0o100755);
    expect(byName.get('empty/')!.mode).toBe(0o040700);
    expect(byName.get('empty/')!.externalAttrs & 0x10).toBe(0x10);
    expect(byName.get('readme.md')!.mtime).toBe(MTIME.getTime() / 1000);
    // Text deflates; a .jpg and random bytes are stored
    expect(byName.get('readme.md')!.method).toBe(8);
    expect(byName.get('readme.md')!.compressed).toBeLessThan(byName.get('readme.md')!.uncompressed);
    expect(byName.get('nested/photo.jpg')!.method).toBe(0);
    expect(byName.get('nested/deeper/data.bin')!.method).toBe(0);
    const t = tree.type === 'dir' ? tree.children : {};
    expect(byName.get(UNICODE)!.data).toEqual(expectedContent(t[UNICODE]!));
    const nested = (t.nested as Extract<FakeNode, { type: 'dir' }>).children.deeper as Extract<FakeNode, { type: 'dir' }>;
    expect(byName.get('nested/deeper/data.bin')!.data).toEqual(expectedContent(nested.children['data.bin']!));
  });

  it.skipIf(!HAS_UNZIP)('passes unzip -t and zipinfo, and extracts byte-for-byte', async () => {
    const tree = sampleTree();
    const { buf } = await build(tree, 'zip');
    const zipPath = tmpFile(buf, 'zip');
    expect(run('unzip', ['-t', zipPath])).toMatch(/No errors detected/);
    const info = run('zipinfo', [zipPath]);
    expect(info).toMatch(/-rwxr-xr-x .* run\.sh/);
    expect(info).toMatch(/drwx------ .* empty\//);
    const out = path.join(tmp, `x${++seq}`);
    run('unzip', ['-q', zipPath, '-d', out]);
    expect(fs.readFileSync(path.join(out, 'readme.md'), 'utf8')).toBe('# hello\n'.repeat(500));
    expect(fs.statSync(path.join(out, 'empty')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(out, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(out, 'readme.md')).mtime.getTime()).toBe(MTIME.getTime());
  });

  it('leaves symlinks out with a note, never following them', async () => {
    const { summary, buf, stats } = await build(dir({ link: { type: 'symlink', target: '/etc/passwd' }, 'a.txt': file('a') }), 'zip');
    expect(summary.skipped).toBe(1);
    const zip = await readZip(buf);
    expect(zip.entries.map((e) => e.name)).toEqual(['a.txt', SKIPPED_NOTE]);
    expect(zip.entries[1]!.data!.toString()).toMatch(/^link\tsymbolic link to \/etc\/passwd \(zip archives cannot hold links/m);
    expect(stats.opened).toEqual(['a.txt']);
  });

  it.skipIf(!HAS_UNZIP)('writes the ZIP64 end records past 65 535 entries', async () => {
    const children: Record<string, FakeNode> = {};
    for (let i = 0; i < 70_000; i++) children[`f${String(i).padStart(5, '0')}.txt`] = file(i % 1000 === 0 ? `n${i}` : '');
    const { summary, buf } = await build(dir(children), 'zip');
    expect(summary.files).toBe(70_000);
    const zip = await readZip(buf);
    expect(zip.zip64End).toBe(true);
    expect(zip.entries).toHaveLength(70_000);
    expect(zip.entries[1000]!.data!.toString()).toBe('n1000');
    const p = tmpFile(buf, 'zip');
    expect(run('unzip', ['-t', '-q', p])).toMatch(/No errors detected/);
    expect(run('zipinfo', ['-1', p]).trim().split('\n')).toHaveLength(70_000);
  }, 120_000);

  it.skipIf(!HAS_UNZIP)('writes a single entry over 4 GiB as ZIP64 (generated, never held)', async () => {
    const size = 4 * GiB + 3 * MiB + 17;
    const { summary, buf } = await build(dir({ 'zeros.img': { type: 'file', size, chunkSize: 1 * MiB }, 'after.txt': file('after') }), 'zip');
    expect(summary.bytes).toBe(size + 5);
    const zip = await readZip(buf, 0);
    const big = zip.entries.find((e) => e.name === 'zeros.img')!;
    expect(big.zip64).toBe(true);
    expect(big.versionNeeded).toBe(45);
    expect(big.uncompressed).toBe(size);
    expect(big.method).toBe(8);
    const p = tmpFile(buf, 'zip');
    expect(run('unzip', ['-t', p])).toMatch(/No errors detected/);
    expect(run('zipinfo', [p])).toMatch(new RegExp(`${size} .* zeros\\.img`));
  }, 300_000);

  it.skipIf(!HAS_UNZIP)('stores offsets past 4 GiB in ZIP64 fields (streamed through a verifier)', async () => {
    // Three stored 1.5 GiB files push the fourth entry and the central directory past 4 GiB
    const pattern = randomBytes(MiB);
    const children: Record<string, FakeNode> = {};
    const sizes = new Map<string, number>();
    for (const n of ['a', 'b', 'c']) {
      children[`${n}.jpg`] = { type: 'file', size: 1.5 * GiB, pattern, chunkSize: MiB };
      sizes.set(`${n}.jpg`, 1.5 * GiB);
    }
    // Random bytes are stored (by ratio): the verifier follows stored entries only
    children['d.txt'] = file(randomBytes(7));
    sizes.set('d.txt', 7);
    const walker = fakeWalker(dir(children));
    const verifier = streamingZipVerifier(sizes);
    const summary = await writeFolderArchive(walker, verifier, {
      format: 'zip',
      rootRef: '',
      maxBytes: 10 * GiB,
      maxFiles: 10,
      signal: new AbortController().signal,
    });
    expect(summary.bytes).toBe(4.5 * GiB + 7);
    const read = verifier.done();
    const d = read.entries.find((e) => e.name === 'd.txt')!;
    expect(d.offset).toBeGreaterThan(2 ** 32);
    expect(d.zip64).toBe(true);
    expect(read.zip64End).toBe(true);
    expect(read.centralOffset).toBeGreaterThan(2 ** 32);
  }, 300_000);

  it('switches to ZIP64 sizes for a file declared just under 4 GiB', async () => {
    // Declared near the boundary, the header has to commit to ZIP64 before deflate could overshoot
    const size = 2 ** 32 - 1024;
    const { buf } = await build(dir({ 'big.bin': { type: 'file', size, chunkSize: 4 * MiB } }), 'zip');
    const zip = await readZip(buf, 0);
    expect(zip.entries[0]!.zip64).toBe(true);
    expect(zip.entries[0]!.uncompressed).toBe(size);
  }, 300_000);
});

describe('tar.gz writer', () => {
  it('writes ustar with PAX for long and unicode names, symlinks as links, empty folders', async () => {
    const long = `${'very-long-folder-name-'.repeat(6)}/`;
    const longFile = `${'f'.repeat(150)}.txt`;
    const tree = dir({
      [UNICODE]: file('u'),
      'run.sh': file('#!/bin/sh\n', { mode: 0o755, mtime: MTIME }),
      empty: dir({}),
      link: { type: 'symlink', target: '../../outside/target' },
      longlink: { type: 'symlink', target: `${'t'.repeat(120)}/x` },
      [long.slice(0, -1)]: dir({ [longFile]: file('deep') }),
      'odd.dat': file(Buffer.alloc(513, 1)),
    });
    const { summary, buf } = await build(tree, 'tar.gz');
    expect(summary).toMatchObject({ files: 6, skipped: 0, truncated: false });
    const entries = readTarGz(buf);
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get(UNICODE)!.data.toString()).toBe('u');
    expect(byName.get('run.sh')!.mode).toBe(0o755);
    expect(byName.get('run.sh')!.mtime).toBe(MTIME.getTime() / 1000);
    expect(byName.get('empty/')!.type).toBe('5');
    expect(byName.get('link')).toMatchObject({ type: '2', linkName: '../../outside/target' });
    expect(byName.get('longlink')!.linkName).toBe(`${'t'.repeat(120)}/x`);
    expect(byName.get(`${long}${longFile}`)!.data.toString()).toBe('deep');
    expect(byName.get('odd.dat')!.data).toEqual(Buffer.alloc(513, 1));
  });

  it.skipIf(!HAS_TAR)('is listed and extracted by the system tar', async () => {
    const longFile = `${'g'.repeat(140)}.txt`;
    const tree = dir({
      [UNICODE]: file('u'),
      sub: dir({ [longFile]: file('long name'), inner: dir({}) }),
      link: { type: 'symlink', target: 'sub' },
    });
    const { buf } = await build(tree, 'tar.gz');
    const p = tmpFile(buf, 'tar.gz');
    const listing = run('tar', ['-tzvf', p]);
    expect(listing).toMatch(/link -> sub/);
    expect(listing).toContain(longFile);
    const out = path.join(tmp, `t${++seq}`);
    fs.mkdirSync(out);
    run('tar', ['-xzf', p, '-C', out]);
    expect(fs.readFileSync(path.join(out, UNICODE), 'utf8')).toBe('u');
    expect(fs.readFileSync(path.join(out, 'sub', longFile), 'utf8')).toBe('long name');
    expect(fs.statSync(path.join(out, 'sub', 'inner')).isDirectory()).toBe(true);
    expect(fs.readlinkSync(path.join(out, 'link'))).toBe('sub');
  });
});

describe.each(['zip', 'tar.gz'] as const)('driver (%s)', (format) => {
  const names = async (buf: Buffer) =>
    format === 'zip' ? (await readZip(buf)).entries.map((e) => ({ name: e.name, data: e.data ?? Buffer.alloc(0) })) : readTarGz(buf);

  it('stops at the file limit with _TRUNCATED.txt', async () => {
    const children: Record<string, FakeNode> = {};
    for (let i = 0; i < 10; i++) children[`f${i}`] = file(`${i}`);
    const { summary, buf } = await build(dir(children), format, { maxFiles: 4 });
    expect(summary).toMatchObject({ files: 4, truncated: true });
    const entries = await names(buf);
    expect(entries.map((e) => e.name)).toEqual(['f0', 'f1', 'f2', 'f3', TRUNCATED_NOTE]);
    expect(entries[4]!.data.toString()).toMatch(/SMT_FOLDER_DOWNLOAD_MAX_FILES/);
  });

  it('stops before the file that would pass the byte limit', async () => {
    const { summary, buf } = await build(
      dir({ a: file(Buffer.alloc(400)), b: file(Buffer.alloc(400)), c: file(Buffer.alloc(400)) }),
      format,
      { maxBytes: 1000 },
    );
    expect(summary).toMatchObject({ files: 2, bytes: 800, truncated: true });
    const entries = await names(buf);
    expect(entries.map((e) => e.name)).toEqual(['a', 'b', TRUNCATED_NOTE]);
    expect(entries[2]!.data.toString()).toMatch(/SMT_FOLDER_DOWNLOAD_MAX_BYTES/);
  });

  it('skips unreadable files, unlistable folders, special files and unsafe names, listing them in _skipped.txt', async () => {
    const tree = dir({
      'denied.txt': file('x', { failOpen: 'Permission denied' }),
      'vanished.txt': file('x', { failAfter: 0 }),
      'half.txt': file(Buffer.alloc(200_000, 3), { failAfter: 65_536, chunkSize: 65_536 }),
      locked: dir({ 'inside.txt': file('never') }, { failList: 'Permission denied' }),
      fifo: { type: 'other' },
      '..': file('climb'),
      '': file('empty name'),
      'a\\b': file('backslash'),
      a_b: file('real a_b'),
      'ok.txt': file('fine'),
    });
    const { summary, buf } = await build(tree, format);
    const entries = await names(buf);
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    expect(byName.get('ok.txt')!.toString()).toBe('fine');
    expect(byName.get('a_b')!.toString()).toBe('backslash');
    expect(byName.get('a_b (2)')!.toString()).toBe('real a_b');
    expect(byName.has('denied.txt')).toBe(false);
    expect(byName.has('vanished.txt')).toBe(false);
    expect(byName.has('locked/')).toBe(true);
    // Part-way failures keep what was read (tar pads to the declared size)
    expect(byName.get('half.txt')!.length).toBe(format === 'zip' ? 65_536 : 200_000);
    const note = byName.get(SKIPPED_NOTE)!.toString();
    expect(note).toMatch(/^denied\.txt\tcould not be opened: Permission denied$/m);
    expect(note).toMatch(/^vanished\.txt\tcould not be read/m);
    expect(note).toMatch(/^half\.txt\tread failed after 65536 of 200000 bytes/m);
    expect(note).toMatch(/^locked\/\tfolder could not be listed: Permission denied$/m);
    expect(note).toMatch(/^fifo\tnot a regular file/m);
    expect(note).toMatch(/^\.\.\tname cannot be stored/m);
    expect(summary.skipped).toBe(7);
    expect(summary.truncated).toBe(false);
    // Nothing escapes the chosen folder
    for (const e of entries) {
      expect(e.name.startsWith('/')).toBe(false);
      expect(e.name.split('/')).not.toContain('..');
    }
  });

  it('cuts a file that grew since it was listed at its listed size', async () => {
    const { buf, summary } = await build(dir({ 'grow.log': { type: 'file', size: 100, actualSize: 300 } }), format);
    expect(summary.bytes).toBe(100);
    expect((await names(buf))[0]!.data.length).toBe(100);
  });

  it('cancels mid-entry: the remote read is destroyed and the summary says aborted', async () => {
    const controller = new AbortController();
    let produced = 0;
    const tree = dir({
      'first.txt': file('done'),
      'big.bin': {
        type: 'file',
        size: 1 * GiB,
        chunkSize: 64 * 1024,
        onRead: (n) => {
          produced += n;
          if (produced >= 5 * MiB) controller.abort(new Error('client went away'));
        },
      },
      'never.txt': file('never'),
    });
    const walker = fakeWalker(tree);
    const started = Date.now();
    const summary = await writeFolderArchive(walker, collector(), {
      format,
      rootRef: '',
      maxBytes: 10 * GiB,
      maxFiles: 100,
      signal: controller.signal,
    });
    expect(summary.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(produced).toBeLessThan(10 * MiB);
    expect(walker.stats.opened).toEqual(['big.bin']);
    expect(walker.stats.destroyed).toContain('big.bin');
  });

  it('cancels while the remote read is stalled', async () => {
    const controller = new AbortController();
    const walker = fakeWalker(dir({ 'stuck.bin': { type: 'file', size: MiB, stallAfter: 100_000 } }));
    setTimeout(() => controller.abort(), 100);
    const summary = await writeFolderArchive(walker, collector(), {
      format,
      rootRef: '',
      maxBytes: GiB,
      maxFiles: 100,
      signal: controller.signal,
    });
    expect(summary.aborted).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(walker.stats.destroyed).toEqual(['stuck.bin']);
  });

  it('reports the download connection closing as aborted', async () => {
    const out = new Writable({
      highWaterMark: 1024,
      write(_c, _e, cb) {
        setTimeout(cb, 5);
      },
    });
    setTimeout(() => out.destroy(), 50);
    // No abort signal: the writers notice the destination going away by themselves
    const controller = new AbortController();
    const summary = await writeFolderArchive(fakeWalker(dir({ 'x.bin': { type: 'file', size: 100 * MiB, pattern: randomBytes(4096) } })), out, {
      format,
      rootRef: '',
      maxBytes: GiB,
      maxFiles: 100,
      signal: controller.signal,
    });
    expect(summary.aborted).toBe(true);
  });

  it('streams 1 GiB through a slow reader with bounded read-ahead and memory', async () => {
    let produced = 0;
    let consumed = 0;
    let maxAhead = 0;
    const pattern = randomBytes(MiB);
    const walker = fakeWalker(
      dir({ 'big.bin': { type: 'file', size: GiB, pattern, chunkSize: 256 * 1024, onRead: (n) => (produced += n) } }),
    );
    const baseline = process.memoryUsage();
    let peakExternal = 0;
    let ticks = 0;
    const out = new Writable({
      highWaterMark: 256 * 1024,
      write(chunk: Buffer, _e, cb) {
        consumed += chunk.length;
        maxAhead = Math.max(maxAhead, produced - consumed);
        if (++ticks % 64 === 0) {
          const m = process.memoryUsage();
          peakExternal = Math.max(peakExternal, m.arrayBuffers - baseline.arrayBuffers);
        }
        setImmediate(cb);
      },
    });
    const summary = await writeFolderArchive(walker, out, {
      format,
      rootRef: '',
      maxBytes: 2 * GiB,
      maxFiles: 10,
      signal: new AbortController().signal,
    });
    expect(summary).toMatchObject({ files: 1, bytes: GiB, aborted: false });
    // The writer only reads as fast as the consumer takes (compression may lag a little behind)
    expect(maxAhead).toBeLessThan(32 * MiB);
    expect(peakExternal).toBeLessThan(128 * MiB);
  }, 120_000);
});
