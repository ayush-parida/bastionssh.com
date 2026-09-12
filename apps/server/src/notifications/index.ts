import { and, eq } from 'drizzle-orm';
import type { AlertSeverity, NotificationChannelType } from '@smt/shared';
import { getDb } from '../db/index.js';
import { notificationChannels, servers } from '../db/schema.js';
import { vault } from '../vault/index.js';
import logger from '../logger.js';
import {
  buildPayload,
  emailBody,
  emailSubject,
  maskUrl,
  parseRecipients,
  passesSeverityFilter,
  type AlertEvent,
  type ServerRef,
} from './format.js';
import { emailAvailable, sendEmail } from './email.js';

export { describeRecipients, maskUrl, type AlertEvent } from './format.js';
export { emailAvailable } from './email.js';

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;

type ChannelRow = typeof notificationChannels.$inferSelect;

/** Bad channel input the caller can fix — maps to a 400. */
export class ChannelInputError extends Error {}
export class InvalidWebhookUrlError extends ChannelInputError {}

/**
 * Reject URLs we should never POST to. This is a guard against an obvious
 * mistake, not a complete SSRF defence: a hostname that resolves to a private
 * address still passes, since only a literal match is checked here.
 */
export function assertSafeUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidWebhookUrlError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidWebhookUrlError('Webhook URL must use http or https');
  }
  // The cloud instance-metadata address — never a legitimate webhook target
  if (url.hostname === '169.254.169.254' || url.hostname === 'metadata.google.internal') {
    throw new InvalidWebhookUrlError('That address is not allowed');
  }
}

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
 * POST the payload, retrying once on a network error or 5xx. A 4xx is final —
 * a deleted Slack hook will not start working on the second try.
 */
function post(url: string, body: unknown): Promise<void> {
  return withRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return;
    if (res.status < 500) throw new FinalDeliveryError(`HTTP ${res.status}`);
    throw new Error(`HTTP ${res.status}`);
  });
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
      await post(target, buildPayload(channel.type as NotificationChannelType, event, server, sentAt));
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
