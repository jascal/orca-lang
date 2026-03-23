export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  stop_sequences?: string[];
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface LLMProvider {
  name(): string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  completeWithPrefix?(request: LLMRequest, prefix: string): Promise<LLMResponse>;
}

export interface LLMProviderConfig {
  api_key?: string;
  base_url?: string;
  model: string;
  max_tokens?: number;
  temperature?: number;
}
