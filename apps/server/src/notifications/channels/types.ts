import type { NotificationChannelType, OpsgenieRegion } from '@smt/shared';
import { alertLabel, maskUrl, type AlertEvent, type ServerRef } from '../format.js';

/** Bad channel input the caller can fix — maps to a 400. */
export class ChannelInputError extends Error {}
export class InvalidWebhookUrlError extends ChannelInputError {}

/** What the route hands an adapter after zod has checked shapes. */
export interface ChannelInput {
  url?: string;
  recipients?: string[];
  token?: string;
  chatId?: string;
  userKey?: string;
  routingKey?: string;
  region?: OpsgenieRegion;
}

/** One outbound HTTP call. `followUp` is sent only after this one succeeds. */
export interface OutboundRequest {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  followUp?: OutboundRequest;
}

/**
 * Everything one channel type knows: how to turn form input into the single
 * vaulted target string (plus a display hint), and how to turn an event into
 * the request that delivers it.
 */
export interface ChannelAdapter {
  type: NotificationChannelType;
  prepare(input: ChannelInput): { target: string; hint: string };
  build(target: string, event: AlertEvent, server: ServerRef, sentAt: string): OutboundRequest;
}

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

export function requireUrl(input: ChannelInput, what = 'A webhook URL'): string {
  if (!input.url) throw new ChannelInputError(`${what} is required`);
  assertSafeUrl(input.url);
  return input.url;
}

/** `prepare()` for every plain URL channel: vault the URL, show it masked. */
export function urlTarget(input: ChannelInput, what?: string): { target: string; hint: string } {
  const url = requireUrl(input, what);
  return { target: url, hint: maskUrl(url) };
}

/** `[CRITICAL] CPU high on web-01` / `Resolved: CPU high on web-01` / `Test notification`. */
export function title(event: AlertEvent, server: ServerRef): string {
  if (event.kind === 'test') return 'Test notification';
  if (event.kind === 'resolved') return `Resolved: ${alertLabel(event.type)} on ${server.name}`;
  return `[${event.severity.toUpperCase()}] ${alertLabel(event.type)} on ${server.name}`;
}

/** Stable per-alert key so paging tools resolve the incident they opened. */
export function dedupKey(event: AlertEvent, sentAt: string): string {
  if (event.kind === 'test') return `smt:test:${sentAt}`;
  return `smt:${event.serverId}:${event.type}`;
}

/** Three-way tone every adapter maps onto its own colour / priority scale. */
export type Tone = 'critical' | 'warning' | 'resolved' | 'test';

export function tone(event: AlertEvent): Tone {
  if (event.kind === 'resolved') return 'resolved';
  if (event.kind === 'test') return 'test';
  return event.severity;
}

/** Key/value lines shared by the richer payloads. */
export function facts(event: AlertEvent, server: ServerRef, sentAt: string): [string, string][] {
  const out: [string, string][] = [['Server', `${server.name} (${server.host})`]];
  if (event.kind !== 'test') {
    out.push(['Alert', alertLabel(event.type)], ['Severity', event.severity]);
  }
  if (event.value !== undefined) out.push(['Value', String(event.value)]);
  if (event.threshold !== undefined) out.push(['Threshold', String(event.threshold)]);
  if (event.openedAt) out.push(['Opened', event.openedAt]);
  out.push(['Sent', sentAt]);
  return out;
}

export function lastFour(secret: string): string {
  return `…${secret.slice(-4)}`;
}
