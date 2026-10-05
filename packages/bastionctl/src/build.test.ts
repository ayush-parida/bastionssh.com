import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeployAppConfig } from '@smt/shared';
import { detectPackageManager, GENERATED_DOCKERFILE, nodeVersion, planBuild } from './build.js';
import { CADDY_IMAGE } from './proxy.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-build-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content = '') => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
};

const config = (build: Partial<DeployAppConfig['build']> = {}, port = 3000): Pick<DeployAppConfig, 'build' | 'run'> => ({
  build: { type: 'nextjs', node: null, dir: '.', output: null, ...build },
  run: { port, env_file: '.env', volumes: [], memory: null, cpus: null },
});

const NEXT_CONFIG = "/** @type {import('next').NextConfig} */\nmodule.exports = { output: 'standalone' };\n";

describe('Next.js builds', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm', 'corepack enable && pnpm install --frozen-lockfile', 'pnpm run build'],
    ['yarn.lock', 'yarn', 'corepack enable && yarn install --frozen-lockfile', 'yarn build'],
    ['package-lock.json', 'npm', 'npm ci', 'npm run build'],
    ['bun.lock', 'bun', 'bun install --frozen-lockfile', 'bun run build'],
    ['bun.lockb', 'bun', 'bun install --frozen-lockfile', 'bun run build'],
  ])('with %s installs with %s', (lockfile, manager, install, build) => {
    write('package.json', '{"name":"x"}');
    write(lockfile);
    write('next.config.js', NEXT_CONFIG);
    expect(detectPackageManager(dir).manager).toBe(manager);
    const plan = planBuild(dir, config());
    expect(plan.dockerfile).toBe(GENERATED_DOCKERFILE);
    expect(plan.exclude).toEqual(['.git', 'node_modules', '.next']);
    expect(plan.generated).toContain(`COPY ["package.json", "${lockfile}", "./"]`);
    expect(plan.generated).toContain(`RUN ${install}\n`);
    expect(plan.generated).toContain(`RUN ${build} && mkdir -p public`);
    expect(plan.generated).toContain('FROM node:20-alpine AS run');
    expect(plan.generated).toContain('PORT=3000 HOSTNAME=0.0.0.0');
    expect(plan.generated).toContain('CMD ["node", "server.js"]');
    // Bun is brought into the install and build stages only; the server runs on Node
    const bunLines = plan.generated!.split('\n').filter((l) => l.includes('oven/bun'));
    expect(bunLines).toEqual(manager === 'bun' ? Array(2).fill('COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun') : []);
  });

  it('uses yarn berry, npm install without a lockfile, and the configured port', () => {
    write('package.json', '{}');
    write('yarn.lock');
    write('.yarnrc.yml', 'nodeLinker: node-modules');
    write('next.config.mjs', 'export default { output: "standalone" }');
    expect(planBuild(dir, config({}, 8080)).generated).toMatch(/yarn install --immutable[\s\S]*PORT=8080[\s\S]*EXPOSE 8080/);
    fs.rmSync(path.join(dir, 'yarn.lock'));
    fs.rmSync(path.join(dir, '.yarnrc.yml'));
    expect(planBuild(dir, config()).generated).toContain('RUN npm install\n');
  });

  it('explains how to turn on standalone output when it is off', () => {
    write('package.json', '{}');
    write('next.config.js', 'module.exports = {}');
    expect(() => planBuild(dir, config())).toThrow(/output: 'standalone'/);
    fs.rmSync(path.join(dir, 'next.config.js'));
    expect(() => planBuild(dir, config())).toThrow(/output: 'standalone'/);
  });

  it('picks the Node version from config, .nvmrc, engines, else 20', () => {
    write('package.json', JSON.stringify({ engines: { node: '>=18.17 <23' } }));
    expect(nodeVersion(dir, null)).toBe('18');
    write('.nvmrc', 'v22.11.0\n');
    expect(nodeVersion(dir, null)).toBe('22');
    expect(nodeVersion(dir, '21')).toBe('21');
    fs.rmSync(path.join(dir, '.nvmrc'));
    write('package.json', '{}');
    expect(nodeVersion(dir, null)).toBe('20');
  });
});

describe('dockerfile and static builds', () => {
  it("uses the project's Dockerfile from build.dir", () => {
    write('apps/web/Dockerfile', 'FROM busybox');
    const plan = planBuild(dir, config({ type: 'dockerfile', dir: 'apps/web' }));
    expect(plan).toMatchObject({ context: path.join(dir, 'apps/web'), dockerfile: 'Dockerfile', generated: null });
    expect(() => planBuild(dir, config({ type: 'dockerfile' }))).toThrow(/no Dockerfile/);
    expect(() => planBuild(dir, config({ type: 'dockerfile', dir: 'missing' }))).toThrow(/not a folder/);
  });

  it('serves a prebuilt folder with the pinned Caddy, or builds it with Node first', () => {
    write('out/index.html', 'hi');
    let plan = planBuild(dir, config({ type: 'static', output: 'out' }));
    expect(plan.generated).toBe(`FROM ${CADDY_IMAGE}\nCOPY ["out","/srv/"]\nEXPOSE 80\nCMD ["caddy", "file-server", "--root", "/srv", "--listen", ":80"]\n`);
    expect(() => planBuild(dir, config({ type: 'static', output: 'dist' }))).toThrow(/not a folder/);

    write('package.json', '{}');
    write('pnpm-lock.yaml');
    plan = planBuild(dir, config({ type: 'static', output: 'dist' }));
    expect(plan.generated).toMatch(/FROM node:20-alpine AS build[\s\S]*pnpm run build[\s\S]*FROM caddy@sha256:[0-9a-f]{64}\nCOPY --from=build \["\/app\/dist","\/srv\/"\]/);

    fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
    write('bun.lock');
    plan = planBuild(dir, config({ type: 'static', output: 'dist' }));
    expect(plan.generated).toMatch(/AS build\nWORKDIR \/app\nCOPY --from=oven\/bun:1-alpine \/usr\/local\/bin\/bun \/usr\/local\/bin\/bun\nCOPY \["package.json", "bun.lock", ".\/"\]\nRUN bun install --frozen-lockfile\nCOPY . .\nRUN bun run build\n/);
  });

  it('never reads a config file through a link', () => {
    write('package.json', '{}');
    fs.symlinkSync('/etc/hosts', path.join(dir, 'next.config.js'));
    expect(() => planBuild(dir, config())).toThrow(/standalone/);
  });
});
