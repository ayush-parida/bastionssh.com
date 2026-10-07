import fs from 'node:fs';
import path from 'node:path';
import { checkDeploySource, type DeployAppConfig, type DeploySourceView } from '@smt/shared';
import { BUN_IMAGE, CADDY_IMAGE, IMAGES, NODE_BUILD_VERSIONS, nodeBuildImage } from './images.js';
import { BastionError, isInside } from './names.js';

/**
 * How an app's image is built (deployments spec §5 step 3):
 *
 * - **nextjs** — a generated multi-stage Dockerfile: dependencies installed
 *   with the package manager the lockfile names (npm, pnpm, yarn or bun),
 *   `next build`, and a small runtime stage from Next's standalone output
 *   (required: `output: 'standalone'` in next.config).
 * - **dockerfile** — the project's own `Dockerfile`.
 * - **static** — built with Node when there is a package.json, then the
 *   `output` folder served by Caddy on port 80.
 *
 * Generated Dockerfiles are added to the context as `.bastion.Dockerfile`, so
 * a project's own Dockerfile is left alone.
 */

export const GENERATED_DOCKERFILE = '.bastion.Dockerfile';
const DEFAULT_NODE = '20';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'yarn-berry' | 'bun';

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
  if (exists(dir, 'bun.lock')) return { manager: 'bun', lockfile: 'bun.lock' };
  if (exists(dir, 'bun.lockb')) return { manager: 'bun', lockfile: 'bun.lockb' };
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
    case 'bun':
      return 'bun install --frozen-lockfile';
    default:
      return lockfile ? 'npm ci' : 'npm install';
  }
}

function runScript(manager: PackageManager, script: string): string {
  if (manager === 'pnpm') return `pnpm run ${script}`;
  if (manager === 'yarn' || manager === 'yarn-berry') return `yarn ${script}`;
  if (manager === 'bun') return `bun run ${script}`;
  return `npm run ${script}`;
}

/**
 * Lines a Node.js stage needs before it can run `manager` (corepack ships with Node for pnpm and yarn).
 * Bun is copied into the Node.js stages from its official image (pinned); Next itself still runs on Node.
 */
function toolLines(manager: PackageManager): string[] {
  return manager === 'bun' ? [`COPY --from=${BUN_IMAGE} /usr/local/bin/bun /usr/local/bin/bun`] : [];
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
    const m = typeof engines === 'string' ? /(>=?)?\s*v?(\d{2})(\.\d)?/.exec(engines) : null;
    if (m) {
      if (!m[1]) return m[2]!;
      // A floor (`>=16`, `>18`): the oldest pinned image that meets it
      const floor = Number(m[2]) + (m[1] === '>' && !m[3] ? 1 : 0);
      return NODE_BUILD_VERSIONS.find((v) => Number(v) >= floor) ?? m[2]!;
    }
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
  const node = nodeBuildImage(nodeVersion(dir, config.build.node));
  const { manager, lockfile } = detectPackageManager(dir);
  const manifests = manifestFiles(dir, lockfile).map((f) => JSON.stringify(f)).join(', ');
  return [
    `FROM ${node} AS deps`,
    'WORKDIR /app',
    'RUN apk add --no-cache libc6-compat',
    ...toolLines(manager),
    `COPY [${manifests}, "./"]`,
    `RUN ${installCommand(manager, lockfile)}`,
    '',
    `FROM ${node} AS build`,
    'WORKDIR /app',
    'ENV NEXT_TELEMETRY_DISABLED=1',
    ...toolLines(manager),
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
  const node = nodeBuildImage(nodeVersion(dir, config.build.node));
  const { manager, lockfile } = detectPackageManager(dir);
  const manifests = manifestFiles(dir, lockfile).map((f) => JSON.stringify(f)).join(', ');
  return [
    `FROM ${node} AS build`,
    'WORKDIR /app',
    ...toolLines(manager),
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

/** The build log's line naming the Node.js image a build uses (by tag and digest). */
function nodeNote(dir: string, configured: string | null): string {
  const version = nodeVersion(dir, configured);
  nodeBuildImage(version);
  const major = /^\d+/.exec(version)![0];
  const ref = (IMAGES.build as Record<string, string>)[major]!;
  return version === major ? `Node.js ${major}: ${ref}` : `Node.js ${version} asked for; building with the pinned Node.js ${major} image: ${ref}`;
}

/**
 * The extracted upload as the shared source check sees it ({@link checkDeploySource}).
 * Never through a link: a link to a folder is not a folder of the upload.
 */
export function sourceView(root: string): DeploySourceView {
  const resolve = (p: string) => {
    const full = path.resolve(root, p);
    return isInside(root, full) ? full : null;
  };
  const stat = (p: string) => {
    const full = resolve(p);
    try {
      return full ? fs.lstatSync(full) : null;
    } catch {
      return null;
    }
  };
  return {
    isFile: (p) => !!stat(p)?.isFile(),
    isDir: (p) => !!stat(p)?.isDirectory(),
    list: (dir) => {
      const full = resolve(dir);
      try {
        return full
          ? fs
              .readdirSync(full, { withFileTypes: true })
              .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
              .sort()
          : [];
      } catch {
        return [];
      }
    },
    readText: (p) => {
      const s = stat(p);
      // package.json: a file, and not one so large reading it is the problem
      if (!s?.isFile() || s.size > 1024 * 1024) return null;
      try {
        return fs.readFileSync(resolve(p)!, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Refuse an upload that cannot build as configured, with what to do instead
 * (a static site's `.next` folder, a package.json without a build script, a
 * missing output folder…). The browser runs the same check before uploading.
 */
export function checkSource(extracted: string, config: Pick<DeployAppConfig, 'build'>): void {
  const problem = checkDeploySource(sourceView(extracted), config.build);
  if (problem) throw new BastionError(`${problem.message} (Docs: ${problem.docs})`);
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
  checkSource(extracted, config);
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
        notes: [`Building Next.js (standalone) with ${manager.replace('-berry', '')}`, nodeNote(context, config.build.node)],
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
        notes: ['Building a static site served by Caddy', ...(exists(context, 'package.json') ? [nodeNote(context, config.build.node)] : [])],
      };
    case 'image':
      // checkSource refused it already: an image is pulled, not built from an upload
      throw new BastionError('build.type is image: nothing is built from an upload');
  }
}
