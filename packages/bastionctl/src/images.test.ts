import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeployAppConfig } from '@smt/shared';
import { planBuild } from './build.js';
import images from './images.json' with { type: 'json' };
import { NODE_BUILD_VERSIONS, nodeBuildImage, pinnedRef } from './images.js';
import { proxyDockerfile } from './proxy-image.js';

/**
 * Every image bastionctl uses is pinned by digest (deployments spec §8): the
 * references in images.json, every FROM and COPY --from of the Dockerfiles it
 * generates (each build type, each package manager, each Node.js version) and
 * of the proxy image, and no image reference by tag only anywhere in the
 * source or the wrapper. To move an image, run update-images.mjs (see
 * images.ts) — never edit a tag in.
 */

const PINNED = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*:[\w.-]+@sha256:[0-9a-f]{64}$/;
const SRC = import.meta.dirname;

function refs(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Object.values(value as Record<string, unknown>).flatMap(refs);
}

/** The image references of a Dockerfile: FROM and COPY --from (stage names excluded). */
function dockerfileImages(text: string): string[] {
  const stages = new Set([...text.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((m) => m[1]));
  return [...text.matchAll(/^FROM (\S+)/gm), ...text.matchAll(/--from=(\S+)/g)].map((m) => m[1]!).filter((ref) => !stages.has(ref));
}

const DIGEST_REF = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;

describe('pinned images', () => {
  it('pins every reference in images.json by tag and digest, with a build image per supported Node.js version', () => {
    const all = refs(images);
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const ref of all) expect(ref, ref).toMatch(PINNED);
    expect(NODE_BUILD_VERSIONS).toEqual(['18', '20', '22', '24']);
    for (const v of NODE_BUILD_VERSIONS) expect(images.build[v as keyof typeof images.build]).toMatch(new RegExp(`^node:${v}-alpine@`));
    expect(pinnedRef(images.caddy)).toMatch(DIGEST_REF);
  });

  it('generates Dockerfiles that use digests only, for every build type, package manager and Node.js version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-images-'));
    try {
      const write = (name: string, content = '') => fs.writeFileSync(path.join(dir, name), content);
      const config = (build: Partial<DeployAppConfig['build']>): Pick<DeployAppConfig, 'build' | 'run'> => ({
        build: { type: 'nextjs', node: null, dir: '.', output: null, ...build },
        run: { port: 3000, env_file: '.env', volumes: [], memory: null, cpus: null },
      });
      fs.mkdirSync(path.join(dir, 'out'));
      write('out/index.html', 'hi');
      const texts = [planBuild(dir, config({ type: 'static', output: 'out' })).generated!];
      write('package.json', '{"scripts":{"build":"next build"}}');
      write('next.config.js', "module.exports = { output: 'standalone' };");
      for (const lockfile of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'package-lock.json']) {
        write(lockfile);
        for (const node of NODE_BUILD_VERSIONS) {
          texts.push(planBuild(dir, config({ node })).generated!, planBuild(dir, config({ type: 'static', node, output: 'out' })).generated!);
        }
        fs.rmSync(path.join(dir, lockfile));
      }
      texts.push(proxyDockerfile());
      const used = new Set(texts.flatMap(dockerfileImages));
      for (const ref of used) expect(ref, ref).toMatch(DIGEST_REF);
      // Every pinned image is one a generated Dockerfile can use (or bastionctl's own runtime)
      expect([...used].sort()).toEqual([...new Set([...Object.values(images.build), images.bun, images.caddy, images.node].map(pinnedRef))].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a Node.js version it has no pinned image for', () => {
    expect(nodeBuildImage('22.11.0')).toBe(pinnedRef(images.build['22']));
    expect(() => nodeBuildImage('16')).toThrow(/use one of 18, 20, 22, 24/);
  });

  it('names no image by tag alone anywhere in the source, the wrapper, the nginx helper or the build scripts', () => {
    const files = [
      ...fs
        .readdirSync(SRC)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('test-helper'))
        .map((f) => path.join(SRC, f)),
      ...['wrapper.sh', 'bastion-nginx.sh', 'build.mjs'].map((f) => path.join(SRC, '..', f)),
    ];
    // An image reference in a string: repo[:tag] of a known image, not followed by a digest
    // (`node:fs` is a module, and a bare `caddy` or `node` a command, not an image)
    const tagged = /(?:['"`]|FROM |--from=)(?:docker\.io\/)?(?:library\/)?(?:(?:node|caddy|busybox|alpine|nginx):(?:\d|latest|alpine|lts|current)[\w.-]*|oven\/bun(?::[\w.-]+)?)(?=['"`\s])/g;
    const found: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(tagged)) {
        const line = text.slice(0, m.index).split('\n').length;
        const source = text.split('\n')[line - 1]!.trim();
        // Comments may name images; code may not
        if (source.startsWith('//') || source.startsWith('*') || source.startsWith('#')) continue;
        found.push(`${path.basename(file)}:${line}: ${source}`);
      }
    }
    expect(found).toEqual([]);
    // The wrapper's image is filled in from images.json by the build (and the built one, when there is one, has it)
    expect(fs.readFileSync(path.join(SRC, '..', 'wrapper.sh'), 'utf8')).toContain("IMAGE='@NODE_IMAGE@'");
    const built = path.join(SRC, '..', 'dist', 'bastionctl');
    if (fs.existsSync(built)) expect(fs.readFileSync(built, 'utf8')).toContain(`IMAGE='${images.node}'`);
  });
});
