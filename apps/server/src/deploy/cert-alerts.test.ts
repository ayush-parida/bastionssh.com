import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeployCertificate } from '@smt/shared';

const sent = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../notifications/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notifications/index.js')>()),
  notifyAlertsChanged: (events: Array<Record<string, unknown>>) => sent.events.push(...events),
}));

import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { serverAlerts } from '../db/schema.js';
import { reconcileAlerts } from '../monitoring/alerts.js';
import { seedOrg, seedServer, seedUser } from '../api/routes/test-utils.js';
import {
  certificateCondition,
  reconcileAppCertificates,
  REOPEN_COOLDOWN_MS,
  resetCertificateAlertsForTests,
  resolveCertificateAlerts,
} from './cert-alerts.js';

/**
 * Certificate alerts (deployments spec §6): which certificates alert
 * (expiring, renewal errors, expired — never Caddy's hours-long internal
 * ones for being short), and their reconciliation as `server_alerts` rows —
 * one per app and domain, channels told on open, escalation and resolve
 * only, a flap within the cooldown kept quiet, and the host alerts' own
 * reconciliation leaving them alone.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');

const cert = (over: Partial<DeployCertificate> = {}): DeployCertificate => ({
  domain: 'site1.com',
  source: 'acme',
  issuer: "Let's Encrypt R11",
  notBefore: '2026-10-01T00:00:00.000Z',
  notAfter: '2026-12-30T00:00:00.000Z',
  lastError: null,
  state: 'valid',
  daysLeft: 85,
  ...over,
});

let orgId: string;
let serverId: string;

function openAlerts() {
  return getDb()
    .select()
    .from(serverAlerts)
    .where(and(eq(serverAlerts.serverId, serverId), eq(serverAlerts.type, 'deploy_certificate'), isNull(serverAlerts.resolvedAt)))
    .all();
}

beforeAll(async () => {
  await runMigrations();
  orgId = seedOrg('org-cert-alerts');
  serverId = seedServer(orgId, seedUser(orgId, 'admin').userId, 'web-certs');
});

afterAll(() => resetCertificateAlertsForTests());

beforeEach(() => {
  resetCertificateAlertsForTests();
  sent.events.length = 0;
});

describe('which certificates alert', () => {
  it('fires for renewal errors, expiry and a near end, and not for valid or short-lived ones', () => {
    expect(certificateCondition('site1', cert())).toBeNull();
    expect(certificateCondition('site1', cert({ state: 'failing', daysLeft: 20, lastError: { at: null, message: 'timeout\nmore detail' } }))).toEqual({
      key: 'site1/site1.com',
      severity: 'warning',
      message: 'site1/site1.com: The certificate of site1.com (app site1) is not being renewed; it expires on 2026-12-30 (20 days): timeout',
      value: 20,
    });
    expect(certificateCondition('site1', cert({ state: 'failing', daysLeft: 2 }))?.severity).toBe('critical');
    expect(certificateCondition('site1', cert({ state: 'expired', daysLeft: -1 }))).toMatchObject({ severity: 'critical', message: expect.stringContaining('expired on 2026-12-30') });
    expect(certificateCondition('site1', cert({ state: 'failing', notAfter: null, daysLeft: null, lastError: { at: null, message: 'NXDOMAIN' } }))).toMatchObject({
      message: 'site1/site1.com: No certificate could be obtained for site1.com (app site1): NXDOMAIN',
    });
    // Files in the app folder: nobody renews them, so under 14 days is news
    expect(certificateCondition('site1', cert({ source: 'files', state: 'expiring', daysLeft: 10 }))).toMatchObject({
      severity: 'warning',
      threshold: 14,
      message: 'site1/site1.com: The certificate of site1.com (app site1) expires on 2026-12-30 (10 days left)',
    });
    expect(certificateCondition('site1', cert({ source: 'files', state: 'valid', daysLeft: 20 }))).toBeNull();
    // An ACME certificate that should have lasted months, down to 13 days
    expect(certificateCondition('site1', cert({ state: 'expiring', notBefore: '2026-07-01T00:00:00.000Z', notAfter: '2026-10-18T00:00:00.000Z', daysLeft: 13 }))).not.toBeNull();
    // Short-lived by design (Caddy's internal CA, six-day ACME profiles): a few days left is normal
    expect(certificateCondition('site1', cert({ source: 'internal', state: 'expiring', notBefore: '2026-10-05T00:00:00.000Z', notAfter: '2026-10-05T12:00:00.000Z', daysLeft: 0 }))).toBeNull();
    expect(certificateCondition('site1', cert({ state: 'expiring', notBefore: '2026-10-01T00:00:00.000Z', notAfter: '2026-10-07T00:00:00.000Z', daysLeft: 1 }))).toBeNull();
  });
});

describe('reconciliation', () => {
  const failing = cert({ domain: 'www.site1.com', state: 'failing', daysLeft: 20, lastError: { at: null, message: 'timeout' } });

  it('opens one row per app and domain, refreshes it quietly, escalates once, resolves on recovery', () => {
    expect(reconcileAppCertificates(orgId, serverId, 'site1', [cert(), failing], undefined, NOW)).toEqual([
      expect.objectContaining({ kind: 'opened', orgId, serverId, type: 'deploy_certificate', severity: 'warning', value: 20, container: 'site1/www.site1.com' }),
    ]);
    expect(openAlerts()).toHaveLength(1);
    expect(openAlerts()[0]!.message).toMatch(/^site1\/www\.site1\.com: /);

    // Still failing, a day closer: the row follows, channels hear nothing
    expect(reconcileAppCertificates(orgId, serverId, 'site1', [{ ...failing, daysLeft: 19 }], undefined, NOW + DAY)).toEqual([]);
    expect(openAlerts()).toMatchObject([{ value: 19, severity: 'warning' }]);

    // Expired: critical, told again under the same subject
    const expired = { ...failing, state: 'expired' as const, daysLeft: -1 };
    expect(reconcileAppCertificates(orgId, serverId, 'site1', [expired], undefined, NOW + 2 * DAY)).toMatchObject([{ kind: 'opened', severity: 'critical', container: 'site1/www.site1.com' }]);
    expect(reconcileAppCertificates(orgId, serverId, 'site1', [expired], undefined, NOW + 2 * DAY)).toEqual([]);

    expect(reconcileAppCertificates(orgId, serverId, 'site1', [{ ...failing, state: 'valid', daysLeft: 89 }], undefined, NOW + 3 * DAY)).toMatchObject([
      { kind: 'resolved', type: 'deploy_certificate', container: 'site1/www.site1.com', message: 'The certificate of www.site1.com (app site1) is fine again' },
    ]);
    expect(openAlerts()).toEqual([]);
    expect(sent.events.map((e) => e.kind)).toEqual(['opened', 'opened', 'resolved']);
  });

  it('reopens quietly within the cooldown, and then resolves quietly too', () => {
    reconcileAppCertificates(orgId, serverId, 'site1', [failing], undefined, NOW);
    reconcileAppCertificates(orgId, serverId, 'site1', [{ ...failing, state: 'valid' }], undefined, NOW + 1000);
    sent.events.length = 0;
    // The flapping error is back an hour after it resolved
    const later = NOW + 3_600_000;
    expect(reconcileAppCertificates(orgId, serverId, 'site1', [failing], undefined, later)).toEqual([]);
    expect(openAlerts()).toHaveLength(1);
    expect(reconcileAppCertificates(orgId, serverId, 'site1', [{ ...failing, state: 'valid' }], undefined, later + 1000)).toEqual([]);
    expect(openAlerts()).toHaveLength(0);
    // Past the cooldown, it is news again
    expect(reconcileAppCertificates(orgId, serverId, 'site1', [failing], undefined, later + 1000 + REOPEN_COOLDOWN_MS + 1000)).toHaveLength(1);
  });

  it('resolves domains the app no longer serves, keeps those the read said nothing about, and keeps apps apart', () => {
    reconcileAppCertificates(orgId, serverId, 'site1', [failing, { ...failing, domain: 'old.site1.com' }], undefined, NOW);
    reconcileAppCertificates(orgId, serverId, 'blog', [{ ...failing, domain: 'blog.example.com' }], undefined, NOW);
    expect(openAlerts()).toHaveLength(3);
    sent.events.length = 0;
    // Read: site1.com only; www still configured but unread; old.site1.com gone from the config
    const events = reconcileAppCertificates(orgId, serverId, 'site1', [cert()], ['site1.com', 'www.site1.com'], NOW);
    expect(events).toMatchObject([{ kind: 'resolved', container: 'site1/old.site1.com' }]);
    expect(openAlerts().map((a) => a.message.split(':')[0]).sort()).toEqual(['blog/blog.example.com', 'site1/www.site1.com']);
  });

  it('resolves apps that are gone, quietly when asked', () => {
    reconcileAppCertificates(orgId, serverId, 'site1', [failing], undefined, NOW);
    reconcileAppCertificates(orgId, serverId, 'blog', [{ ...failing, domain: 'blog.example.com' }], undefined, NOW);
    sent.events.length = 0;
    expect(resolveCertificateAlerts(orgId, serverId, ['site1'])).toMatchObject([{ kind: 'resolved', container: 'blog/blog.example.com' }]);
    expect(resolveCertificateAlerts(orgId, serverId, [], { notify: false })).toEqual([]);
    expect(openAlerts()).toEqual([]);
  });

  it("is left alone by the host alerts' reconciliation", () => {
    reconcileAppCertificates(orgId, serverId, 'site1', [failing], undefined, NOW);
    reconcileAlerts(orgId, serverId, [], { notify: false });
    expect(openAlerts()).toHaveLength(1);
  });
});
