import { and, eq } from 'drizzle-orm';
import type { AlertSeverity, NotificationChannelType } from '@smt/shared';
import { getDb } from '../db/index.js';
import { notificationChannels, servers } from '../db/schema.js';
import { vault } from '../vault/index.js';
import logger from '../logger.js';
import {
  emailBody,
  emailSubject,
  maskUrl,
  parseRecipients,
  passesSeverityFilter,
  type AlertEvent,
  type ServerRef,
} from './format.js';
import { emailAvailable, sendEmail } from './email.js';
import { getAdapter, type OutboundRequest } from './channels/index.js';

export { describeRecipients, maskUrl, type AlertEvent } from './format.js';
export { emailAvailable } from './email.js';
export {
  assertSafeUrl,
  ChannelInputError,
  InvalidWebhookUrlError,
  getAdapter,
  type ChannelInput,
} from './channels/index.js';

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;

type ChannelRow = typeof notificationChannels.$inferSelect;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FinalDeliveryError extends Error {}

/**
 * Run `fn`, retrying once after a short pause. A `FinalDeliveryError` is not
 * retried — the caller already knows the second attempt cannot succeed.
 */
async function withRetry(fn: () => Promise<void>): Promise<void> {
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (err instanceof FinalDeliveryError) throw new Error(err.message);
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  throw new Error(lastError || 'Delivery failed');
}

/**
 * `fetch` refuses URLs with embedded credentials, so `https://user:pass@host/…`
 * is split into a clean URL and an HTTP Basic header. This is how ntfy, Gotify
 * behind a proxy, and many internal webhooks are protected.
 */
export function splitBasicAuth(raw: string): { url: string; headers: Record<string, string> } {
  const url = new URL(raw);
  if (!url.username && !url.password) return { url: raw, headers: {} };
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  return {
    url: url.toString(),
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` },
  };
}

/**
 * POST one request, retrying once on a network error or 5xx. A 4xx is final —
 * a deleted Slack hook will not start working on the second try. A follow-up
 * (paging tools resolving their own test incident) goes out only after the
 * first request succeeded.
 */
async function sendRequest(req: OutboundRequest): Promise<void> {
  const { url, headers: authHeaders } = splitBasicAuth(req.url);
  await withRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders, ...req.headers },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return;
    if (res.status < 500) throw new FinalDeliveryError(`HTTP ${res.status}`);
    throw new Error(`HTTP ${res.status}`);
  });
  if (req.followUp) await sendRequest(req.followUp);
}

/** Deliver an email alert; the recipient list is what the channel has vaulted. */
function mail(recipients: string, event: AlertEvent, server: ServerRef, sentAt: string): Promise<void> {
  if (!emailAvailable()) {
    return Promise.reject(new Error('Email delivery is not configured on this instance'));
  }
  const { text, html } = emailBody(event, server, sentAt);
  return withRetry(() =>
    sendEmail({ to: parseRecipients(recipients), subject: emailSubject(event, server), text, html }),
  );
}

function recordResult(channelId: string, error: string | null): void {
  try {
    getDb()
      .update(notificationChannels)
      .set({
        lastStatus: error ? 'failed' : 'ok',
        lastError: error?.slice(0, 300) ?? null,
        lastSentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(notificationChannels.id, channelId))
      .run();
  } catch (err) {
    logger.warn({ err, channelId }, 'Could not record notification delivery result');
  }
}

/** Deliver one event to one channel. Resolves either way — never throws. */
async function deliver(channel: ChannelRow, event: AlertEvent, server: ServerRef): Promise<boolean> {
  try {
    // For webhook-style channels this is the URL; for email it is the recipient list.
    const target = await vault.decrypt(channel.encryptedUrl, channel.id);
    const sentAt = new Date().toISOString();
    if (channel.type === 'email') {
      await mail(target, event, server, sentAt);
    } else {
      const adapter = getAdapter(channel.type as NotificationChannelType);
      await sendRequest(adapter.build(target, event, server, sentAt));
    }
    recordResult(channel.id, null);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordResult(channel.id, message);
    logger.warn(
      { channelId: channel.id, channel: channel.name, err: message },
      'Alert notification delivery failed',
    );
    return false;
  }
}

function serverRef(serverId: string): ServerRef | null {
  const row = getDb()
    .select({ id: servers.id, name: servers.name, host: servers.host })
    .from(servers)
    .where(eq(servers.id, serverId))
    .get();
  return row ?? null;
}

function enabledChannels(orgId: string): ChannelRow[] {
  return getDb()
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.orgId, orgId), eq(notificationChannels.enabled, true)))
    .all();
}

/** Fan one batch of events out to every channel that wants them. */
async function dispatch(events: AlertEvent[]): Promise<void> {
  const byOrg = new Map<string, AlertEvent[]>();
  for (const event of events) {
    const list = byOrg.get(event.orgId);
    if (list) list.push(event);
    else byOrg.set(event.orgId, [event]);
  }

  for (const [orgId, orgEvents] of byOrg) {
    const channels = enabledChannels(orgId);
    if (channels.length === 0) continue;

    const sends: Promise<boolean>[] = [];
    for (const event of orgEvents) {
      const server = serverRef(event.serverId);
      if (!server) continue;

      for (const channel of channels) {
        if (event.kind === 'resolved' && !channel.notifyOnResolve) continue;
        if (!passesSeverityFilter(event, channel.minSeverity as AlertSeverity)) continue;
        sends.push(deliver(channel, event, server));
      }
    }

    if (sends.length) {
      const results = await Promise.all(sends);
      logger.info(
        { orgId, sent: results.filter(Boolean).length, failed: results.filter((r) => !r).length },
        'Alert notifications dispatched',
      );
    }
  }
}

/**
 * Entry point for the health sweep. Deliberately fire-and-forget: a slow or
 * unreachable webhook must not stall the monitor or fail a health check.
 */
export function notifyAlertsChanged(events: AlertEvent[]): void {
  if (events.length === 0) return;
  void dispatch(events).catch((err) => {
    logger.error({ err }, 'Alert notification dispatch failed');
  });
}

/** Send a test message so an admin can confirm a channel works. */
export async function sendTestNotification(
  orgId: string,
  channelId: string,
): Promise<{ ok: boolean; error?: string }> {
  const channel = getDb()
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.orgId, orgId)))
    .get();
  if (!channel) return { ok: false, error: 'Channel not found' };

  const event: AlertEvent = {
    kind: 'test',
    orgId,
    serverId: 'test',
    type: 'test',
    severity: 'warning',
    message: 'Test notification',
  };
  const placeholder: ServerRef = { id: 'test', name: 'Server Manager', host: 'test' };

  const ok = await deliver(channel, event, placeholder);
  if (ok) return { ok: true };

  const refreshed = getDb()
    .select({ lastError: notificationChannels.lastError })
    .from(notificationChannels)
    .where(eq(notificationChannels.id, channelId))
    .get();
  return { ok: false, error: refreshed?.lastError ?? 'Delivery failed' };
}
