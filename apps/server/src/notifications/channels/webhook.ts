import type { AlertWebhookPayload, NoticeWebhookPayload } from '@smt/shared';
import { summarize } from '../format.js';
import { urlTarget, type ChannelAdapter } from './types.js';

/** Structured JSON a receiver can route on. */
export const webhook: ChannelAdapter = {
  type: 'webhook',
  prepare: (input) => urlTarget(input),
  build(target, event, server, sentAt) {
    if (event.notice) {
      const notice: NoticeWebhookPayload = {
        event: event.notice.event,
        title: event.notice.title,
        message: event.notice.message,
        details: Object.fromEntries(event.notice.details),
        sentAt,
      };
      return { url: target, body: notice };
    }
    const body: AlertWebhookPayload = {
      event: event.kind === 'test' ? 'test' : event.kind === 'resolved' ? 'alert.resolved' : 'alert.opened',
      alert: {
        type: event.type as AlertWebhookPayload['alert']['type'],
        severity: event.severity,
        message: event.kind === 'test' ? summarize(event, server) : event.message,
        ...(event.value !== undefined && { value: event.value }),
        ...(event.threshold !== undefined && { threshold: event.threshold }),
        ...(event.openedAt && { openedAt: event.openedAt }),
        ...(event.container && { container: event.container }),
      },
      server: { id: server.id, name: server.name, host: server.host },
      sentAt,
    };
    return { url: target, body };
  },
};
