import { LLMProvider, LLMProviderConfig } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import { GrokProvider } from './grok.js';
import { LLMProviderType } from '../config/types.js';

export { LLMProvider, LLMMessage, LLMRequest, LLMResponse } from './provider.js';
export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export { OllamaProvider } from './ollama.js';
export { GrokProvider } from './grok.js';

export function createProvider(type: LLMProviderType, config: LLMProviderConfig): LLMProvider {
  switch (type) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'grok':
      return new GrokProvider(config);
    default:
      throw new Error(`Unknown LLM provider type: ${type}`);
  }
}
