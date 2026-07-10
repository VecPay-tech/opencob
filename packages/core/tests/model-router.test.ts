import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModelRouter } from '../src/llm/model-router.js';
import { OllamaAdapter } from '../src/llm/ollama-adapter.js';
import type {
  LlmAdapter,
  ChatMessage,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from '../src/llm/types.js';

/** Minimal mock adapter for testing */
function createMockAdapter(name: string): LlmAdapter {
  return {
    name,
    async *chat(_messages: ChatMessage[]): AsyncIterable<StreamChunk> {
      yield { type: 'text', text: `response from ${name}` };
      yield { type: 'done' };
    },
    async complete(_request: CompletionRequest): Promise<CompletionResponse> {
      return { text: `completion from ${name}`, finishReason: 'stop' };
    },
    async listModels(): Promise<string[]> {
      return [name];
    },
    async isAvailable(): Promise<boolean> {
      return true;
    },
  };
}

describe('ModelRouter', () => {
  it('routes to default adapter when no specific adapter registered', () => {
    const defaultAdapter = createMockAdapter('default-model');
    const router = new ModelRouter(defaultAdapter);

    const adapter = router.getAdapterForTask('chat');
    expect(adapter.name).toBe('default-model');
  });

  it('returns correct model name for each task type', () => {
    const router = new ModelRouter(createMockAdapter('default'), {
      chat: 'chat-model',
      completion: 'completion-model',
      planning: 'planning-model',
      embedding: 'embed-model',
    });

    expect(router.getModelForTask('chat')).toBe('chat-model');
    expect(router.getModelForTask('completion')).toBe('completion-model');
    expect(router.getModelForTask('planning')).toBe('planning-model');
    expect(router.getModelForTask('embedding')).toBe('embed-model');
  });

  it('allows updating model for a task type', () => {
    const router = new ModelRouter(createMockAdapter('default'));

    router.setModelForTask('chat', 'new-chat-model');
    expect(router.getModelForTask('chat')).toBe('new-chat-model');
  });

  it('registers and retrieves named adapters', () => {
    const defaultAdapter = createMockAdapter('default');
    const specialAdapter = createMockAdapter('special-model');

    const router = new ModelRouter(defaultAdapter, { chat: 'special-model' });
    router.registerAdapter('special-model', specialAdapter);

    const adapter = router.getAdapterForTask('chat');
    expect(adapter.name).toBe('special-model');
  });

  it('completes using the completion model', async () => {
    const completionAdapter = createMockAdapter('fast-model');
    const router = new ModelRouter(createMockAdapter('default'), {
      completion: 'fast-model',
    });
    router.registerAdapter('fast-model', completionAdapter);

    const result = await router.complete({ prompt: 'test' });
    expect(result.text).toBe('completion from fast-model');
  });

  it('falls back to default adapter for unknown models', () => {
    const router = new ModelRouter(createMockAdapter('fallback'), {
      chat: 'nonexistent-model',
    });

    const adapter = router.getAdapterForTask('chat');
    expect(adapter.name).toBe('fallback');
  });

  it('lists registered adapter names', () => {
    const router = new ModelRouter(createMockAdapter('default'));
    router.registerAdapter('model-a', createMockAdapter('model-a'));
    router.registerAdapter('model-b', createMockAdapter('model-b'));

    const names = router.getRegisteredAdapters();
    expect(names).toContain('default');
    expect(names).toContain('model-a');
    expect(names).toContain('model-b');
  });

  it('returns all routes', () => {
    const router = new ModelRouter(createMockAdapter('default'), {
      chat: 'chat-m',
      completion: 'comp-m',
    });

    const routes = router.getRoutes();
    expect(routes.chat).toBe('chat-m');
    expect(routes.completion).toBe('comp-m');
  });
});

describe('ModelRouter.fromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a ModelRouter instance', () => {
    const router = ModelRouter.fromEnv();
    expect(router).toBeInstanceOf(ModelRouter);
  });

  it('registers OpenAiAdapter when OPENAI_API_KEY is set', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const router = ModelRouter.fromEnv();
    const adapter = router.getAdapterForTask('chat');
    expect(adapter.name).toBe('openai');
  });

  it('registers AnthropicAdapter when ANTHROPIC_API_KEY is set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const router = ModelRouter.fromEnv();
    const adapter = router.getAdapterForTask('chat');
    expect(adapter.name).toBe('anthropic');
  });

  it('falls back to OllamaAdapter when no API key is set', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('GOOGLE_API_KEY', '');
    const router = ModelRouter.fromEnv();
    expect(router.getAdapterForTask('chat')).toBeInstanceOf(OllamaAdapter);
  });
});
