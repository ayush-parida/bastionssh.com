import type { Client, ClientChannel } from 'ssh2';
import type {
  DockerComposeContainer,
  DockerComposeProject,
  DockerComposeService,
  DockerComposeVerb,
  DockerContainerState,
} from '@smt/shared';
import { DockerError } from './errors.js';
import { LineSplitter } from './demux.js';
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL, healthFromStatus } from './objects.js';
import { shellCommand } from './shell.js';

/**
 * Compose projects (D4). The Engine API knows nothing about Compose, so:
 *
 * - projects are *discovered* from the labels compose puts on every container
 *   it creates (project, service, working dir, config files);
 * - *actions* run the `docker compose` CLI on the server, over the caller's
 *   pooled SSH connection (docker/pool.ts — `sshConnectConfig` + `connectSsh`,
 *   so host keys, jump hosts and agents apply), in the project's working dir.
 *
 * Label values are written by whoever started the project and are untrusted
 * here. They only ever reach the remote shell as separate argv elements, each
 * single-quoted by {@link shellCommand}; the one shell script involved is a
 * constant. Flags are passed as `--flag=value`, so a value starting with `-`
 * stays a value, and paths must be absolute. Only the fixed verbs in
 * {@link COMPOSE_VERB_ARGS} can run.
 */

export const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
export const COMPOSE_CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';
export const COMPOSE_NUMBER_LABEL = 'com.docker.compose.container-number';
export const COMPOSE_ONEOFF_LABEL = 'com.docker.compose.oneoff';

/** Project names as Compose v2 normalises them (lower case, digits, `-`, `_`). */
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,254}$/;
/** Service names: Compose allows letters, digits, `.`, `-`, `_`. */
export const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

/** What each verb runs, after `docker compose <global flags>`. */
export const COMPOSE_VERB_ARGS: Record<DockerComposeVerb, readonly string[]> = {
  up: ['up', '--detach'],
  down: ['down'],
  pull: ['pull'],
  restart: ['restart'],
};

/** Longest a compose action may run before its channel is closed. */
export const COMPOSE_TIMEOUT_MS = 15 * 60 * 1000;
/** Longest path accepted from a label. */
const MAX_PATH = 4096;
/** Most config files accepted for one project. */
const MAX_CONFIG_FILES = 32;

/**
 * `cd` into the working dir, then run the rest of the arguments as they are.
 * Constant: the dir and the command arrive as positional parameters.
 */
const RUN_IN_DIR = 'cd -- "$1" && shift && exec "$@"';

/** A compose project name from a URL; throws 400 otherwise. */
export function projectName(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_NAME_PATTERN.test(value)) {
    throw new DockerError('Invalid compose project name', 400);
  }
  return value;
}

/** A compose service name from a query string; throws 400 otherwise. */
export function serviceName(value: unknown): string {
  if (typeof value !== 'string' || !SERVICE_NAME_PATTERN.test(value)) {
    throw new DockerError('Invalid compose service name', 400);
  }
  return value;
}

/** An absolute path with no control characters (newlines and NUL included). */
export function isUsablePath(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return path.startsWith('/') && path.length <= MAX_PATH && !/[\x00-\x1f\x7f]/.test(path);
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function labelsOf(raw: Raw): Record<string, string> {
  const out: Record<string, string> = {};
  const labels = raw.Labels;
  if (typeof labels === 'object' && labels !== null) {
    for (const [key, value] of Object.entries(labels)) if (typeof value === 'string') out[key] = value;
  }
  return out;
}

const STATES: DockerContainerState[] = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'];

/** Compose joins config files with commas; empty parts are dropped. */
export function splitConfigFiles(label: string | undefined): string[] {
  return (label ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Why actions cannot run for a project with these labels, or null. Each
 * container carries the project's labels; they must agree.
 */
function unmanageableReason(name: string, dirs: Set<string>, fileSets: Set<string>): string | null {
  if (!PROJECT_NAME_PATTERN.test(name)) return 'The project name is not one Compose v2 creates';
  if (dirs.size === 0) return 'Its containers do not record a working directory (created by an old Compose?)';
  if (dirs.size > 1) return 'Its containers disagree about the working directory';
  if (fileSets.size > 1) return 'Its containers disagree about the compose files';
  const [dir] = dirs;
  if (!isUsablePath(dir!)) return 'The recorded working directory is not a usable absolute path';
  const files = splitConfigFiles([...fileSets][0]);
  if (files.length === 0) return 'Its containers do not record the compose files';
  if (files.length > MAX_CONFIG_FILES) return 'Too many compose files';
  if (!files.every(isUsablePath)) return 'A recorded compose file is not a usable absolute path';
  return null;
}

/**
 * Group raw `containers/json?all=1` entries into compose projects, sorted by
 * name. Containers without a project label are ignored; one-off containers
 * (`docker compose run`) are left out.
 */
export function discoverProjects(containers: Raw[]): DockerComposeProject[] {
  interface Acc {
    dirs: Set<string>;
    fileSets: Set<string>;
    services: Map<string, DockerComposeContainer[]>;
  }
  const projects = new Map<string, Acc>();
  for (const raw of containers) {
    const labels = labelsOf(raw);
    const project = labels[COMPOSE_PROJECT_LABEL];
    if (!project) continue;
    if (/^true$/i.test(labels[COMPOSE_ONEOFF_LABEL] ?? '')) continue;
    let acc = projects.get(project);
    if (!acc) {
      acc = { dirs: new Set(), fileSets: new Set(), services: new Map() };
      projects.set(project, acc);
    }
    if (labels[COMPOSE_WORKING_DIR_LABEL]) acc.dirs.add(labels[COMPOSE_WORKING_DIR_LABEL]);
    if (labels[COMPOSE_CONFIG_FILES_LABEL] !== undefined) acc.fileSets.add(labels[COMPOSE_CONFIG_FILES_LABEL]);

    const names = Array.isArray(raw.Names) ? raw.Names.filter((n): n is string => typeof n === 'string') : [];
    const state = str(raw.State).toLowerCase() as DockerContainerState;
    const status = str(raw.Status);
    const number = Number.parseInt(labels[COMPOSE_NUMBER_LABEL] ?? '', 10);
    const service = labels[COMPOSE_SERVICE_LABEL] || '(unknown)';
    const list = acc.services.get(service) ?? [];
    list.push({
      id: str(raw.Id),
      name: (names[0] ?? str(raw.Id).slice(0, 12)).replace(/^\//, ''),
      image: str(raw.Image),
      state: STATES.includes(state) ? state : 'created',
      status,
      health: healthFromStatus(status),
      number: Number.isFinite(number) ? number : null,
    });
    acc.services.set(service, list);
  }

  return [...projects.entries()]
    .map(([name, acc]): DockerComposeProject => {
      const services: DockerComposeService[] = [...acc.services.entries()]
        .map(([service, list]) => ({
          name: service,
          containers: list.sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.name.localeCompare(b.name)),
          running: list.filter((c) => c.state === 'running').length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const total = services.reduce((n, s) => n + s.containers.length, 0);
      const running = services.reduce((n, s) => n + s.running, 0);
      const unmanageable = unmanageableReason(name, acc.dirs, acc.fileSets);
      return {
        name,
        workingDir: acc.dirs.size === 1 ? [...acc.dirs][0]! : null,
        configFiles: acc.fileSets.size === 1 ? splitConfigFiles([...acc.fileSets][0]) : [],
        unmanageable,
        services,
        running,
        total,
        state: running === 0 ? 'stopped' : running === total ? 'running' : 'partial',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Engine API filter for containers of one project, or of any project. */
export function projectFilter(project?: string): string {
  return JSON.stringify({ label: [project ? `${COMPOSE_PROJECT_LABEL}=${project}` : COMPOSE_PROJECT_LABEL] });
}

/** Where compose finds the daemon: the socket detection settled on. */
export interface ComposeTarget {
  project: Pick<DockerComposeProject, 'name' | 'workingDir' | 'configFiles'>;
  socketPath: string;
}

/**
 * The argv for `verb` on a project, before quoting:
 * `sh -c <RUN_IN_DIR> sh <dir> env DOCKER_HOST=… docker compose --ansi=never
 * --project-name=… --project-directory=… --file=… <verb args>`.
 * Throws 400 when the project's labels are unusable or the verb is unknown.
 */
export function composeArgv({ project, socketPath }: ComposeTarget, verb: DockerComposeVerb): string[] {
  const verbArgs = Object.hasOwn(COMPOSE_VERB_ARGS, verb) ? COMPOSE_VERB_ARGS[verb] : undefined;
  if (!verbArgs) throw new DockerError('Unknown compose action', 400);
  if (!PROJECT_NAME_PATTERN.test(project.name)) throw new DockerError('Invalid compose project name', 400);
  const dir = project.workingDir;
  if (!dir || !isUsablePath(dir)) throw new DockerError('The project has no usable working directory', 400);
  if (project.configFiles.length === 0 || project.configFiles.length > MAX_CONFIG_FILES || !project.configFiles.every(isUsablePath)) {
    throw new DockerError('The project has no usable compose files', 400);
  }
  if (!isUsablePath(socketPath)) throw new DockerError('Invalid Docker socket path', 400);
  return [
    'sh',
    '-c',
    RUN_IN_DIR,
    'sh',
    dir,
    'env',
    `DOCKER_HOST=unix://${socketPath}`,
    'docker',
    'compose',
    '--ansi=never',
    `--project-name=${project.name}`,
    `--project-directory=${dir}`,
    ...project.configFiles.map((f) => `--file=${f}`),
    ...verbArgs,
  ];
}

/** The remote command line for {@link composeArgv}: every element single-quoted. */
export function composeCommand(target: ComposeTarget, verb: DockerComposeVerb): string {
  return shellCommand(composeArgv(target, verb));
}

/** How the command is shown to people (UI, audit): what they would type. */
export function composeDisplay(project: Pick<DockerComposeProject, 'name'>, verb: DockerComposeVerb): string {
  return ['docker', 'compose', '-p', project.name, ...COMPOSE_VERB_ARGS[verb]].join(' ');
}

export interface ComposeRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

export interface ComposeRunOptions {
  /** Complete output lines, per stream, as they arrive. */
  onLines: (stream: 'stdout' | 'stderr', lines: string[]) => void;
  timeoutMs?: number;
}

/**
 * Run `command` on an exec channel of `ssh` until it exits (or the timeout
 * closes it). Resolves with the exit status; rejects only when the channel
 * could not be opened. The channel also ends when the pooled connection is
 * evicted (revoked access, server edited), which resolves with no exit code.
 */
export function runCompose(ssh: Client, command: string, opts: ComposeRunOptions): Promise<ComposeRunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    ssh.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err) return reject(new DockerError(`Could not run docker compose: ${err.message}`, 502));
      const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() };
      let exitCode: number | null = null;
      let signal: string | null = null;
      let timedOut = false;
      let done = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Closing the channel alone leaves compose running on the server (no
        // pty, so no SIGHUP) with the project unclaimed here: ask sshd to stop it
        try {
          channel.signal('TERM');
        } catch {
          // channel already gone
        }
        channel.close();
      }, opts.timeoutMs ?? COMPOSE_TIMEOUT_MS);
      timer.unref?.();
      // Nothing is ever typed into compose: EOF on stdin, so a prompt (volume
      // recreation, say) takes its default instead of waiting for the timeout
      channel.end();

      const emit = (stream: 'stdout' | 'stderr', lines: string[]) => {
        if (lines.length > 0) opts.onLines(stream, lines);
      };
      channel.on('data', (chunk: Buffer) => emit('stdout', splitters.stdout.push(chunk)));
      channel.stderr.on('data', (chunk: Buffer) => emit('stderr', splitters.stderr.push(chunk)));
      channel.on('exit', (code: number | null, sig?: string) => {
        exitCode = typeof code === 'number' ? code : null;
        signal = typeof sig === 'string' ? sig : null;
      });
      channel.on('error', () => {
        // surfaced through 'close' with no exit status
      });
      channel.on('close', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        emit('stdout', splitters.stdout.flush());
        emit('stderr', splitters.stderr.flush());
        resolve({ exitCode: timedOut ? null : exitCode, signal, timedOut, durationMs: Date.now() - started });
      });
    });
  });
}

/**
 * Compose actions in flight, per server and project: a second action on the
 * same project waits for nobody — it is refused, so two `up`s cannot race.
 */
const running = new Set<string>();

/** Claim `project` on `serverId`; returns the release, or null when an action is already running. */
export function claimProject(serverId: string, project: string): (() => void) | null {
  const key = `${serverId}\0${project}`;
  if (running.has(key)) return null;
  running.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running.delete(key);
  };
}

/** `web-1` for replica 1 of `web`; the container name when compose did not number it. */
export function logSource(service: string, container: Pick<DockerComposeContainer, 'name' | 'number'>): string {
  return container.number !== null ? `${service}-${container.number}` : container.name;
}
