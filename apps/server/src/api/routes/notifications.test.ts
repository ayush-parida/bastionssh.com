import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// SMTP availability is flipped per test; nothing here opens a socket.
const email = vi.hoisted(() => ({ available: false, sendEmail: vi.fn(async (_msg: unknown) => {}) }));
vi.mock('../../notifications/email.js', () => ({
  emailAvailable: () => email.available,
  sendEmail: email.sendEmail,
  resetTransport: () => {},
}));

import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { seedOrg, seedUser } from './test-utils.js';

describe('notification channel routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let emailChannelId: string;

  beforeAll(async () => {
    await runMigrations();
    const orgId = seedOrg('org-notify');
    admin = seedUser(orgId, 'admin');
    viewer = seedUser(orgId, 'viewer');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports whether email is available', async () => {
    email.available = false;
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications/capabilities',
      headers: viewer.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: false });
  });

  it('creates a discord channel and masks the hook token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: admin.headers,
      payload: { name: 'ops', type: 'discord', url: 'https://discord.com/api/webhooks/1/abcSECRET' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe('discord');
    expect(body.targetHint).toBe('discord.com/api/webhooks/1/…');
    expect(JSON.stringify(body)).not.toContain('abcSECRET');
  });

  it('refuses an email channel when SMTP is not configured', async () => {
    email.available = false;
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: admin.headers,
      payload: { name: 'mail', type: 'email', recipients: ['a@x.com'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('SMTP');
  });

  it('creates an email channel when SMTP is configured', async () => {
    email.available = true;
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: admin.headers,
      payload: { name: 'mail', type: 'email', recipients: ['a@x.com', 'b@x.com'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    emailChannelId = body.id;
    expect(body.type).toBe('email');
    expect(body.targetHint).toBe('a@x.com +1');
  });

  it('validates the field that matches the channel type', async () => {
    email.available = true;
    const cases = [
      { name: 'x', type: 'email' },
      { name: 'x', type: 'email', recipients: ['not-an-email'] },
      { name: 'x', type: 'slack' },
      { name: 'x', type: 'slack', recipients: ['a@x.com'] },
    ];
    for (const payload of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifications/channels',
        headers: admin.headers,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('updates recipients and resets the delivery status', async () => {
    email.available = true;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/channels/${emailChannelId}`,
      headers: admin.headers,
      payload: { recipients: ['c@x.com'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().targetHint).toBe('c@x.com');
    expect(res.json().lastStatus).toBeNull();
  });

  it('sends a test email to the stored recipients', async () => {
    email.available = true;
    email.sendEmail.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notifications/channels/${emailChannelId}/test`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    const msg = email.sendEmail.mock.calls[0]![0] as { to: string[]; subject: string };
    expect(msg.to).toEqual(['c@x.com']);
    expect(msg.subject).toBe('Test notification from Server Manager');
  });

  it('creates the new channel types from their own fields', async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/notifications/channels', headers: admin.headers, payload });

    const telegram = await post({ name: 't', type: 'telegram', token: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ12345', chatId: '-100' });
    expect(telegram.statusCode).toBe(201);
    expect(telegram.json().targetHint).toBe('chat -100');
    expect(JSON.stringify(telegram.json())).not.toContain('ABCdef');

    const halfTelegram = await post({ name: 't', type: 'telegram', token: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ12345' });
    expect(halfTelegram.statusCode).toBe(400);
    expect(halfTelegram.json().error).toContain('both');

    const pd = await post({ name: 'pd', type: 'pagerduty', routingKey: 'R0123456789abcdef0123456789abcdef' });
    expect(pd.statusCode).toBe(201);
    expect(pd.json().targetHint).toBe('…cdef');

    const og = await post({ name: 'og', type: 'opsgenie', routingKey: '01234567-89ab-cdef-0123-456789abcdef', region: 'eu' });
    expect(og.statusCode).toBe(201);
    expect(og.json().targetHint).toBe('eu …cdef');

    const ntfy = await post({ name: 'n', type: 'ntfy', url: 'https://user:secretpw@ntfy.example.com/alerts' });
    expect(ntfy.statusCode).toBe(201);
    expect(ntfy.json().targetHint).toBe('ntfy.example.com/alerts');
    expect(JSON.stringify(ntfy.json())).not.toContain('secretpw');

    const push = await post({ name: 'p', type: 'pushover', token: 'a'.repeat(30), userKey: 'b'.repeat(30) });
    expect(push.statusCode).toBe(201);

    const wrongField = await post({ name: 'x', type: 'teams', routingKey: 'R0123456789abcdef0123456789abcdef' });
    expect(wrongField.statusCode).toBe(400);
    expect(wrongField.json().error).toContain('does not apply');
  });

  it('sends a paging test as trigger then resolve', async () => {
    const calls: { url: string; body: { event_action: string; dedup_key: string } }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response('{"status":"success"}', { status: 202 });
    }) as typeof fetch;
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/notifications/channels',
        headers: admin.headers,
        payload: { name: 'pd2', type: 'pagerduty', routingKey: 'R0123456789abcdef0123456789abcdef' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/notifications/channels/${created.json().id}/test`,
        headers: admin.headers,
      });
      expect(res.json()).toEqual({ ok: true });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://events.pagerduty.com/v2/enqueue');
    expect(calls[0]!.body.event_action).toBe('trigger');
    expect(calls[1]!.body.event_action).toBe('resolve');
    expect(calls[1]!.body.dedup_key).toBe(calls[0]!.body.dedup_key);
  });

  it('refuses a viewer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: viewer.headers,
      payload: { name: 'x', type: 'discord', url: 'https://discord.com/api/webhooks/1/a' },
    });
    expect(res.statusCode).toBe(403);
  });
});
