import { describe, it, expect } from 'vitest';
import type { AlertWebhookPayload } from '@smt/shared';
import type { AlertEvent, ServerRef } from '../format.js';
import { getAdapter } from './index.js';
import { dedupKey, title } from './types.js';

export const SERVER: ServerRef = { id: 'srv1', name: 'web-01', host: '10.0.0.4' };
export const NOW = '2026-09-13T10:00:00.000Z';

export const opened: AlertEvent = {
  kind: 'opened',
  orgId: 'org1',
  serverId: 'srv1',
  type: 'cpu_high',
  severity: 'warning',
  message: 'CPU at 91.0% (threshold 85%)',
  value: 91,
  threshold: 85,
};
export const critical: AlertEvent = { ...opened, severity: 'critical' };
export const resolved: AlertEvent = { ...opened, kind: 'resolved' };
export const test: AlertEvent = {
  kind: 'test',
  orgId: 'org1',
  serverId: 'test',
  type: 'test',
  severity: 'warning',
  message: 'Test notification',
};

const URL = 'https://hooks.example.com/services/T0/B1/secret';

describe('shared helpers', () => {
  it('titles events', () => {
    expect(title(critical, SERVER)).toBe('[CRITICAL] CPU high on web-01');
    expect(title(resolved, SERVER)).toBe('Resolved: CPU high on web-01');
    expect(title(test, SERVER)).toBe('Test notification');
  });
  it('keys alerts per server and type, and tests per send', () => {
    expect(dedupKey(opened, NOW)).toBe('smt:srv1:cpu_high');
    expect(dedupKey(resolved, NOW)).toBe('smt:srv1:cpu_high');
    expect(dedupKey(test, NOW)).toBe(`smt:test:${NOW}`);
  });
});

describe('url channels', () => {
  it('vault the URL and show it masked', () => {
    for (const type of ['webhook', 'slack', 'discord'] as const) {
      expect(getAdapter(type).prepare({ url: URL })).toEqual({
        target: URL,
        hint: 'hooks.example.com/services/T0/B1/…',
      });
    }
  });
  it('reject a missing or unsafe URL', () => {
    expect(() => getAdapter('slack').prepare({})).toThrow(/required/);
    expect(() => getAdapter('slack').prepare({ url: 'http://169.254.169.254/x' })).toThrow(/not allowed/);
  });
});

describe('ported payloads', () => {
  it('slack text keeps its shape', () => {
    const { url, body } = getAdapter('slack').build(URL, opened, SERVER, NOW) as { url: string; body: { text: string } };
    expect(url).toBe(URL);
    expect(body.text).toContain('[WARNING]');
    expect(body.text).toContain('web-01');
  });
  it('webhook payload keeps its shape', () => {
    const body = getAdapter('webhook').build(URL, opened, SERVER, NOW).body as AlertWebhookPayload;
    expect(body.event).toBe('alert.opened');
    expect(body.alert).toMatchObject({ type: 'cpu_high', severity: 'warning', value: 91, threshold: 85 });
    expect(body.sentAt).toBe(NOW);
  });
  it('discord embed keeps its colours', () => {
    const body = getAdapter('discord').build(URL, critical, SERVER, NOW).body as { embeds: { color: number }[] };
    expect(body.embeds[0]!.color).toBe(0xef4444);
  });
});
