import { describe, it, expect } from 'vitest';
import type { NoticeWebhookPayload } from '@smt/shared';
import { emailBody, emailSubject, NOTICE_SERVER, noticeEvent, passesSeverityFilter, summarize } from './format.js';
import { getAdapter } from './channels/index.js';
import { facts, title, tone } from './channels/types.js';

const NOW = '2026-09-28T10:00:00.000Z';
const event = noticeEvent('org1', {
  event: 'access_request.created',
  title: 'Access request from Dana',
  message: 'dana@example.com asks for 2h of access to web-01: deploy <hotfix>',
  details: [
    ['Servers', 'web-01'],
    ['Duration', '2h'],
  ],
});

/** Access requests travel as notices through the alert channels, naming no server. */
describe('notices', () => {
  it('title, summarize and list their own details', () => {
    expect(title(event, NOTICE_SERVER)).toBe('Access request from Dana');
    expect(summarize(event, NOTICE_SERVER)).toBe(event.message);
    expect(tone(event)).toBe('test');
    expect(facts(event, NOTICE_SERVER, NOW)).toEqual([
      ['Servers', 'web-01'],
      ['Duration', '2h'],
      ['Sent', NOW],
    ]);
  });

  it('pass any severity filter', () => {
    expect(passesSeverityFilter(event, 'critical')).toBe(true);
  });

  it('email with an escaped body and no server line', () => {
    expect(emailSubject(event, NOTICE_SERVER)).toBe('Access request from Dana');
    const { text, html } = emailBody(event, NOTICE_SERVER, NOW);
    expect(text).toContain('Duration: 2h');
    expect(text).not.toContain('Server:');
    expect(html).toContain('deploy &lt;hotfix&gt;');
  });

  it('post a notice payload to webhooks', () => {
    const body = getAdapter('webhook').build('https://example.com/hook', event, NOTICE_SERVER, NOW)
      .body as NoticeWebhookPayload;
    expect(body).toEqual({
      event: 'access_request.created',
      title: 'Access request from Dana',
      message: event.message,
      details: { Servers: 'web-01', Duration: '2h' },
      sentAt: NOW,
    });
  });

  it('render in chat channels without mentioning a server', () => {
    const slack = getAdapter('slack').build('https://hooks.slack.com/x', event, NOTICE_SERVER, NOW).body as {
      text: string;
    };
    expect(slack.text).toContain(event.message);
    const discord = getAdapter('discord').build('https://discord.com/x', event, NOTICE_SERVER, NOW).body as {
      embeds: { title: string; description: string }[];
    };
    expect(discord.embeds[0]).toMatchObject({ title: 'Access request from Dana', description: 'Servers: web-01\nDuration: 2h' });
  });
});
