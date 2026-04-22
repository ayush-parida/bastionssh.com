import Anthropic from '@anthropic-ai/sdk';
import type { AIMessage } from '@smt/shared';
import type { AIProvider } from './provider.js';

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async *chat(messages: AIMessage[]): AsyncIterable<string> {
    const system = messages.find((m) => m.role === 'system')?.content;
    const filtered = messages.filter((m) => m.role !== 'system') as Anthropic.MessageParam[];

    const stream = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: filtered,
      stream: true,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }
}
