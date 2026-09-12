import type { NotificationChannelType } from '@smt/shared';
import type { ChannelAdapter } from './types.js';
import { webhook } from './webhook.js';
import { slack } from './slack.js';
import { discord } from './discord.js';
import { email } from './email.js';

export * from './types.js';

const ADAPTERS: Partial<Record<NotificationChannelType, ChannelAdapter>> = {
  webhook,
  slack,
  discord,
  email,
};

export function getAdapter(type: NotificationChannelType): ChannelAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`No adapter for channel type "${type}"`);
  return adapter;
}

export function hasAdapter(type: string): type is NotificationChannelType {
  return type in ADAPTERS;
}
