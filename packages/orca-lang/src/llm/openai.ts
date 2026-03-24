import { LLMProvider, LLMRequest, LLMResponse, LLMProviderConfig } from './provider.js';

export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: LLMProviderConfig) {
    this.apiKey = config.api_key || process.env.OPENAI_API_KEY || '';
    this.baseUrl = config.base_url || 'https://api.openai.com/v1';
    this.model = config.model || 'gpt-4o';
    this.maxTokens = config.max_tokens || 4096;
    this.temperature = config.temperature ?? 0.7;

    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAI provider');
    }
  }

  name(): string {
    return 'openai';
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.model,
        messages: request.messages,
        max_tokens: request.max_tokens || this.maxTokens,
        temperature: request.temperature ?? this.temperature,
        stop: request.stop_sequences,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0]?.message?.content || '',
      model: data.model,
      usage: {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
      },
    };
  }

  async completeWithPrefix(request: LLMRequest, prefix: string): Promise<LLMResponse> {
    // OpenAI doesn't support continuation prefixes directly
    const modifiedRequest: LLMRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant' as const, content: prefix },
      ],
    };
    return this.complete(modifiedRequest);
  }
}
