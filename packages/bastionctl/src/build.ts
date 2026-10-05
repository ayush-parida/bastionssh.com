import fs from 'node:fs';
import path from 'node:path';
import type { DeployAppConfig } from '@smt/shared';
import { BastionError, isInside } from './names.js';
import { CADDY_IMAGE } from './proxy.js';

/**
 * How an app's image is built (deployments spec §5 step 3):
 *
 * - **nextjs** — a generated multi-stage Dockerfile: dependencies installed
 *   with the package manager the lockfile names, `next build`, and a small
 *   runtime stage from Next's standalone output (required: `output:
 *   'standalone'` in next.config).
 * - **dockerfile** — the project's own `Dockerfile`.
 * - **static** — built with Node when there is a package.json, then the
 *   `output` folder served by Caddy on port 80.
 *
 * Generated Dockerfiles are added to the context as `.bastion.Dockerfile`, so
 * a project's own Dockerfile is left alone.
 */

export const GENERATED_DOCKERFILE = '.bastion.Dockerfile';
const DEFAULT_NODE = '20';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'yarn-berry';

export interface BuildPlan {
  /** The build context directory (`build.dir` inside the extraction). */
  context: string;
  dockerfile: string;
  /** Generated Dockerfile text, added to the context; null for the project's own. */
  generated: string | null;
  /** Top-level names left out of the context. */
  exclude: string[];
  /** Human-readable notes for the build log. */
  notes: string[];
}

function exists(dir: string, name: string): boolean {
  try {
    return fs.lstatSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
}

function readText(dir: string, name: string): string | null {
  const file = path.join(dir, name);
  try {
    // Never through a link: extraction already kept links inside, but a config file should be a file
    if (!fs.lstatSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function detectPackageManager(dir: string): { manager: PackageManager; lockfile: string | null } {
  if (exists(dir, 'pnpm-lock.yaml')) return { manager: 'pnpm', lockfile: 'pnpm-lock.yaml' };
  if (exists(dir, 'yarn.lock')) return { manager: exists(dir, '.yarnrc.yml') ? 'yarn-berry' : 'yarn', lockfile: 'yarn.lock' };
  if (exists(dir, 'package-lock.json')) return { manager: 'npm', lockfile: 'package-lock.json' };
  if (exists(dir, 'npm-shrinkwrap.json')) return { manager: 'npm', lockfile: 'npm-shrinkwrap.json' };
  return { manager: 'npm', lockfile: null };
}

function installCommand(manager: PackageManager, lockfile: string | null): string {
  switch (manager) {
    case 'pnpm':
      return 'corepack enable && pnpm install --frozen-lockfile';
    case 'yarn':
      return 'corepack enable && yarn install --frozen-lockfile';
    case 'yarn-berry':
      return 'corepack enable && yarn install --immutable';
    default:
      return lockfile ? 'npm ci' : 'npm install';
  }
}

function runScript(manager: PackageManager, script: string): string {
  if (manager === 'pnpm') return `pnpm run ${script}`;
  if (manager === 'yarn' || manager === 'yarn-berry') return `yarn ${script}`;
  return `npm run ${script}`;
}

/** Major Node version: config, then .nvmrc / .node-version, then package.json engines, then 20. */
export function nodeVersion(dir: string, configured: string | null): string {
  if (configured) return configured;
  for (const name of ['.nvmrc', '.node-version']) {
    const m = /^\s*v?(\d{2})(?:\.\d+){0,2}\s*$/.exec(readText(dir, name) ?? '');
    if (m) return m[1]!;
  }
  try {
    const engines = (JSON.parse(readText(dir, 'package.json') ?? '{}') as { engines?: { node?: unknown } }).engines?.node;
    const m = typeof engines === 'string' ? /(\d{2})/.exec(engines) : null;
    if (m) return m[1]!;
  } catch {
    // unreadable package.json: the build reports it
  }
  return DEFAULT_NODE;
}

const STANDALONE = /output\s*:\s*['"`]standalone['"`]/;
const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts'];

/** Files the dependency stage copies before installing (only those present). */
function manifestFiles(dir: string, lockfile: string | null): string[] {
  return ['package.json', lockfile, '.npmrc', '.yarnrc.yml', 'pnpm-workspace.yaml'].filter((f): f is string => !!f && exists(dir, f));
}

export function nextjsDockerfile(dir: string, config: Pick<DeployAppConfig, 'build' | 'run'>): string {
  if (!exists(dir, 'package.json')) throw new BastionError('build.type is nextjs but there is no package.json in build.dir');
  const nextConfig = NEXT_CONFIGS.map((name) => readText(dir, name)).find((text) => text !== null);
  if (!nextConfig || !STANDALONE.test(nextConfig)) {
    throw new BastionError(
      "Next.js apps are deployed from Next's standalone output. Add output: 'standalone' to next.config " +
        '(e.g. `const nextConfig = { output: "standalone" }`), then deploy again.',
    );
  }
  const node = `node:${nodeVersion(dir, config.build.node)}-alpine`;
  const { manager, lockfile } = detectPackageManager(dir);
  const manifests = manifestFiles(dir, lockfile).map((f) => JSON.stringify(f)).join(', ');
  return [
    `FROM ${node} AS deps`,
    'WORKDIR /app',
    'RUN apk add --no-cache libc6-compat',
    `COPY [${manifests}, "./"]`,
    `RUN ${installCommand(manager, lockfile)}`,
    '',
    `FROM ${node} AS build`,
    'WORKDIR /app',
    'ENV NEXT_TELEMETRY_DISABLED=1',
    'COPY --from=deps /app/node_modules ./node_modules',
    'COPY . .',
    `RUN ${runScript(manager, 'build')} && mkdir -p public`,
    '',
    `FROM ${node} AS run`,
    'WORKDIR /app',
    `ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=${config.run.port} HOSTNAME=0.0.0.0`,
    'RUN addgroup -S app && adduser -S app -G app',
    'COPY --from=build --chown=app:app /app/public ./public',
    'COPY --from=build --chown=app:app /app/.next/standalone ./',
    'COPY --from=build --chown=app:app /app/.next/static ./.next/static',
    'USER app',
    `EXPOSE ${config.run.port}`,
    'CMD ["node", "server.js"]',
    '',
  ].join('\n');
}

export function staticDockerfile(dir: string, config: Pick<DeployAppConfig, 'build'>): string {
  const output = config.build.output ?? 'out';
  const serve = [`FROM ${CADDY_IMAGE}`, 'EXPOSE 80', 'CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":80"]'];
  if (!exists(dir, 'package.json')) {
    return [...serve.slice(0, 1), `COPY ${JSON.stringify([output, '/srv/'])}`, ...serve.slice(1), ''].join('\n');
  }
  const node = `node:${nodeVersion(dir, config.build.node)}-alpine`;
  const { manager, lockfile } = detectPackageManager(dir);
  const manifests = manifestFiles(dir, lockfile).map((f) => JSON.stringify(f)).join(', ');
  return [
    `FROM ${node} AS build`,
    'WORKDIR /app',
    `COPY [${manifests}, "./"]`,
    `RUN ${installCommand(manager, lockfile)}`,
    'COPY . .',
    `RUN ${runScript(manager, 'build')}`,
    '',
    serve[0],
    `COPY --from=build ${JSON.stringify([`/app/${output}`, '/srv/'])}`,
    ...serve.slice(1),
    '',
  ].join('\n');
}

/** Work out how to build the extracted upload at `extracted`. */
export function planBuild(extracted: string, config: Pick<DeployAppConfig, 'build' | 'run'>): BuildPlan {
  const context = path.resolve(extracted, config.build.dir);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(context);
  } catch {
    // reported below
  }
  if (!isInside(extracted, context) || !stat?.isDirectory()) {
    throw new BastionError(`build.dir ${config.build.dir} is not a folder in the upload`);
  }
  switch (config.build.type) {
    case 'dockerfile':
      if (!exists(context, 'Dockerfile')) throw new BastionError(`build.type is dockerfile but there is no Dockerfile in ${config.build.dir}`);
      return { context, dockerfile: 'Dockerfile', generated: null, exclude: ['.git'], notes: ["Building with the project's Dockerfile"] };
    case 'nextjs': {
      const { manager } = detectPackageManager(context);
      return {
        context,
        dockerfile: GENERATED_DOCKERFILE,
        generated: nextjsDockerfile(context, config),
        exclude: ['.git', 'node_modules', '.next'],
        notes: [`Building Next.js (standalone) with ${manager.replace('-berry', '')}`],
      };
    }
    case 'static':
      if (!exists(context, 'package.json')) {
        const output = path.resolve(context, config.build.output ?? 'out');
        let outStat: fs.Stats | null = null;
        try {
          outStat = fs.lstatSync(output);
        } catch {
          // reported below
        }
        if (!isInside(context, output) || !outStat?.isDirectory()) {
          throw new BastionError(`build.output ${config.build.output} is not a folder in the upload`);
        }
      }
      return {
        context,
        dockerfile: GENERATED_DOCKERFILE,
        generated: staticDockerfile(context, config),
        exclude: ['.git', 'node_modules'],
        notes: ['Building a static site served by Caddy'],
      };
  }
}
