import { summarize } from '../format.js';
import { ChannelInputError, requireUrl, title, tone, type ChannelAdapter } from './types.js';

const PRIORITY = { critical: 8, warning: 5, resolved: 2, test: 2 } as const;

export const gotify: ChannelAdapter = {
  type: 'gotify',
  prepare(input) {
    const raw = requireUrl(input, 'A Gotify message URL');
    const url = new URL(raw);
    if (!url.searchParams.get('token')) {
      throw new ChannelInputError('The Gotify URL needs an application token: https://host/message?token=…');
    }
    return { target: raw, hint: `${url.host}/message?token=…` };
  },
  build(target, event, server) {
    return {
      url: target,
      body: {
        title: title(event, server),
        message: summarize(event, server),
        priority: PRIORITY[tone(event)],
      },
    };
  },
};
