import { and, eq, isNull } from 'drizzle-orm';
import type { Client } from 'ssh2';
import {
  DEFAULT_DOCKER_SOCKET,
  type DockerProbeAttempt,
  type DockerProbeResult,
  type DockerProblem,
  type DockerTransport,
} from '@smt/shared';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import logger from '../logger.js';
import { DockerClient, negotiateApiVersion } from './client.js';
import { DockerError, isChannelOpenFailure, isForwardingRefused } from './errors.js';
import { shellCommand } from './shell.js';
import { execCapture, openDaemonStream, type DaemonEndpoint } from './transport.js';

/**
 * Finding a server's Docker daemon, on demand only (an admin's "Detect
 * Docker", or the first Docker request for a server not yet detected):
 *
 * 1. streamlocal to the configured socket (default `/var/run/docker.sock`) → `GET /_ping`;
 * 2. otherwise one small shell script reports whether the CLI exists, which
 *    candidate sockets exist, and whether the SSH user may use them —
 *    including rootless Docker under `$XDG_RUNTIME_DIR` and Podman's
 *    Docker-compatible socket when no path was configured;
 * 3. each usable socket is tried over streamlocal, and over `docker system
 *    dial-stdio` when sshd refuses socket forwarding;
 * 4. the first that answers is recorded on the server row with the engine
 *    version and the negotiated API version; otherwise the script's findings
 *    say why (not installed, daemon down, permission denied, forwarding
 *    disabled with no CLI to fall back on).
 */

export const PODMAN_ROOTFUL_SOCKET = '/run/podman/podman.sock';

/** Takes the fixed candidates as arguments; adds the per-user runtime ones itself. Never sees user input. */
const HOST_FACTS_SCRIPT = [
  'if command -v docker >/dev/null 2>&1; then echo cli=1; else echo cli=0; fi',
  'uid=$(id -u 2>/dev/null)',
  'echo "uid=$uid"',
  'rt="${XDG_RUNTIME_DIR:-/run/user/$uid}"',
  'echo "runtime=$rt"',
  'for p in "$@" "$rt/docker.sock" "$rt/podman/podman.sock"; do',
  '  if [ -S "$p" ]; then',
  '    if [ -r "$p" ] && [ -w "$p" ]; then echo "sock=ok:$p"; else echo "sock=denied:$p"; fi',
  '  else echo "sock=missing:$p"; fi',
  'done',
].join('\n');

export type SocketState = 'ok' | 'denied' | 'missing';

export interface HostFacts {
  cli: boolean;
  uid: string | null;
  runtimeDir: string | null;
  sockets: Map<string, SocketState>;
}

export function parseHostFacts(stdout: string): HostFacts {
  const facts: HostFacts = { cli: false, uid: null, runtimeDir: null, sockets: new Map() };
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === 'cli') facts.cli = value === '1';
    else if (key === 'uid') facts.uid = value || null;
    else if (key === 'runtime') facts.runtimeDir = value || null;
    else if (key === 'sock') {
      const colon = value.indexOf(':');
      const state = value.slice(0, colon) as SocketState;
      const path = value.slice(colon + 1);
      if (path && ['ok', 'denied', 'missing'].includes(state) && !facts.sockets.has(path)) facts.sockets.set(path, state);
    }
  }
  return facts;
}

/** Sockets to try, in order: the override alone, or the default, rootless Docker, then Podman. */
export function candidateSockets(override: string | null, facts: HostFacts | null): string[] {
  if (override) return [override];
  const runtime = facts?.runtimeDir;
  return [
    DEFAULT_DOCKER_SOCKET,
    ...(runtime ? [`${runtime}/docker.sock`] : []),
    PODMAN_ROOTFUL_SOCKET,
    ...(runtime ? [`${runtime}/podman/podman.sock`] : []),
  ];
}

export async function inspectHost(ssh: Client, override: string | null): Promise<HostFacts> {
  const fixed = override ? [override] : [DEFAULT_DOCKER_SOCKET, PODMAN_ROOTFUL_SOCKET];
  // sh -c, so the user's login shell (fish, csh…) does not matter
  const result = await execCapture(ssh, shellCommand(['sh', '-c', HOST_FACTS_SCRIPT, 'sh', ...fixed]));
  return parseHostFacts(result.stdout);
}

interface Reached {
  ok: true;
  version: string;
  apiVersion: string;
  flavor: DockerProbeResult['flavor'];
}
interface Missed {
  ok: false;
  /** sshd explicitly refused to forward. */
  refused: boolean;
  /** sshd did not open the channel at all (refused, or nothing to connect to). */
  channelFailed: boolean;
  error: Error;
}

/** Ping the daemon at `endpoint` and read its version; never throws. */
async function reach(ssh: Client, endpoint: DaemonEndpoint): Promise<Reached | Missed> {
  const docker = new DockerClient(() => openDaemonStream(ssh, endpoint));
  try {
    if (!(await docker.ping())) throw new DockerError('The socket answered, but not like a Docker daemon', 502);
    const version = await docker.json<Record<string, unknown>>({ path: '/version', versioned: false });
    const apiVersion = negotiateApiVersion(version);
    const platform = (version.Platform as { Name?: unknown } | undefined)?.Name;
    const components = Array.isArray(version.Components) ? (version.Components as { Name?: unknown }[]) : [];
    const podman =
      (typeof platform === 'string' && /podman/i.test(platform)) ||
      components.some((c) => typeof c.Name === 'string' && /podman/i.test(c.Name));
    return {
      ok: true,
      version: typeof version.Version === 'string' ? version.Version : 'unknown',
      apiVersion,
      flavor: podman ? 'podman' : endpoint.socketPath.startsWith('/run/user/') ? 'rootless' : 'docker',
    };
  } catch (err) {
    const unwrapped = (err as { cause?: unknown }).cause ?? err;
    return {
      ok: false,
      refused: isForwardingRefused(err) || isForwardingRefused(unwrapped),
      channelFailed: isChannelOpenFailure(err) || isChannelOpenFailure(unwrapped),
      error: err instanceof Error ? err : new Error(String(err)),
    };
  } finally {
    docker.close();
  }
}

function failure(
  problem: DockerProblem,
  error: string,
  hint: string | null,
  attempts: DockerProbeAttempt[],
): DockerProbeResult {
  return {
    ok: false,
    transport: null,
    socketPath: null,
    version: null,
    apiVersion: null,
    flavor: null,
    detectedAt: null,
    problem,
    error,
    hint,
    attempts,
  };
}

/**
 * Find the daemon on the server `ssh` is connected to. `override` is the
 * admin's socket path (only that one is tried); `username` is the SSH user,
 * named in the permission hint.
 */
export async function probeDocker(
  ssh: Client,
  opts: { override: string | null; username: string },
): Promise<DockerProbeResult> {
  const attempts: DockerProbeAttempt[] = [];
  // An engine this app cannot talk to answers the same on every path: stop there
  const seen: { unsupported: Error | null } = { unsupported: null };
  const unsupported = (): Error | null => seen.unsupported;

  const attempt = async (transport: DockerTransport, socketPath: string) => {
    const result = await reach(ssh, { transport, socketPath });
    attempts.push({ transport, socketPath, ok: result.ok, ...(!result.ok && { error: result.error.message }) });
    if (!result.ok && (result.error as DockerError).problem === 'unsupported_version') seen.unsupported = result.error;
    return result;
  };
  const success = (transport: DockerTransport, socketPath: string, r: Reached): DockerProbeResult => ({
    ok: true,
    transport,
    socketPath,
    version: r.version,
    apiVersion: r.apiVersion,
    flavor: r.flavor,
    detectedAt: new Date().toISOString(),
    problem: null,
    error: null,
    hint: null,
    attempts,
  });

  // The common case costs one channel and no shell
  const first = opts.override ?? DEFAULT_DOCKER_SOCKET;
  const fast = await attempt('streamlocal', first);
  if (fast.ok) return success('streamlocal', first, fast);
  const tooOld = unsupported();
  if (tooOld) return failure('unsupported_version', tooOld.message, null, attempts);
  let forwardingRefused = fast.refused;

  let facts: HostFacts;
  try {
    facts = await inspectHost(ssh, opts.override);
  } catch (err) {
    logger.warn({ err }, 'Docker probe could not inspect the host');
    return failure('unreachable', `Could not reach Docker: ${fast.error.message}`, null, attempts);
  }

  const candidates = candidateSockets(opts.override, facts);
  for (const path of candidates) {
    if (facts.sockets.get(path) !== 'ok') continue;
    if (!forwardingRefused) {
      const r = path === first ? fast : await attempt('streamlocal', path);
      if (r.ok) return success('streamlocal', path, r);
      // The user may use this socket, yet sshd would not open a channel to
      // it: forwarding is off (AllowStreamLocalForwarding, or
      // AllowTcpForwarding, which OpenSSH applies to sockets too)
      if (r.refused || r.channelFailed) forwardingRefused = true;
    }
    if (forwardingRefused && facts.cli) {
      const r = await attempt('dial-stdio', path);
      if (r.ok) return success('dial-stdio', path, r);
    }
    const incompatible = unsupported();
    if (incompatible) return failure('unsupported_version', incompatible.message, null, attempts);
  }

  // Nothing answered: say why, from what the script saw
  const usable = candidates.filter((p) => facts.sockets.get(p) === 'ok');
  const denied = candidates.filter((p) => facts.sockets.get(p) === 'denied');
  const lastError = attempts.at(-1)?.error ?? fast.error.message;

  if (usable.length > 0) {
    if (forwardingRefused && !facts.cli) {
      return failure(
        'forwarding_disabled',
        `sshd on this server refuses to forward the Docker socket (${usable[0]}), and the docker CLI is not installed to fall back on docker system dial-stdio.`,
        'Allow socket forwarding in /etc/ssh/sshd_config ("AllowStreamLocalForwarding yes", and "AllowTcpForwarding local" or "yes" — OpenSSH applies both to sockets) and reload sshd, or install the Docker CLI on the server.',
        attempts,
      );
    }
    return failure('unreachable', `Docker's socket exists but the daemon did not answer: ${lastError}`, null, attempts);
  }
  if (denied.length > 0) {
    const path = denied[0]!;
    const dockerGroup = !path.includes('podman');
    return failure(
      'permission_denied',
      `The Docker socket ${path} exists, but ${opts.username} is not allowed to use it.`,
      dockerGroup
        ? `Add the user to the docker group, then detect again (group changes apply to new SSH logins): sudo usermod -aG docker ${opts.username}`
        : `Give ${opts.username} read and write access to ${path}, or set the socket path of a daemon it may use.`,
      attempts,
    );
  }
  const looked = candidates.join(', ');
  if (facts.cli) {
    return failure(
      'daemon_not_running',
      `The docker command is installed, but no daemon socket was found (looked at ${looked}).`,
      opts.override
        ? 'Check the socket path in the server settings, and that the daemon is running.'
        : 'Start the daemon (sudo systemctl start docker), or set the socket path for rootless Docker or Podman.',
      attempts,
    );
  }
  return failure(
    'not_installed',
    `Docker does not appear to be installed: no docker command, and no socket at ${looked}.`,
    opts.override ? 'Check the socket path in the server settings.' : 'Install Docker Engine: https://docs.docker.com/engine/install/',
    attempts,
  );
}

/** HTTP status for a failed detection surfaced by a Docker route. */
export function probeStatus(problem: DockerProblem | null): number {
  switch (problem) {
    case 'permission_denied':
      return 403;
    case 'unreachable':
      return 502;
    default:
      return 400;
  }
}

/**
 * Store a probe's outcome on the server row. A failure forgets what an
 * earlier probe found, so the tab shows the new diagnosis rather than a
 * transport that no longer works. `override` is the socket path the probe
 * ran with: when an admin changed it meanwhile, the outcome describes the
 * old daemon and is dropped.
 */
export function recordProbe(serverId: string, result: DockerProbeResult, override: string | null): void {
  getDb()
    .update(servers)
    .set(
      result.ok
        ? {
            dockerTransport: result.transport,
            dockerDetectedSocketPath: result.socketPath,
            dockerDetectedAt: result.detectedAt,
            dockerVersion: result.version,
            dockerApiVersion: result.apiVersion,
          }
        : clearedDetection(),
    )
    .where(
      and(
        eq(servers.id, serverId),
        override === null ? isNull(servers.dockerSocketPath) : eq(servers.dockerSocketPath, override),
      ),
    )
    .run();
}

/** Column values for "not detected" — after a failed probe, or a changed socket path. */
export function clearedDetection() {
  return {
    dockerTransport: null,
    dockerDetectedSocketPath: null,
    dockerDetectedAt: null,
    dockerVersion: null,
    dockerApiVersion: null,
  } satisfies Partial<typeof servers.$inferInsert>;
}
