import { LLMProvider, LLMRequest, LLMResponse, LLMProviderConfig } from './provider.js';

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;
  private temperature: number;

  constructor(config: LLMProviderConfig) {
    this.baseUrl = config.base_url || 'http://localhost:11434';
    this.model = config.model || 'llama3';
    this.temperature = config.temperature ?? 0.7;
  }

  name(): string {
    return 'ollama';
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model || this.model,
        messages: request.messages,
        options: {
          temperature: request.temperature ?? this.temperature,
          num_predict: request.max_tokens || 4096,
        },
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} ${error}`);
    }

    const data = await response.json() as {
      message: { content: string };
      model: string;
    };

    return {
      content: data.message.content,
      model: data.model,
    };
  }

  async completeWithPrefix(request: LLMRequest, prefix: string): Promise<LLMResponse> {
    // Ollama doesn't support continuation prefixes directly
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
