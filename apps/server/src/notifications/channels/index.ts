import type { NotificationChannelType } from '@smt/shared';
import type { ChannelAdapter } from './types.js';
import { webhook } from './webhook.js';
import { slack } from './slack.js';
import { discord } from './discord.js';
import { email } from './email.js';
import { teams } from './teams.js';
import { googlechat } from './googlechat.js';
import { telegram } from './telegram.js';
import { ntfy } from './ntfy.js';
import { gotify } from './gotify.js';
import { pushover } from './pushover.js';
import { pagerduty } from './pagerduty.js';
import { opsgenie } from './opsgenie.js';

export * from './types.js';

const ADAPTERS: Record<NotificationChannelType, ChannelAdapter> = {
  webhook,
  slack,
  discord,
  email,
  teams,
  googlechat,
  telegram,
  ntfy,
  gotify,
  pushover,
  pagerduty,
  opsgenie,
};

export function getAdapter(type: NotificationChannelType): ChannelAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`No adapter for channel type "${type}"`);
  return adapter;
}

export function hasAdapter(type: string): type is NotificationChannelType {
  return type in ADAPTERS;
}
