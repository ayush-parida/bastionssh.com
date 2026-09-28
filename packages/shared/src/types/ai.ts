import type { HostKeyStatus } from './host-key.js';

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
  /**
   * A command that may change the server is waiting for the user. Settle it with
   * `POST /api/ai/approvals/:id` ({ approved }); `id` is the tool call's id.
   */
  | {
      type: 'approval_required';
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Why the command was judged to make changes */
      reason: string;
      serverId?: string;
      serverName?: string;
      /** The SSH login the command will run as */
      sshUser?: string;
      /** The target's host key state; a mismatch means the command will be refused */
      hostKeyStatus?: HostKeyStatus;
    }
  /** The pending approval settled; `expired` is set when it timed out undecided */
  | { type: 'approval_resolved'; id: string; approved: boolean; expired?: boolean }
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
  type: AIAgentEvent['type'];
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
