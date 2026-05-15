import type {
  LlmAdapter,
  ChatMessage,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from './types.js';

export interface OllamaConfig {
  baseUrl: string;
  chatModel: string;
  completionModel: string;
}

const DEFAULT_CONFIG: OllamaConfig = {
  baseUrl: 'http://127.0.0.1:11434',
  chatModel: 'qwen2.5-coder:7b',
  completionModel: 'qwen2.5-coder:1.5b',
};

export class OllamaAdapter implements LlmAdapter {
  readonly name = 'ollama';
  private config: OllamaConfig;

  constructor(config?: Partial<OllamaConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async *chat(
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number; tools?: unknown[] },
  ): AsyncIterable<StreamChunk> {
    const url = `${this.config.baseUrl}/api/chat`;
    const body = {
      model: this.config.chatModel,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? 4096,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      yield { type: 'error', error: `Ollama error: ${response.status} ${response.statusText}` };
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
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.done) {
            yield { type: 'done' };
          } else if (parsed.message?.content) {
            yield { type: 'text', text: parsed.message.content };
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.config.baseUrl}/api/generate`;

    // FIM: use prefix/suffix for fill-in-the-middle
    const prompt = request.suffix
      ? `<|fim_prefix|>${request.prompt}<|fim_suffix|>${request.suffix}<|fim_middle|>`
      : request.prompt;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.completionModel,
        prompt,
        stream: false,
        options: {
          temperature: request.temperature ?? 0.2,
          num_predict: request.maxTokens ?? 256,
          stop: request.stop,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama completion error: ${response.status}`);
    }

    const result = await response.json();
    return {
      text: result.response ?? '',
      finishReason: result.done ? 'stop' : 'length',
    };
  }

  async listModels(): Promise<string[]> {
    const url = `${this.config.baseUrl}/api/tags`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models ?? []).map((m: { name: string }) => m.name);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/version`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Switch the chat model at runtime (F9 model hot-swap) */
  setChatModel(model: string): void {
    this.config.chatModel = model;
  }

  /** Switch the completion model at runtime */
  setCompletionModel(model: string): void {
    this.config.completionModel = model;
  }

  /** Get current chat model name */
  getChatModel(): string {
    return this.config.chatModel;
  }

  /** Get current completion model name */
  getCompletionModel(): string {
    return this.config.completionModel;
  }
}
