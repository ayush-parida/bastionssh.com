/**
 * Builds on the BastionSSH side (bastion-side builds spec) and what every
 * build shares with them: which uploaded files are environment files (left
 * out unless asked for), which `.env` variables a build may see, and how
 * their values are kept out of logs. Pure, so the browser's packer,
 * BastionSSH and bastionctl apply the same rules.
 */

/** The `.env` name prefix every build gets as a build arg: Next.js inlines these into the browser's JavaScript. */
export const DEPLOY_PUBLIC_ENV_PREFIX = 'NEXT_PUBLIC_';

/** Most names `build.args` may list. */
export const DEPLOY_MAX_BUILD_ARGS = 64;

/**
 * An environment file by its name: `.env` and `.env.<anything>` at any depth,
 * except `.env.example` (a template meant to be committed). Uploads leave
 * them out unless the person deploying includes them on purpose: they tend
 * to hold secrets, which would end up in the release's source on the server
 * and, through `COPY . .`, in the image.
 */
export function isDeployEnvFile(path: string): boolean {
  const name = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example');
}

/** Whether `.env` variable `name` is passed to a build: every `NEXT_PUBLIC_*`, and the names `build.args` lists. */
export function isDeployBuildArg(name: string, allowed: readonly string[] = []): boolean {
  return name.startsWith(DEPLOY_PUBLIC_ENV_PREFIX) || allowed.includes(name);
}

/** The build args among `.env` values: `NEXT_PUBLIC_*` and `build.args`, nothing else. */
export function pickDeployBuildArgs(env: Iterable<[string, string]>, allowed: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of env) if (isDeployBuildArg(key, allowed)) out[key] = value;
  return out;
}

// ── Masking secret values in logs ─────────────────────────────────────────────

export const DEPLOY_MASK = '••••';
/** Shorter values (`1`, `true`, `prod`) would mask ordinary words. */
export const DEPLOY_MIN_SECRET_LENGTH = 6;

/**
 * The texts a value can show up as: itself; each of its lines, since a
 * multi-line value (a PEM key) printed by an app reaches a log one line at a
 * time; and its JSON-escaped form (an app logging its config as JSON).
 */
function forms(value: string): string[] {
  const out = [value];
  if (/[\r\n]/.test(value)) out.push(...value.split(/\r?\n|\r/).map((line) => line.trim()));
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) out.push(escaped);
  return out;
}

/**
 * A function replacing every occurrence of `values` (of at least
 * {@link DEPLOY_MIN_SECRET_LENGTH} characters) in a text with
 * {@link DEPLOY_MASK}: bastionctl's deploy log, build.log and release.json,
 * and the log of a build on the BastionSSH side.
 */
export function secretMasker(values: Iterable<string>): (text: string) => string {
  // Longest first: a value containing another is masked whole
  const secrets = [
    ...new Set([...values].filter((v) => v.length >= DEPLOY_MIN_SECRET_LENGTH).flatMap(forms).filter((v) => v.length >= DEPLOY_MIN_SECRET_LENGTH)),
  ].sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(DEPLOY_MASK);
    return out;
  };
}

// ── The builder ───────────────────────────────────────────────────────────────

/**
 * `GET /api/deploy/builder`: BastionSSH's BuildKit service as BastionSSH sees
 * it now (nothing is stored). `configured` is false when this BastionSSH has
 * no builder address (`SMT_BUILDKIT_ADDR`), so `build.where: bastion` cannot
 * be used.
 */
export interface DeployBuilderStatus {
  configured: boolean;
  reachable: boolean;
  /** The builder's own platform (`linux/arm64`): images for another one are built under QEMU emulation, much slower. */
  platform: string | null;
  /** Every platform it can build for (its own and emulated ones). */
  platforms: string[];
  /** BuildKit's version (`v0.33.1`). */
  version: string | null;
  /** The layer cache's size on disk, in bytes. */
  cacheBytes: number | null;
  /** The cache is garbage-collected beyond this (`keepStorage`), when known. */
  cacheLimitBytes: number | null;
  /** A build running now, and how many wait their turn (one build at a time). */
  running: { app: string; serverId: string; since: string } | null;
  queued: number;
  error: string | null;
}

/** `GET /api/deploy/servers/:id/platform`: the platform the server's Docker runs images for (`linux/amd64`). */
export interface DeployServerPlatform {
  platform: string;
}

/** `POST /api/deploy/builder/prune`: what clearing the build cache freed. */
export interface DeployBuilderPruneResult {
  reclaimedBytes: number;
  records: number;
}

/** Whether building on `builder` for `target` runs under emulation (another CPU architecture): slower, often several times. */
export function isEmulatedBuild(builder: string | null, target: string | null): boolean {
  if (!builder || !target) return false;
  const arch = (p: string) => p.split('/').slice(1).join('/').replace(/^arm64\/v8$/, 'arm64');
  return arch(builder) !== arch(target);
}
