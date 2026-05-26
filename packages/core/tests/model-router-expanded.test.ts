import { describe, it, expect, vi } from 'vitest';
import { ModelRouter } from '../src/llm/model-router.js';
import type { TaskType } from '../src/llm/model-router.js';

function createMockAdapter(name = 'mock') {
  return {
    name,
    isAvailable: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue(['model-a', 'model-b']),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: `response from ${name}` };
      yield { type: 'done' };
    }),
    complete: vi.fn().mockResolvedValue({
      text: 'completion',
      choices: [{ message: { content: 'completed' }, finish_reason: 'stop' }],
    }),
    getChatModel: vi.fn().mockReturnValue('chat-model'),
    setChatModel: vi.fn(),
    getCompletionModel: vi.fn().mockReturnValue('completion-model'),
    setCompletionModel: vi.fn(),
  } as any;
}

describe('ModelRouter', () => {
  it('uses default routes when none specified', () => {
    const adapter = createMockAdapter();
    const router = new ModelRouter(adapter);
    expect(router.getModelForTask('chat')).toBe('qwen2.5-coder:7b');
    expect(router.getModelForTask('completion')).toBe('qwen2.5-coder:1.5b');
  });

  it('accepts custom routes', () => {
    const adapter = createMockAdapter();
    const router = new ModelRouter(adapter, {
      chat: 'gpt-4o',
      completion: 'gpt-4o-mini',
      planning: 'o1',
    });
    expect(router.getModelForTask('chat')).toBe('gpt-4o');
    expect(router.getModelForTask('completion')).toBe('gpt-4o-mini');
    expect(router.getModelForTask('planning')).toBe('o1');
  });

  it('setModelForTask updates route', () => {
    const adapter = createMockAdapter();
    const router = new ModelRouter(adapter);
    router.setModelForTask('chat', 'new-model');
    expect(router.getModelForTask('chat')).toBe('new-model');
  });

  it('getAdapterForTask returns default when no match', () => {
    const adapter = createMockAdapter('default');
    const router = new ModelRouter(adapter);
    const result = router.getAdapterForTask('chat');
    expect(result).toBe(adapter);
  });

  it('getAdapterForTask returns registered adapter', () => {
    const defaultAdapter = createMockAdapter('default');
    const planningAdapter = createMockAdapter('planning');
    const router = new ModelRouter(defaultAdapter, { planning: 'plan-model' });
    router.registerAdapter('plan-model', planningAdapter);
    const result = router.getAdapterForTask('planning');
    expect(result).toBe(planningAdapter);
  });

  it('chat routes to correct adapter', async () => {
    const defaultAdapter = createMockAdapter('default');
    const router = new ModelRouter(defaultAdapter);
    const chunks: any[] = [];
    for await (const chunk of router.chat([{ role: 'user', content: 'hi' }], 'chat')) {
      chunks.push(chunk);
    }
    expect(defaultAdapter.chat).toHaveBeenCalled();
    expect(chunks[0].text).toContain('default');
  });

  it('chat with registered adapter for task', async () => {
    const defaultAdapter = createMockAdapter('default');
    const planAdapter = createMockAdapter('plan');
    const router = new ModelRouter(defaultAdapter, { planning: 'plan-model' });
    router.registerAdapter('plan-model', planAdapter);

    const chunks: any[] = [];
    for await (const chunk of router.chat([{ role: 'user', content: 'plan' }], 'planning')) {
      chunks.push(chunk);
    }
    expect(planAdapter.chat).toHaveBeenCalled();
    expect(chunks[0].text).toContain('plan');
  });

  it('complete uses completion adapter', async () => {
    const defaultAdapter = createMockAdapter('default');
    const router = new ModelRouter(defaultAdapter);
    const result = await router.complete({ prefix: 'hello', suffix: '' });
    expect(defaultAdapter.complete).toHaveBeenCalled();
    expect(result.text).toBe('completion');
  });

  it('getRoutes returns copy of current routes', () => {
    const adapter = createMockAdapter();
    const router = new ModelRouter(adapter, { chat: 'custom-chat' });
    const routes = router.getRoutes();
    expect(routes.chat).toBe('custom-chat');
    // Mutating returned object doesn't affect router
    routes.chat = 'mutated';
    expect(router.getModelForTask('chat')).toBe('custom-chat');
  });

  it('getRegisteredAdapters lists all registered', () => {
    const adapter = createMockAdapter();
    const router = new ModelRouter(adapter);
    router.registerAdapter('extra-1', createMockAdapter());
    router.registerAdapter('extra-2', createMockAdapter());
    const names = router.getRegisteredAdapters();
    expect(names).toContain('default');
    expect(names).toContain('extra-1');
    expect(names).toContain('extra-2');
  });

  it('falls back to chat route for unknown task type', () => {
    const adapter = createMockAdapter();
    const router = new ModelRouter(adapter, { chat: 'fallback-model' });
    // enhancement falls to its own route by default
    const enhancementModel = router.getModelForTask('enhancement');
    expect(enhancementModel).toBe('qwen2.5-coder:7b'); // default enhancement
  });

  it('chat passes options to adapter', async () => {
    const defaultAdapter = createMockAdapter();
    const router = new ModelRouter(defaultAdapter);
    const opts = { temperature: 0.5, maxTokens: 100 };

    // Consume the async iterable
    for await (const _chunk of router.chat([{ role: 'user', content: 'test' }], 'chat', opts)) {
      // consume
    }
    expect(defaultAdapter.chat).toHaveBeenCalledWith([{ role: 'user', content: 'test' }], opts);
  });

  it('handles all task types', () => {
    const adapter = createMockAdapter();
    const router = new ModelRouter(adapter, {
      chat: 'c',
      completion: 'comp',
      planning: 'p',
      embedding: 'e',
      enhancement: 'en',
    });
    const tasks: TaskType[] = ['chat', 'completion', 'planning', 'embedding', 'enhancement'];
    const expected = ['c', 'comp', 'p', 'e', 'en'];
    tasks.forEach((task, i) => {
      expect(router.getModelForTask(task)).toBe(expected[i]);
    });
  });
});
