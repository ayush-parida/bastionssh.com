import Anthropic from '@anthropic-ai/sdk';
import type { AIMessage, AITool, AIAgentEvent } from '@smt/shared';
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

  async *agentLoop(
    messages: AIMessage[],
    tools: AITool[],
    executeToolFn: (name: string, input: Record<string, unknown>) => Promise<string>,
    opts?: { maxTurns?: number },
  ): AsyncGenerator<AIAgentEvent> {
    const maxTurns = opts?.maxTurns ?? 6;

    const system = messages.find((m) => m.role === 'system')?.content;
    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    // Maintain Anthropic-native message history (no system role)
    const history: Anthropic.MessageParam[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system,
        messages: history,
        tools: anthropicTools,
        tool_choice: { type: 'auto' },
        stream: false,
      });

      // Emit text content
      const textContent = response.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as Anthropic.TextBlock).text)
        .join('');

      if (textContent) {
        yield { type: 'delta', content: textContent };
      }

      // Add assistant turn to history
      history.push({ role: 'assistant', content: response.content });

      const toolUseBlocks = response.content.filter(
        (c) => c.type === 'tool_use',
      ) as Anthropic.ToolUseBlock[];

      if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
        yield { type: 'done' };
        return;
      }

      // Execute tool calls
      const toolResultContent: Anthropic.ToolResultBlockParam[] = [];

      for (const tc of toolUseBlocks) {
        const input = tc.input as Record<string, unknown>;
        yield { type: 'tool_call', id: tc.id, name: tc.name, input };

        let output: string;
        let isError = false;
        try {
          output = await executeToolFn(tc.name, input);
        } catch (err) {
          output = err instanceof Error ? err.message : 'Tool execution failed';
          isError = true;
        }

        yield { type: 'tool_result', id: tc.id, name: tc.name, output, isError };
        toolResultContent.push({ type: 'tool_result', tool_use_id: tc.id, content: output });
      }

      // Add all tool results as a single user turn
      history.push({ role: 'user', content: toolResultContent });
    }

    yield { type: 'done' };
  }
}
