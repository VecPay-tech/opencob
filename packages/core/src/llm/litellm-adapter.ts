import type {
  LlmAdapter,
  ChatMessage,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from './types.js';

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  completionModel: string;
  embeddingModel?: string;
  providerName?: string;
}

/** @deprecated Use OpenAICompatibleConfig */
export type LiteLLMConfig = OpenAICompatibleConfig;

const DEFAULT_CONFIG: OpenAICompatibleConfig = {
  baseUrl: 'http://127.0.0.1:4000',
  apiKey: '',
  chatModel: 'azure/gpt-5-mini-EU',
  completionModel: 'azure/gpt-5-nano-EU',
  embeddingModel: 'azure/text-embedding-3-large',
  providerName: 'openai-compatible',
};

/**
 * Provider presets for common LLM services.
 * All use the OpenAI-compatible chat/completions protocol.
 */
export const PROVIDER_PRESETS: Record<string, Partial<OpenAICompatibleConfig>> = {
  litellm: {
    baseUrl: 'http://127.0.0.1:4000',
    chatModel: 'azure/gpt-5-mini-EU',
    completionModel: 'azure/gpt-5-nano-EU',
    providerName: 'litellm',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    chatModel: 'gpt-4o',
    completionModel: 'gpt-4o-mini',
    providerName: 'openai',
  },
  azure: {
    baseUrl: 'https://YOUR_RESOURCE.openai.azure.com',
    chatModel: 'gpt-4o',
    completionModel: 'gpt-4o-mini',
    providerName: 'azure',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    chatModel: 'claude-sonnet-4-5-20250514',
    completionModel: 'claude-haiku-4-5-20250514',
    providerName: 'anthropic',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chatModel: 'gemini-2.5-flash',
    completionModel: 'gemini-2.5-flash',
    providerName: 'gemini',
  },
  'openai-compatible': {
    baseUrl: 'http://127.0.0.1:8000',
    chatModel: 'default',
    completionModel: 'default',
    providerName: 'openai-compatible',
  },
};

/**
 * Universal adapter for OpenAI-compatible APIs.
 * Works with: LiteLLM proxy, OpenAI, Azure OpenAI, Anthropic, Google Gemini,
 * and any endpoint that implements the /v1/chat/completions protocol.
 */
export class OpenAICompatibleAdapter implements LlmAdapter {
  readonly name: string;
  private config: OpenAICompatibleConfig;

  constructor(config?: Partial<OpenAICompatibleConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.name = this.config.providerName ?? 'openai-compatible';
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      h['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }

  async *chat(
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): AsyncIterable<StreamChunk> {
    const url = `${this.config.baseUrl}/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      yield { type: 'error', error: `${this.name} error: ${response.status} ${text}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'text', text: delta.content };
          }
          if (parsed.choices?.[0]?.finish_reason) {
            yield { type: 'done' };
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // LiteLLM/OpenAI doesn't have a native FIM endpoint like Ollama.
    // Use chat completions with a system prompt for fill-in-the-middle.
    const url = `${this.config.baseUrl}/v1/chat/completions`;

    let userContent: string;
    if (request.suffix) {
      userContent =
        `Complete the code between <prefix> and <suffix>. Return ONLY the code that goes in the middle, nothing else.\n\n` +
        `<prefix>${request.prompt}</prefix>\n<suffix>${request.suffix}</suffix>`;
    } else {
      userContent = `Continue the following code. Return ONLY the continuation, nothing else.\n\n${request.prompt}`;
    }

    const body: Record<string, unknown> = {
      model: this.config.completionModel,
      messages: [
        {
          role: 'system',
          content: 'You are a code completion assistant. Output only code, no explanations.',
        },
        { role: 'user', content: userContent },
      ],
      stream: false,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 256,
      stop: request.stop,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`${this.name} completion error: ${response.status}`);
    }

    const result = await response.json();
    const text = result.choices?.[0]?.message?.content ?? '';
    const finishReason = result.choices?.[0]?.finish_reason === 'stop' ? 'stop' : 'length';
    return { text, finishReason };
  }

  async listModels(): Promise<string[]> {
    const url = `${this.config.baseUrl}/v1/models`;
    try {
      const response = await fetch(url, { headers: this.headers });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.data ?? []).map((m: { id: string }) => m.id);
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/health`, {
        headers: this.headers,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  setChatModel(model: string): void {
    this.config.chatModel = model;
  }

  setCompletionModel(model: string): void {
    this.config.completionModel = model;
  }

  getChatModel(): string {
    return this.config.chatModel;
  }

  getCompletionModel(): string {
    return this.config.completionModel;
  }
}

/** @deprecated Use OpenAICompatibleAdapter */
export const LiteLLMAdapter = OpenAICompatibleAdapter;
