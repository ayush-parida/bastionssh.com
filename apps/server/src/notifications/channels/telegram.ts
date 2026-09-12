import { summarize } from '../format.js';
import { ChannelInputError, facts, title, type ChannelAdapter } from './types.js';

const TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const CHAT_ID = /^(-?\d+|@[A-Za-z0-9_]{5,})$/;

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

/**
 * Bot token and chat id are packed into one sendMessage URL so a single
 * vaulted string carries both; `build` unpacks the chat id into the body.
 */
export const telegram: ChannelAdapter = {
  type: 'telegram',
  prepare(input) {
    const token = input.token?.trim();
    const chatId = input.chatId?.trim();
    if (!token || !chatId) {
      throw new ChannelInputError('Telegram needs both a bot token and a chat id');
    }
    if (!TOKEN.test(token)) throw new ChannelInputError('That does not look like a Telegram bot token');
    if (!CHAT_ID.test(chatId)) {
      throw new ChannelInputError('Chat id must be numeric (negative for groups) or an @channel name');
    }
    return {
      target: `https://api.telegram.org/bot${token}/sendMessage?chat_id=${encodeURIComponent(chatId)}`,
      hint: `chat ${chatId}`,
    };
  },
  build(target, event, server, sentAt) {
    const url = new URL(target);
    const chatId = url.searchParams.get('chat_id') ?? '';
    url.search = '';
    const lines = [
      `<b>${escapeHtml(title(event, server))}</b>`,
      escapeHtml(summarize(event, server)),
      '',
      ...facts(event, server, sentAt).map(([k, v]) => `${escapeHtml(k)}: <code>${escapeHtml(v)}</code>`),
    ];
    return {
      url: url.toString(),
      body: {
        chat_id: chatId,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
    };
  },
};
