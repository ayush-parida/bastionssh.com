import { summarize } from '../format.js';
import { tone, urlTarget, type ChannelAdapter } from './types.js';

const MARK = { critical: '🚨', warning: '⚠️', resolved: '✅', test: '🔔' } as const;

/** Google Chat incoming webhooks take `{ text }`; shortcodes do not render, so unicode it is. */
export const googlechat: ChannelAdapter = {
  type: 'googlechat',
  prepare: (input) => urlTarget(input, 'A Google Chat webhook URL'),
  build(target, event, server) {
    const prefix = event.kind === 'opened' ? `*${event.severity.toUpperCase()}* ` : '';
    return { url: target, body: { text: `${MARK[tone(event)]} ${prefix}${summarize(event, server)}` } };
  },
};
