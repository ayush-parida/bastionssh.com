import { DEPLOY_DOCS, DEPLOY_TROUBLESHOOTING_ANCHORS as A, type DeployBuildType } from '@smt/shared';

/**
 * The Deployments tab's pointers into the docs (Docs page, deployments
 * section): a guide per build type for the config editor and the deploy
 * dialog, and the troubleshooting section a failed deploy's log matches.
 */

const trouble = (anchor: string) => `${DEPLOY_DOCS.troubleshooting}#${anchor}`;

export interface BuildTypeGuide {
  title: string;
  /** What to upload, in a sentence. */
  upload: string;
  /** One line for the deploy dialog. */
  hint: string;
  /** The smallest config for this type (after name and domains). */
  yaml: string;
  docs: string;
}

export const BUILD_TYPE_GUIDES: Record<DeployBuildType, BuildTypeGuide> = {
  static: {
    title: 'Static site',
    upload: 'Upload the built site — for Next.js, the out folder from output: \'export\' (it contains index.html), with output set to . — or the project with a build script, and output set to the folder it builds.',
    hint: 'Static app: pick your out folder (it must contain index.html), not .next.',
    yaml: 'build:\n  type: static\n  output: .      # the upload is the out folder itself',
    docs: DEPLOY_DOCS.staticSite,
  },
  nextjs: {
    title: 'Next.js (built on the server)',
    upload: "Upload the project folder (package.json, lockfile, next.config with output: 'standalone'). The server installs, builds and runs it; builds need 1–2 GB of memory.",
    hint: "Next.js app: pick the project folder with package.json and next.config (output: 'standalone') — not .next.",
    yaml: 'build:\n  type: nextjs\nrun:\n  port: 3000',
    docs: DEPLOY_DOCS.nextjs,
  },
  dockerfile: {
    title: 'Your own Dockerfile',
    upload: 'Upload the folder with your Dockerfile at its top. The app must listen on 0.0.0.0 at run.port and answer the health check.',
    hint: 'Dockerfile app: pick the folder with the Dockerfile at its top (a prebuilt Next.js standalone build goes up as a .tar.gz).',
    yaml: 'build:\n  type: dockerfile\nrun:\n  port: 3000',
    docs: DEPLOY_DOCS.dockerfile,
  },
};

export interface LogHint {
  pattern: RegExp;
  label: string;
  href: string;
}

/** Failures the deploy log may show, most specific first. */
export const DEPLOY_LOG_HINTS: readonly LogHint[] = [
  { pattern: /\.next build folder|is a Next\.js build folder/, label: 'Uploaded a Next.js build folder', href: trouble(A.nextBuildFolder) },
  { pattern: /Missing script:\s*"?build"?|has no build script|package\.json is not valid JSON/i, label: 'Missing script: build', href: trouble(A.missingBuildScript) },
  { pattern: /standalone output|output: 'standalone'/, label: 'Standalone output required', href: trouble(A.standalone) },
  { pattern: /build\.output \S+ is not a folder in the upload/, label: 'Output folder not found', href: trouble(A.outputMissing) },
  { pattern: /no package\.json in/, label: 'Upload has no package.json', href: trouble(A.noPackageJson) },
  { pattern: /no Dockerfile in/, label: 'No Dockerfile in the upload', href: trouble(A.noDockerfile) },
  { pattern: /Health check failed|The new container stopped/, label: 'Health check failed', href: trouble(A.healthCheck) },
  { pattern: /Ports 80\/443 are taken|address already in use|port is already allocated/i, label: 'Ports 80 or 443 already in use', href: trouble(A.ports) },
  { pattern: /not the version this BastionSSH ships|bastionctl needs reinstalling/, label: 'Reinstall bastionctl', href: trouble(A.integrity) },
  { pattern: /exit code: 137|heap out of memory|Reached heap limit|\bKilled\b|out of memory/i, label: 'Build ran out of memory', href: trouble(A.memory) },
];

/** The troubleshooting section for a log line or error, or null. */
export function deployLogHint(text: string): LogHint | null {
  return DEPLOY_LOG_HINTS.find((h) => h.pattern.test(text)) ?? null;
}

/** The first known failure in a deploy's error and log (the error first: it says why). */
export function deployFailureHint(error: string | null, lines: readonly { text: string }[]): LogHint | null {
  if (error) {
    const hint = deployLogHint(error);
    if (hint) return hint;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const hint = deployLogHint(lines[i]!.text);
    if (hint) return hint;
  }
  return null;
}
