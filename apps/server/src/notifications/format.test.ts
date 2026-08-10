import { describe, it, expect } from 'vitest';
import type { AlertWebhookPayload } from '@smt/shared';
import {
  alertLabel,
  buildPayload,
  maskUrl,
  passesSeverityFilter,
  summarize,
  type AlertEvent,
  type ServerRef,
} from './format.js';

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
