import { LLMProvider, LLMRequest, LLMResponse, LLMProviderConfig } from './provider.js';

export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: LLMProviderConfig) {
    this.apiKey = config.api_key || process.env.ANTHROPIC_API_KEY || '';
    this.baseUrl = config.base_url || 'https://api.anthropic.com';
    this.model = config.model || 'claude-sonnet-4-6';
    this.maxTokens = config.max_tokens || 4096;
    this.temperature = config.temperature ?? 0.7;

    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for Anthropic provider');
    }
  }

  name(): string {
    return 'anthropic';
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // Separate system message from user/assistant messages
    const systemMessage = request.messages.find(m => m.role === 'system');
    const otherMessages = request.messages.filter(m => m.role !== 'system');

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: request.model || this.model,
        system: systemMessage?.content,
        messages: otherMessages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
        max_tokens: request.max_tokens || this.maxTokens,
        temperature: request.temperature ?? this.temperature,
        stop_sequences: request.stop_sequences,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const textContent = data.content.find(c => c.type === 'text');
    return {
      content: textContent?.text || '',
      model: data.model,
      usage: {
        input_tokens: data.usage.input_tokens,
        output_tokens: data.usage.output_tokens,
      },
    };
  }

  async completeWithPrefix(request: LLMRequest, prefix: string): Promise<LLMResponse> {
    // Anthropic doesn't support continuation prefixes directly
    // We need to include the prefix in the system prompt and ask for completion
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
