import { eventLabel, summarize } from '../format.js';
import { tone, urlTarget, type ChannelAdapter } from './types.js';

const COLOR = { critical: 0xef4444, warning: 0xf59e0b, resolved: 0x22c55e, test: 0x3b82f6 } as const;

export const discord: ChannelAdapter = {
  type: 'discord',
  prepare: (input) => urlTarget(input),
  build(target, event, server) {
    const embedTitle = event.notice
      ? event.notice.title
      : event.kind === 'test'
        ? 'Test notification'
        : `${event.kind === 'resolved' ? 'Resolved: ' : ''}${eventLabel(event)}`;
    const description = event.notice
      ? event.notice.details.map(([k, v]) => `${k}: ${v}`).join('\n')
      : `${server.name} (${server.host})` + (event.kind === 'opened' ? `\n${event.message}` : '');
    return {
      url: target,
      body: {
        content: summarize(event, server),
        // Never ping: notices carry member-typed text
        allowed_mentions: { parse: [] },
        embeds: [{ title: embedTitle, description, color: COLOR[tone(event)] }],
      },
    };
  },
};
