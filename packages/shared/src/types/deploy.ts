/**
 * Server-side deployments (deployments spec): the shapes `bastionctl` prints
 * with `--json` and the API under `/api/deploy` passes on. Everything here is
 * read from the server on each request — BastionSSH stores none of it.
 */

/** App names and release ids (spec §3). */
export const DEPLOY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** `.env` variable names. */
export const DEPLOY_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type DeployBuildType = 'nextjs' | 'dockerfile' | 'static' | 'image';
/** How a release replaces the one serving: side by side (`rolling`), or the old one stopped first (`recreate`). */
export type DeployRunStrategy = 'rolling' | 'recreate';
export type DeployHealthcheckType = 'http' | 'tcp' | 'command';
/** `none`: only other apps on bastion-apps reach it; `localhost`: 127.0.0.1:<port> on the host; `public`: every address. */
export type DeployPublishScope = 'none' | 'localhost' | 'public';
export type DeployProxyMode = 'caddy' | 'nginx';
export type DeployRedirectWww = 'apex' | 'www' | 'none';
/** `auto` | `staging` | `internal` | `dns:<provider>`, or certificate files in the app folder. */
export type DeployTls = string | { cert: string; key: string };

/**
 * Who may deploy and roll back an app (`permissions.deploy` in bastion.yml):
 * members with operate on the server (the default) or only those with
 * manage. BastionSSH enforces it; bastionctl validates and reports it.
 */
export type DeployPermissionLevel = 'operate' | 'manage';

export interface DeployAppPermissions {
  deploy: DeployPermissionLevel;
}

/** A named volume of `run.volumes`, short (`data:/path[:ro]`) or long form. */
export interface DeployVolume {
  name: string;
  /** Absolute path in the container. */
  path: string;
  readonly: boolean;
  /** Only one container may use it at a time (a database's data): forces `run.strategy: recreate`. */
  exclusive: boolean;
}

/** `bastion.yml` after validation, defaults filled in (spec §4; services spec §3.2). */
export interface DeployAppConfig {
  /** The quick-service template the app was created from (informational); null for an app. */
  service: string | null;
  /** Empty for a service without a web UI: no proxy entry. */
  domains: string[];
  name: string;
  redirect_www: DeployRedirectWww;
  tls: DeployTls;
  /** `image`: a registry reference pulled instead of built (`dir`/`node`/`output` unused). */
  build: { type: DeployBuildType; node: string | null; dir: string; output: string | null; image: string | null };
  run: {
    port: number;
    env_file: string;
    volumes: DeployVolume[];
    memory: string | null;
    cpus: number | null;
    /** The effective strategy: `recreate` when asked for, or forced by an exclusive volume or a published port. */
    strategy: DeployRunStrategy;
    /**
     * `run.publish`: the host port bound, on which addresses, and the
     * container port it reaches (`target`: `run.port` unless the config
     * names another, like MinIO's S3 port beside its console).
     */
    publish: { scope: DeployPublishScope; port: number | null; target?: number | null };
    /** `run.command`: replaces the image's CMD (argv, no shell unless it names one); null keeps the image's. Absent from older versions. */
    command?: string[] | null;
    /** `run.entrypoint`: replaces the image's ENTRYPOINT; null keeps the image's. Absent from older versions. */
    entrypoint?: string[] | null;
  };
  /** `path` is used by `http`, `command` (argv run inside the container) by `command`; `tcp` connects from the proxy network. */
  healthcheck: { type: DeployHealthcheckType; path: string; command: string[] | null; timeout: string };
  keep_releases: number;
  proxy: DeployProxyMode;
  permissions: DeployAppPermissions;
  /** `backups`: the schedule and retention of a quick service's backups (default off, 7 kept). Absent from older versions. */
  backups?: DeployBackupSettings;
}

/** How often bastion-cron backs a service up (services spec §3.4). */
export type DeployBackupSchedule = 'off' | 'hourly' | 'daily';

export interface DeployBackupSettings {
  schedule: DeployBackupSchedule;
  /** Backups kept after each new one (oldest removed first), 1 to 100. */
  keep: number;
}

/** Backups made by hand, by the schedule, and before a restore (of the data the restore replaced). */
export type DeployBackupKind = 'manual' | 'scheduled' | 'pre-restore';

/** A file in `<root>/apps/<name>/backups/`: `<UTC timestamp>[-<kind>].<ext>`. */
export interface DeployBackup {
  file: string;
  bytes: number;
  createdAt: string;
  kind: DeployBackupKind;
}

/** The last run of the schedule, as bastion-cron recorded it. */
export interface DeployBackupRun {
  at: string;
  result: 'success' | 'failed';
  file: string | null;
  error: string | null;
}

/** `bastionctl backups list <app>`. */
export interface DeployBackupList {
  app: string;
  /** bastion.yml's `service`; backups need a template that has a dump command. */
  service: string | null;
  supported: boolean;
  /** Newest first. */
  backups: DeployBackup[];
  settings: DeployBackupSettings;
  lastScheduled: DeployBackupRun | null;
  /** The bastion-cron container that runs schedules, when one is needed (null: no schedule on the server). */
  cron: DeployContainer | null;
}

/** `bastionctl backup <app>`. */
export interface DeployBackupResult {
  app: string;
  backup: DeployBackup;
  /** Files removed beyond `keep`. */
  pruned: string[];
}

/** `bastionctl restore <app> <file>`. */
export interface DeployRestoreResult {
  app: string;
  file: string;
  /** The backup of the data that was replaced, taken first. */
  safety: DeployBackup | null;
  /** `exec`: the template's restore command ran in the live container; `replace-file`: the container was stopped, its data file replaced and started again. */
  method: 'exec' | 'replace-file';
}

/** One way to connect, as `GET …/apps/:app/connection` gives it: `{KEY}` placeholders stand for secret `.env` values (revealed with a passkey). */
export interface DeployConnectionString {
  label: string;
  /** For apps on the same server (`<name>` on bastion-apps). */
  internal: string;
  /** Through the published port, when there is one. */
  published: string | null;
}

export interface DeployConnectionField {
  label: string;
  /** Known without a secret (host, port, user names from the template). */
  value: string | null;
  /** The `.env` variable holding it, when it is a secret. */
  secret: string | null;
}

/** `GET /api/deploy/servers/:id/apps/:app/connection`: how to reach a quick service, secrets masked. */
export interface DeployServiceConnection {
  app: string;
  service: string;
  /** The template's name (PostgreSQL); null for a template this BastionSSH does not know. */
  name: string | null;
  /** On bastion-apps: the app's name. */
  host: string;
  port: number;
  ports: Array<{ port: number; label: string }>;
  /** `run.publish` resolved to an address: 127.0.0.1 (SSH tunnel) or the server's host. */
  published: { scope: 'localhost' | 'public'; host: string; port: number; target: number } | null;
  fields: DeployConnectionField[];
  strings: DeployConnectionString[];
  /** The secrets the strings and fields refer to, in order. */
  secrets: string[];
  /** The web UI, when the service has one and a domain. */
  ui: { label: string; urls: string[] } | null;
  docs: string;
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
  /** From bastion.yml (default deploy: operate); null when the config is missing or invalid. Absent from older bastionctl versions. */
  permissions?: DeployAppPermissions | null;
  /**
   * The app's certificate as the proxy has it (the one expiring first across
   * its domains): Caddy's storage, or certbot's in nginx mode. Null when there
   * is none to read (not deployed, proxy down); absent from older versions.
   */
  certificate?: DeployAppCertificate | null;
  /** The live container's CPU and memory, from one Docker stats read; null when it is not running. */
  usage?: DeployAppUsage | null;
  /** bastion.yml's `service` (the quick-service template id); null for an app. Absent from older versions. */
  service?: string | null;
}

export interface DeployAppCertificate {
  issuer: string | null;
  notAfter: string | null;
  /** Whole days until notAfter, when bastionctl read it (negative once expired). */
  daysLeft: number | null;
  /** The latest issuance or renewal error logged for one of the domains. */
  lastError: string | null;
}

export interface DeployAppUsage {
  cpuPercent: number;
  memoryBytes: number;
  /** The container's memory limit (run.memory); null without one. */
  memoryLimitBytes: number | null;
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
  /** SHA-256 of the uploaded source (`build.type: image`: of the image reference). */
  checksum: string;
  image: string;
  container: string;
  port: number;
  buildType: DeployBuildType;
  result: DeployReleaseResult;
  error: string | null;
  previous: string | null;
  /** `build.type: image`: the digest the pulled image resolved to (`sha256:…`); null for builds. Absent from older releases. */
  digest?: string | null;
  /** `build.type: image`: the image reference pulled (`postgres:17.6-alpine@sha256:…`). Absent from older releases. */
  ref?: string | null;
  /** A quick service's template id when it was deployed. Absent from older releases and apps. */
  service?: string | null;
  /** A quick service: the template line the release runs (`17`), recorded at deploy, or read from its image for an older release; null when it cannot be told. */
  line?: string | null;
  current: boolean;
  imagePresent: boolean;
  /**
   * A quick service: why a rollback to this release is refused — another
   * line than the one serving, against the template's rules (Update
   * version's), or a line that cannot be told. Null when it is allowed;
   * absent for apps.
   */
  rollbackRefused?: string | null;
}

/** The outcome of `deploy` / `rollback`. */
export interface DeployOutcome {
  app: string;
  release: string;
  previous: string | null;
  result: 'success' | 'failed';
  error: string | null;
  /** The proxy was upgraded (or the attempt failed) before the command ran. */
  proxyUpgrade?: DeployProxyUpgrade;
}

/** `restart <app>`. */
export interface DeployRestartResult {
  app: string;
  container: string;
  /** The proxy was upgraded (or the attempt failed) before the restart. */
  proxyUpgrade?: DeployProxyUpgrade;
}

/** `env generate <app> KEY`: the value is written to `.env`, never returned. */
export interface DeployEnvGenerated {
  key: string;
  /** False with `--if-missing` when the variable was set already (left as it was). */
  generated: boolean;
}

export interface DeploySetupResult {
  root: string;
  proxy: DeployProxyMode;
  network: string;
  proxyContainer: DeployContainer | null;
  version: string;
  proxyUpgrade?: DeployProxyUpgrade;
}

/** What made bastionctl upgrade the proxy. */
export type DeployProxyUpgradeTrigger = 'deploy' | 'rollback' | 'restart' | 'proxy_apply' | 'setup' | 'manual';

/**
 * An automatic (or requested) proxy upgrade (services spec §2), as bastionctl
 * reports it in the command's JSON; BastionSSH audits it as
 * `deploy.proxy_upgrade`. `caddy`: only Caddy was replaced, behind the front,
 * with no connection dropped; `front`: the proxy container itself was
 * replaced (in-flight connections may drop for about a second).
 */
export interface DeployProxyUpgrade {
  /** The proxy build before: `0.1.0+<build>` from the container's label, `unknown` for a proxy from before labels. */
  from: string;
  to: string;
  trigger: DeployProxyUpgradeTrigger;
  result: 'success' | 'failed';
  replaced: Array<'caddy' | 'front'>;
  /** Failed: why; the previous proxy was restored and serves. */
  error?: string;
}

/**
 * `bastionctl proxy status`: the proxy against what this bastionctl would run.
 * `outdated` lists what an upgrade would replace.
 */
export interface DeployProxyStatus {
  state: 'ok' | 'outdated' | 'missing' | 'stopped';
  /** The build that last brought the proxy up to date; `unknown` before labels, null when missing. */
  build: string | null;
  /** This bastionctl's build. */
  target: string;
  outdated: Array<'caddy' | 'front'>;
  /** `<root>/bin/.pinned`: not upgraded automatically. */
  pinned: boolean;
}

export interface DeployVersion {
  version: string;
  node: string;
  images: { node: string; caddy: string; bun?: string; build?: Record<string, string> };
}

/**
 * The state of `bastionctl` on a server, from BastionSSH's side: where it
 * lives (spec §2.4, discovered on every use), and whether the installed file
 * is the one this BastionSSH ships. Reading it upgrades a set-up server's
 * bastionctl to the shipped one first, unless the server is pinned.
 */
export interface DeployServerState {
  root: string | null;
  /**
   * `missing`: not set up; `mismatch`: a different or modified bastionctl
   * that was not upgraded — the server is `pinned`, or the upgrade failed
   * (`upgradeError`); Reinstall with setup.
   */
  integrity: 'ok' | 'missing' | 'mismatch';
  /** The bastionctl this BastionSSH ships: `0.1.0+<build>` (first 7 hex of the bundle hash). */
  version: string;
  /** The version the server's bastionctl says it is (`0.1.0` from before build ids); null when missing or unreadable. Absent from older servers' answers. */
  installedVersion?: string | null;
  /** `<root>/bin/.pinned` exists: never upgraded automatically. */
  pinned?: boolean;
  /** This request upgraded the server's bastionctl. */
  upgraded?: { from: string | null; to: string };
  /** Why the automatic upgrade failed. */
  upgradeError?: string;
  /** The proxy is from an older bastionctl (it is upgraded at the next deploy, rollback, restart or setup, or with Update proxy now). Absent when unknown. */
  proxyOutdated?: boolean;
  /** `bastionctl proxy status`, when it could be read. */
  proxy?: DeployProxyStatus;
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

// ── Domains, TLS and the proxy (spec §6) ────────────────────────────────────

/**
 * Where a domain's certificate comes from: Caddy's ACME issuers (`acme`,
 * `staging`), Caddy's own CA (`internal`), files in the app folder (`files`),
 * or certbot on the host in nginx mode (`certbot`).
 */
export type DeployCertSource = 'acme' | 'staging' | 'internal' | 'files' | 'certbot';

/**
 * `failing`: past the point it should have been renewed, or none and the
 * proxy logged an error — what raises an alert. `missing`: none yet and no
 * error (being issued).
 */
export type DeployCertState = 'valid' | 'expiring' | 'expired' | 'missing' | 'failing';

/** What the server reports about a domain's certificate (`bastionctl certs`, or the nginx helper). */
export interface DeployCertFacts {
  domain: string;
  source: DeployCertSource;
  issuer: string | null;
  notBefore: string | null;
  notAfter: string | null;
  /** The latest issuance or renewal error logged for this domain. */
  lastError: { at: string | null; message: string } | null;
}

/** A certificate with its state, derived by BastionSSH when read ({@link deployCertState}). */
export interface DeployCertificate extends DeployCertFacts {
  state: DeployCertState;
  /** Whole days until `notAfter` (negative once expired). */
  daysLeft: number | null;
}

const DAY_MS = 86_400_000;
/** Shown as expiring this close to the end. */
export const DEPLOY_CERT_EXPIRING_DAYS = 14;
/** How long past its renewal point a certificate may go before renewal counts as failing. */
const RENEWAL_GRACE_MS = 2 * DAY_MS;

/**
 * A certificate's state, derived from what the server reports — nothing is
 * stored. Caddy and certbot both renew once a third of the lifetime is left
 * (30 days of Let's Encrypt's 90; hours of Caddy's internal 12-hour
 * certificates): a certificate still older than that, or one whose renewal
 * window has an error logged after it was issued, is `failing`. Files in the
 * app folder are nobody's to renew; they only expire.
 */
export function deployCertState(
  cert: Pick<DeployCertFacts, 'source' | 'notBefore' | 'notAfter' | 'lastError'>,
  now = Date.now(),
): { state: DeployCertState; daysLeft: number | null } {
  const end = cert.notAfter ? Date.parse(cert.notAfter) : NaN;
  if (Number.isNaN(end)) return { state: cert.lastError ? 'failing' : 'missing', daysLeft: null };
  const daysLeft = Math.floor((end - now) / DAY_MS);
  if (now >= end) return { state: 'expired', daysLeft };
  const nearEnd = daysLeft <= DEPLOY_CERT_EXPIRING_DAYS;
  if (cert.source === 'files') return { state: nearEnd ? 'expiring' : 'valid', daysLeft };
  const start = cert.notBefore ? Date.parse(cert.notBefore) : NaN;
  const lifetime = Number.isNaN(start) ? 90 * DAY_MS : end - start;
  const renewAt = end - lifetime / 3;
  if (now > renewAt + RENEWAL_GRACE_MS) return { state: 'failing', daysLeft };
  const errorAt = cert.lastError?.at ? Date.parse(cert.lastError.at) : NaN;
  if (cert.lastError && now > renewAt && (Number.isNaN(errorAt) || Number.isNaN(start) || errorAt > start)) return { state: 'failing', daysLeft };
  return { state: nearEnd ? 'expiring' : 'valid', daysLeft };
}

/** The states that raise an alert. */
export function isDeployCertAlerting(state: DeployCertState): boolean {
  return state === 'failing' || state === 'expired';
}

/** A DNS record the domain needs: exactly what to create. */
export interface DeployDnsRecord {
  type: 'A' | 'AAAA';
  name: string;
  value: string;
}

export interface DeployDomainDns {
  /** `wrong`: it resolves, but not (only) to this server; `skipped`: no server address to compare with. */
  status: 'ok' | 'wrong' | 'missing' | 'error' | 'skipped';
  /** What the domain resolves to now (A and AAAA). */
  addresses: string[];
  detail: string;
  /** The records to create or change; empty when DNS is right. */
  records: DeployDnsRecord[];
}

export interface DeployDomainCheck {
  domain: string;
  dns: DeployDomainDns;
  certificate: DeployCertificate | null;
}

export interface DeployPortCheck {
  port: 80 | 443;
  status: 'open' | 'closed' | 'filtered' | 'error';
  detail: string;
  remediation?: string;
}

/** `GET /api/deploy/servers/:id/apps/:app/domains`: DNS, ports and certificates, checked now. */
export interface DeployDomainsReport {
  app: string;
  proxy: DeployProxyMode;
  tls: DeployTls;
  /** The server's public addresses the domains must point at. */
  serverAddresses: string[];
  /** `host`: the server's address in BastionSSH; `dns`: its host name resolved; `server`: asked from the server itself. */
  addressSource: 'host' | 'dns' | 'server' | 'none';
  domains: DeployDomainCheck[];
  /** Ports 80 and 443, from BastionSSH; checked for ACME certificates only (tls auto or staging). */
  ports: DeployPortCheck[];
  /** Why certificates could not be read, when they could not. */
  certificatesError: string | null;
  checkedAt: string;
}

/** The host's nginx, as BastionSSH sees it over SSH (spec §6, nginx mode). */
export interface DeployNginxState {
  /** nginx runs on the host and something listens on 80 or 443: setup picks nginx mode. */
  detected: boolean;
  installed: boolean;
  running: boolean;
  ports: { http: boolean; https: boolean };
  certbot: boolean;
  /** nginx.conf includes /etc/nginx/conf.d/*.conf (Alpine: http.d), where the server blocks go. */
  confInclude: boolean;
  /** The root-owned helper at {@link DeployProxyState.helperPath}: missing, not the shipped one, or ok. */
  helper: 'missing' | 'mismatch' | 'ok';
  /** The SSH user may run the helper with passwordless sudo. */
  sudo: boolean;
}

/** `GET /api/deploy/servers/:id/proxy`: the proxy mode and, for nginx, what setup still needs. */
export interface DeployProxyState {
  /** Null before setup. */
  mode: DeployProxyMode | null;
  nginx: DeployNginxState;
  helperPath: string;
  /** Commands an administrator runs once on the server for nginx mode, in order; empty when nothing is missing. */
  instructions: string[];
}

/** What the nginx helper did for one app. */
export interface DeployNginxApplyResult {
  app: string;
  /** `unchanged`: the server block was already current. */
  result: 'applied' | 'unchanged' | 'removed' | 'failed';
  certificate: 'present' | 'issued' | 'failed' | 'skipped';
  error: string | null;
  /** The helper's own progress lines (nginx -t, certbot). */
  log: string[];
}
