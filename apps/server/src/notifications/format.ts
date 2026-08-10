import type {
  AlertSeverity,
  AlertType,
  AlertWebhookPayload,
  NotificationChannelType,
} from '@smt/shared';

/** One thing worth telling someone about. Pure data — no DB rows, so it is testable. */
export interface AlertEvent {
  kind: 'opened' | 'resolved' | 'test';
  orgId: string;
  serverId: string;
  type: AlertType | 'test';
  severity: AlertSeverity;
  message: string;
  value?: number;
  threshold?: number;
  openedAt?: string;
}

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
  if (event.kind === 'resolved') return true;
  return SEVERITY_RANK[event.severity] >= SEVERITY_RANK[minSeverity];
}

/** Human label for an alert type, e.g. `cpu_high` → "CPU high". */
export function alertLabel(type: AlertType | 'test'): string {
  const labels: Record<string, string> = {
    offline: 'Offline',
    cpu_high: 'CPU high',
    memory_high: 'Memory high',
    disk_high: 'Disk high',
    load_high: 'Load high',
    test: 'Test notification',
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
  if (event.kind === 'test') {
    return `Test notification from Server Manager — delivery to this channel is working.`;
  }
  if (event.kind === 'resolved') {
    return `Resolved: ${alertLabel(event.type)} on ${server.name} (${server.host})`;
  }
  return `${alertLabel(event.type)} on ${server.name} (${server.host}) — ${event.message}`;
}

function slackIcon(event: AlertEvent): string {
  if (event.kind === 'resolved') return ':white_check_mark:';
  if (event.kind === 'test') return ':bell:';
  return event.severity === 'critical' ? ':rotating_light:' : ':warning:';
}

/**
 * Build the request body for a channel. Slack gets its incoming-webhook shape;
 * a plain webhook gets structured JSON it can route on.
 */
export function buildPayload(
  type: NotificationChannelType,
  event: AlertEvent,
  server: ServerRef,
  sentAt: string,
): unknown {
  if (type === 'slack') {
    const prefix = event.kind === 'opened' ? `[${event.severity.toUpperCase()}] ` : '';
    return { text: `${slackIcon(event)} ${prefix}${summarize(event, server)}` };
  }

  const payload: AlertWebhookPayload = {
    event: event.kind === 'test' ? 'test' : `alert.${event.kind}`,
    alert: {
      type: event.type,
      severity: event.severity,
      message: event.kind === 'test' ? summarize(event, server) : event.message,
      ...(event.value !== undefined && { value: event.value }),
      ...(event.threshold !== undefined && { threshold: event.threshold }),
      ...(event.openedAt && { openedAt: event.openedAt }),
    },
    server: { id: server.id, name: server.name, host: server.host },
    sentAt,
  };
  return payload;
}
