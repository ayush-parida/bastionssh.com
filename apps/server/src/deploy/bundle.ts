import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { BastionctlInfo } from '@smt/shared';

/**
 * The bastionctl this BastionSSH ships (packages/bastionctl, built into
 * dist/): the bundled program and its POSIX wrapper. Their SHA-256 is what
 * every server's installed copy is checked against before each use
 * (deployments spec §2.3) — computed here from the files themselves, not
 * taken from the build's manifest.
 */

export interface BastionctlBundle {
  /** `0.1.0+<build>` (the first 7 hex of the bundle hash, packages/bastionctl/build.mjs); plain `0.1.0` from older builds. */
  version: string;
  script: Buffer;
  wrapper: Buffer;
  scriptSha256: string;
  wrapperSha256: string;
  /** The nginx-mode helper an administrator installs root-owned (spec §6); absent from older builds. */
  nginxHelper?: Buffer;
  nginxHelperSha256?: string;
}

let cached: BastionctlBundle | null | undefined;

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const VERSION = String.raw`\d{1,4}\.\d{1,4}\.\d{1,4}(?:\+[0-9a-f]{7})?`;
/** Line 2 of a build-aware bundle: `// bastionctl 0.1.0+abc1234`. */
const BANNER = new RegExp(`^// bastionctl (${VERSION})$`, 'm');
/** Older bundles (plain 0.1.0) only have the constant. */
const CONSTANT = new RegExp(`\\bBASTIONCTL_VERSION\\d* = (?:true \\? )?"(${VERSION})"`);

/**
 * The version a bastionctl program says it is, read from its text: the
 * banner line a build-aware bundle starts with, else the version constant of
 * an older one (`0.1.0`). Null for a file that is neither.
 */
export function bastionctlVersionOf(script: Buffer): string | null {
  const head = script.subarray(0, 512).toString('utf8');
  const banner = BANNER.exec(head);
  if (banner) return banner[1]!;
  return CONSTANT.exec(script.toString('utf8'))?.[1] ?? null;
}

/** The built bundle, or null when packages/bastionctl has not been built. */
export function bastionctlBundle(): BastionctlBundle | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    const dir = path.dirname(require.resolve('@smt/bastionctl/package.json'));
    const script = readFileSync(path.join(dir, 'dist', 'bastionctl.mjs'));
    const wrapper = readFileSync(path.join(dir, 'dist', 'bastionctl'));
    const nginxHelper = readFileSync(path.join(dir, 'dist', 'bastion-nginx'));
    const { version } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string };
    cached = {
      version: bastionctlVersionOf(script) ?? version,
      script,
      wrapper,
      scriptSha256: sha256(script),
      wrapperSha256: sha256(wrapper),
      nginxHelper,
      nginxHelperSha256: sha256(nginxHelper),
    };
  } catch {
    cached = null;
  }
  return cached;
}

/** What `GET /api/deploy/bastionctl` reports; the program's hash identifies the build. */
export function bastionctlInfo(bundle: BastionctlBundle): BastionctlInfo {
  return { version: bundle.version, sha256: bundle.scriptSha256 };
}

/** Tests swap in their own bundle (or none). */
export function setBastionctlBundleForTests(bundle: BastionctlBundle | null | undefined): void {
  cached = bundle;
}
