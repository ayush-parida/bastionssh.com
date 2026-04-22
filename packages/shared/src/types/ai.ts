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

export interface AIChatRequest {
  messages: AIMessage[];
  /** Optional context injected as a system message */
  context?: {
    serverId?: string;
    lastOutput?: string;
    serverInfo?: string;
  };
  providerId?: string;
}

export interface AIChatChunk {
  type: 'delta' | 'done' | 'error';
  content?: string;
  error?: string;
}
