export type LLMProviderType = 'anthropic' | 'openai' | 'ollama' | 'grok';

export type CodeGeneratorType = 'typescript' | 'python' | 'rust' | 'go';

export interface OrcaConfig {
  provider: LLMProviderType;
  model: string;
  api_key?: string;
  base_url?: string;
  code_generator: CodeGeneratorType;
  max_tokens?: number;
  temperature?: number;
}

export const DEFAULT_CONFIG: OrcaConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  code_generator: 'typescript',
  max_tokens: 4096,
  temperature: 0.7,
};
