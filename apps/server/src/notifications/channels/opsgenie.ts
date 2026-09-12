import { summarize } from '../format.js';
import {
  ChannelInputError,
  dedupKey,
  facts,
  lastFour,
  title,
  type ChannelAdapter,
  type OutboundRequest,
} from './types.js';

const HOST = { us: 'https://api.opsgenie.com', eu: 'https://api.eu.opsgenie.com' } as const;
const PRIORITY = { critical: 'P2', warning: 'P3' } as const;

/** Alerts API: create with an alias on open, close by alias on resolve. */
export const opsgenie: ChannelAdapter = {
  type: 'opsgenie',
  prepare(input) {
    const key = input.routingKey?.trim();
    if (!key) throw new ChannelInputError('Opsgenie needs an API integration key');
    if (key.length < 20) throw new ChannelInputError('That does not look like an Opsgenie API key');
    const region = input.region ?? 'us';
    return { target: `${region}:${key}`, hint: `${region} ${lastFour(key)}` };
  },
  build(target, event, server, sentAt) {
    const sep = target.indexOf(':');
    const region = (sep === -1 ? 'us' : target.slice(0, sep)) as keyof typeof HOST;
    const key = sep === -1 ? target : target.slice(sep + 1);
    const base = HOST[region] ?? HOST.us;
    const headers = { Authorization: `GenieKey ${key}` };
    const alias = dedupKey(event, sentAt);

    const close: OutboundRequest = {
      url: `${base}/v2/alerts/${encodeURIComponent(alias)}/close?identifierType=alias`,
      headers,
      body: { source: 'BastionSSH', note: summarize(event, server) },
    };
    if (event.kind === 'resolved') return close;

    const create: OutboundRequest = {
      url: `${base}/v2/alerts`,
      headers,
      body: {
        message: title(event, server),
        alias,
        description: summarize(event, server),
        source: server.host,
        priority: event.kind === 'test' ? 'P5' : PRIORITY[event.severity],
        tags: ['bastionssh', event.type],
        details: Object.fromEntries(facts(event, server, sentAt)),
      },
    };
    return event.kind === 'test' ? { ...create, followUp: close } : create;
  },
};
