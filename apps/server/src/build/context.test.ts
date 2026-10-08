import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeployAppConfig } from '@smt/shared';
import { jobDir, prepareContext, receiveUpload } from './context.js';
import { tarOf } from './fake-buildctl.test-helper.js';

/**
 * The ephemeral build context of a build on the BastionSSH side: the
 * upload's caps, the shared extraction's safety checks, environment files
 * left out (or kept on request), the generated Dockerfile with ARG lines for
 * the build args, and nothing left behind.
 */

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-ctx-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const config = (build: Partial<DeployAppConfig['build']> = {}): Pick<DeployAppConfig, 'build' | 'run'> => ({
  build: { type: 'nextjs', node: null, dir: '.', output: null, image: null, where: 'bastion', args: [], ...build },
  run: { port: 3000, env_file: '.env', volumes: [], memory: null, cpus: null, strategy: 'rolling', publish: { scope: 'none', port: null } },
});

const NEXT = {
  'package.json': '{"name":"web","scripts":{"build":"next build"}}',
  'package-lock.json': '{}',
  'next.config.js': "module.exports = { output: 'standalone' };",
  'app/page.js': 'export default function Page() { return null }',
};

function upload(entries: Parameters<typeof tarOf>[0]): string {
  const file = path.join(root, `upload-${Math.random().toString(36).slice(2)}.tar.gz`);
  fs.writeFileSync(file, zlib.gzipSync(tarOf(entries)));
  return file;
}

function files(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? files(dir, p) : [p];
  });
}

describe('receiving the upload', () => {
  it('writes it with its size and SHA-256, and refuses one past the cap (leaving nothing)', async () => {
    const file = path.join(root, 'u');
    expect(await receiveUpload(Readable.from([Buffer.from('hello '), Buffer.from('world')]), file, 100)).toEqual({
      bytes: 11,
      sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const big = path.join(root, 'big');
    await expect(receiveUpload(Readable.from([Buffer.alloc(64), Buffer.alloc(64)]), big, 100)).rejects.toMatchObject({ statusCode: 413 });
    expect(fs.existsSync(big)).toBe(false);
  });
});

describe('the build context', () => {
  it('leaves environment files out (not .env.example), says which, and writes the Dockerfile with ARG lines for the build args', async () => {
    const job = jobDir(root);
    const prepared = await prepareContext(
      upload({ ...NEXT, '.env': 'SECRET=1', '.env.local': 'SECRET=2', '.env.example': 'SECRET=', 'node_modules/x/index.js': 'x', '.git/HEAD': 'ref' }),
      job.dir,
      config(),
      { includeEnvFiles: false, maxBytes: 1024 * 1024, buildArgs: ['NEXT_PUBLIC_API_URL', 'SENTRY_RELEASE'] },
    );
    expect(prepared.skipped).toEqual(['.env', '.env.local']);
    expect(prepared.skippedCount).toBe(2);
    const listed = files(prepared.dir).sort();
    expect(listed).toEqual(['.bastion.Dockerfile', '.env.example', 'app/page.js', 'next.config.js', 'package-lock.json', 'package.json']);
    const dockerfile = fs.readFileSync(path.join(prepared.dir, '.bastion.Dockerfile'), 'utf8');
    expect(dockerfile).toContain('ARG NEXT_PUBLIC_API_URL\nARG SENTRY_RELEASE\nRUN npm run build');
    // Names only: a value never reaches the Dockerfile
    expect(prepared.plan.dockerfile).toBe('.bastion.Dockerfile');
    job.remove();
    expect(fs.existsSync(job.dir)).toBe(false);
  });

  it('keeps environment files when asked', async () => {
    const job = jobDir(root);
    const prepared = await prepareContext(upload({ ...NEXT, '.env.production': 'NEXT_PUBLIC_X=1' }), job.dir, config(), {
      includeEnvFiles: true,
      maxBytes: 1024 * 1024,
      buildArgs: [],
    });
    expect(prepared.skippedCount).toBe(0);
    expect(fs.readFileSync(path.join(prepared.dir, '.env.production'), 'utf8')).toBe('NEXT_PUBLIC_X=1');
  });

  it('refuses unsafe archives and ones past the size cap, as a 422, leaving no unpacked files', async () => {
    for (const [entries, message] of [
      [[{ name: '../escape', content: 'x' }], /\.\./],
      [[{ name: 'Dockerfile', content: 'FROM x' }, { name: 'out', type: '2', linkname: '/etc/passwd' }], /absolute path/],
      [[{ name: 'Dockerfile', content: 'FROM x' }, { name: 'up', type: '2', linkname: '../../outside' }], /outside the upload/],
      [[{ name: 'Dockerfile', content: 'FROM x' }, { name: 'dev', type: '3' }], /special file/],
    ] as const) {
      const job = jobDir(root);
      await expect(prepareContext(upload(entries as never), job.dir, config({ type: 'dockerfile' }), { includeEnvFiles: false, maxBytes: 1024, buildArgs: [] })).rejects.toMatchObject({
        statusCode: 422,
        message: expect.stringMatching(message),
      });
      expect(fs.existsSync(path.join(job.dir, 'src'))).toBe(false);
      job.remove();
    }
    const job = jobDir(root);
    await expect(
      prepareContext(upload({ Dockerfile: 'FROM x', big: 'x'.repeat(4096) }), job.dir, config({ type: 'dockerfile' }), { includeEnvFiles: false, maxBytes: 1024, buildArgs: [] }),
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/more than/) });
  });

  it('refuses an upload that cannot build as configured, with the same message bastionctl gives', async () => {
    const job = jobDir(root);
    await expect(
      prepareContext(upload({ 'package.json': '{}', 'next.config.js': 'module.exports = {}' }), job.dir, config(), { includeEnvFiles: false, maxBytes: 1024 * 1024, buildArgs: [] }),
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/output: 'standalone'/) });
  });

  it("never writes the generated Dockerfile through a link of that name in the upload", async () => {
    const job = jobDir(root);
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'untouched');
    const prepared = await prepareContext(
      upload({ ...NEXT, '.bastion.Dockerfile': { type: '2', linkname: 'package.json' } }),
      job.dir,
      config(),
      { includeEnvFiles: false, maxBytes: 1024 * 1024, buildArgs: [] },
    );
    expect(fs.lstatSync(path.join(prepared.dir, '.bastion.Dockerfile')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(prepared.dir, 'package.json'), 'utf8')).toBe(NEXT['package.json']);
  });
});
