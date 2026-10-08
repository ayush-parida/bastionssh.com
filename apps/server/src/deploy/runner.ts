import type { DeployProxyUpgrade } from '@smt/shared';
import { shellCommand } from '../docker/shell.js';
import { DeployError } from './errors.js';
import { wrapperPath } from './install.js';
import type { Remote, RunOptions, RunResult } from './remote.js';

/**
 * Running bastionctl over SSH (deployments spec §7, §8). The command line is
 * built from an argv, every element single-quoted; on top of that each
 * argument must look like what bastionctl takes — a subcommand, a validated
 * name, a flag we know, or a path under the root — so nothing a request
 * carries can become an option or a shell word. `--json` is always passed;
 * the result is the last line bastionctl prints on stdout.
 */

/** Generous: a deploy builds an image. */
export const DEPLOY_TIMEOUT_MS = 30 * 60_000;
export const SETUP_TIMEOUT_MS = 10 * 60_000;
export const COMMAND_TIMEOUT_MS = 2 * 60_000;

const FLAGS = new Set([
  '--source',
  '--config',
  '--file',
  '--force',
  '--purge',
  '--drain',
  '--proxy',
  '--bytes',
  '--if-missing',
  '--keep',
  '--force-line',
  '--include-env-files',
  '--prebuilt',
  '--checksum',
  '--build-ms',
]);
const WORD = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/**
 * An image reference (set-image: a catalog image, or the one a failed
 * Update version puts back): starts with a lower-case letter or digit, so it
 * is never an option; bastionctl checks it is a reference.
 */
const IMAGE = /^[a-z0-9][a-z0-9._/:-]{0,255}(?:@sha256:[a-f0-9]{64})?$/;

function checkedArg(arg: string, root: string): string {
  if (FLAGS.has(arg) || WORD.test(arg) || IMAGE.test(arg)) return arg;
  // Paths are only ever ones we built under the root
  const rest = arg.startsWith(`${root}/`) ? arg.slice(root.length + 1) : null;
  if (rest && /^[A-Za-z0-9/_.-]+$/.test(rest) && !rest.split('/').includes('..')) return arg;
  throw new DeployError(`Refusing to pass ${JSON.stringify(arg.slice(0, 80))} to bastionctl`, 400);
}

/** Who bastionctl records (release.json); one line, printable. */
export function actorLabel(user: { email: string; id: string }): string {
  // eslint-disable-next-line no-control-regex
  return (user.email || user.id).replace(/[\0-\x1f\x7f]/g, '').slice(0, 200);
}

export function bastionctlCommand(root: string, args: string[], actor: string): string {
  return shellCommand(['env', `BASTION_ACTOR=${actor}`, wrapperPath(root), ...args.map((a) => checkedArg(a, root)), '--json']);
}

/**
 * The proxy upgrade bastionctl reports beside a result or an error (services
 * spec §2): commands that change traffic upgrade an outdated proxy first.
 */
export function proxyUpgradeOf(value: unknown): DeployProxyUpgrade | null {
  const u = (value as { proxyUpgrade?: unknown } | null)?.proxyUpgrade as Partial<DeployProxyUpgrade> | undefined;
  if (!u || typeof u !== 'object' || typeof u.to !== 'string' || (u.result !== 'success' && u.result !== 'failed')) return null;
  return u as DeployProxyUpgrade;
}

export interface BastionctlRun<T> {
  value: T;
  result: RunResult;
}

/** bastionctl's `{ error, code }` answer, as an HTTP status. */
function statusFor(code: unknown, message: string): number {
  if (code === 2) return 400;
  if (code === 3) return 422;
  if (code === 4) return 409;
  if (/^No app named|has no release|no current release/.test(message)) return 404;
  return 409;
}

/** The JSON result line, or null when bastionctl printed none (it never started, or was cut off). */
export function parseResult(stdout: string): unknown {
  const line = stdout.trim().split('\n').pop()?.trim();
  if (!line || !line.startsWith('{') && !line.startsWith('[')) return null;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

/**
 * Run `bastionctl <args> --json` and return its result; bastionctl's own
 * errors become {@link DeployError}s with a matching status. `allowError`
 * returns `{ error }` results (validation) instead of throwing.
 */
export async function bastionctl<T>(
  remote: Remote,
  root: string,
  args: string[],
  opts: RunOptions & { actor: string; allowFailure?: boolean; onProxyUpgrade?: (upgrade: DeployProxyUpgrade) => void | Promise<void> },
): Promise<BastionctlRun<T>> {
  const result = await remote.run(bastionctlCommand(root, args, opts.actor), { timeoutMs: COMMAND_TIMEOUT_MS, ...opts });
  if (result.timedOut) throw new DeployError(`bastionctl ${args[0]} did not finish in time`, 504);
  const value = parseResult(result.stdout);
  if (value === null) {
    const detail = result.stderr.trim().split('\n').slice(-5).join('\n');
    throw new DeployError(`bastionctl ${args[0]} failed${detail ? `: ${detail}` : ' with no output'}`, 502);
  }
  const upgrade = proxyUpgradeOf(value);
  if (upgrade) await opts.onProxyUpgrade?.(upgrade);
  const failure = value as { error?: unknown; code?: unknown };
  if (typeof failure.error === 'string' && !opts.allowFailure) {
    throw new DeployError(failure.error, statusFor(failure.code, failure.error), failure.code === 4 ? 'locked' : undefined);
  }
  return { value: value as T, result };
}
