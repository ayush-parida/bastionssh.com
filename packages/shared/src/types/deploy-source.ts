import type { DeployAppConfig } from './deploy.js';

/**
 * A sanity check of a deploy upload before anything is built (deployments
 * docs, "Troubleshooting"): the mistakes that otherwise surface as a
 * confusing build failure — Next's `.next` build folder uploaded as a static
 * site, a package.json with no `build` script, an output folder that is not
 * there. The browser runs it on the packed file list before uploading, and
 * bastionctl again on the extracted upload before building, so a deploy from
 * a shell gets the same answer.
 *
 * Pure: it looks at the upload through a {@link DeploySourceView}, which the
 * browser builds from file paths and bastionctl from the file system.
 */

/** The upload as the check sees it. Paths are relative to the upload's root, `/`-separated; `''` is the root. */
export interface DeploySourceView {
  isFile(path: string): boolean;
  isDir(path: string): boolean;
  /** Names directly inside a folder, folders with a trailing `/`, sorted. */
  list(dir: string): string[];
  /** A small text file (package.json), or null when it is not there or cannot be read. */
  readText(path: string): string | null;
}

export type DeploySourceProblemCode =
  | 'dir_missing'
  | 'next_build_folder'
  | 'no_build_script'
  | 'bad_package_json'
  | 'output_missing'
  | 'no_package_json'
  | 'no_dockerfile'
  | 'image_takes_no_source';

export interface DeploySourceProblem {
  code: DeploySourceProblemCode;
  message: string;
  /** The page of the in-app docs that explains it (`/docs/<section>/<slug>#<anchor>`). */
  docs: string;
}

/** Where the deployment docs live in the app, and the troubleshooting anchors the checks and the deploy log link to. */
export const DEPLOY_DOCS = {
  overview: '/docs/deployments/overview',
  staticSite: '/docs/deployments/static-site',
  nextjs: '/docs/deployments/nextjs-dynamic',
  dockerfile: '/docs/deployments/dockerfile',
  config: '/docs/deployments/bastion-yml',
  troubleshooting: '/docs/deployments/troubleshooting',
} as const;

export const DEPLOY_TROUBLESHOOTING_ANCHORS = {
  missingBuildScript: 'missing-script-build',
  nextBuildFolder: 'uploaded-a-nextjs-build-folder',
  standalone: 'standalone-output-required',
  outputMissing: 'output-folder-not-found',
  noPackageJson: 'upload-has-no-packagejson',
  noDockerfile: 'no-dockerfile-in-the-upload',
  healthCheck: 'health-check-failed',
  dns: 'dns-not-pointing-at-the-server',
  ports: 'ports-80-or-443-already-in-use',
  integrity: 'integrity-check-failed-reinstall',
  memory: 'build-ran-out-of-memory',
  certificate: 'certificate-not-issued',
} as const;

const trouble = (anchor: keyof typeof DEPLOY_TROUBLESHOOTING_ANCHORS) => `${DEPLOY_DOCS.troubleshooting}#${DEPLOY_TROUBLESHOOTING_ANCHORS[anchor]}`;

/** `a`, `./b`, `.` → `a/b`: a path inside the upload, `''` for its root. */
export function joinSourcePath(...parts: string[]): string {
  return parts
    .join('/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

/** Files that mark Next's build folder (`.next`, or `out` when next.config sets `distDir: 'out'` without `output: 'export'`). */
export function looksLikeNextBuild(view: DeploySourceView, dir: string): boolean {
  const at = (name: string) => joinSourcePath(dir, name);
  return view.isFile(at('BUILD_ID')) || view.isFile(at('required-server-files.json')) || (view.isDir(at('server')) && view.isDir(at('static')));
}

/** What is at the top of a folder, for a message: `index.html, _next/, … (12 entries)`. */
function describeTop(view: DeploySourceView, dir: string): string {
  const names = view.list(dir);
  if (names.length === 0) return 'nothing';
  const shown = names.slice(0, 8).join(', ');
  return names.length > 8 ? `${shown}, … (${names.length} entries)` : shown;
}

const where = (dir: string) => (dir === '' ? 'the upload' : `${dir}/ in the upload`);

/**
 * The first problem found with an upload for `build`, or null when it looks
 * deployable. Only what can be told before a build: a static site with a
 * package.json is built first, so its output folder is not looked for.
 */
export function checkDeploySource(view: DeploySourceView, build: Pick<DeployAppConfig['build'], 'type' | 'dir' | 'output'>): DeploySourceProblem | null {
  const dir = joinSourcePath(build.dir);
  if (dir !== '' && !view.isDir(dir)) {
    return {
      code: 'dir_missing',
      message: `build.dir ${build.dir} is not a folder in the upload. At the top of the upload: ${describeTop(view, '')}.`,
      docs: DEPLOY_DOCS.config,
    };
  }
  const packageJson = joinSourcePath(dir, 'package.json');

  if (build.type === 'image') {
    return {
      code: 'image_takes_no_source',
      message: 'build.type is image: the server pulls build.image from its registry, so there is nothing to upload. Deploy it without a source.',
      docs: `${DEPLOY_DOCS.config}#buildimage`,
    };
  }

  if (build.type === 'dockerfile') {
    if (view.isFile(joinSourcePath(dir, 'Dockerfile'))) return null;
    return {
      code: 'no_dockerfile',
      message: `build.type is dockerfile but there is no Dockerfile in ${where(dir)}. Found: ${describeTop(view, dir)}.`,
      docs: trouble('noDockerfile'),
    };
  }

  if (build.type === 'nextjs') {
    if (looksLikeNextBuild(view, dir)) {
      return {
        code: 'next_build_folder',
        message:
          "This is Next's .next build folder, not your project's source. build.type nextjs builds on the server from source: upload the project folder " +
          '(the one with package.json and next.config). To upload only a build you made yourself, use build.type: dockerfile.',
        docs: trouble('nextBuildFolder'),
      };
    }
    if (!view.isFile(packageJson)) {
      return {
        code: 'no_package_json',
        message: `build.type is nextjs but there is no package.json in ${where(dir)}. Upload the project folder (package.json, next.config, app/ or pages/). Found: ${describeTop(view, dir)}.`,
        docs: trouble('noPackageJson'),
      };
    }
    return null;
  }

  // static
  const output = build.output ?? 'out';
  if (looksLikeNextBuild(view, dir)) {
    return {
      code: 'next_build_folder',
      message:
        "This is Next's .next build folder, not a static export. Set output: 'export' in next.config, run the build, and upload the out folder (it contains index.html).",
      docs: trouble('nextBuildFolder'),
    };
  }
  if (view.isFile(packageJson)) {
    let scripts: unknown;
    try {
      scripts = (JSON.parse(view.readText(packageJson) ?? '') as { scripts?: unknown }).scripts;
    } catch {
      return { code: 'bad_package_json', message: `${packageJson} is not valid JSON, so the site cannot be built.`, docs: trouble('missingBuildScript') };
    }
    const script = typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, unknown>).build : undefined;
    if (typeof script !== 'string' || script.trim() === '') {
      return {
        code: 'no_build_script',
        message:
          'package.json has no build script, so there is nothing to build (npm run build would fail with "Missing script: build"). ' +
          'To deploy a site you already built, upload only its output folder (the out folder, with index.html) and set build.output to . — or add a build script.',
        docs: trouble('missingBuildScript'),
      };
    }
    return null;
  }
  const out = joinSourcePath(dir, output);
  if (!view.isDir(out)) {
    const here = view.isFile(joinSourcePath(dir, 'index.html'));
    return {
      code: 'output_missing',
      message:
        `build.output ${output} is not a folder in the upload. At the top of ${where(dir)}: ${describeTop(view, dir)}. ` +
        (here
          ? 'Those look like the site itself: set build.output to . (or upload the folder that contains them as out/).'
          : `Upload the folder that contains ${output}/, or set build.output to the folder your index.html is in.`),
      docs: trouble('outputMissing'),
    };
  }
  if (looksLikeNextBuild(view, out)) {
    return {
      code: 'next_build_folder',
      message:
        `${output} is a Next.js build folder (BUILD_ID, server/, static/), not a static export — next.config sets distDir: '${output}' without output: 'export'. ` +
        "Set output: 'export', remove distDir, run the build, and upload the out folder (it contains index.html).",
      docs: trouble('nextBuildFolder'),
    };
  }
  return null;
}

/** A {@link DeploySourceView} of a list of file paths (folders are implied), with the text of the files that may be read. */
export function deploySourceViewFromPaths(paths: readonly string[], texts: Readonly<Record<string, string>> = {}): DeploySourceView {
  const files = new Set<string>();
  const children = new Map<string, Set<string>>();
  const add = (dir: string, name: string) => {
    let set = children.get(dir);
    if (!set) children.set(dir, (set = new Set()));
    set.add(name);
  };
  for (const raw of paths) {
    const path = joinSourcePath(raw);
    if (!path) continue;
    files.add(path);
    const segs = path.split('/');
    for (let i = 0; i < segs.length; i++) {
      add(segs.slice(0, i).join('/'), i === segs.length - 1 ? segs[i]! : `${segs[i]}/`);
    }
  }
  return {
    isFile: (p) => files.has(joinSourcePath(p)),
    isDir: (p) => {
      const path = joinSourcePath(p);
      return path === '' ? files.size > 0 : children.has(path);
    },
    list: (dir) => [...(children.get(joinSourcePath(dir)) ?? [])].sort(),
    readText: (p) => texts[joinSourcePath(p)] ?? null,
  };
}
