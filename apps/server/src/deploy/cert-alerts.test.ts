import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeployCertificate } from '@smt/shared';

const sent = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../notifications/index.js', () => ({
  notifyAlertsChanged: (events: unknown[]) => sent.events.push(...events),
}));

import { certificateEvents, notifyCertificates, resetCertificateAlertsForTests } from './cert-alerts.js';

/**
 * Renewal alerts (deployments spec §6): derived from each read, sent through
 * the existing channels on a change only — opened when a certificate starts
 * failing (critical once expired), resolved when it recovers — with nothing
 * stored in the database.
 */

const cert = (over: Partial<DeployCertificate> = {}): DeployCertificate => ({
  domain: 'site1.com',
  source: 'acme',
  issuer: "Let's Encrypt R11",
  notBefore: '2026-10-01T00:00:00.000Z',
  notAfter: '2026-12-30T00:00:00.000Z',
  lastError: null,
  state: 'valid',
  daysLeft: 50,
  ...over,
});

beforeEach(() => {
  resetCertificateAlertsForTests();
  sent.events.length = 0;
});

describe('certificate alerts', () => {
  it('opens once per failing certificate, escalates when it expires, and resolves when it recovers', () => {
    expect(certificateEvents('org', 'srv', 'site1', [cert()])).toEqual([]);

    const failing = cert({ state: 'failing', daysLeft: 20, lastError: { at: null, message: 'timeout' } });
    expect(certificateEvents('org', 'srv', 'site1', [failing])).toEqual([
      {
        kind: 'opened',
        orgId: 'org',
        serverId: 'srv',
        type: 'deploy_certificate',
        severity: 'warning',
        message: 'The certificate of site1.com (app site1) is not being renewed; it expires on 2026-12-30 (20 days): timeout',
        value: 20,
        container: 'site1/site1.com',
      },
    ]);
    // Read again, still failing: nothing new
    expect(certificateEvents('org', 'srv', 'site1', [failing])).toEqual([]);

    const expired = certificateEvents('org', 'srv', 'site1', [cert({ state: 'expired', daysLeft: -1 })]);
    expect(expired).toMatchObject([{ kind: 'opened', severity: 'critical', message: 'The certificate of site1.com (app site1) expired on 2026-12-30' }]);

    expect(certificateEvents('org', 'srv', 'site1', [cert()])).toMatchObject([{ kind: 'resolved', type: 'deploy_certificate', container: 'site1/site1.com' }]);
    expect(certificateEvents('org', 'srv', 'site1', [cert()])).toEqual([]);
  });

  it('keeps servers, apps and domains apart, and names a certificate that never came', () => {
    const none = cert({ domain: 'www.site1.com', state: 'failing', notAfter: null, daysLeft: null, lastError: { at: null, message: 'NXDOMAIN' } });
    const events = notifyCertificates('org', 'srv', 'site1', [none]);
    expect(events).toMatchObject([{ message: 'No certificate could be obtained for www.site1.com (app site1): NXDOMAIN', container: 'site1/www.site1.com' }]);
    expect(events[0]).not.toHaveProperty('value');
    expect(sent.events).toEqual(events);
    expect(certificateEvents('org', 'other', 'site1', [none])).toHaveLength(1);
    expect(certificateEvents('org', 'srv', 'blog', [none])).toHaveLength(1);
  });
});
