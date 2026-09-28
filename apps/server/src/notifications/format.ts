import type { AlertSeverity, AlertType, NoticeEvent, NotificationChannelType } from '@smt/shared';
import { getAdapter } from './channels/index.js';

/**
 * Something that is not a server alert — an access request, say — delivered
 * through the same channels. Carried on an {@link AlertEvent} of kind `notice`.
 */
export interface Notice {
  event: NoticeEvent;
  title: string;
  message: string;
  details: [string, string][];
}

/** One thing worth telling someone about. Pure data — no DB rows, so it is testable. */
export interface AlertEvent {
  kind: 'opened' | 'resolved' | 'test' | 'notice';
  orgId: string;
  serverId: string;
  type: AlertType | 'test' | 'notice';
  severity: AlertSeverity;
  message: string;
  value?: number;
  threshold?: number;
  openedAt?: string;
  /** Present exactly when `kind` is `notice`. */
  notice?: Notice;
}

/** Wrap a notice so the channel adapters can carry it. It names no server. */
export function noticeEvent(orgId: string, notice: Notice): AlertEvent {
  return { kind: 'notice', orgId, serverId: '', type: 'notice', severity: 'warning', message: notice.message, notice };
}

/** Stands in for the server on a notice, which is about none. */
export const NOTICE_SERVER: ServerRef = { id: '', name: 'BastionSSH', host: '' };

export interface ServerRef {
  id: string;
  name: string;
  host: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { warning: 0, critical: 1 };

/**
 * A channel set to `critical` stays quiet for warnings. Resolutions always pass
 * the filter when the channel wants them — the open notice already went out, so
 * suppressing the all-clear would leave a false alarm standing.
 */
export function passesSeverityFilter(event: AlertEvent, minSeverity: AlertSeverity): boolean {
  // Notices are not alerts and have no severity of their own
  if (event.kind === 'resolved' || event.kind === 'notice') return true;
  return SEVERITY_RANK[event.severity] >= SEVERITY_RANK[minSeverity];
}

/** Human label for an alert type, e.g. `cpu_high` → "CPU high". */
export function alertLabel(type: AlertType | 'test' | 'notice'): string {
  const labels: Record<string, string> = {
    offline: 'Offline',
    cpu_high: 'CPU high',
    memory_high: 'Memory high',
    disk_high: 'Disk high',
    load_high: 'Load high',
    host_key_mismatch: 'SSH host key changed',
    test: 'Test notification',
    notice: 'Notice',
  };
  return labels[type] ?? type;
}

/**
 * Hide the secret in a webhook URL while keeping enough to tell two channels
 * apart. Slack and Mattermost both put the token in the final path segment.
 */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return url.host;
    const kept = segments.slice(0, -1);
    return `${url.host}/${[...kept, '…'].join('/')}`;
  } catch {
    return 'invalid URL';
  }
}

/** Plain-text summary shared by the Slack payload and log lines. */
export function summarize(event: AlertEvent, server: ServerRef): string {
  if (event.kind === 'notice') return event.message;
  if (event.kind === 'test') {
    return `Test notification from Server Manager — delivery to this channel is working.`;
  }
  if (event.kind === 'resolved') {
    return `Resolved: ${alertLabel(event.type)} on ${server.name} (${server.host})`;
  }
  return `${alertLabel(event.type)} on ${server.name} (${server.host}) — ${event.message}`;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return s.replace(/[&<>"']/g, (c) => map[c]!);
}

/** `[WARNING] CPU high on web-01` / `[Resolved] …` / a fixed line for tests. */
export function emailSubject(event: AlertEvent, server: ServerRef): string {
  if (event.notice) return event.notice.title;
  if (event.kind === 'test') return 'Test notification from Server Manager';
  const prefix = event.kind === 'resolved' ? '[Resolved]' : `[${event.severity.toUpperCase()}]`;
  return `${prefix} ${alertLabel(event.type)} on ${server.name}`;
}

/** Plain-text and HTML bodies with the same content; HTML is escaped, never templated. */
export function emailBody(
  event: AlertEvent,
  server: ServerRef,
  sentAt: string,
): { text: string; html: string } {
  const details = event.notice
    ? [...event.notice.details.map(([k, v]) => `${k}: ${v}`), `Sent: ${sentAt}`]
    : alertDetails(event, server, sentAt);
  const headline = summarize(event, server);
  const text = [headline, '', ...details].join('\n');
  const html =
    `<p><strong>${escapeHtml(headline)}</strong></p>` +
    `<pre style="font-family:monospace">${escapeHtml(details.join('\n'))}</pre>`;
  return { text, html };
}

function alertDetails(event: AlertEvent, server: ServerRef, sentAt: string): string[] {
  return [
    `Server: ${server.name} (${server.host})`,
    ...(event.kind !== 'test'
      ? [`Alert: ${alertLabel(event.type)}`, `Severity: ${event.severity}`]
      : []),
    ...(event.value !== undefined ? [`Value: ${event.value}`] : []),
    ...(event.threshold !== undefined ? [`Threshold: ${event.threshold}`] : []),
    ...(event.openedAt ? [`Opened: ${event.openedAt}`] : []),
    `Sent: ${sentAt}`,
  ];
}

/** `ops@example.com +2` — enough to tell two email channels apart in a list. */
export function describeRecipients(recipients: string[]): string {
  if (recipients.length === 0) return '';
  if (recipients.length === 1) return recipients[0]!;
  return `${recipients[0]} +${recipients.length - 1}`;
}

/** Recipients are vaulted as one comma-joined string, like a webhook URL. */
export function parseRecipients(stored: string): string[] {
  return stored
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the request body for an HTTP channel. Kept as a thin wrapper over the
 * channel adapters so callers (and older tests) have one simple entry point.
 */
export function buildPayload(
  type: NotificationChannelType,
  event: AlertEvent,
  server: ServerRef,
  sentAt: string,
): unknown {
  return getAdapter(type).build('https://example.invalid', event, server, sentAt).body;
}
