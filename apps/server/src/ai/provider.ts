import type { AIMessage, AITool, AIAgentEvent } from '@smt/shared';

export interface AIProvider {
  chat(messages: AIMessage[], opts?: { temperature?: number }): AsyncIterable<string>;
  /**
   * Run a full agent turn with tool calling.
   * Each provider handles its own native message format.
   * Emits AIAgentEvent items via an async generator.
   */
  agentLoop?(
    messages: AIMessage[],
    tools: AITool[],
    executeToolFn: (name: string, input: Record<string, unknown>) => Promise<string>,
    opts?: { maxTurns?: number },
  ): AsyncGenerator<AIAgentEvent>;
}
