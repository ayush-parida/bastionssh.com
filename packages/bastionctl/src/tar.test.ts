import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTar, packDirectory, tarBuffer } from './tar.js';

let work: string;
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-tar-'));
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

function archive(entries: Parameters<typeof tarBuffer>[0], gz = true): string {
  const file = path.join(work, `upload-${Math.random().toString(36).slice(2)}.tar${gz ? '.gz' : ''}`);
  const tar = tarBuffer(entries);
  fs.writeFileSync(file, gz ? zlib.gzipSync(tar) : tar);
  return file;
}

const dest = () => path.join(work, 'out');

async function refused(entries: Parameters<typeof tarBuffer>[0], message: RegExp) {
  await expect(extractTar(archive(entries), dest())).rejects.toThrow(message);
  // Nothing is left behind
  expect(fs.existsSync(dest())).toBe(false);
}

describe('extracting an upload', () => {
  it('extracts files, folders and links that stay inside, gzip or not', async () => {
    const long = `deep/${'d'.repeat(120)}/file.txt`;
    const entries: Parameters<typeof tarBuffer>[0] = [
      { name: './', type: '5' },
      { name: 'src/', type: '5' },
      { name: 'src/index.js', content: 'console.log(1)', mode: 0o4755 },
      { name: long, content: 'long name via pax' },
      { name: 'link', type: '2', linkname: 'src/index.js' },
      { name: 'src/up', type: '2', linkname: '../link' },
      { name: 'dangling', type: '2', linkname: 'not/there' },
    ];
    for (const gz of [true, false]) {
      fs.rmSync(dest(), { recursive: true, force: true });
      const result = await extractTar(archive(entries, gz), dest());
      expect(result.files).toBe(7);
      expect(fs.readFileSync(path.join(dest(), 'src/index.js'), 'utf8')).toBe('console.log(1)');
      expect(fs.readFileSync(path.join(dest(), long), 'utf8')).toBe('long name via pax');
      expect(fs.readFileSync(path.join(dest(), 'src/up'), 'utf8')).toBe('console.log(1)');
      // setuid and friends are dropped
      expect(fs.statSync(path.join(dest(), 'src/index.js')).mode & 0o7777).toBe(0o755);
    }
  });

  it('refuses absolute paths and ..', async () => {
    await refused([{ name: '/etc/cron.d/x', content: 'x' }], /absolute path/);
    await refused([{ name: 'a/../../escape', content: 'x' }], /\.\./);
    await refused([{ name: '../escape', content: 'x' }], /\.\./);
    expect(fs.existsSync(path.join(work, 'escape'))).toBe(false);
  });

  it('refuses links that lead outside, directly or through other links', async () => {
    await refused([{ name: 'l', type: '2', linkname: '/etc/passwd' }], /absolute path/);
    await refused([{ name: 'l', type: '2', linkname: '../../.env' }], /outside the upload/);
    // a/e -> .. stays inside by name, but f -> a/e/../.. walks out once a/e is followed
    await refused(
      [
        { name: 'a/', type: '5' },
        { name: 'a/e', type: '2', linkname: '..' },
        { name: 'f', type: '2', linkname: 'a/e/../..' },
      ],
      /outside the upload/,
    );
    await refused(
      [
        { name: 'x', type: '2', linkname: 'y' },
        { name: 'y', type: '2', linkname: 'x' },
        { name: 'z', type: '2', linkname: 'x/w' },
      ],
      /loop/,
    );
  });

  it('never writes through a link, or replaces one', async () => {
    await refused(
      [
        { name: 'd', type: '2', linkname: '.' },
        { name: 'd/x', content: 'through the link' },
      ],
      /inside a symbolic link/,
    );
    await refused(
      [
        { name: 'l', type: '2', linkname: 'f' },
        { name: 'l', content: 'replace the link' },
      ],
      /replacing a symbolic link/,
    );
  });

  it('refuses hard links and special files', async () => {
    await refused([{ name: 'f', content: 'x' }, { name: 'h', type: '1', linkname: 'f' }], /hard link/);
    await refused([{ name: 'dev', type: '3' }], /special file/);
  });

  it('caps the size and number of entries', async () => {
    const big = archive([{ name: 'big', content: 'x'.repeat(5000) }]);
    await expect(extractTar(big, dest(), { maxBytes: 4096 })).rejects.toThrow(/unpacks to more than/);
    expect(fs.existsSync(dest())).toBe(false);
    const many = archive(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, content: 'x' })));
    await expect(extractTar(many, dest(), { maxEntries: 10 })).rejects.toThrow(/more than 10 entries/);
  });

  it('refuses what is not a tar archive', async () => {
    const junk = path.join(work, 'junk.tar.gz');
    fs.writeFileSync(junk, zlib.gzipSync(Buffer.from('not a tar file at all '.repeat(40))));
    await expect(extractTar(junk, dest())).rejects.toThrow(/not a valid tar/);
    const badGz = path.join(work, 'bad.gz');
    fs.writeFileSync(badGz, Buffer.from([0x1f, 0x8b, 0, 1, 2, 3]));
    await expect(extractTar(badGz, dest())).rejects.toThrow();
    const empty = archive([]);
    await expect(extractTar(empty, dest())).rejects.toThrow(/empty/);
  });
});

describe('packing a build context', () => {
  it('round-trips through extraction, links kept as links, with extra files and exclusions', async () => {
    const src = path.join(work, 'src');
    fs.mkdirSync(path.join(src, 'app', `${'n'.repeat(110)}`), { recursive: true });
    fs.mkdirSync(path.join(src, 'node_modules'));
    fs.writeFileSync(path.join(src, 'node_modules', 'big'), 'skip me');
    fs.writeFileSync(path.join(src, 'app', 'main.js'), 'main');
    fs.writeFileSync(path.join(src, 'app', `${'n'.repeat(110)}`, 'deep.txt'), 'deep');
    fs.writeFileSync(path.join(src, 'Dockerfile'), 'FROM theirs');
    fs.symlinkSync('app/main.js', path.join(src, 'entry'));

    const packed = path.join(work, 'ctx.tar');
    const chunks: Buffer[] = [];
    for await (const c of packDirectory(src, [{ name: 'Dockerfile', content: 'FROM ours' }], ['node_modules']) as AsyncIterable<Buffer>) chunks.push(c);
    fs.writeFileSync(packed, Buffer.concat(chunks));

    await extractTar(packed, dest());
    expect(fs.readFileSync(path.join(dest(), 'app/main.js'), 'utf8')).toBe('main');
    expect(fs.readFileSync(path.join(dest(), 'app', 'n'.repeat(110), 'deep.txt'), 'utf8')).toBe('deep');
    expect(fs.readlinkSync(path.join(dest(), 'entry'))).toBe('app/main.js');
    expect(fs.readFileSync(path.join(dest(), 'Dockerfile'), 'utf8')).toBe('FROM ours');
    expect(fs.existsSync(path.join(dest(), 'node_modules'))).toBe(false);
  });
});
