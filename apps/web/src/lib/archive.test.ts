import { crc32, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deploySourceViewFromPaths, type DeployAppConfig } from '@smt/shared';
import { checkSource, packFolder, packZip, sourceEnvFiles } from './archive.js';

/** The names in a packed (gzipped tar) upload, sorted. */
async function names(blob: Blob): Promise<string[]> {
  const tar = gunzipSync(Buffer.from(await blob.arrayBuffer()));
  const out: string[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = tar.subarray(at, at + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(at + 124, at + 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    out.push(name);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out.sort();
}

/** Files as `<input webkitdirectory>` gives them: paths start with the picked folder. */
function folder(files: Record<string, string>): File[] {
  return Object.entries(files).map(([path, text]) => {
    const file = new File([text], path.split('/').pop()!);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
  });
}

/** A zip with stored (uncompressed) entries. */
function zip(files: Record<string, string>): File {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new File([Buffer.concat([...parts, cdBuf, eocd])], 'site.zip');
}

const build = (b: Partial<DeployAppConfig['build']>): DeployAppConfig['build'] => ({ type: 'static', node: null, dir: '.', output: 'out', image: null, ...b });

describe('checking a deploy source before uploading', () => {
  it("refuses Next's .next folder picked for a static app", async () => {
    const problem = await checkSource({ kind: 'folder', files: folder({ '.next/BUILD_ID': 'x', '.next/server/app/index.html': '', '.next/static/chunks/a.js': '' }) }, build({ output: '.' }));
    expect(problem).toMatchObject({ code: 'next_build_folder', docs: '/docs/deployments/troubleshooting#uploaded-a-nextjs-build-folder' });
    expect(problem!.message).toBe(
      "This is Next's .next build folder, not a static export. Set output: 'export' in next.config, run the build, and upload the out folder (it contains index.html).",
    );
  });

  it('accepts the out folder picked with output: ., and names what is there with output: out', async () => {
    const out = { 'out/index.html': '<h1>hi</h1>', 'out/_next/static/a.js': '', 'out/about/index.html': '' };
    expect(await checkSource({ kind: 'folder', files: folder(out) }, build({ output: '.' }))).toBeNull();
    const problem = await checkSource({ kind: 'folder', files: folder(out) }, build({ output: 'out' }));
    expect(problem?.code).toBe('output_missing');
    expect(problem?.message).toContain('At the top of the upload: _next/, about/, index.html.');
    expect(problem?.message).toContain('set build.output to .');
    // A deploy folder that contains out/
    expect(await checkSource({ kind: 'folder', files: folder({ 'deploy/out/index.html': '', 'deploy/bastion.yml': '' }) }, build({}))).toBeNull();
  });

  it('reads package.json for its build script, also inside a zip', async () => {
    const project = { 'site/package.json': '{"scripts":{"start":"next start"}}', 'site/out/index.html': '' };
    expect((await checkSource({ kind: 'folder', files: folder(project) }, build({})))?.code).toBe('no_build_script');
    expect((await checkSource({ kind: 'zip', file: zip(project) }, build({})))?.code).toBe('no_build_script');
    const buildable = { ...project, 'site/package.json': '{"scripts":{"build":"next build"}}' };
    expect(await checkSource({ kind: 'zip', file: zip(buildable) }, build({}))).toBeNull();
    // The zip still packs as before
    expect((await packZip(zip(buildable))).files).toBe(2);
  });

  it('refuses a Next.js upload without package.json, and leaves Dockerfile apps to their Dockerfile', async () => {
    expect((await checkSource({ kind: 'folder', files: folder({ 'app/app/page.tsx': '' }) }, build({ type: 'nextjs', output: null })))?.code).toBe('no_package_json');
    expect(await checkSource({ kind: 'folder', files: folder({ 'app/package.json': '{}', 'app/next.config.js': '' }) }, build({ type: 'nextjs', output: null }))).toBeNull();
    expect((await checkSource({ kind: 'folder', files: folder({ 'api/main.py': '' }) }, build({ type: 'dockerfile', output: null })))?.code).toBe('no_dockerfile');
    expect(await checkSource({ kind: 'folder', files: folder({ 'web/apps/site/package.json': '{}', 'web/README.md': '' }) }, build({ type: 'nextjs', dir: 'apps/site', output: null }))).toBeNull();
  });
});

describe('a source view of file paths', () => {
  it('implies folders and lists them with a trailing /', () => {
    const view = deploySourceViewFromPaths(['index.html', './_next/static/a.js', 'about/index.html'], { 'package.json': '{}' });
    expect(view.isDir('')).toBe(true);
    expect(view.isDir('_next/static')).toBe(true);
    expect(view.isFile('_next')).toBe(false);
    expect(view.list('.')).toEqual(['_next/', 'about/', 'index.html']);
    expect(view.readText('./package.json')).toBe('{}');
  });
});

describe('environment files in an upload', () => {
  const project = {
    'site/package.json': '{"scripts":{"build":"next build"}}',
    'site/.env': 'SECRET=1',
    'site/.env.local': 'SECRET=2',
    'site/.env.production': 'SECRET=3',
    'site/.env.example': 'SECRET=',
    'site/apps/web/.env.development.local': 'SECRET=4',
    'site/src/env.ts': 'export {}',
  };
  const left = ['.env', '.env.local', '.env.production', 'apps/web/.env.development.local'];

  it('are named before packing (.env.example is not one)', async () => {
    expect((await sourceEnvFiles({ kind: 'folder', files: folder(project) })).sort()).toEqual(left);
    expect((await sourceEnvFiles({ kind: 'zip', file: zip(project) })).sort()).toEqual(left);
    expect(await sourceEnvFiles({ kind: 'folder', files: folder({ 'a/package.json': '{}' }) })).toEqual([]);
  });

  it('are left out of a folder or zip by default, and say which', async () => {
    const packed = await packFolder(folder(project));
    expect(await names(packed.blob)).toEqual(['.env.example', 'package.json', 'src/env.ts']);
    expect(packed.envFiles.sort()).toEqual(left);
    expect(packed.skipped).toBe(4);
    const zipped = await packZip(zip(project));
    expect(await names(zipped.blob)).toEqual(['.env.example', 'package.json', 'src/env.ts']);
    expect(zipped.envFiles.sort()).toEqual(left);
  });

  it('go up when included on purpose', async () => {
    const packed = await packFolder(folder(project), { includeEnvFiles: true });
    expect(await names(packed.blob)).toEqual(['.env', '.env.example', '.env.local', '.env.production', 'apps/web/.env.development.local', 'package.json', 'src/env.ts']);
    expect(packed.envFiles).toEqual([]);
    expect((await packZip(zip(project), { includeEnvFiles: true })).files).toBe(7);
  });

  it('are not all an upload may hold', async () => {
    await expect(packFolder(folder({ 'site/.env': 'A=1' }))).rejects.toThrow(/Nothing to upload/);
  });
});
