import { and, desc, eq, gt, isNotNull, isNull, like } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DEPLOY_CERT_EXPIRING_DAYS, isDeployCertAlerting, type AlertSeverity, type DeployCertificate } from '@smt/shared';
import { getDb } from '../db/index.js';
import { serverAlerts } from '../db/schema.js';
import logger from '../logger.js';
import { notifyAlertsChanged, type AlertEvent } from '../notifications/index.js';

/**
 * Certificate alerts for deployed apps (deployments spec §6), raised through
 * the org's existing notification channels — by the background check every
 * few hours (deploy/cert-check.ts) and by every read of an app's Domains.
 *
 * An alert is monitoring data, like a container's: one open `server_alerts`
 * row of type `deploy_certificate` per (server, app, domain), its message led
 * by `<app>/<domain>:` (neither can hold a `:`) — the row says what is wrong
 * now, never anything about the app's configuration. Channels hear about it
 * when it opens, when it escalates to critical (expired), and when it
 * resolves. One that comes back within {@link REOPEN_COOLDOWN_MS} of
 * resolving (a renewal error that flaps between reads) reopens quietly, and
 * then resolves quietly too.
 *
 * What fires:
 * - expired — critical;
 * - failing — not renewed past its renewal point, or a renewal error logged
 *   inside the renewal window (no certificate at all and an error, too);
 * - expiring — under {@link DEPLOY_CERT_EXPIRING_DAYS} days left on a
 *   certificate nobody renews (files in the app folder) or one long-lived
 *   enough that this is late (Caddy's internal certificates live hours and
 *   are always "expiring": they never alert for that).
 */

export const DEPLOY_CERT_ALERT = 'deploy_certificate' as const;
export const REOPEN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
/** Below this lifetime, a certificate is short-lived by design: few days left is normal. */
const SHORT_LIVED_MS = 3 * DEPLOY_CERT_EXPIRING_DAYS * DAY_MS;
/** Days left at which an expiring certificate becomes critical. */
const CRITICAL_DAYS = 3;

export interface CertCondition {
  /** `<app>/<domain>`. */
  key: string;
  severity: AlertSeverity;
  message: string;
  value?: number;
  threshold?: number;
}

/** Row ids that opened quietly within the cooldown: their resolution is quiet too. */
const quiet = new Set<string>();

const subjectOf = (app: string, domain: string) => `${app}/${domain}`;

/** The `<app>/<domain>` an alert row is about: its message's leading key. */
export function certKeyOfMessage(message: string): string {
  const at = message.indexOf(':');
  return at === -1 ? message : message.slice(0, at);
}

function describe(app: string, cert: DeployCertificate): string {
  const where = `${cert.domain} (app ${app})`;
  const error = cert.lastError ? `: ${cert.lastError.message.split('\n')[0]!.slice(0, 300)}` : '';
  if (cert.state === 'expired') return `The certificate of ${where} expired on ${cert.notAfter?.slice(0, 10) ?? '?'}${error}`;
  if (!cert.notAfter) return `No certificate could be obtained for ${where}${error}`;
  if (cert.state === 'failing') return `The certificate of ${where} is not being renewed; it expires on ${cert.notAfter.slice(0, 10)} (${cert.daysLeft} days)${error}`;
  return `The certificate of ${where} expires on ${cert.notAfter.slice(0, 10)} (${cert.daysLeft} days left)${error}`;
}

function lifetimeMs(cert: DeployCertificate): number | null {
  const start = cert.notBefore ? Date.parse(cert.notBefore) : NaN;
  const end = cert.notAfter ? Date.parse(cert.notAfter) : NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? null : end - start;
}

/** Whether `cert` raises an alert now, and how. */
export function certificateCondition(app: string, cert: DeployCertificate): CertCondition | null {
  const key = subjectOf(app, cert.domain);
  const message = `${key}: ${describe(app, cert)}`;
  const value = cert.daysLeft ?? undefined;
  if (cert.state === 'expired') return { key, severity: 'critical', message, value };
  if (isDeployCertAlerting(cert.state)) {
    return { key, severity: cert.daysLeft !== null && cert.daysLeft <= CRITICAL_DAYS ? 'critical' : 'warning', message, value };
  }
  if (cert.source === 'internal' || cert.daysLeft === null || cert.daysLeft >= DEPLOY_CERT_EXPIRING_DAYS) return null;
  const lifetime = lifetimeMs(cert);
  if (cert.source !== 'files' && (lifetime === null || lifetime < SHORT_LIVED_MS)) return null;
  return { key, severity: cert.daysLeft <= CRITICAL_DAYS ? 'critical' : 'warning', message, value, threshold: DEPLOY_CERT_EXPIRING_DAYS };
}

type AlertRow = typeof serverAlerts.$inferSelect;

function openRows(serverId: string, app?: string): AlertRow[] {
  return getDb()
    .select()
    .from(serverAlerts)
    .where(
      and(
        eq(serverAlerts.serverId, serverId),
        eq(serverAlerts.type, DEPLOY_CERT_ALERT),
        isNull(serverAlerts.resolvedAt),
        app ? like(serverAlerts.message, `${app}/%`) : undefined,
      ),
    )
    .all()
    .filter((row) => !app || certKeyOfMessage(row.message).startsWith(`${app}/`));
}

/** Resolved within the cooldown: reopening it is not news. */
function recentlyResolved(serverId: string, app: string, key: string, now: number): boolean {
  const since = new Date(now - REOPEN_COOLDOWN_MS).toISOString();
  const last = getDb()
    .select({ message: serverAlerts.message, resolvedAt: serverAlerts.resolvedAt })
    .from(serverAlerts)
    .where(
      and(
        eq(serverAlerts.serverId, serverId),
        eq(serverAlerts.type, DEPLOY_CERT_ALERT),
        isNotNull(serverAlerts.resolvedAt),
        gt(serverAlerts.resolvedAt, since),
        // App names hold no LIKE wildcards (DEPLOY_NAME_PATTERN)
        like(serverAlerts.message, `${app}/%`),
      ),
    )
    .orderBy(desc(serverAlerts.resolvedAt))
    .all()
    .find((row) => certKeyOfMessage(row.message) === key);
  return !!last?.resolvedAt && now - Date.parse(last.resolvedAt) < REOPEN_COOLDOWN_MS;
}

function resolvedEvent(orgId: string, serverId: string, row: AlertRow): AlertEvent {
  const key = certKeyOfMessage(row.message);
  return {
    kind: 'resolved',
    orgId,
    serverId,
    type: DEPLOY_CERT_ALERT,
    severity: row.severity as AlertSeverity,
    message: `The certificate of ${key.slice(key.indexOf('/') + 1)} (app ${key.slice(0, key.indexOf('/'))}) is fine again`,
    openedAt: row.openedAt,
    container: key,
  };
}

function resolveRows(orgId: string, serverId: string, rows: AlertRow[], nowIso: string, events: AlertEvent[], notify: boolean) {
  const db = getDb();
  for (const row of rows) {
    db.update(serverAlerts).set({ resolvedAt: nowIso }).where(eq(serverAlerts.id, row.id)).run();
    const wasQuiet = quiet.delete(row.id);
    if (notify && !wasQuiet) events.push(resolvedEvent(orgId, serverId, row));
  }
}

/**
 * Reconcile one app's certificate alerts with a fresh read: open what fires,
 * refresh what still fires, resolve what recovered and domains the app no
 * longer serves. A configured domain the read said nothing about keeps its
 * alert as it is. Notifies the channels (fire-and-forget) and returns the
 * events sent.
 */
export function reconcileAppCertificates(
  orgId: string,
  serverId: string,
  app: string,
  certs: readonly DeployCertificate[],
  domains: readonly string[] = certs.map((c) => c.domain),
  now = Date.now(),
): AlertEvent[] {
  const db = getDb();
  const nowIso = new Date(now).toISOString();
  const open = new Map(openRows(serverId, app).map((row) => [certKeyOfMessage(row.message), row]));
  const events: AlertEvent[] = [];
  const read = new Set(certs.map((c) => subjectOf(app, c.domain)));
  const served = new Set(domains.map((d) => subjectOf(app, d)));
  const firing = new Set<string>();

  for (const cert of certs) {
    const condition = certificateCondition(app, cert);
    if (!condition || firing.has(condition.key)) continue;
    firing.add(condition.key);
    const event: AlertEvent = {
      kind: 'opened',
      orgId,
      serverId,
      type: DEPLOY_CERT_ALERT,
      severity: condition.severity,
      message: condition.message,
      ...(condition.value !== undefined && { value: condition.value }),
      ...(condition.threshold !== undefined && { threshold: condition.threshold }),
      container: condition.key,
    };
    const existing = open.get(condition.key);
    if (existing) {
      db.update(serverAlerts)
        .set({ message: condition.message, severity: condition.severity, value: condition.value ?? null, threshold: condition.threshold ?? null })
        .where(eq(serverAlerts.id, existing.id))
        .run();
      // Expired since it opened: worth telling again, under the same dedup key
      if (existing.severity !== 'critical' && condition.severity === 'critical' && !quiet.has(existing.id)) events.push(event);
      continue;
    }
    const id = nanoid();
    const isQuiet = recentlyResolved(serverId, app, condition.key, now);
    db.insert(serverAlerts)
      .values({
        id,
        orgId,
        serverId,
        type: DEPLOY_CERT_ALERT,
        severity: condition.severity,
        message: condition.message,
        value: condition.value,
        threshold: condition.threshold,
        openedAt: nowIso,
      })
      .run();
    if (isQuiet) quiet.add(id);
    else events.push(event);
  }

  const recovered = [...open.entries()].filter(([key]) => !firing.has(key) && (read.has(key) || !served.has(key))).map(([, row]) => row);
  resolveRows(orgId, serverId, recovered, nowIso, events, true);

  if (events.length) logger.info({ serverId, app, events: events.map((e) => `${e.kind}:${e.container}`) }, 'Certificate alerts changed');
  notifyAlertsChanged(events);
  return events;
}

/**
 * Resolve a server's certificate alerts for apps it no longer has (deleted,
 * or deployments removed altogether: `keepApps` empty). `notify: false`
 * resolves without telling anyone (monitoring paused).
 */
export function resolveCertificateAlerts(
  orgId: string,
  serverId: string,
  keepApps: Iterable<string> = [],
  options: { notify?: boolean; now?: number } = {},
): AlertEvent[] {
  const keep = new Set(keepApps);
  const rows = openRows(serverId).filter((row) => {
    const key = certKeyOfMessage(row.message);
    return !keep.has(key.slice(0, key.indexOf('/')));
  });
  const events: AlertEvent[] = [];
  resolveRows(orgId, serverId, rows, new Date(options.now ?? Date.now()).toISOString(), events, options.notify !== false);
  notifyAlertsChanged(events);
  return events;
}

export function resetCertificateAlertsForTests(): void {
  quiet.clear();
  getDb().delete(serverAlerts).where(eq(serverAlerts.type, DEPLOY_CERT_ALERT)).run();
}
