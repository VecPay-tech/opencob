import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
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

  async *chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    const url = `${this.config.baseUrl}/v1/chat/completions`;
    const hasTools = options?.tools && options.tools.length > 0;

    const mappedMessages = messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role };
      // Assistant messages with tool_calls: set content to null if empty, include tool_calls
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        msg.content = m.content || null;
        msg.tool_calls = m.toolCalls;
      } else if (m.role === 'tool') {
        // Tool result messages
        msg.content = m.content;
        if (m.toolCallId) msg.tool_call_id = m.toolCallId;
      } else {
        msg.content = m.content;
      }
      return msg;
    });

    // When tools are provided, use non-streaming to get reliable tool_calls
    // (LiteLLM proxy doesn't relay delta.tool_calls in streaming mode)
    if (hasTools) {
      yield* this.chatWithTools(url, mappedMessages, options!);
      return;
    }

    // Streaming path (no tools) for smooth text output
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      messages: mappedMessages,
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

  /**
   * Non-streaming chat with tools — reliable tool_calls parsing.
   * Text content is yielded as a single chunk, tool calls as structured events.
   */
  private async *chatWithTools(
    url: string,
    mappedMessages: Record<string, unknown>[],
    options: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    const body: Record<string, unknown> = {
      model: this.config.chatModel,
      messages: mappedMessages,
      stream: false,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

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

    const result = (await response.json()) as Record<string, unknown>;
    const choice = (
      result as { choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }> }
    ).choices?.[0];

    if (!choice) {
      yield { type: 'error', error: 'No choice in response' };
      return;
    }

    const message = choice.message as
      | {
          content?: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        }
      | undefined;

    // Yield text content if any
    if (message?.content) {
      yield { type: 'text', text: message.content };
    }

    // Yield tool calls if any
    if (message?.tool_calls && message.tool_calls.length > 0) {
      for (const tc of message.tool_calls) {
        try {
          const params = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          yield {
            type: 'tool_call',
            toolCall: { name: tc.function.name, parameters: params },
            toolCallId: tc.id,
          };
        } catch {
          yield {
            type: 'error',
            error: `Failed to parse tool call arguments for ${tc.function.name}`,
          };
        }
      }
    }

    yield { type: 'done' };
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
