import type { AlertSeverity, AlertType } from './monitoring.js';

/**
 * Slack shares the incoming-webhook shape used by Mattermost and friends;
 * Discord, Teams and Google Chat have their own. Email needs SMTP configured
 * on the instance. PagerDuty and Opsgenie open and resolve incidents rather
 * than posting messages.
 */
export type NotificationChannelType =
  | 'webhook'
  | 'slack'
  | 'discord'
  | 'email'
  | 'teams'
  | 'googlechat'
  | 'telegram'
  | 'ntfy'
  | 'gotify'
  | 'pushover'
  | 'pagerduty'
  | 'opsgenie';

/** Input fields a channel type needs; the form renders exactly these. */
export type ChannelField = 'url' | 'recipients' | 'token' | 'chatId' | 'userKey' | 'routingKey' | 'region';

export type ChannelGroup = 'chat' | 'paging' | 'push' | 'other';

export type OpsgenieRegion = 'us' | 'eu';

export interface ChannelTypeMeta {
  type: NotificationChannelType;
  label: string;
  group: ChannelGroup;
  fields: ChannelField[];
  /** Where to get the credential, shown under the form. */
  help: string;
  urlPlaceholder?: string;
}

export const CHANNEL_TYPES: readonly ChannelTypeMeta[] = [
  {
    type: 'slack',
    label: 'Slack / Mattermost',
    group: 'chat',
    fields: ['url'],
    help: 'An incoming-webhook URL. Mattermost and Rocket.Chat incoming webhooks accept the same payload.',
    urlPlaceholder: 'https://hooks.slack.com/services/…',
  },
  {
    type: 'discord',
    label: 'Discord',
    group: 'chat',
    fields: ['url'],
    help: 'Channel settings → Integrations → Webhooks → New webhook.',
    urlPlaceholder: 'https://discord.com/api/webhooks/…',
  },
  {
    type: 'teams',
    label: 'Microsoft Teams',
    group: 'chat',
    fields: ['url'],
    help: 'A Workflows "post to a channel when a webhook request is received" URL (or a legacy incoming-webhook connector URL).',
    urlPlaceholder: 'https://prod-00.westus.logic.azure.com:443/workflows/…',
  },
  {
    type: 'googlechat',
    label: 'Google Chat',
    group: 'chat',
    fields: ['url'],
    help: 'Space → Apps & integrations → Webhooks.',
    urlPlaceholder: 'https://chat.googleapis.com/v1/spaces/…/messages?key=…',
  },
  {
    type: 'telegram',
    label: 'Telegram',
    group: 'chat',
    fields: ['token', 'chatId'],
    help: 'Create a bot with @BotFather for the token. The chat id is the group or channel id (negative for groups); add the bot to it first.',
  },
  {
    type: 'pagerduty',
    label: 'PagerDuty',
    group: 'paging',
    fields: ['routingKey'],
    help: 'Service → Integrations → Events API v2 → Integration key. Alerts open an incident and resolve it when the alert clears.',
  },
  {
    type: 'opsgenie',
    label: 'Opsgenie',
    group: 'paging',
    fields: ['routingKey', 'region'],
    help: 'Team → Integrations → API → API key. Alerts are created and closed by alias.',
  },
  {
    type: 'ntfy',
    label: 'ntfy',
    group: 'push',
    fields: ['url'],
    help: 'The topic URL, e.g. https://ntfy.sh/my-alerts. Put user:password@ before the host for a protected server.',
    urlPlaceholder: 'https://ntfy.sh/my-alerts',
  },
  {
    type: 'gotify',
    label: 'Gotify',
    group: 'push',
    fields: ['url'],
    help: 'Your server URL with an application token: https://gotify.example.com/message?token=…',
    urlPlaceholder: 'https://gotify.example.com/message?token=A…',
  },
  {
    type: 'pushover',
    label: 'Pushover',
    group: 'push',
    fields: ['token', 'userKey'],
    help: 'Create an application for the API token; the user key is on your Pushover dashboard.',
  },
  {
    type: 'email',
    label: 'Email',
    group: 'other',
    fields: ['recipients'],
    help: 'Up to 20 addresses. Sent from the address in SMT_SMTP_FROM.',
  },
  {
    type: 'webhook',
    label: 'Webhook (JSON POST)',
    group: 'other',
    fields: ['url'],
    help: 'Receives a structured JSON body you can route on. user:password@ in the URL becomes HTTP Basic auth.',
    urlPlaceholder: 'https://example.com/hooks/alerts',
  },
];

export const CHANNEL_TYPE_IDS = CHANNEL_TYPES.map((m) => m.type) as [
  NotificationChannelType,
  ...NotificationChannelType[],
];

export function channelMeta(type: NotificationChannelType): ChannelTypeMeta {
  return CHANNEL_TYPES.find((m) => m.type === type) ?? CHANNEL_TYPES[CHANNEL_TYPES.length - 1]!;
}

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
  /** URL-based channels (webhook, slack, discord, teams, googlechat, ntfy, gotify). */
  url?: string;
  /** Email: 1–20 addresses. */
  recipients?: string[];
  /** Telegram bot token / Pushover application token. */
  token?: string;
  /** Telegram. */
  chatId?: string;
  /** Pushover. */
  userKey?: string;
  /** PagerDuty integration key / Opsgenie API key. */
  routingKey?: string;
  /** Opsgenie. */
  region?: OpsgenieRegion;
  minSeverity?: AlertSeverity;
  notifyOnResolve?: boolean;
  enabled?: boolean;
}

export interface UpdateNotificationChannelRequest {
  name?: string;
  /** Omit every target field to keep the stored target. */
  url?: string;
  recipients?: string[];
  token?: string;
  chatId?: string;
  userKey?: string;
  routingKey?: string;
  region?: OpsgenieRegion;
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
