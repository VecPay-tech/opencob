import type { LlmAdapter, ChatMessage, StreamChunk, CompletionRequest, CompletionResponse } from './types.js';

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
    options?: { temperature?: number; maxTokens?: number },
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
}
