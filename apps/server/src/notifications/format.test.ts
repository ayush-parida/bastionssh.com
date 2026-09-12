import { describe, it, expect } from 'vitest';
import type { AlertWebhookPayload } from '@smt/shared';
import {
  alertLabel,
  buildPayload,
  describeRecipients,
  emailBody,
  emailSubject,
  maskUrl,
  parseRecipients,
  passesSeverityFilter,
  summarize,
  type AlertEvent,
  type ServerRef,
} from './format.js';

const NOW = '2026-09-13T10:00:00.000Z';

const SERVER: ServerRef = { id: 'srv1', name: 'web-01', host: '10.0.0.4' };

const opened: AlertEvent = {
  kind: 'opened',
  orgId: 'org1',
  serverId: 'srv1',
  type: 'cpu_high',
  severity: 'warning',
  message: 'CPU at 91.0% (threshold 85%)',
  value: 91,
  threshold: 85,
};

describe('passesSeverityFilter', () => {
  it('lets everything through on a warning channel', () => {
    expect(passesSeverityFilter(opened, 'warning')).toBe(true);
    expect(passesSeverityFilter({ ...opened, severity: 'critical' }, 'warning')).toBe(true);
  });

  it('drops warnings on a critical-only channel', () => {
    expect(passesSeverityFilter(opened, 'critical')).toBe(false);
    expect(passesSeverityFilter({ ...opened, severity: 'critical' }, 'critical')).toBe(true);
  });

  it('always forwards a resolution, so no false alarm is left standing', () => {
    const resolved: AlertEvent = { ...opened, kind: 'resolved', severity: 'warning' };
    expect(passesSeverityFilter(resolved, 'critical')).toBe(true);
  });
});

describe('maskUrl', () => {
  it('hides the secret final segment of a Slack hook', () => {
    const masked = maskUrl('https://hooks.slack.com/services/T00000/B11111/abcdefSECRET');
    expect(masked).toBe('hooks.slack.com/services/T00000/B11111/…');
    expect(masked).not.toContain('abcdefSECRET');
  });

  it('handles a bare host with no path', () => {
    expect(maskUrl('https://example.com')).toBe('example.com');
  });

  it('does not throw on junk', () => {
    expect(maskUrl('not a url')).toBe('invalid URL');
  });
});

describe('buildPayload', () => {
  it('produces Slack text with the severity for a new alert', () => {
    const body = buildPayload('slack', opened, SERVER, '2026-01-01T00:00:00.000Z') as {
      text: string;
    };
    expect(body.text).toContain('[WARNING]');
    expect(body.text).toContain('web-01');
    expect(body.text).toContain('CPU at 91.0%');
  });

  it('marks a resolution without a severity prefix', () => {
    const body = buildPayload(
      'slack',
      { ...opened, kind: 'resolved' },
      SERVER,
      '2026-01-01T00:00:00.000Z',
    ) as { text: string };
    expect(body.text).toContain('Resolved');
    expect(body.text).not.toContain('[WARNING]');
  });

  it('gives a webhook structured fields to route on', () => {
    const body = buildPayload(
      'webhook',
      opened,
      SERVER,
      '2026-01-01T00:00:00.000Z',
    ) as AlertWebhookPayload;
    expect(body.event).toBe('alert.opened');
    expect(body.alert).toMatchObject({ type: 'cpu_high', severity: 'warning', value: 91, threshold: 85 });
    expect(body.server).toEqual({ id: 'srv1', name: 'web-01', host: '10.0.0.4' });
    expect(body.sentAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('omits absent numeric fields rather than sending nulls', () => {
    const offline: AlertEvent = {
      kind: 'opened',
      orgId: 'org1',
      serverId: 'srv1',
      type: 'offline',
      severity: 'critical',
      message: 'Unreachable for 3 consecutive checks',
    };
    const body = buildPayload('webhook', offline, SERVER, 'now') as AlertWebhookPayload;
    expect('value' in body.alert).toBe(false);
    expect('threshold' in body.alert).toBe(false);
  });
});

describe('summarize', () => {
  it('names the server and host', () => {
    expect(summarize(opened, SERVER)).toContain('web-01 (10.0.0.4)');
  });

  it('labels alert types readably', () => {
    expect(alertLabel('memory_high')).toBe('Memory high');
    expect(alertLabel('offline')).toBe('Offline');
  });
});

describe('discord payload', () => {
  it('uses an embed coloured by severity', () => {
    const body = buildPayload('discord', { ...opened, severity: 'critical' }, SERVER, NOW) as {
      content: string;
      embeds: { title: string; description: string; color: number }[];
    };
    expect(body.embeds[0]!.color).toBe(0xef4444);
    expect(body.embeds[0]!.title).toContain('CPU high');
    expect(body.content).toContain('web-01');
  });

  it('turns green on resolve', () => {
    const body = buildPayload('discord', { ...opened, kind: 'resolved' }, SERVER, NOW) as {
      embeds: { color: number }[];
    };
    expect(body.embeds[0]!.color).toBe(0x22c55e);
  });
});

describe('email', () => {
  it('prefixes the subject with severity', () => {
    expect(emailSubject(opened, SERVER)).toBe('[WARNING] CPU high on web-01');
    expect(emailSubject({ ...opened, kind: 'resolved' }, SERVER)).toBe('[Resolved] CPU high on web-01');
    expect(emailSubject({ ...opened, kind: 'test', type: 'test' }, SERVER)).toBe(
      'Test notification from Server Manager',
    );
  });

  it('renders text and html bodies with the message and host', () => {
    const { text, html } = emailBody(opened, SERVER, NOW);
    expect(text).toContain('10.0.0.4');
    expect(text).toContain('CPU at 91.0%');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('<script');
  });

  it('escapes html in the message', () => {
    const { html } = emailBody({ ...opened, message: '<b>x</b>' }, SERVER, NOW);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('recipients', () => {
  it('shows the first address and a count', () => {
    expect(describeRecipients(['a@x.com'])).toBe('a@x.com');
    expect(describeRecipients(['a@x.com', 'b@x.com', 'c@x.com'])).toBe('a@x.com +2');
  });

  it('round-trips through the stored form', () => {
    expect(parseRecipients('a@x.com,b@x.com')).toEqual(['a@x.com', 'b@x.com']);
    expect(parseRecipients('')).toEqual([]);
  });
});
