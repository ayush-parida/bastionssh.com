import type { AlertSeverity, AlertType } from './monitoring.js';

/**
 * Slack shares the incoming-webhook shape used by Mattermost and friends;
 * Discord has its own. Email needs SMTP configured on the instance.
 */
export type NotificationChannelType = 'webhook' | 'slack' | 'discord' | 'email';

export type DeliveryStatus = 'ok' | 'failed';

export interface NotificationChannel {
  id: string;
  orgId: string;
  name: string;
  type: NotificationChannelType;
  /** Masked for display — the full URL is stored encrypted and never returned. */
  targetHint: string;
  enabled: boolean;
  /** 'warning' forwards everything; 'critical' only forwards critical alerts. */
  minSeverity: AlertSeverity;
  notifyOnResolve: boolean;
  lastStatus: DeliveryStatus | null;
  lastError: string | null;
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNotificationChannelRequest {
  name: string;
  type: NotificationChannelType;
  /** Required for webhook, slack and discord. */
  url?: string;
  /** Required for email: 1–20 addresses. */
  recipients?: string[];
  minSeverity?: AlertSeverity;
  notifyOnResolve?: boolean;
  enabled?: boolean;
}

export interface UpdateNotificationChannelRequest {
  name?: string;
  /** Omit to keep the stored URL. */
  url?: string;
  /** Email only. Omit to keep the stored recipients. */
  recipients?: string[];
  minSeverity?: AlertSeverity;
  notifyOnResolve?: boolean;
  enabled?: boolean;
}

export interface NotificationCapabilities {
  /** True when the instance has SMTP configured, so email channels can be created. */
  email: boolean;
}

export interface NotificationTestResult {
  ok: boolean;
  error?: string;
}

/** JSON body POSTed to a `webhook` channel. */
export interface AlertWebhookPayload {
  event: 'alert.opened' | 'alert.resolved' | 'test';
  alert: {
    type: AlertType | 'test';
    severity: AlertSeverity;
    message: string;
    value?: number;
    threshold?: number;
    openedAt?: string;
  };
  server: {
    id: string;
    name: string;
    host: string;
  };
  sentAt: string;
}
