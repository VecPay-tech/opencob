import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from './types.js';
import { OpenAiAdapter } from './openai-adapter.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';

export type TaskType = 'chat' | 'completion' | 'planning' | 'embedding' | 'enhancement';

export interface ModelRouteConfig {
  chat: string;
  completion: string;
  planning?: string;
  embedding?: string;
  enhancement?: string;
}

const DEFAULT_ROUTES: ModelRouteConfig = {
  chat: 'qwen2.5-coder:7b',
  completion: 'qwen2.5-coder:1.5b',
  planning: 'qwen2.5-coder:7b',
  embedding: 'nomic-embed-text',
  enhancement: 'qwen2.5-coder:7b',
};

/**
 * Model Router — routes LLM requests to different models based on task type.
 * Supports per-task model configuration (fast model for completion,
 * large model for planning, etc.) as specified in F9.
 */
export class ModelRouter {
  private routes: ModelRouteConfig;
  private adapters: Map<string, LlmAdapter> = new Map();
  private defaultAdapter: LlmAdapter;

  constructor(defaultAdapter: LlmAdapter, routes?: Partial<ModelRouteConfig>) {
    this.defaultAdapter = defaultAdapter;
    this.routes = { ...DEFAULT_ROUTES, ...routes };
    this.adapters.set('default', defaultAdapter);
  }

  /** Register an adapter for a specific model name pattern */
  registerAdapter(name: string, adapter: LlmAdapter): void {
    this.adapters.set(name, adapter);
  }

  /** Get the model name for a task type */
  getModelForTask(task: TaskType): string {
    return this.routes[task] ?? this.routes.chat;
  }

  /** Update model route for a task type */
  setModelForTask(task: TaskType, model: string): void {
    this.routes[task] = model;
  }

  /** Get the adapter for a task type (falls back to default) */
  getAdapterForTask(task: TaskType): LlmAdapter {
    const model = this.getModelForTask(task);
    return this.adapters.get(model) ?? this.defaultAdapter;
  }

  /** Chat using the appropriate model for the task */
  chat(
    messages: ChatMessage[],
    task: TaskType = 'chat',
    options?: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    const adapter = this.getAdapterForTask(task);
    return adapter.chat(messages, options);
  }

  /** Complete using the completion model */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const adapter = this.getAdapterForTask('completion');
    return adapter.complete(request);
  }

  /** Get all configured routes */
  getRoutes(): ModelRouteConfig {
    return { ...this.routes };
  }

  /** Get all registered adapter names */
  getRegisteredAdapters(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Construct a ModelRouter from environment variables.
   * Priority: OpenAI > Anthropic > Gemini > Ollama (fallback).
   * All available adapters are registered; the first available becomes default.
   */
  static fromEnv(): ModelRouter {
    const openaiKey = process.env['OPENAI_API_KEY'];
    const anthropicKey = process.env['ANTHROPIC_API_KEY'];
    const googleKey = process.env['GOOGLE_API_KEY'];
    const ollamaUrl = process.env['OLLAMA_BASE_URL'];

    let defaultAdapter: LlmAdapter;
    if (openaiKey) {
      defaultAdapter = new OpenAiAdapter({
        apiKey: openaiKey,
        baseUrl: process.env['OPENAI_BASE_URL'],
      });
    } else if (anthropicKey) {
      defaultAdapter = new AnthropicAdapter({ apiKey: anthropicKey });
    } else if (googleKey) {
      defaultAdapter = new GeminiAdapter({ apiKey: googleKey });
    } else {
      defaultAdapter = new OllamaAdapter({ baseUrl: ollamaUrl });
    }

    const router = new ModelRouter(defaultAdapter);

    if (openaiKey) {
      router.registerAdapter(
        'openai',
        new OpenAiAdapter({ apiKey: openaiKey, baseUrl: process.env['OPENAI_BASE_URL'] }),
      );
    }
    if (anthropicKey) {
      router.registerAdapter('anthropic', new AnthropicAdapter({ apiKey: anthropicKey }));
    }
    if (googleKey) {
      router.registerAdapter('gemini', new GeminiAdapter({ apiKey: googleKey }));
    }

    return router;
  }
}
