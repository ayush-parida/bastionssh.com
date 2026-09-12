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

describe('teams', () => {
  it('sends an adaptive card in the message envelope', () => {
    const body = getAdapter('teams').build(URL, critical, SERVER, NOW).body as {
      type: string;
      attachments: { contentType: string; content: { body: { type: string; text?: string; color?: string; facts?: unknown[] }[] } }[];
    };
    expect(body.type).toBe('message');
    expect(body.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = body.attachments[0]!.content.body;
    expect(card[0]!.text).toBe('[CRITICAL] CPU high on web-01');
    expect(card[0]!.color).toBe('Attention');
    expect(card[2]!.type).toBe('FactSet');
    expect(card[2]!.facts!.length).toBeGreaterThan(2);
  });
});

describe('googlechat', () => {
  it('uses unicode markers', () => {
    expect((getAdapter('googlechat').build(URL, critical, SERVER, NOW).body as { text: string }).text).toMatch(/^🚨 \*CRITICAL\*/);
    expect((getAdapter('googlechat').build(URL, resolved, SERVER, NOW).body as { text: string }).text).toMatch(/^✅/);
  });
});

describe('telegram', () => {
  const token = '123456:ABCdefGHIjklMNOpqrSTUvwxYZ12345';
  it('packs token and chat id into one URL and unpacks the chat id into the body', () => {
    const prepared = getAdapter('telegram').prepare({ token, chatId: '-1001' });
    expect(prepared).toEqual({
      target: `https://api.telegram.org/bot${token}/sendMessage?chat_id=-1001`,
      hint: 'chat -1001',
    });
    const req = getAdapter('telegram').build(prepared.target, opened, SERVER, NOW);
    expect(req.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(req.body).toMatchObject({ chat_id: '-1001', parse_mode: 'HTML' });
    expect((req.body as { text: string }).text).toContain('<b>[WARNING] CPU high on web-01</b>');
  });
  it('escapes html in the message', () => {
    const req = getAdapter('telegram').build(`https://api.telegram.org/bot${token}/sendMessage?chat_id=1`, { ...opened, message: '<x>' }, SERVER, NOW);
    expect((req.body as { text: string }).text).toContain('&lt;x&gt;');
  });
  it('needs both halves and a plausible token', () => {
    expect(() => getAdapter('telegram').prepare({ token })).toThrow(/both/);
    expect(() => getAdapter('telegram').prepare({ chatId: '1' })).toThrow(/both/);
    expect(() => getAdapter('telegram').prepare({ token: 'nope', chatId: '1' })).toThrow(/bot token/);
  });
});

describe('ntfy', () => {
  it('keeps credentials in the target, hides them in the hint, publishes JSON to the root', () => {
    const prepared = getAdapter('ntfy').prepare({ url: 'https://u:p@ntfy.example.com/alerts' });
    expect(prepared.hint).toBe('ntfy.example.com/alerts');
    const req = getAdapter('ntfy').build(prepared.target, critical, SERVER, NOW);
    expect(req.url).toBe('https://u:p@ntfy.example.com/');
    expect(req.body).toEqual({
      topic: 'alerts',
      title: '[CRITICAL] CPU high on web-01',
      message: expect.stringContaining('web-01'),
      priority: 5,
      tags: ['rotating_light'],
    });
  });
  it('rejects a URL without a topic', () => {
    expect(() => getAdapter('ntfy').prepare({ url: 'https://ntfy.sh/' })).toThrow(/topic/);
  });
});

describe('gotify', () => {
  it('requires an app token and posts title/message/priority', () => {
    expect(() => getAdapter('gotify').prepare({ url: 'https://g.example.com/message' })).toThrow(/token/);
    const prepared = getAdapter('gotify').prepare({ url: 'https://g.example.com/message?token=Abc' });
    expect(prepared.hint).toBe('g.example.com/message?token=…');
    const req = getAdapter('gotify').build(prepared.target, opened, SERVER, NOW);
    expect(req.url).toBe('https://g.example.com/message?token=Abc');
    expect(req.body).toMatchObject({ priority: 5, title: '[WARNING] CPU high on web-01' });
  });
});

describe('pushover', () => {
  const token = 'a'.repeat(30);
  const userKey = 'u'.repeat(29) + 'Z';
  it('packs both keys and posts them in the body', () => {
    const prepared = getAdapter('pushover').prepare({ token, userKey });
    expect(prepared.hint).toBe('user …uuuZ');
    const req = getAdapter('pushover').build(prepared.target, critical, SERVER, NOW);
    expect(req.url).toBe('https://api.pushover.net/1/messages.json');
    expect(req.body).toMatchObject({ token, user: userKey, priority: 1 });
  });
  it('validates key shape', () => {
    expect(() => getAdapter('pushover').prepare({ token: 'short', userKey })).toThrow(/30/);
  });
});

describe('pagerduty', () => {
  const key = 'R0123456789abcdef0123456789abcdef';
  it('triggers on open with a stable dedup key, resolves on resolve', () => {
    const prepared = getAdapter('pagerduty').prepare({ routingKey: key });
    expect(prepared).toEqual({ target: key, hint: '…cdef' });
    const open = getAdapter('pagerduty').build(key, critical, SERVER, NOW);
    expect(open.url).toBe('https://events.pagerduty.com/v2/enqueue');
    expect(open.body).toMatchObject({
      routing_key: key,
      event_action: 'trigger',
      dedup_key: 'smt:srv1:cpu_high',
      payload: { severity: 'critical', source: '10.0.0.4' },
    });
    expect(open.followUp).toBeUndefined();
    const done = getAdapter('pagerduty').build(key, resolved, SERVER, NOW);
    expect(done.body).toEqual({ routing_key: key, event_action: 'resolve', dedup_key: 'smt:srv1:cpu_high' });
  });
  it('resolves its own test incident', () => {
    const req = getAdapter('pagerduty').build(key, test, SERVER, NOW);
    expect(req.body).toMatchObject({ event_action: 'trigger', dedup_key: `smt:test:${NOW}`, payload: { severity: 'info' } });
    expect(req.followUp?.body).toMatchObject({ event_action: 'resolve', dedup_key: `smt:test:${NOW}` });
  });
  it('rejects a short key', () => {
    expect(() => getAdapter('pagerduty').prepare({ routingKey: 'short' })).toThrow(/integration key/);
  });
});

describe('opsgenie', () => {
  const key = '01234567-89ab-cdef-0123-456789abcdef';
  it('creates by alias in the chosen region and closes by alias', () => {
    const prepared = getAdapter('opsgenie').prepare({ routingKey: key, region: 'eu' });
    expect(prepared).toEqual({ target: `eu:${key}`, hint: 'eu …cdef' });
    const open = getAdapter('opsgenie').build(prepared.target, opened, SERVER, NOW);
    expect(open.url).toBe('https://api.eu.opsgenie.com/v2/alerts');
    expect(open.headers).toEqual({ Authorization: `GenieKey ${key}` });
    expect(open.body).toMatchObject({ alias: 'smt:srv1:cpu_high', priority: 'P3', message: '[WARNING] CPU high on web-01' });
    const close = getAdapter('opsgenie').build(prepared.target, resolved, SERVER, NOW);
    expect(close.url).toBe('https://api.eu.opsgenie.com/v2/alerts/smt%3Asrv1%3Acpu_high/close?identifierType=alias');
  });
  it('defaults to the US region and closes its own test alert', () => {
    const prepared = getAdapter('opsgenie').prepare({ routingKey: key });
    expect(prepared.target).toBe(`us:${key}`);
    const req = getAdapter('opsgenie').build(prepared.target, test, SERVER, NOW);
    expect(req.url).toBe('https://api.opsgenie.com/v2/alerts');
    expect(req.followUp?.url).toContain('/close?identifierType=alias');
  });
});
