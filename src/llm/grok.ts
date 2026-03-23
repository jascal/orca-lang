import { LLMProvider, LLMRequest, LLMResponse, LLMProviderConfig } from './provider.js';

export class GrokProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: LLMProviderConfig) {
    this.apiKey = config.api_key || process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
    this.baseUrl = config.base_url || 'https://api.x.ai/v1';
    this.model = config.model || 'grok-3';
    this.maxTokens = config.max_tokens || 4096;
    this.temperature = config.temperature ?? 0.7;

    if (!this.apiKey) {
      throw new Error('XAI_API_KEY or GROK_API_KEY is required for Grok provider');
    }
  }

  name(): string {
    return 'grok';
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
      throw new Error(`Grok API error: ${response.status} ${error}`);
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
