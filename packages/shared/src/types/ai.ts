export type AIProviderType = 'openai' | 'anthropic' | 'openai_compatible';

export interface AIProviderConfig {
  id: string;
  orgId: string;
  name: string;
  provider: AIProviderType;
  baseUrl?: string;
  model: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** apiKey is never returned to the client */
}

export interface CreateAIProviderRequest {
  name: string;
  provider: AIProviderType;
  baseUrl?: string;
  model: string;
  apiKey: string;
  isDefault?: boolean;
}

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Unified tool definition compatible with OpenAI and Anthropic */
export interface AITool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

/** Events emitted by the AI agent SSE stream */
export type AIAgentEvent =
  | { type: 'delta'; content: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface AIChatRequest {
  messages: AIMessage[];
  /** Optional context injected as a system message */
  context?: {
    serverId?: string;
    lastOutput?: string;
    serverInfo?: string;
  };
  providerId?: string;
  /** Active SSH session ID — enables run_command tool on that session */
  sessionId?: string;
  /** Set false to disable agent/tool-call mode and use simple streaming chat */
  agentMode?: boolean;
}

export interface AIChatChunk {
  type: 'delta' | 'done' | 'error' | 'tool_call' | 'tool_result';
  content?: string;
  error?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}

/** Returned by the /api/ai/context endpoint */
export interface AIAppContext {
  servers: Array<{
    id: string;
    name: string;
    host: string;
    username: string;
    port: number;
    tags: string[];
  }>;
  commands: Array<{ id: string; name: string; command: string; serverId: string | null }>;
  cronJobs: Array<{ id: string; name: string; schedule: string; enabled: boolean }>;
}
