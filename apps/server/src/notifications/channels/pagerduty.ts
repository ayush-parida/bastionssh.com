import { summarize } from '../format.js';
import {
  ChannelInputError,
  dedupKey,
  facts,
  lastFour,
  type ChannelAdapter,
  type OutboundRequest,
} from './types.js';

const API = 'https://events.pagerduty.com/v2/enqueue';

/**
 * Events API v2. An alert opens an incident keyed on the server + alert type
 * and resolves the same key when it clears. A channel test triggers and then
 * immediately resolves, so the integration is proven without a lingering page.
 */
export const pagerduty: ChannelAdapter = {
  type: 'pagerduty',
  prepare(input) {
    const key = input.routingKey?.trim();
    if (!key) throw new ChannelInputError('PagerDuty needs an Events API v2 integration key');
    if (key.length < 20) throw new ChannelInputError('That does not look like a PagerDuty integration key');
    return { target: key, hint: lastFour(key) };
  },
  build(target, event, server, sentAt) {
    const key = dedupKey(event, sentAt);
    const resolve: OutboundRequest = {
      url: API,
      body: { routing_key: target, event_action: 'resolve', dedup_key: key },
    };
    if (event.kind === 'resolved') return resolve;

    const trigger: OutboundRequest = {
      url: API,
      body: {
        routing_key: target,
        event_action: 'trigger',
        dedup_key: key,
        payload: {
          summary: summarize(event, server),
          source: server.host,
          component: server.name,
          severity: event.kind === 'test' ? 'info' : event.severity,
          timestamp: sentAt,
          custom_details: Object.fromEntries(facts(event, server, sentAt)),
        },
      },
    };
    return event.kind === 'test' ? { ...trigger, followUp: resolve } : trigger;
  },
};
