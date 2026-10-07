import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import { ArchiveMeter, detectArchiveFormat, engineReads, parseLoadLine, platformWarning, tagIndex, toLoadedImage } from './image-load.js';
import { composeArgv, composeDisplay } from './compose.js';
import { imageArchive } from './actions-daemon.test-helper.js';

describe('archive formats', () => {
  it('reads the format from the first bytes', () => {
    const tar = imageArchive({ tags: ['a:1'] });
    expect(detectArchiveFormat(tar)).toBe('tar');
    expect(detectArchiveFormat(gzipSync(tar))).toBe('gzip');
    expect(detectArchiveFormat(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1]))).toBe('xz');
    expect(detectArchiveFormat(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1]))).toBe('zstd');
    expect(detectArchiveFormat(Buffer.from('BZh91AY'))).toBe('bzip2');
    expect(detectArchiveFormat(Buffer.from('PK\x03\x04 a zip'))).toBeNull();
    expect(detectArchiveFormat(tar.subarray(0, 200))).toBeNull();
  });

  it('knows zstd needs Docker 23 (API 1.42)', () => {
    expect(engineReads('gzip', '1.25')).toBe(true);
    expect(engineReads('zstd', '1.41')).toBe(false);
    expect(engineReads('zstd', '1.42')).toBe(true);
    expect(engineReads('zstd', null)).toBe(false);
  });
});

describe('ArchiveMeter', () => {
  const run = async (data: Buffer, limit: number, chunk = 100) => {
    const meter = new ArchiveMeter(limit, (f) => (f === 'zstd' ? Object.assign(new Error('no zstd'), { statusCode: 400 }) : null) as never);
    const out: Buffer[] = [];
    const parts = Array.from({ length: Math.ceil(data.length / chunk) }, (_, i) => data.subarray(i * chunk, (i + 1) * chunk));
    await pipeline(Readable.from(parts), meter, async function* (source) {
      for await (const c of source) out.push(c as Buffer);
    });
    return { meter, out: Buffer.concat(out) };
  };

  it('passes the archive through unchanged, counting it', async () => {
    const tar = imageArchive({ tags: ['a:1'] });
    const { meter, out } = await run(tar, 1e6);
    expect(out.equals(tar)).toBe(true);
    expect(meter.bytes).toBe(tar.length);
    expect(meter.format).toBe('tar');
  });

  it('fails past the limit, and on what is not an archive or refused', async () => {
    await expect(run(imageArchive({ tags: ['a:1'], padding: 5000 }), 4096)).rejects.toMatchObject({ statusCode: 413 });
    await expect(run(Buffer.alloc(2000, 65), 1e6)).rejects.toMatchObject({ statusCode: 400 });
    await expect(run(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, ...Buffer.alloc(600)]), 1e6)).rejects.toThrow('no zstd');
    await expect(run(Buffer.alloc(0), 1e6)).rejects.toThrow(/empty/);
  });

  it('decides on a small archive at its end', async () => {
    const gz = Buffer.from([0x1f, 0x8b, 1, 2, 3]);
    const { meter, out } = await run(gz, 1e6);
    expect(meter.format).toBe('gzip');
    expect(out.equals(gz)).toBe(true);
  });
});

describe('load output', () => {
  it('reads loaded tags, untagged ids, progress and errors', () => {
    expect(parseLoadLine({ stream: 'Loaded image: knexbi-website:latest\n' })).toMatchObject({ kind: 'progress', loaded: { ref: 'knexbi-website:latest' } });
    const id = 'sha256:' + 'a'.repeat(64);
    expect(parseLoadLine({ stream: `Loaded image ID: ${id}\n` })).toMatchObject({ loaded: { id } });
    expect(parseLoadLine({ status: 'Loading layer', id: 'abc', progressDetail: { current: 1, total: 2 } })).toEqual({
      kind: 'progress',
      progress: { id: 'abc', status: 'Loading layer', current: 1, total: 2 },
      loaded: null,
    });
    expect(parseLoadLine({ errorDetail: { message: 'unexpected EOF' } })).toEqual({ kind: 'error', error: 'unexpected EOF' });
  });

  it('compares the platform with x86_64/amd64 and aarch64/arm64 as the same', () => {
    const before = tagIndex([{ Id: 'sha256:old', RepoTags: ['app:1', '<none>:<none>'] }]);
    const amd = toLoadedImage('app:1', { Id: 'sha256:new', Os: 'linux', Architecture: 'amd64', Size: 5 }, { os: 'linux', arch: 'x86_64' }, before);
    expect(amd).toMatchObject({ platformMismatch: false, replacedId: 'sha256:old' });
    const same = toLoadedImage('app:1', { Id: 'sha256:old', Os: 'linux', Architecture: 'arm64' }, { os: 'linux', arch: 'aarch64' }, before);
    expect(same).toMatchObject({ platformMismatch: false, replacedId: null });
    const arm = toLoadedImage('app:1', { Id: 'sha256:x', Os: 'linux', Architecture: 'arm64', Variant: 'v8' }, { os: 'linux', arch: 'amd64' }, before);
    expect(arm.platformMismatch).toBe(true);
    expect(platformWarning(arm, { os: 'linux', arch: 'amd64' })).toMatch(/app:1 is built for linux\/arm64\/v8, but this server is linux\/amd64/);
  });
});

describe('compose commands on one service', () => {
  const target = { project: { name: 'infra', workingDir: '/home/u/infra', configFiles: ['/home/u/infra/compose.yaml'] }, socketPath: '/var/run/docker.sock' };

  it('appends the service after the fixed arguments', () => {
    expect(composeArgv(target, 'up', 'website').slice(-4)).toEqual(['up', '--detach', '--no-deps', 'website']);
    expect(composeArgv(target, 'stop', 'website').slice(-2)).toEqual(['stop', 'website']);
    expect(composeDisplay(target.project, 'up', 'website')).toBe('docker compose -p infra up --detach --no-deps website');
  });

  it('refuses names that could read as flags or carry shell syntax, and project-only verbs', () => {
    for (const name of ['-d', '--rm', 'a b', 'a;b', '', '.x']) expect(() => composeArgv(target, 'up', name), name).toThrow(/service name/);
    expect(() => composeArgv(target, 'down' as 'up', 'website')).toThrow(/Unknown compose action for a service/);
    expect(() => composeArgv(target, 'stop' as 'up')).toThrow(/Unknown compose action/);
  });
});
