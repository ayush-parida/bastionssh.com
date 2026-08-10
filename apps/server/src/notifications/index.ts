import { and, eq } from 'drizzle-orm';
import type { AlertSeverity, NotificationChannelType } from '@smt/shared';
import { getDb } from '../db/index.js';
import { notificationChannels, servers } from '../db/schema.js';
import { vault } from '../vault/index.js';
import logger from '../logger.js';
import { buildPayload, maskUrl, passesSeverityFilter, type AlertEvent, type ServerRef } from './format.js';

export { maskUrl, type AlertEvent } from './format.js';

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;

type ChannelRow = typeof notificationChannels.$inferSelect;

export class InvalidWebhookUrlError extends Error {}

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

/**
 * POST the payload, retrying once on a network error or 5xx. A 4xx is final —
 * a deleted Slack hook will not start working on the second try.
 */
async function post(url: string, body: unknown): Promise<void> {
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.ok) return;

      lastError = `HTTP ${res.status}`;
      if (res.status < 500) throw new Error(lastError);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // A 4xx was rethrown above and should not be retried
      if (lastError.startsWith('HTTP 4')) throw new Error(lastError);
    }

    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  throw new Error(lastError || 'Delivery failed');
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
    const url = await vault.decrypt(channel.encryptedUrl, channel.id);
    const payload = buildPayload(
      channel.type as NotificationChannelType,
      event,
      server,
      new Date().toISOString(),
    );
    await post(url, payload);
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
