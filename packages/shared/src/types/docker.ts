import type { Role } from './auth.js';

/**
 * Docker on managed servers, reached over the server's own SSH connection —
 * the daemon socket is forwarded (or piped through `docker system
 * dial-stdio`), never exposed on a port. See docs/ARCHITECTURE.md §4.15.
 */

/** `off` hides Docker for a server and refuses its Docker routes. */
export type DockerMode = 'auto' | 'off';

/** How the daemon is reached: a forwarded Unix socket, or the CLI piping the API over an exec channel. */
export type DockerTransport = 'streamlocal' | 'dial-stdio';

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

/** Per-server Docker state, folded into `Server.docker`. */
export interface ServerDocker {
  mode: DockerMode;
  /** Admin override (rootless Docker, Podman); null = detect. */
  socketPath: string | null;
  /** From the last successful probe; all null until Docker was detected. */
  transport: DockerTransport | null;
  detectedSocketPath: string | null;
  detectedAt: string | null;
  /** Engine version, e.g. `27.3.1`. */
  version: string | null;
  /** API version this app talks, negotiated from `/version` (≤ what it supports). */
  apiVersion: string | null;
}

/** Org-wide Docker permissions (owners and admins set them). */
export interface DockerSettings {
  /** Operators may open a shell inside containers. */
  operatorsCanExec: boolean;
  /** Operators may remove containers and images. */
  operatorsCanRemove: boolean;
  /** Admins may prune unused containers, images, volumes and networks. */
  allowPrune: boolean;
}

export const DEFAULT_DOCKER_SETTINGS: DockerSettings = {
  operatorsCanExec: true,
  operatorsCanRemove: false,
  allowPrune: true,
};

/**
 * What a member may do with Docker. One place for the whole matrix so the
 * server's gates and the UI's buttons cannot disagree:
 *
 * - `view` — list containers, images, volumes, networks; engine info; events
 * - `inspect` — logs, stats, top, redacted inspect (logs routinely carry tokens and PII)
 * - `control` — start, stop, restart, pause, kill
 * - `exec` — a shell inside a container
 * - `remove` — remove containers and images
 * - `pull` — pull images; compose up/down/pull/restart
 * - `prune` — reclaim unused space
 * - `revealEnv` — unredacted environment (also needs a passkey step-up)
 * - `configure` — per-server Docker settings and detection
 */
export type DockerCapability =
  | 'view'
  | 'inspect'
  | 'control'
  | 'exec'
  | 'remove'
  | 'pull'
  | 'prune'
  | 'revealEnv'
  | 'configure';

export type DockerPermissions = Record<DockerCapability, boolean>;

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

/** The capabilities `role` has under `settings`. Unknown roles get nothing beyond viewing. */
export function dockerPermissions(role: Role, settings: DockerSettings): DockerPermissions {
  const rank = ROLE_RANK[role] ?? 0;
  const operator = rank >= ROLE_RANK.operator;
  const admin = rank >= ROLE_RANK.admin;
  return {
    view: true,
    inspect: operator,
    control: operator,
    exec: admin || (operator && settings.operatorsCanExec),
    remove: admin || (operator && settings.operatorsCanRemove),
    pull: operator,
    prune: admin && settings.allowPrune,
    revealEnv: admin,
    configure: admin,
  };
}

// ── Detection ────────────────────────────────────────────────────────────────

/** Why Docker could not be reached, when a probe fails. */
export type DockerProblem =
  | 'disabled'
  | 'not_installed'
  | 'daemon_not_running'
  | 'permission_denied'
  | 'forwarding_disabled'
  | 'unsupported_version'
  | 'unreachable';

export interface DockerProbeAttempt {
  transport: DockerTransport;
  socketPath: string;
  ok: boolean;
  error?: string;
}

export interface DockerProbeResult {
  ok: boolean;
  transport: DockerTransport | null;
  socketPath: string | null;
  version: string | null;
  apiVersion: string | null;
  /** Rootless Docker or Podman, as far as the daemon says. */
  flavor: 'docker' | 'rootless' | 'podman' | null;
  detectedAt: string | null;
  problem: DockerProblem | null;
  /** Plain-words diagnosis when not ok. */
  error: string | null;
  /** What to do about it — a command to run where there is one. */
  hint: string | null;
  attempts: DockerProbeAttempt[];
}

/** GET /api/docker/servers/:id — what the Docker tab needs before loading anything. */
export interface DockerServerStatus {
  serverId: string;
  serverName: string;
  docker: ServerDocker;
  permissions: DockerPermissions;
}

// ── Objects ──────────────────────────────────────────────────────────────────

export type DockerContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';

export type DockerHealth = 'healthy' | 'unhealthy' | 'starting' | null;

export interface DockerPort {
  privatePort: number;
  publicPort: number | null;
  type: string;
  ip: string | null;
}

export interface DockerContainer {
  id: string;
  /** Primary name, without the leading slash. */
  name: string;
  image: string;
  imageId: string;
  command: string;
  createdAt: string;
  state: DockerContainerState;
  /** Docker's own words, e.g. `Up 3 hours (healthy)`. */
  status: string;
  health: DockerHealth;
  ports: DockerPort[];
  labels: Record<string, string>;
  composeProject: string | null;
  composeService: string | null;
}

export interface DockerImage {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  size: number;
  createdAt: string;
  /** Containers using it; -1 when the daemon did not count. */
  containers: number;
  inUse: boolean;
  dangling: boolean;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  createdAt: string | null;
  labels: Record<string, string>;
  inUse: boolean;
  /** Bytes, when the daemon measured it (from /system/df); null otherwise. */
  size: number | null;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  subnets: string[];
  containers: number;
  createdAt: string | null;
}

export interface DockerDiskUsageEntry {
  count: number;
  size: number;
  reclaimable: number;
}

export interface DockerDiskUsage {
  images: DockerDiskUsageEntry;
  containers: DockerDiskUsageEntry;
  volumes: DockerDiskUsageEntry;
  buildCache: DockerDiskUsageEntry;
  total: number;
}

export interface DockerEngineInfo {
  name: string;
  serverVersion: string;
  apiVersion: string;
  operatingSystem: string;
  osType: string;
  architecture: string;
  kernelVersion: string;
  ncpu: number;
  memTotal: number;
  storageDriver: string;
  rootless: boolean;
  containers: number;
  containersRunning: number;
  containersPaused: number;
  containersStopped: number;
  images: number;
  transport: DockerTransport;
  socketPath: string;
  /** Null when /system/df failed or timed out (it can be slow on big hosts). */
  diskUsage: DockerDiskUsage | null;
}

export interface DockerTop {
  titles: string[];
  processes: string[][];
}

export interface DockerStatsSample {
  time: string;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
}

export interface DockerLogLine {
  stream: 'stdout' | 'stderr';
  /** RFC 3339 timestamp, when requested. */
  time?: string;
  text: string;
  /** Which container the line came from, on merged streams (compose logs: `web-1`). */
  source?: string;
}

/** An engine event, trimmed to what the UI reacts to. */
export interface DockerEngineEvent {
  /** container | image | volume | network | … */
  type: string;
  /** start, die, pull, destroy, health_status: healthy, … */
  action: string;
  id: string;
  /** Container or image name, when the event carries one. */
  name: string | null;
  time: string;
}

/**
 * Events on Docker's server-sent streams (logs, stats, events). `end` means
 * the daemon closed the stream (container stopped, no follow); `error` ends it
 * with a reason.
 */
export type DockerStreamEvent =
  | { type: 'logs'; lines: DockerLogLine[] }
  | { type: 'stats'; sample: DockerStatsSample }
  | { type: 'event'; event: DockerEngineEvent }
  | { type: 'pull'; progress: DockerPullProgress }
  | { type: 'end' }
  | { type: 'error'; error: string; status?: number }
  /** A compose action finished; `exitCode` is null when the command was cut off (timeout, lost connection). */
  | { type: 'exit'; exitCode: number | null; signal: string | null; durationMs: number; timedOut: boolean };

// ── Compose (D4) ─────────────────────────────────────────────────────────────

/** The only compose commands the app runs: `up -d`, `down`, `pull`, `restart`. */
export type DockerComposeVerb = 'up' | 'down' | 'pull' | 'restart';

export const DOCKER_COMPOSE_VERBS: readonly DockerComposeVerb[] = ['up', 'down', 'pull', 'restart'];

export interface DockerComposeContainer {
  id: string;
  name: string;
  image: string;
  state: DockerContainerState;
  status: string;
  health: DockerHealth;
  /** Replica number (`com.docker.compose.container-number`), when set. */
  number: number | null;
}

export interface DockerComposeService {
  name: string;
  containers: DockerComposeContainer[];
  running: number;
}

/**
 * A compose project, discovered from its containers' labels — there is no
 * other record of it, so a project whose containers were all removed
 * (`down`) is no longer listed.
 */
export interface DockerComposeProject {
  name: string;
  /** Where compose ran (`com.docker.compose.project.working_dir`). */
  workingDir: string | null;
  /** Compose files used (`com.docker.compose.project.config_files`). */
  configFiles: string[];
  /** Why actions cannot run for this project (labels missing or unusable); null when they can. */
  unmanageable: string | null;
  services: DockerComposeService[];
  running: number;
  total: number;
  /** `running`: every container up; `partial`: some; `stopped`: none. */
  state: 'running' | 'partial' | 'stopped';
}

/** Update body for `PATCH /api/servers/:id`, Docker part. */
export interface UpdateServerDockerRequest {
  dockerMode?: DockerMode;
  /** null returns to detection. */
  dockerSocketPath?: string | null;
}

// ── Actions (D2) ─────────────────────────────────────────────────────────────

/** Lifecycle actions on a container (`control` permission). */
export type DockerContainerAction = 'start' | 'stop' | 'restart' | 'kill' | 'pause' | 'unpause';

export const DOCKER_CONTAINER_ACTIONS: readonly DockerContainerAction[] = [
  'start',
  'stop',
  'restart',
  'kill',
  'pause',
  'unpause',
];

/** Body of `POST …/containers/:cid/:action`; every field is optional. */
export interface DockerContainerActionRequest {
  /** stop, restart: seconds to wait before killing (default: the container's own, usually 10). */
  timeout?: number;
  /** kill: the signal, e.g. `SIGTERM` (default SIGKILL). */
  signal?: string;
}

export interface DockerActionResult {
  /** false when the container already was in that state (start a running one, stop a stopped one). */
  changed: boolean;
}

/** `POST …/images/pull` body: `image` may carry its tag or digest, or `tag` gives it. */
export interface DockerPullRequest {
  image: string;
  tag?: string;
}

/** One line of pull progress, per layer (`id`) or for the whole pull. */
export interface DockerPullProgress {
  /** Layer id, when the line is about a layer. */
  id: string | null;
  /** `Pulling fs layer`, `Downloading`, `Pull complete`, `Status: Downloaded newer image for …` */
  status: string;
  current: number | null;
  total: number | null;
}

/** What `DELETE …/images/:iid` removed. */
export interface DockerImageRemoveResult {
  untagged: string[];
  deleted: string[];
}

/** What to prune. */
export interface DockerPruneRequest {
  containers?: boolean;
  images?: boolean;
  volumes?: boolean;
  networks?: boolean;
  /** Images: dangling only (default true), like `docker image prune` without `-a`; false prunes every unused image. */
  dangling?: boolean;
}

export interface DockerPruneEstimate {
  count: number;
  /** Bytes; null where Docker does not measure it (networks). */
  size: number | null;
}

/** Dry run: what a prune would remove, from `/system/df` and the network list. */
export interface DockerPrunePreview {
  /** Stopped containers. */
  containers: DockerPruneEstimate;
  danglingImages: DockerPruneEstimate;
  /** Every image no container uses, dangling or tagged. */
  unusedImages: DockerPruneEstimate;
  /** Unused volumes: anonymous ones only on Docker 23+ (API 1.42), like `docker volume prune`. */
  volumes: DockerPruneEstimate;
  /** Older engines prune named volumes too — their data with them. */
  volumesIncludeNamed: boolean;
  /** Custom networks no container is attached to. */
  networks: DockerPruneEstimate;
}

export interface DockerPruneResult {
  containers: { deleted: number; reclaimed: number } | null;
  images: { deleted: number; reclaimed: number } | null;
  volumes: { deleted: number; reclaimed: number } | null;
  networks: { deleted: number } | null;
  /** Bytes reclaimed, all kinds together. */
  reclaimed: number;
}

/** `POST …/containers/:cid/env/reveal` — admins, after a passkey step-up; audited. */
export interface DockerEnvReveal {
  env: string[];
}

// ── Exec (D3) ────────────────────────────────────────────────────────────────

/** `POST …/containers/:cid/exec` body. */
export interface DockerExecRequest {
  /** The command, as argv (no shell parsing). Default: /bin/bash if the container has it, else /bin/sh. */
  cmd?: string[];
  /** `user`, `user:group`, `uid` or `uid:gid`; default the container's user. */
  user?: string;
  /** Default true. Without a TTY, stdout and stderr arrive separately and nothing can be resized. */
  tty?: boolean;
  cols?: number;
  rows?: number;
}

/**
 * A shell in a container, as a terminal session: attach to `wsUrl`, the same
 * WebSocket path as SSH terminals (`/api/ssh-sessions/:id/ws`), and close it
 * with `DELETE /api/ssh-sessions/:id`.
 */
export interface DockerExecSession {
  sessionId: string;
  wsUrl: string;
  container: { id: string; name: string };
  /** The command that runs, e.g. `["/bin/bash"]`. */
  cmd: string[];
  recording: { id: string; inputRecorded: boolean } | null;
}
