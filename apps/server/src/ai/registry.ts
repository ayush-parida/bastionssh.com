import type { AIProvider } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

interface ProviderConfig {
  provider: 'openai' | 'anthropic' | 'openai_compatible';
  model: string;
  baseUrl?: string | null;
}

export function getAIProvider(config: ProviderConfig, apiKey: string): AIProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIProvider(apiKey, config.model);
    case 'openai_compatible':
      return new OpenAIProvider(apiKey, config.model, config.baseUrl ?? undefined);
    case 'anthropic':
      return new AnthropicProvider(apiKey, config.model);
    default:
      throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}
