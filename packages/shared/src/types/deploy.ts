/**
 * Server-side deployments (deployments spec): the shapes `bastionctl` prints
 * with `--json` and the API under `/api/deploy` passes on. Everything here is
 * read from the server on each request — BastionSSH stores none of it.
 */

/** App names and release ids (spec §3). */
export const DEPLOY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** `.env` variable names. */
export const DEPLOY_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type DeployBuildType = 'nextjs' | 'dockerfile' | 'static';
export type DeployProxyMode = 'caddy' | 'nginx';
export type DeployRedirectWww = 'apex' | 'www' | 'none';
/** `auto` | `staging` | `internal` | `dns:<provider>`, or certificate files in the app folder. */
export type DeployTls = string | { cert: string; key: string };

/** `bastion.yml` after validation, defaults filled in (spec §4). */
export interface DeployAppConfig {
  name: string;
  domains: string[];
  redirect_www: DeployRedirectWww;
  tls: DeployTls;
  build: { type: DeployBuildType; node: string | null; dir: string; output: string | null };
  run: {
    port: number;
    env_file: string;
    volumes: string[];
    memory: string | null;
    cpus: number | null;
  };
  healthcheck: { path: string; timeout: string };
  keep_releases: number;
  proxy: DeployProxyMode;
}

export interface DeployValidationIssue {
  /** Dotted key path (`run.port`), or '' for the document. */
  path: string;
  message: string;
}

export interface DeployValidation {
  ok: boolean;
  errors: DeployValidationIssue[];
}

export interface DeployContainer {
  name: string;
  id: string;
  /** Docker's state: running, exited, created, restarting… */
  state: string;
  status: string;
  /** healthy | unhealthy | starting, when the image has a health check. */
  health: string | null;
}

export interface DeployLock {
  holder: string;
  since: string;
}

export interface DeployAppSummary {
  name: string;
  domains: string[];
  buildType: DeployBuildType | null;
  currentRelease: string | null;
  container: DeployContainer | null;
  /** Set when bastion.yml is missing or invalid. */
  configError: string | null;
  locked: boolean;
}

export interface DeployAppStatus extends DeployAppSummary {
  config: DeployAppConfig | null;
  previousRelease: string | null;
  lock: DeployLock | null;
}

export type DeployReleaseResult = 'building' | 'success' | 'failed';

/** `releases/<id>/release.json`, plus what the server knows about it now. */
export interface DeployRelease {
  id: string;
  app: string;
  createdAt: string;
  finishedAt: string | null;
  /** Who deployed it — passed in by BastionSSH, or the SSH user for a plain CLI run. */
  actor: string;
  /** SHA-256 of the uploaded source. */
  checksum: string;
  image: string;
  container: string;
  port: number;
  buildType: DeployBuildType;
  result: DeployReleaseResult;
  error: string | null;
  previous: string | null;
  current: boolean;
  imagePresent: boolean;
}

/** The outcome of `deploy` / `rollback`. */
export interface DeployOutcome {
  app: string;
  release: string;
  previous: string | null;
  result: 'success' | 'failed';
  error: string | null;
}

export interface DeploySetupResult {
  root: string;
  proxy: DeployProxyMode;
  network: string;
  proxyContainer: DeployContainer | null;
  version: string;
}

export interface DeployVersion {
  version: string;
  node: string;
  images: { node: string; caddy: string };
}

/**
 * The state of `bastionctl` on a server, from BastionSSH's side: where it
 * lives (spec §2.4, discovered on every use), and whether the installed file
 * is the one this BastionSSH ships.
 */
export interface DeployServerState {
  root: string | null;
  /** `missing`: not set up; `mismatch`: a different or modified bastionctl — reinstall with setup. */
  integrity: 'ok' | 'missing' | 'mismatch';
  version: string;
}

export interface BastionctlInfo {
  version: string;
  sha256: string;
}

export interface DeployLogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

/** Events of a deploy or rollback stream. */
export type DeployStreamEvent =
  | { type: 'log'; lines: DeployLogLine[] }
  | { type: 'result'; outcome: DeployOutcome }
  /** `exitCode` is null when the command was cut off (timeout, lost connection). */
  | { type: 'exit'; exitCode: number | null; signal: string | null; durationMs: number; timedOut: boolean }
  | { type: 'end' }
  | { type: 'error'; error: string; status?: number };

export interface DeployEnvKeys {
  keys: string[];
}

export interface DeployEnvReveal {
  key: string;
  value: string;
}
