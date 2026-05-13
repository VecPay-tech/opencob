import { describe, it, expect } from 'vitest';
import { ConversationCompactor } from '../src/agent/conversation-compactor.js';
import { PromptEnhancer } from '../src/agent/prompt-enhancer.js';
import type {
  LlmAdapter,
  ChatMessage,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from '../src/llm/types.js';

// Mock LLM that returns predictable responses
class MockLlm implements LlmAdapter {
  name = 'mock';
  private response: string;

  constructor(response: string = 'Mock summary of the conversation.') {
    this.response = response;
  }

  async *chat(_messages: ChatMessage[]): AsyncIterable<StreamChunk> {
    yield { type: 'text', text: this.response };
    yield { type: 'done' };
  }

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    return { text: 'mock', finishReason: 'stop' };
  }

  async listModels(): Promise<string[]> {
    return ['mock-model'];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe('ConversationCompactor', () => {
  it('does not compact short conversations', () => {
    const compactor = new ConversationCompactor(new MockLlm());
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    expect(compactor.needsCompaction(messages)).toBe(false);
  });

  it('detects need for compaction on long conversations', () => {
    const compactor = new ConversationCompactor(new MockLlm(), { triggerThreshold: 100 });
    const messages: ChatMessage[] = [
      { role: 'user', content: 'A'.repeat(500) },
      { role: 'assistant', content: 'B'.repeat(500) },
    ];
    expect(compactor.needsCompaction(messages)).toBe(true);
  });

  it('compacts keeping recent messages', async () => {
    const compactor = new ConversationCompactor(new MockLlm(), {
      triggerThreshold: 50,
      keepRecentMessages: 2,
    });
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Old message 1' },
      { role: 'assistant', content: 'Old response 1' },
      { role: 'user', content: 'Old message 2' },
      { role: 'assistant', content: 'Old response 2' },
      { role: 'user', content: 'Recent message' },
      { role: 'assistant', content: 'Recent response' },
    ];

    const compacted = await compactor.compact(messages);
    // Should have: 1 summary + 2 recent messages
    expect(compacted).toHaveLength(3);
    expect(compacted[0].role).toBe('system');
    expect(compacted[0].content).toContain('Conversation Summary');
    expect(compacted[1].content).toBe('Recent message');
    expect(compacted[2].content).toBe('Recent response');
  });

  it('returns messages as-is when fewer than keepRecentMessages', async () => {
    const compactor = new ConversationCompactor(new MockLlm(), {
      keepRecentMessages: 10,
    });
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

    const compacted = await compactor.compact(messages);
    expect(compacted).toHaveLength(1);
  });
});

describe('PromptEnhancer', () => {
  it('returns short prompts unchanged', async () => {
    const enhancer = new PromptEnhancer(new MockLlm());
    const result = await enhancer.enhance('fix bug');
    expect(result).toBe('fix bug');
  });

  it('enhances longer prompts via LLM', async () => {
    const enhanced =
      'Please refactor the authentication module to use JWT tokens instead of session cookies.';
    const enhancer = new PromptEnhancer(new MockLlm(enhanced));
    const result = await enhancer.enhance('refactor the auth module to use jwt tokens');
    expect(result).toBe(enhanced);
  });

  it('falls back to original on LLM error', async () => {
    const errorLlm = new MockLlm();
    errorLlm.chat = async function* () {
      throw new Error('LLM unavailable');
    };

    const enhancer = new PromptEnhancer(errorLlm);
    const original = 'some prompt that is long enough to enhance';
    const result = await enhancer.enhance(original);
    expect(result).toBe(original);
  });
});
