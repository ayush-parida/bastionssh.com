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
