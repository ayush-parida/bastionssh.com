import { summarize } from '../format.js';
import { tone, urlTarget, type ChannelAdapter } from './types.js';

const ICON = {
  critical: ':rotating_light:',
  warning: ':warning:',
  resolved: ':white_check_mark:',
  test: ':bell:',
} as const;

/** Slack incoming-webhook shape; Mattermost and Rocket.Chat accept it too. */
export const slack: ChannelAdapter = {
  type: 'slack',
  prepare: (input) => urlTarget(input),
  build(target, event, server) {
    const prefix = event.kind === 'opened' ? `[${event.severity.toUpperCase()}] ` : '';
    return { url: target, body: { text: `${ICON[tone(event)]} ${prefix}${summarize(event, server)}` } };
  },
};
