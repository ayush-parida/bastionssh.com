import { summarize } from '../format.js';
import { ChannelInputError, lastFour, title, tone, type ChannelAdapter } from './types.js';

const API = 'https://api.pushover.net/1/messages.json';
const KEY = /^[A-Za-z0-9]{30}$/;
const PRIORITY = { critical: 1, warning: 0, resolved: -1, test: -1 } as const;

export const pushover: ChannelAdapter = {
  type: 'pushover',
  prepare(input) {
    const token = input.token?.trim();
    const user = input.userKey?.trim();
    if (!token || !user) throw new ChannelInputError('Pushover needs both an application token and a user key');
    if (!KEY.test(token) || !KEY.test(user)) {
      throw new ChannelInputError('Pushover tokens and user keys are 30 alphanumeric characters');
    }
    const target = new URL(API);
    target.searchParams.set('token', token);
    target.searchParams.set('user', user);
    return { target: target.toString(), hint: `user ${lastFour(user)}` };
  },
  build(target, event, server) {
    const url = new URL(target);
    return {
      url: API,
      body: {
        token: url.searchParams.get('token'),
        user: url.searchParams.get('user'),
        title: title(event, server),
        message: summarize(event, server),
        priority: PRIORITY[tone(event)],
      },
    };
  },
};
