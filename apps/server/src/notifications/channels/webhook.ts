import type { AlertWebhookPayload } from '@smt/shared';
import { summarize } from '../format.js';
import { urlTarget, type ChannelAdapter } from './types.js';

/** Structured JSON a receiver can route on. */
export const webhook: ChannelAdapter = {
  type: 'webhook',
  prepare: (input) => urlTarget(input),
  build(target, event, server, sentAt) {
    const body: AlertWebhookPayload = {
      event: event.kind === 'test' ? 'test' : `alert.${event.kind}`,
      alert: {
        type: event.type,
        severity: event.severity,
        message: event.kind === 'test' ? summarize(event, server) : event.message,
        ...(event.value !== undefined && { value: event.value }),
        ...(event.threshold !== undefined && { threshold: event.threshold }),
        ...(event.openedAt && { openedAt: event.openedAt }),
      },
      server: { id: server.id, name: server.name, host: server.host },
      sentAt,
    };
    return { url: target, body };
  },
};
