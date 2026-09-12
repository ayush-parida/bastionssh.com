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
