import type { DeployServerState } from '@smt/shared';
import { shellCommand } from '../docker/shell.js';
import { bastionctlBundle, type BastionctlBundle } from './bundle.js';
import { DeployError } from './errors.js';
import type { Remote } from './remote.js';

/**
 * Where deployments live on a server and whether its bastionctl is ours
 * (deployments spec §2.3, §2.4). The root directory is `/opt/bastion` when
 * the SSH user can write it (created with passwordless `sudo` at setup when
 * allowed), otherwise `$HOME/bastion` — discovered on every use, never
 * stored. Before any bastionctl run, the installed program and wrapper must
 * hash to exactly what this BastionSSH ships; otherwise the command is
 * refused and the server offers Reinstall (setup).
 *
 * Both scripts are constant: nothing from a request is spliced into them.
 */

/** Finds an installed root: the first of /opt/bastion, $HOME/bastion with bin/bastionctl that we can write. */
export const DISCOVER_SCRIPT = [
  'for d in /opt/bastion "$HOME/bastion"; do',
  '  if [ -f "$d/bin/bastionctl" ] && [ -w "$d" ]; then cd "$d" && printf "root=%s\\n" "$(pwd -P)"; exit 0; fi',
  'done',
  'printf "root=\\n"',
].join('\n');

/**
 * Picks (and creates) the root for setup, and reports what setup needs:
 * Docker, and whether the SSH user may use its socket directly or through
 * passwordless sudo.
 */
export const PREPARE_SCRIPT = [
  'set -u',
  'sudo_used=no',
  'if [ -d /opt/bastion ] && [ -w /opt/bastion ]; then r=/opt/bastion',
  'elif [ ! -e /opt/bastion ] && mkdir /opt/bastion 2>/dev/null; then r=/opt/bastion',
  'elif [ ! -e /opt/bastion ] && sudo -n true 2>/dev/null && sudo -n mkdir -p /opt/bastion && sudo -n chown "$(id -u):$(id -g)" /opt/bastion; then r=/opt/bastion; sudo_used=yes',
  'else r="$HOME/bastion"; mkdir -p "$r" || exit 1',
  'fi',
  'mkdir -p "$r/bin" "$r/tmp" && chmod 700 "$r/tmp" || exit 1',
  'cd "$r" && printf "root=%s\\n" "$(pwd -P)"',
  'printf "sudo=%s\\n" "$sudo_used"',
  's=/var/run/docker.sock',
  'if command -v docker >/dev/null 2>&1; then printf "docker=yes\\n"; else printf "docker=no\\n"; fi',
  'if [ -S "$s" ] && [ -w "$s" ]; then printf "socket=writable\\n"; elif [ -S "$s" ] && sudo -n docker version >/dev/null 2>&1; then printf "socket=sudo\\n"; elif [ -S "$s" ]; then printf "socket=denied\\n"; else printf "socket=missing\\n"; fi',
].join('\n');

/** Key=value lines a script printed. */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

const shScript = (script: string) => shellCommand(['sh', '-c', script]);

/** A root printed by a script: absolute, normalized, no control characters or quotes. */
function checkedRoot(value: string | undefined): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith('/') || /[\0-\x1f'"\\]/.test(value) || value.split('/').includes('..') || value.length > 1024) {
    throw new DeployError(`The server reported an unusable deployments folder: ${JSON.stringify(value.slice(0, 200))}`, 502);
  }
  return value;
}

export async function discoverRoot(remote: Remote): Promise<string | null> {
  const result = await remote.run(shScript(DISCOVER_SCRIPT), { timeoutMs: 20_000 });
  if (result.exitCode !== 0) throw new DeployError(`Could not look for deployments on the server: ${result.stderr.trim() || 'no answer'}`, 502);
  return checkedRoot(parseKeyValues(result.stdout).root);
}

export interface PreparedRoot {
  root: string;
  sudo: boolean;
  docker: boolean;
  socket: 'writable' | 'sudo' | 'denied' | 'missing';
}

export async function prepareRoot(remote: Remote): Promise<PreparedRoot> {
  const result = await remote.run(shScript(PREPARE_SCRIPT), { timeoutMs: 30_000 });
  const values = parseKeyValues(result.stdout);
  const root = checkedRoot(values.root);
  if (result.exitCode !== 0 || !root) {
    throw new DeployError(`Could not create the deployments folder on the server: ${result.stderr.trim() || 'no answer'}`, 502);
  }
  const socket = (['writable', 'sudo', 'denied', 'missing'] as const).find((s) => s === values.socket) ?? 'missing';
  return { root, sudo: values.sudo === 'yes', docker: values.docker === 'yes', socket };
}

export function requireBundle(): BastionctlBundle {
  const bundle = bastionctlBundle();
  if (!bundle) {
    throw new DeployError('This BastionSSH was built without bastionctl (build packages/bastionctl)', 503, 'bastionctl_missing_bundle');
  }
  return bundle;
}

export const scriptPath = (root: string) => `${root}/bin/bastionctl.mjs`;
export const wrapperPath = (root: string) => `${root}/bin/bastionctl`;

/** Compare the installed files with the shipped ones. */
export async function integrity(remote: Remote, root: string, bundle = requireBundle()): Promise<DeployServerState['integrity']> {
  const [script, wrapper] = await Promise.all([remote.hashFile(scriptPath(root)), remote.hashFile(wrapperPath(root))]);
  if (script === null || wrapper === null) return 'missing';
  return script === bundle.scriptSha256 && wrapper === bundle.wrapperSha256 ? 'ok' : 'mismatch';
}

/** Throws unless the installed bastionctl is exactly the shipped one. */
export async function verifyInstalled(remote: Remote, root: string, bundle = requireBundle()): Promise<void> {
  const state = await integrity(remote, root, bundle);
  if (state === 'missing') throw new DeployError('bastionctl is missing on this server; set it up again', 409, 'not_set_up');
  if (state === 'mismatch') {
    throw new DeployError(
      'The bastionctl on this server is not the version this BastionSSH ships (or it was modified). Reinstall it with Set up.',
      409,
      'bastionctl_mismatch',
    );
  }
}

/** Upload both files (0755, owned by the SSH user) and check what landed. */
export async function installBastionctl(remote: Remote, root: string, bundle = requireBundle()): Promise<void> {
  await remote.writeFile(scriptPath(root), bundle.script, 0o755);
  await remote.writeFile(wrapperPath(root), bundle.wrapper, 0o755);
  await verifyInstalled(remote, root, bundle);
}
