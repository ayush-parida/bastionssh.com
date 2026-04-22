import OpenAI from 'openai';
import type { AIMessage, AITool, AIAgentEvent } from '@smt/shared';
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

  async *agentLoop(
    messages: AIMessage[],
    tools: AITool[],
    executeToolFn: (name: string, input: Record<string, unknown>) => Promise<string>,
    opts?: { maxTurns?: number },
  ): AsyncGenerator<AIAgentEvent> {
    const maxTurns = opts?.maxTurns ?? 6;
    const oaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    // Maintain OpenAI-native message history
    const history: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }));

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: history,
        tools: oaiTools,
        tool_choice: 'auto',
        max_tokens: 4096,
        stream: false,
      });

      const msg = response.choices[0]?.message;
      if (!msg) break;

      // Emit text content
      if (msg.content) {
        yield { type: 'delta', content: msg.content };
      }

      // Push assistant turn to history
      history.push(msg);

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        yield { type: 'done' };
        return;
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          /* malformed args */
        }

        yield { type: 'tool_call', id: tc.id, name: tc.function.name, input };

        let output: string;
        let isError = false;
        try {
          output = await executeToolFn(tc.function.name, input);
        } catch (err) {
          output = err instanceof Error ? err.message : 'Tool execution failed';
          isError = true;
        }

        yield { type: 'tool_result', id: tc.id, name: tc.function.name, output, isError };

        // Add tool result in OpenAI format
        history.push({ role: 'tool', tool_call_id: tc.id, content: output });
      }
    }

    yield { type: 'done' };
  }
}
