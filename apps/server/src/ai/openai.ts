import OpenAI from 'openai';
import type { AIMessage } from '@smt/shared';
import type { AIProvider } from './provider.js';

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl, timeout: 60_000, maxRetries: 0 });
    this.model = model;
  }

  async *chat(messages: AIMessage[]): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}
