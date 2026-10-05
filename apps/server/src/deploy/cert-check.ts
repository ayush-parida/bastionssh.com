import type { DeployAppStatus, DeployAppSummary, DeployCertFacts } from '@smt/shared';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { mapPooled } from '../docker/fleet.js';
import { isMonitored } from '../monitoring/scheduler.js';
import { bastionctlBundle, type BastionctlBundle } from './bundle.js';
import { reconcileAppCertificates, resolveCertificateAlerts } from './cert-alerts.js';
import { withState } from './domains.js';
import { discoverRoot, integrity } from './install.js';
import { nginxCertificates, readProxyMode } from './nginx.js';
import { openSystemRemote, type Remote, type ServerRow } from './remote.js';
import { bastionctl } from './runner.js';

/**
 * The background certificate check (deployments spec §6): every
 * {@link CERT_CHECK_INTERVAL_MS}, each monitored server is asked — over a
 * short-lived SSH connection with its own credentials, a few servers at a
 * time — whether it has deployments: the same cheap root discovery a request
 * makes, so nothing records which servers have any. Where bastionctl is
 * installed and is exactly the one this BastionSSH ships, each deployed app's
 * certificates are read (bastionctl certs, or the nginx helper in nginx
 * mode) and its alerts reconciled (deploy/cert-alerts.ts): expiring, renewal
 * errors and expiry go out through the org's notification channels with
 * their usual settings; recoveries resolve.
 *
 * Nothing is stored but those alert rows. A server that cannot be reached,
 * or an app whose certificates cannot be read, keeps its alerts as they are
 * (the health check reports an unreachable server); a server without
 * deployments any more, or an app that is gone, has its alerts resolved; a
 * server whose monitoring is off has them resolved quietly, as host alerts
 * are when monitoring pauses. A bastionctl that is not ours is never run.
 */

export const CERT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Who bastionctl records for these runs (they only read). */
const ACTOR = 'bastionssh-certificate-check';

/** Tunables; tests shorten them. */
export const certCheckLimits = {
  concurrency: 4,
  /** One server's whole check, connection included. */
  serverTimeoutMs: 3 * 60_000,
  /** First run after start, so the API and the health sweep come up first. */
  initialDelayMs: 2 * 60_000,
};

export type CertCheckOutcome =
  | { serverId: string; result: 'checked'; apps: number; skipped: number }
  | { serverId: string; result: 'no_deployments' | 'mismatch' | 'unreachable' | 'paused' };

export interface CertCheckDeps {
  open: (server: ServerRow) => Promise<Remote>;
  bundle: () => BastionctlBundle | null;
  now: () => number;
}

const defaultDeps: CertCheckDeps = { open: openSystemRemote, bundle: bastionctlBundle, now: Date.now };

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`did not finish within ${Math.round(ms / 1000)} s`));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Read and reconcile one server's certificates over `remote`. */
export async function checkCertificatesOn(
  server: ServerRow,
  remote: Remote,
  bundle: BastionctlBundle,
  now = Date.now(),
): Promise<CertCheckOutcome> {
  const root = await discoverRoot(remote);
  if (!root) {
    resolveCertificateAlerts(server.orgId, server.id, [], { now });
    return { serverId: server.id, result: 'no_deployments' };
  }
  const installed = await integrity(remote, root, bundle);
  if (installed === 'missing') {
    resolveCertificateAlerts(server.orgId, server.id, [], { now });
    return { serverId: server.id, result: 'no_deployments' };
  }
  // Not ours (another version, or modified): never run it; Set up on the tab reinstalls
  if (installed !== 'ok') return { serverId: server.id, result: 'mismatch' };

  const run = async <T>(args: string[]) => (await bastionctl<T>(remote, root, args, { actor: ACTOR })).value;
  const proxy = (await readProxyMode(remote, root)) ?? 'caddy';
  const apps = await run<DeployAppSummary[]>(['list']);
  let checked = 0;
  let skipped = 0;
  for (const app of apps) {
    if (app.configError || !app.currentRelease || app.domains.length === 0) {
      // Nothing served (yet, or any more): nothing to renew
      reconcileAppCertificates(server.orgId, server.id, app.name, [], [], now);
      continue;
    }
    try {
      const status = await run<DeployAppStatus>(['status', app.name]);
      const cfg = status.config;
      if (!cfg) {
        skipped++;
        continue;
      }
      const facts =
        proxy === 'nginx'
          ? await nginxCertificates(remote, app.name, cfg.tls === 'staging', cfg.domains, bundle)
          : await run<DeployCertFacts[]>(['certs', app.name]);
      reconcileAppCertificates(server.orgId, server.id, app.name, withState(facts, now), cfg.domains, now);
      checked++;
    } catch (err) {
      // Its alerts stay as they are until a read succeeds
      skipped++;
      logger.debug({ serverId: server.id, app: app.name, err: (err as Error).message }, 'Certificate check could not read an app');
    }
  }
  resolveCertificateAlerts(
    server.orgId,
    server.id,
    apps.map((a) => a.name),
    { now },
  );
  return { serverId: server.id, result: 'checked', apps: checked, skipped };
}

async function checkServer(server: ServerRow, bundle: BastionctlBundle, deps: CertCheckDeps): Promise<CertCheckOutcome> {
  let remote: Remote | null = null;
  try {
    return await withTimeout(
      (async () => {
        remote = await deps.open(server);
        return checkCertificatesOn(server, remote, bundle, deps.now());
      })(),
      certCheckLimits.serverTimeoutMs,
      () => (remote as Remote | null)?.release(),
    );
  } catch (err) {
    logger.debug({ serverId: server.id, err: (err as Error).message }, 'Certificate check could not reach a server');
    return { serverId: server.id, result: 'unreachable' };
  } finally {
    (remote as Remote | null)?.release();
  }
}

/** Check every server once. */
export async function runCertificateCheck(deps: CertCheckDeps = defaultDeps): Promise<CertCheckOutcome[]> {
  const bundle = deps.bundle();
  if (!bundle) return [];
  const all = getDb().select().from(servers).all();
  const outcomes: CertCheckOutcome[] = [];
  for (const server of all.filter((s) => !isMonitored(s))) {
    resolveCertificateAlerts(server.orgId, server.id, [], { notify: false, now: deps.now() });
    outcomes.push({ serverId: server.id, result: 'paused' });
  }
  const started = Date.now();
  outcomes.push(...(await mapPooled(all.filter(isMonitored), certCheckLimits.concurrency, (server) => checkServer(server, bundle, deps))));
  const checked = outcomes.filter((o) => o.result === 'checked').length;
  logger.debug({ servers: outcomes.length, withDeployments: checked, durationMs: Date.now() - started }, 'Certificate check complete');
  return outcomes;
}

let timer: NodeJS.Timeout | null = null;
let first: NodeJS.Timeout | null = null;
let running = false;

async function tick() {
  // A slow fleet must not stack checks up
  if (running) return;
  running = true;
  try {
    await runCertificateCheck();
  } catch (err) {
    logger.error({ err }, 'Certificate check failed');
  } finally {
    running = false;
  }
}

/** Start the check (once; a second call does nothing). Off with health monitoring. */
export function startCertificateChecks(): void {
  if (!config.monitoring.enabled || timer) return;
  timer = setInterval(() => void tick(), CERT_CHECK_INTERVAL_MS);
  timer.unref?.();
  first = setTimeout(() => void tick(), certCheckLimits.initialDelayMs);
  first.unref?.();
  logger.info({ intervalHours: CERT_CHECK_INTERVAL_MS / 3_600_000, concurrency: certCheckLimits.concurrency }, 'Certificate check started');
}

export function stopCertificateChecks(): void {
  if (timer) clearInterval(timer);
  if (first) clearTimeout(first);
  timer = null;
  first = null;
}
