import { isDeployCertAlerting, type DeployCertificate } from '@smt/shared';
import { notifyAlertsChanged, type AlertEvent } from '../notifications/index.js';

/**
 * Certificate renewal alerts (deployments spec §6), through the org's
 * existing notification channels. Whether a certificate is failing is
 * derived each time its status is read from the server; nothing is written
 * to the database. To tell channels once per change rather than on every
 * read, this process remembers which certificates it last announced as
 * failing — after a restart a still-failing certificate is announced again
 * on its next read, which is the safe side.
 */

/** Per server, app and domain: the alert last sent. */
const announced = new Map<string, string>();
const MAX_ENTRIES = 10_000;

function describe(app: string, cert: DeployCertificate): string {
  const where = `${cert.domain} (app ${app})`;
  const error = cert.lastError ? `: ${cert.lastError.message}` : '';
  if (cert.state === 'expired') return `The certificate of ${where} expired on ${cert.notAfter?.slice(0, 10) ?? '?'}${error}`;
  if (!cert.notAfter) return `No certificate could be obtained for ${where}${error}`;
  return `The certificate of ${where} is not being renewed; it expires on ${cert.notAfter.slice(0, 10)} (${cert.daysLeft} days)${error}`;
}

/** The alert events this read of `app`'s certificates causes: newly failing (opened) and recovered (resolved). */
export function certificateEvents(orgId: string, serverId: string, app: string, certs: readonly DeployCertificate[]): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const cert of certs) {
    const key = `${serverId}\0${app}\0${cert.domain}`;
    const was = announced.get(key);
    const subject = `${app}/${cert.domain}`;
    if (isDeployCertAlerting(cert.state)) {
      if (was === cert.state) continue;
      if (announced.size >= MAX_ENTRIES) announced.delete(announced.keys().next().value!);
      announced.set(key, cert.state);
      events.push({
        kind: 'opened',
        orgId,
        serverId,
        type: 'deploy_certificate',
        severity: cert.state === 'expired' ? 'critical' : 'warning',
        message: describe(app, cert),
        ...(cert.daysLeft !== null && { value: cert.daysLeft }),
        container: subject,
      });
    } else if (was !== undefined) {
      announced.delete(key);
      events.push({ kind: 'resolved', orgId, serverId, type: 'deploy_certificate', severity: 'warning', message: `The certificate of ${cert.domain} (app ${app}) is ${cert.state} again`, container: subject });
    }
  }
  return events;
}

/** Notify channels about what changed since the last read (fire-and-forget). */
export function notifyCertificates(orgId: string, serverId: string, app: string, certs: readonly DeployCertificate[]): AlertEvent[] {
  const events = certificateEvents(orgId, serverId, app, certs);
  notifyAlertsChanged(events);
  return events;
}

export function resetCertificateAlertsForTests(): void {
  announced.clear();
}
