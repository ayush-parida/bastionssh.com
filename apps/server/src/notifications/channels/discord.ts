import { alertLabel, summarize } from '../format.js';
import { tone, urlTarget, type ChannelAdapter } from './types.js';

const COLOR = { critical: 0xef4444, warning: 0xf59e0b, resolved: 0x22c55e, test: 0x3b82f6 } as const;

export const discord: ChannelAdapter = {
  type: 'discord',
  prepare: (input) => urlTarget(input),
  build(target, event, server) {
    const embedTitle =
      event.kind === 'test'
        ? 'Test notification'
        : `${event.kind === 'resolved' ? 'Resolved: ' : ''}${alertLabel(event.type)}`;
    const description =
      `${server.name} (${server.host})` + (event.kind === 'opened' ? `\n${event.message}` : '');
    return {
      url: target,
      body: {
        content: summarize(event, server),
        embeds: [{ title: embedTitle, description, color: COLOR[tone(event)] }],
      },
    };
  },
};
