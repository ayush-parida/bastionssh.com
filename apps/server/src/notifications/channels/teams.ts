import { summarize } from '../format.js';
import { facts, title, tone, urlTarget, type ChannelAdapter } from './types.js';

const COLOR = { critical: 'Attention', warning: 'Warning', resolved: 'Good', test: 'Accent' } as const;

/**
 * Adaptive Card wrapped in the `message` envelope. Accepted by Power Automate
 * "when a Teams webhook request is received" flows and by the legacy
 * Office 365 connector webhooks alike.
 */
export const teams: ChannelAdapter = {
  type: 'teams',
  prepare: (input) => urlTarget(input, 'A Teams workflow URL'),
  build(target, event, server, sentAt) {
    return {
      url: target,
      body: {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            contentUrl: null,
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              msteams: { width: 'Full' },
              body: [
                {
                  type: 'TextBlock',
                  size: 'Large',
                  weight: 'Bolder',
                  color: COLOR[tone(event)],
                  text: title(event, server),
                  wrap: true,
                },
                { type: 'TextBlock', text: summarize(event, server), wrap: true },
                {
                  type: 'FactSet',
                  facts: facts(event, server, sentAt).map(([t, v]) => ({ title: t, value: v })),
                },
              ],
            },
          },
        ],
      },
    };
  },
};
