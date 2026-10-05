import {
  DEPLOY_NAME_PATTERN,
  type DeployCertFacts,
  type DeployNginxApplyResult,
  type DeployNginxState,
  type DeployProxyMode,
  type DeployProxyState,
} from '@smt/shared';
import { shellCommand, shellQuote } from '../docker/shell.js';
import type { BastionctlBundle } from './bundle.js';
import { DeployError } from './errors.js';
import { parseKeyValues } from './install.js';
import type { Remote } from './remote.js';

/**
 * nginx mode, BastionSSH's half (deployments spec §2.5, §6). bastionctl runs
 * in a container and cannot touch the host, so the host's nginx is changed by
 * `bastion-nginx`, a POSIX script shipped with bastionctl
 * (packages/bastionctl/bastion-nginx.sh) that an administrator installs
 * root-owned at {@link NGINX_HELPER_PATH} and allows through passwordless
 * sudo — the only command BastionSSH ever runs as root. It writes
 * `/etc/nginx/conf.d/bastion-<app>.conf` (Alpine: `http.d`) from the facts bastionctl left in
 * `<root>/proxy/nginx/<app>.site`, runs `nginx -t` and reloads (restoring the
 * previous file on failure), and gets certificates with `certbot certonly
 * --webroot`, renewed by certbot's timer with a reload hook.
 *
 * Here: detecting a host nginx (setup picks nginx mode when one owns 80/443),
 * the one-time setup commands for an administrator, checking the installed
 * helper is byte for byte the shipped one before each use, and running it
 * after a deploy, a config change or a delete. Every script below is
 * constant; the helper's arguments are a subcommand, the root directory
 * (discovered and checked) and a validated app name, each shell-quoted.
 */

export const NGINX_HELPER_PATH = '/usr/local/sbin/bastion-nginx';
/** Certbot asks Let's Encrypt; give it time. */
const HELPER_TIMEOUT_MS = 5 * 60_000;

/** What the host has: nginx installed and running, who listens on 80/443, certbot, the conf.d include, the helper and sudo for it. */
export const DETECT_SCRIPT = [
  'set -u',
  `h=${NGINX_HELPER_PATH}`,
  'if command -v nginx >/dev/null 2>&1 || [ -x /usr/sbin/nginx ]; then echo installed=yes; else echo installed=no; fi',
  // nginx retitles its processes ("nginx: master process …"), which BusyBox's pgrep -x matches against
  "if pgrep -x nginx >/dev/null 2>&1 || pgrep -f '^nginx: master process' >/dev/null 2>&1; then echo running=yes; else echo running=no; fi",
  // The local address is the 4th column of both `ss -Hltn` and `netstat -ltn`
  'listening() { (ss -Hltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk -v p=":$1" \'substr($4, length($4) - length(p) + 1) == p { f = 1 } END { exit !f }\'; }',
  'if listening 80; then echo http=yes; else echo http=no; fi',
  'if listening 443; then echo https=yes; else echo https=no; fi',
  'if command -v certbot >/dev/null 2>&1; then echo certbot=yes; else echo certbot=no; fi',
  // Where the helper writes server blocks: Alpine's conf.d is included outside http { }, its http.d inside
  'd=conf; if [ -d /etc/nginx/http.d ]; then d=http; fi',
  `if grep -qsE "^[[:space:]]*include[[:space:]]+/etc/nginx/$d\\.d/\\*\\.conf" /etc/nginx/nginx.conf; then echo include=yes; else echo include=no; fi`,
  'if sudo -n -l "$h" >/dev/null 2>&1; then echo sudo=yes; else echo sudo=no; fi',
].join('\n');

const yes = (v: string | undefined) => v === 'yes';

/** The host's nginx as the SSH user sees it, and whether the installed helper is ours. */
export async function detectNginx(remote: Remote, bundle: BastionctlBundle): Promise<DeployNginxState> {
  const result = await remote.run(shellCommand(['sh', '-c', DETECT_SCRIPT]), { timeoutMs: 20_000 });
  if (result.exitCode !== 0) throw new DeployError(`Could not look for nginx on the server: ${result.stderr.trim() || 'no answer'}`, 502);
  const v = parseKeyValues(result.stdout);
  const installed = yes(v.installed);
  const running = yes(v.running);
  const ports = { http: yes(v.http), https: yes(v.https) };
  return {
    detected: installed && running && (ports.http || ports.https),
    installed,
    running,
    ports,
    certbot: yes(v.certbot),
    confInclude: yes(v.include),
    helper: await helperIntegrity(remote, bundle),
    sudo: yes(v.sudo),
  };
}

export async function helperIntegrity(remote: Remote, bundle: BastionctlBundle): Promise<DeployNginxState['helper']> {
  const hash = await remote.hashFile(NGINX_HELPER_PATH);
  if (hash === null) return 'missing';
  return bundle.nginxHelperSha256 && hash === bundle.nginxHelperSha256 ? 'ok' : 'mismatch';
}

/** What an administrator runs once (in order) for what is still missing; empty when nginx mode is ready. */
export function nginxInstructions(root: string, username: string, nginx: DeployNginxState): string[] {
  const steps: string[] = [];
  if (!nginx.installed) steps.push('sudo apt-get install -y nginx    # or your distribution’s package; nginx mode is for servers that already run nginx');
  if (!nginx.certbot) steps.push('sudo apt-get install -y certbot    # or your distribution’s certbot package (its timer renews certificates)');
  if (nginx.installed && !nginx.confInclude) {
    steps.push('# /etc/nginx/nginx.conf must include /etc/nginx/conf.d/*.conf (on Alpine /etc/nginx/http.d/*.conf) inside http { }: the server blocks are written there');
  }
  if (nginx.helper !== 'ok') steps.push(shellCommand(['sudo', 'install', '-o', 'root', '-g', 'root', '-m', '0755', `${root}/bin/bastion-nginx`, NGINX_HELPER_PATH]));
  if (!nginx.sudo) {
    const rule = `${username} ALL=(root) NOPASSWD: ${NGINX_HELPER_PATH}`;
    steps.push(`echo ${shellQuote(rule)} | sudo tee /etc/sudoers.d/bastion-nginx && sudo chmod 0440 /etc/sudoers.d/bastion-nginx`);
  }
  return steps;
}

/** The server's proxy mode from `<root>/proxy/mode` (written by `bastionctl setup`), or null before setup. */
export async function readProxyMode(remote: Remote, root: string): Promise<DeployProxyMode | null> {
  const data = await remote.readFile(`${root}/proxy/mode`, 64);
  const mode = data?.toString('utf8').trim();
  return mode === 'caddy' || mode === 'nginx' ? mode : null;
}

/**
 * The mode a server already uses: its mode file, else Caddy when it was set
 * up before modes existed (a Caddyfile but no mode file) — its bastion-caddy
 * owns 80/443, which detection would otherwise take for the host's nginx and
 * move every app behind it. Null for a server never set up.
 */
export async function existingProxyMode(remote: Remote, root: string): Promise<DeployProxyMode | null> {
  const mode = await readProxyMode(remote, root);
  if (mode) return mode;
  return (await remote.hashFile(`${root}/proxy/Caddyfile`)) !== null ? 'caddy' : null;
}

/** Put the shipped helper next to bastionctl, for the administrator to install root-owned. */
export async function uploadHelper(remote: Remote, root: string, bundle: BastionctlBundle): Promise<void> {
  if (!bundle.nginxHelper) throw new DeployError('This BastionSSH was built without the nginx helper (build packages/bastionctl)', 503, 'bastionctl_missing_bundle');
  await remote.writeFile(`${root}/bin/bastion-nginx`, bundle.nginxHelper, 0o755);
}

export async function proxyState(remote: Remote, root: string | null, bundle: BastionctlBundle): Promise<DeployProxyState> {
  const nginx = await detectNginx(remote, bundle);
  const mode = root ? await existingProxyMode(remote, root) : null;
  const wantsNginx = mode === 'nginx' || (mode === null && nginx.detected);
  return {
    mode,
    nginx,
    helperPath: NGINX_HELPER_PATH,
    instructions: wantsNginx ? nginxInstructions(root ?? '/opt/bastion', remote.server.username, nginx) : [],
  };
}

/** Refuses unless the helper is installed, is the shipped one, and sudo allows it. */
async function requireHelper(remote: Remote, bundle: BastionctlBundle): Promise<void> {
  const state = await helperIntegrity(remote, bundle);
  if (state === 'missing') {
    throw new DeployError(`The nginx helper is not installed at ${NGINX_HELPER_PATH}; follow the setup instructions on the Deployments tab`, 409, 'nginx_helper_missing');
  }
  if (state === 'mismatch') {
    throw new DeployError(
      `${NGINX_HELPER_PATH} is not the helper this BastionSSH ships (or it was modified). Set up again, then install the new copy as shown.`,
      409,
      'nginx_helper_mismatch',
    );
  }
}

/** `O CN` of an openssl `-issuer` line, in OpenSSL's (`O = X, CN = Y`) or LibreSSL's (`/O=X/CN=Y`) form. */
export function opensslIssuer(line: string): string | null {
  const text = line.replace(/^issuer=\s*/, '');
  const field = (name: string) => new RegExp(`(?:^|[,/])\\s*${name}\\s*=\\s*([^,/]+)`).exec(text)?.[1]?.trim();
  const parts = [field('O'), field('CN')].filter(Boolean);
  return parts.length ? parts.join(' ') : text.trim() || null;
}

const isoDate = (value: string | undefined) => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/**
 * Certificate facts of an app in nginx mode, from `bastion-nginx status`:
 * one certbot certificate covers all the app's domains; `staging` picks the
 * staging certificate. The last error is the one the helper kept when
 * certbot failed.
 */
export function parseHelperStatus(stdout: string, app: string, staging: boolean, domains: readonly string[]): DeployCertFacts[] {
  const name = staging ? `bastion-${app}-staging` : `bastion-${app}`;
  let block: 'cert' | 'error' | null = null;
  const cert: Record<string, string> = {};
  const error: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'cert') block = value === name ? 'cert' : null;
    else if (key === 'error_cert') block = value === name ? 'error' : null;
    else if (block === 'cert') cert[key] = value;
    else if (block === 'error') error[key] = value;
  }
  const lastError = error.error_message ? { at: isoDate(error.error_at), message: error.error_message } : null;
  return domains.map((domain) => ({
    domain,
    source: 'certbot',
    issuer: cert.issuer ? opensslIssuer(cert.issuer) : null,
    notBefore: isoDate(cert.notBefore),
    notAfter: isoDate(cert.notAfter),
    lastError,
  }));
}

export async function nginxCertificates(remote: Remote, app: string, staging: boolean, domains: readonly string[], bundle: BastionctlBundle): Promise<DeployCertFacts[]> {
  if (!DEPLOY_NAME_PATTERN.test(app)) throw new DeployError('Invalid app name', 400);
  await requireHelper(remote, bundle);
  const result = await remote.run(helperCommand(['status', app]), { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new DeployError(parseKeyValues(result.stdout).error ?? `The nginx helper could not read certificates: ${result.stderr.trim().split('\n').pop() ?? 'no answer'}`, 502);
  }
  return parseHelperStatus(result.stdout, app, staging, domains);
}

export function helperCommand(args: string[]): string {
  return shellCommand(['sudo', '-n', NGINX_HELPER_PATH, ...args]);
}

/**
 * Run the helper for `app`: `apply` (server block and certificate) or
 * `remove`. A failure of the helper itself is returned as a `failed` result
 * (the deploy or delete it follows already happened); one of reaching it
 * throws.
 */
export async function runHelper(
  remote: Remote,
  root: string,
  app: string,
  action: 'apply' | 'remove',
  bundle: BastionctlBundle,
  onLine?: (line: string) => void,
): Promise<DeployNginxApplyResult> {
  if (!DEPLOY_NAME_PATTERN.test(app)) throw new DeployError('Invalid app name', 400);
  await requireHelper(remote, bundle);
  const log: string[] = [];
  const result = await remote.run(helperCommand(action === 'apply' ? ['apply', root, app] : ['remove', app]), {
    timeoutMs: HELPER_TIMEOUT_MS,
    onLine: (stream, line) => {
      if (stream !== 'stderr') return;
      log.push(line);
      onLine?.(line);
    },
  });
  const v = parseKeyValues(result.stdout);
  if (result.exitCode !== 0 && !v.error && /a password is required|not allowed to|may not run sudo/i.test(result.stderr)) {
    v.error = `sudo refused to run ${NGINX_HELPER_PATH} without a password; add the sudoers rule shown on the Deployments tab`;
  }
  const outcome = (['applied', 'unchanged', 'removed'] as const).find((r) => r === v.result);
  const certificate = (['present', 'issued', 'failed', 'skipped'] as const).find((c) => c === v.certificate) ?? 'skipped';
  const error = result.exitCode === 0 ? null : (v.error ?? (result.timedOut ? 'The nginx helper did not finish in time' : result.stderr.trim().split('\n').pop() || 'The nginx helper failed'));
  // certbot failing still leaves the server block applied: both are reported
  return { app, result: outcome ?? 'failed', certificate, error: error?.slice(0, 500) ?? null, log };
}
