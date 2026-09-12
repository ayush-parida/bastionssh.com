import { describeRecipients } from '../format.js';
import { emailAvailable } from '../email.js';
import { ChannelInputError, type ChannelAdapter } from './types.js';

/**
 * Email is delivered over SMTP, not HTTP, so only `prepare` lives here; the
 * dispatcher routes email channels to the mail path and never calls `build`.
 */
export const email: ChannelAdapter = {
  type: 'email',
  prepare(input) {
    if (!input.recipients?.length) {
      throw new ChannelInputError('Email channels need at least one recipient');
    }
    if (!emailAvailable()) {
      throw new ChannelInputError(
        'Email delivery is not configured on this instance (set SMT_SMTP_URL and SMT_SMTP_FROM)',
      );
    }
    return { target: input.recipients.join(','), hint: describeRecipients(input.recipients) };
  },
  build() {
    throw new Error('Email channels are delivered over SMTP, not HTTP');
  },
};
