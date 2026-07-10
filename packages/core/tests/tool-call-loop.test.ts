import { describe, it, expect, vi } from 'vitest';
import { ToolCallLoop } from '../src/agent/tool-call-loop.js';
import { ChangeTracker } from '../src/agent/change-tracker.js';
import { ConversationManager } from '../src/conversation/conversation-manager.js';
import { ModeEngine } from '../src/modes/mode-engine.js';
import { RedactionEngine } from '../src/security/redaction-engine.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from '../src/llm/types.js';

function makeMockAdapter(chunks: StreamChunk[]): LlmAdapter {
  return {
    name: 'mock',
    getChatModel: () => 'mock',
    getCompletionModel: () => 'mock',
    setChatModel: vi.fn(),
    setCompletionModel: vi.fn(),
    isAvailable: async () => true,
    listModels: async () => ['mock'],
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
      text: '',
      finishReason: 'stop',
    }),
    async *chat(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncIterable<StreamChunk> {
      for (const c of chunks) yield c;
    },
  };
}

describe('ToolCallLoop', () => {
  it('yields text events from LLM and a done event', async () => {
    const modeEngine = new ModeEngine();
    const toolRegistry = new ToolRegistry(modeEngine);
    const conversationManager = new ConversationManager();
    const redactionEngine = new RedactionEngine();
    const changeTracker = new ChangeTracker();
    const adapter = makeMockAdapter([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'done' },
    ]);
    const loop = new ToolCallLoop({
      llm: adapter,
      toolRegistry,
      conversationManager,
      redactionEngine,
      changeTracker,
      maxToolRounds: 5,
      maxSelfCorrectionAttempts: 2,
      enablePostEditVerification: false,
      postEditVerifier: null,
    });
    const events: string[] = [];
    for await (const ev of loop.run('system', 8000)) {
      events.push(ev.type);
    }
    expect(events).toContain('text');
    expect(events.at(-1)).toBe('done');
  });
});
