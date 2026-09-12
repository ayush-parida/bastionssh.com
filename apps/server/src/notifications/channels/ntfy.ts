import { summarize } from '../format.js';
import { ChannelInputError, requireUrl, title, tone, type ChannelAdapter } from './types.js';

const PRIORITY = { critical: 5, warning: 4, resolved: 3, test: 3 } as const;
const TAGS = { critical: 'rotating_light', warning: 'warning', resolved: 'white_check_mark', test: 'bell' } as const;

/**
 * The stored target is the topic URL, credentials included when the server is
 * protected. Publishing goes to the server root as JSON with the topic in the
 * body; the dispatcher turns `user:pass@` into a Basic header.
 */
export const ntfy: ChannelAdapter = {
  type: 'ntfy',
  prepare(input) {
    const raw = requireUrl(input, 'An ntfy topic URL');
    const url = new URL(raw);
    const topic = url.pathname.split('/').filter(Boolean).pop();
    if (!topic) throw new ChannelInputError('The ntfy URL must end with the topic, e.g. https://ntfy.sh/my-alerts');
    return { target: raw, hint: `${url.host}/${topic}` };
  },
  build(target, event, server) {
    const url = new URL(target);
    const topic = url.pathname.split('/').filter(Boolean).pop()!;
    const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
    return {
      url: `${url.protocol}//${auth}${url.host}/`,
      body: {
        topic,
        title: title(event, server),
        message: summarize(event, server),
        priority: PRIORITY[tone(event)],
        tags: [TAGS[tone(event)]],
      },
    };
  },
};
