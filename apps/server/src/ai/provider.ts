import type { AIMessage } from '@smt/shared';

export interface AIProvider {
  chat(messages: AIMessage[], opts?: { temperature?: number }): AsyncIterable<string>;
}
