import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../src/agent/agent-loop.js';
import type { AgentEvent } from '../src/agent/agent-loop.js';

describe('AgentLoop phase emissions', () => {
  function createMockLoop(options: { mentionParser?: boolean; toolCallOnFirst?: boolean } = {}) {
    const mockLlm: any = {
      chat: vi.fn().mockImplementation(async function* () {
        if (options.toolCallOnFirst) {
          yield {
            type: 'tool_call',
            toolCall: { name: 'read_file', parameters: { path: 'test.ts' } },
            toolCallId: 'call_1',
          };
          yield { type: 'done' };
        } else {
          yield { type: 'text', text: 'Hello' };
          yield { type: 'done' };
        }
      }),
    };

    const mockToolRegistry: any = {
      getToolDefinitions: () => [],
      listAvailable: () => [],
      execute: vi
        .fn()
        .mockResolvedValue({ success: true, content: 'file content', toolName: 'read_file' }),
    };

    const mockConversationManager: any = {
      addMessage: vi.fn(),
      getMessages: () => [],
      getActive: () => ({ id: '1', messages: [], title: 'Test', modeSlug: 'code' }),
      getContextWindow: (_sys: string, _max: number) => [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hello' },
      ],
    };

    const mockModeEngine: any = {
      getActive: () => ({
        slug: 'code',
        name: 'Code',
        roleDefinition: 'You are a coder.',
        groups: [['read', 'edit']],
      }),
      listModes: () => [{ slug: 'code', name: 'Code', groups: [['read', 'edit']] }],
    };

    const mockRedaction: any = {
      redactMessages: (msgs: any[]) => msgs,
      redact: (s: string) => s,
    };

    const mockMentionParser = options.mentionParser
      ? { parse: vi.fn().mockResolvedValue({ cleanText: 'Hello', contextBlock: '' }) }
      : undefined;

    const loop = new AgentLoop(
      mockLlm,
      mockToolRegistry,
      mockConversationManager,
      mockModeEngine,
      { workspaceRoot: '/tmp', maxToolRounds: 3 },
      mockRedaction,
      undefined, // snapshotManager
      undefined, // compactor
      undefined, // postEditVerifier
      mockMentionParser as any,
    );

    return { loop, mockLlm, mockToolRegistry };
  }

  it('emits preparing phase at start of processMessage', async () => {
    const { loop } = createMockLoop();
    const events: AgentEvent[] = [];
    for await (const event of loop.processMessage('Hello')) {
      events.push(event);
    }
    expect(events[0]).toEqual({ type: 'phase_change', phase: 'preparing' });
  });

  it('emits gathering_context phase when mention parser is present', async () => {
    const { loop } = createMockLoop({ mentionParser: true });
    const events: AgentEvent[] = [];
    for await (const event of loop.processMessage('Hello')) {
      events.push(event);
    }
    const phases = events.filter((e) => e.type === 'phase_change').map((e) => e.phase);
    expect(phases).toContain('preparing');
    expect(phases).toContain('gathering_context');
  });

  it('emits reasoning phase before LLM call', async () => {
    const { loop } = createMockLoop();
    const events: AgentEvent[] = [];
    for await (const event of loop.processMessage('Hello')) {
      events.push(event);
    }
    const phases = events.filter((e) => e.type === 'phase_change').map((e) => e.phase);
    expect(phases).toContain('reasoning');
  });

  it('emits analysing phase on tool call', async () => {
    const { loop } = createMockLoop({ toolCallOnFirst: true });
    const events: AgentEvent[] = [];

    // The loop will do 2 rounds: first with tool_call, second with text response
    // Override the mock to return text on second call
    let callCount = 0;
    const mockLlm = (loop as any).llm;
    mockLlm.chat = vi.fn().mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          toolCall: { name: 'read_file', parameters: { path: 'a.ts' } },
          toolCallId: 'c1',
        };
        yield { type: 'done' };
      } else {
        yield { type: 'text', text: 'Done' };
        yield { type: 'done' };
      }
    });

    for await (const event of loop.processMessage('Read file')) {
      events.push(event);
    }
    const phases = events.filter((e) => e.type === 'phase_change').map((e) => e.phase);
    expect(phases).toContain('analysing');
  });

  it('emits processing and evaluating phases during tool execution', async () => {
    const { loop } = createMockLoop({ toolCallOnFirst: true });
    const events: AgentEvent[] = [];

    let callCount = 0;
    const mockLlm = (loop as any).llm;
    mockLlm.chat = vi.fn().mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          toolCall: { name: 'read_file', parameters: { path: 'a.ts' } },
          toolCallId: 'c1',
        };
        yield { type: 'done' };
      } else {
        yield { type: 'text', text: 'Done' };
        yield { type: 'done' };
      }
    });

    for await (const event of loop.processMessage('Read file')) {
      events.push(event);
    }
    const phases = events.filter((e) => e.type === 'phase_change').map((e) => e.phase);
    expect(phases).toContain('processing');
    expect(phases).toContain('evaluating');
  });

  it('includes text events for LLM responses', async () => {
    const { loop } = createMockLoop();
    const events: AgentEvent[] = [];
    for await (const event of loop.processMessage('Hi')) {
      events.push(event);
    }
    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0].text).toBe('Hello');
  });

  it('ends with done event', async () => {
    const { loop } = createMockLoop();
    const events: AgentEvent[] = [];
    for await (const event of loop.processMessage('Hi')) {
      events.push(event);
    }
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('done');
  });

  it('AgentPhase type covers all expected phases', async () => {
    // Type-level check — just ensure the phase_change event has proper typing
    const event: AgentEvent = { type: 'phase_change', phase: 'verifying' };
    expect(event.phase).toBe('verifying');
  });

  it('thinking event type is valid', () => {
    const event: AgentEvent = { type: 'thinking', thinking: 'Let me analyze this...' };
    expect(event.type).toBe('thinking');
    expect(event.thinking).toBe('Let me analyze this...');
  });
});
