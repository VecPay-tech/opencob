import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop, type AgentEvent, type AgentPhase } from '../src/agent/agent-loop.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { ConversationManager } from '../src/conversation/conversation-manager.js';
import { ModeEngine } from '../src/modes/mode-engine.js';
import { RedactionEngine } from '../src/security/redaction-engine.js';
import type {
  LlmAdapter,
  ChatMessage,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from '../src/llm/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

class MockLlm implements LlmAdapter {
  name = 'mock';
  private responses: Array<StreamChunk[]>;
  private callIndex = 0;

  constructor(responses?: Array<StreamChunk[]>) {
    this.responses = responses ?? [[{ type: 'text', text: 'Done!' }, { type: 'done' }]];
  }

  async *chat(
    _messages: ChatMessage[],
    _options?: Record<string, unknown>,
  ): AsyncIterable<StreamChunk> {
    const response = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    for (const chunk of response) {
      yield chunk;
    }
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

async function collectEvents(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

// ─── Test Setup ──────────────────────────────────────────────────────────────

function createAgent(llmResponses?: Array<StreamChunk[]>) {
  const llm = new MockLlm(llmResponses);
  const modeEngine = new ModeEngine();
  const toolRegistry = new ToolRegistry(modeEngine, {
    autoApprove: { read: true, edit: true, command: true, mcp: true, browser: true },
  });
  const conversationManager = new ConversationManager();
  const redactionEngine = new RedactionEngine();

  const agent = new AgentLoop(
    llm,
    toolRegistry,
    conversationManager,
    modeEngine,
    { maxToolRounds: 5, maxContextTokens: 4096 },
    redactionEngine,
  );

  return { agent, llm, toolRegistry, conversationManager, modeEngine };
}

// ─── Orchestrator Integration Tests (§3.17, §8.9.4) ─────────────────────────

describe('Orchestrator Integration in AgentLoop', () => {
  it('should delegate to orchestrator when in orchestrator mode', async () => {
    // First response: orchestrator decomposition (JSON array of subtasks)
    // Subsequent responses: subtask execution
    const llmResponses: Array<StreamChunk[]> = [
      // Decomposition call
      [
        {
          type: 'text',
          text: '[{"description":"Analyze the code","mode":"ask"},{"description":"Implement changes","mode":"code"}]',
        },
        { type: 'done' },
      ],
      // Step 1 execution
      [{ type: 'text', text: 'Analysis complete: found 3 functions.' }, { type: 'done' }],
      // Step 2 execution
      [{ type: 'text', text: 'Changes implemented successfully.' }, { type: 'done' }],
    ];

    const { agent, modeEngine } = createAgent(llmResponses);
    modeEngine.setActive('orchestrator');

    const events = await collectEvents(agent.processMessage('Refactor the auth module'));

    // Should have plan_created event
    const planEvent = events.find((e) => e.type === 'plan_created');
    expect(planEvent).toBeDefined();
    expect(planEvent!.plan).toBeDefined();
    expect(planEvent!.plan!.goal).toBe('Refactor the auth module');
    expect(planEvent!.plan!.steps).toHaveLength(2);
    expect(planEvent!.plan!.steps[0].mode).toBe('ask');
    expect(planEvent!.plan!.steps[1].mode).toBe('code');
  });

  it('should emit plan_step_update for each subtask', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [{ type: 'text', text: '[{"description":"Step one","mode":"ask"}]' }, { type: 'done' }],
      [{ type: 'text', text: 'Step one done.' }, { type: 'done' }],
    ];

    const { agent, modeEngine } = createAgent(llmResponses);
    modeEngine.setActive('orchestrator');

    const events = await collectEvents(agent.processMessage('Do something'));

    const stepUpdates = events.filter((e) => e.type === 'plan_step_update');
    expect(stepUpdates.length).toBeGreaterThanOrEqual(2); // running + done
    expect(stepUpdates[0].planStep?.status).toBe('running');
    expect(stepUpdates[0].planStep?.stepIndex).toBe(0);
    expect(stepUpdates[1].planStep?.status).toBe('done');
  });

  it('should emit thinking and thinking_end events during orchestration', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [{ type: 'text', text: '[{"description":"Analyze","mode":"ask"}]' }, { type: 'done' }],
      [{ type: 'text', text: 'Analysis result.' }, { type: 'done' }],
    ];

    const { agent, modeEngine } = createAgent(llmResponses);
    modeEngine.setActive('orchestrator');

    const events = await collectEvents(agent.processMessage('Analyze this'));

    const thinkingEvents = events.filter((e) => e.type === 'thinking');
    const thinkingEndEvents = events.filter((e) => e.type === 'thinking_end');

    expect(thinkingEvents.length).toBeGreaterThan(0);
    expect(thinkingEndEvents.length).toBeGreaterThan(0);
    // Thinking includes decomposition message
    expect(thinkingEvents[0].thinking).toContain('Decomposing');
  });

  it('should emit planning phase during orchestration', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [{ type: 'text', text: '[{"description":"Step 1","mode":"code"}]' }, { type: 'done' }],
      [{ type: 'text', text: 'Done.' }, { type: 'done' }],
    ];

    const { agent, modeEngine } = createAgent(llmResponses);
    modeEngine.setActive('orchestrator');

    const events = await collectEvents(agent.processMessage('Build it'));

    const phases = events.filter((e) => e.type === 'phase_change').map((e) => e.phase);
    expect(phases).toContain('preparing');
    expect(phases).toContain('planning');
    expect(phases).toContain('reasoning');
  });

  it('should handle orchestrator decomposition failure gracefully', async () => {
    // LLM returns non-JSON response → fallback plan
    const llmResponses: Array<StreamChunk[]> = [
      [{ type: 'text', text: 'I cannot parse this into subtasks.' }, { type: 'done' }],
      // Fallback: single step execution
      [{ type: 'text', text: 'Completed the task.' }, { type: 'done' }],
    ];

    const { agent, modeEngine } = createAgent(llmResponses);
    modeEngine.setActive('orchestrator');

    const events = await collectEvents(agent.processMessage('Do something complex'));

    // Should still produce a plan (fallback)
    const planEvent = events.find((e) => e.type === 'plan_created');
    expect(planEvent).toBeDefined();
    expect(planEvent!.plan!.steps.length).toBeGreaterThanOrEqual(1);

    // Should complete successfully
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
  });

  it('should mark step as failed when LLM throws during subtask', async () => {
    const errorLlm: LlmAdapter = {
      name: 'error-llm',
      async *chat(messages: ChatMessage[]) {
        // First call succeeds (decomposition)
        if (messages.some((m) => m.content?.includes('orchestrator'))) {
          yield { type: 'text' as const, text: '[{"description":"Step 1","mode":"code"}]' };
          yield { type: 'done' as const };
          return;
        }
        throw new Error('LLM connection lost');
      },
      async complete() {
        return { text: '', finishReason: 'stop' };
      },
      async listModels() {
        return [];
      },
      async isAvailable() {
        return false;
      },
    };

    const toolRegistry = new ToolRegistry();
    const conversationManager = new ConversationManager();
    const modeEngine = new ModeEngine();
    const agent = new AgentLoop(errorLlm, toolRegistry, conversationManager, modeEngine, {
      maxToolRounds: 5,
      maxContextTokens: 4096,
    });
    modeEngine.setActive('orchestrator');

    const events = await collectEvents(agent.processMessage('Do it'));

    const failedStep = events.find(
      (e) => e.type === 'plan_step_update' && e.planStep?.status === 'failed',
    );
    expect(failedStep).toBeDefined();
    expect(failedStep!.planStep!.summary).toContain('LLM connection lost');
  });

  it('should restore orchestrator mode after subtask execution', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [
        {
          type: 'text',
          text: '[{"description":"Analyze","mode":"ask"},{"description":"Code","mode":"code"}]',
        },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'Analysis.' }, { type: 'done' }],
      [{ type: 'text', text: 'Code written.' }, { type: 'done' }],
    ];

    const { agent, modeEngine } = createAgent(llmResponses);
    modeEngine.setActive('orchestrator');

    await collectEvents(agent.processMessage('Multi-step task'));

    // Mode should be restored to orchestrator after completion
    expect(modeEngine.getActive().slug).toBe('orchestrator');
  });

  it('should emit done event at end of orchestration', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [{ type: 'text', text: '[{"description":"Step 1","mode":"ask"}]' }, { type: 'done' }],
      [{ type: 'text', text: 'Done.' }, { type: 'done' }],
    ];

    const { agent, modeEngine } = createAgent(llmResponses);
    modeEngine.setActive('orchestrator');

    const events = await collectEvents(agent.processMessage('Simple task'));

    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('done');
  });
});

// ─── Changes Summary Tests (§8.4.1.1) ───────────────────────────────────────

describe('Changes Summary Tracking', () => {
  it('should emit changes_summary when files are modified', async () => {
    // Simulate a tool call that writes a file
    const llmResponses: Array<StreamChunk[]> = [
      [
        {
          type: 'tool_call',
          toolCall: { name: 'write_to_file', parameters: { path: 'test.ts', content: 'hello' } },
          toolCallId: 'call_1',
        },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'File written.' }, { type: 'done' }],
    ];

    const { agent, toolRegistry } = createAgent(llmResponses);

    // Register a mock write tool
    toolRegistry.register({
      name: 'write_to_file',
      description: 'Write file',
      group: 'edit',
      parameters: [{ name: 'path', type: 'string', description: 'File path', required: true }],
      execute: async () => ({ success: true, content: '+line 1\n+line 2\n+line 3' }),
    });

    const events = await collectEvents(agent.processMessage('Create a file'));

    const summaryEvent = events.find((e) => e.type === 'changes_summary');
    expect(summaryEvent).toBeDefined();
    expect(summaryEvent!.changesSummary!.filesChanged).toBe(1);
    expect(summaryEvent!.changesSummary!.linesAdded).toBe(3);
    expect(summaryEvent!.changesSummary!.files[0].path).toBe('test.ts');
  });

  it('should track multiple file changes in one turn', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [
        {
          type: 'tool_call',
          toolCall: { name: 'write_to_file', parameters: { path: 'a.ts', content: 'a' } },
          toolCallId: 'call_1',
        },
        { type: 'done' },
      ],
      [
        {
          type: 'tool_call',
          toolCall: { name: 'write_to_file', parameters: { path: 'b.ts', content: 'b' } },
          toolCallId: 'call_2',
        },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'All done.' }, { type: 'done' }],
    ];

    const { agent, toolRegistry } = createAgent(llmResponses);

    toolRegistry.register({
      name: 'write_to_file',
      description: 'Write file',
      group: 'edit',
      parameters: [{ name: 'path', type: 'string', description: 'File path', required: true }],
      execute: async () => ({ success: true, content: '+new content\n-old content' }),
    });

    const events = await collectEvents(agent.processMessage('Update two files'));

    const summaryEvent = events.find((e) => e.type === 'changes_summary');
    expect(summaryEvent).toBeDefined();
    expect(summaryEvent!.changesSummary!.filesChanged).toBe(2);
    expect(summaryEvent!.changesSummary!.files).toHaveLength(2);
  });

  it('should not emit changes_summary when no files are modified', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [{ type: 'text', text: 'Just answering a question.' }, { type: 'done' }],
    ];

    const { agent } = createAgent(llmResponses);

    const events = await collectEvents(agent.processMessage('What is TypeScript?'));

    const summaryEvent = events.find((e) => e.type === 'changes_summary');
    expect(summaryEvent).toBeUndefined();
  });

  it('should aggregate changes to the same file', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [
        {
          type: 'tool_call',
          toolCall: { name: 'apply_diff', parameters: { path: 'main.ts', diff: '...' } },
          toolCallId: 'call_1',
        },
        { type: 'done' },
      ],
      [
        {
          type: 'tool_call',
          toolCall: { name: 'apply_diff', parameters: { path: 'main.ts', diff: '...' } },
          toolCallId: 'call_2',
        },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'Refactored.' }, { type: 'done' }],
    ];

    const { agent, toolRegistry } = createAgent(llmResponses);

    toolRegistry.register({
      name: 'apply_diff',
      description: 'Apply diff',
      group: 'edit',
      parameters: [{ name: 'path', type: 'string', description: 'File path', required: true }],
      execute: async () => ({ success: true, content: '+added\n-removed' }),
    });

    const events = await collectEvents(agent.processMessage('Refactor main.ts'));

    const summaryEvent = events.find((e) => e.type === 'changes_summary');
    expect(summaryEvent).toBeDefined();
    // Same file modified twice → aggregated into 1 entry
    expect(summaryEvent!.changesSummary!.filesChanged).toBe(1);
    expect(summaryEvent!.changesSummary!.linesAdded).toBe(2); // 1 + 1
    expect(summaryEvent!.changesSummary!.linesRemoved).toBe(2); // 1 + 1
  });

  it('should reset file changes between turns', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [
        {
          type: 'tool_call',
          toolCall: { name: 'write_to_file', parameters: { path: 'first.ts', content: '' } },
          toolCallId: 'call_1',
        },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'Done turn 1.' }, { type: 'done' }],
      // Second turn - no file changes
      [{ type: 'text', text: 'Just answering.' }, { type: 'done' }],
    ];

    const { agent, toolRegistry } = createAgent(llmResponses);

    toolRegistry.register({
      name: 'write_to_file',
      description: 'Write file',
      group: 'edit',
      parameters: [{ name: 'path', type: 'string', description: 'File path', required: true }],
      execute: async () => ({ success: true, content: '+line' }),
    });

    // First turn
    const events1 = await collectEvents(agent.processMessage('Write a file'));
    expect(events1.find((e) => e.type === 'changes_summary')).toBeDefined();

    // Second turn - should not carry over first turn's changes
    const events2 = await collectEvents(agent.processMessage('Just a question'));
    expect(events2.find((e) => e.type === 'changes_summary')).toBeUndefined();
  });

  it('should provide getTurnFileChanges accessor', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [
        {
          type: 'tool_call',
          toolCall: { name: 'write_to_file', parameters: { path: 'out.ts', content: '' } },
          toolCallId: 'call_1',
        },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'Written.' }, { type: 'done' }],
    ];

    const { agent, toolRegistry } = createAgent(llmResponses);

    toolRegistry.register({
      name: 'write_to_file',
      description: 'Write',
      group: 'edit',
      parameters: [{ name: 'path', type: 'string', description: 'File path', required: true }],
      execute: async () => ({ success: true, content: '+line1\n+line2' }),
    });

    await collectEvents(agent.processMessage('Write'));

    const changes = agent.getTurnFileChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('out.ts');
    expect(changes[0].added).toBe(2);
  });
});

// ─── New AgentEvent Types ────────────────────────────────────────────────────

describe('AgentEvent type extensions', () => {
  it('should support plan_created event structure', () => {
    const event: AgentEvent = {
      type: 'plan_created',
      plan: {
        goal: 'Refactor auth',
        steps: [
          { id: 1, description: 'Analyze', mode: 'ask' },
          { id: 2, description: 'Implement', mode: 'code' },
        ],
      },
    };
    expect(event.type).toBe('plan_created');
    expect(event.plan!.steps).toHaveLength(2);
  });

  it('should support plan_step_update event structure', () => {
    const event: AgentEvent = {
      type: 'plan_step_update',
      planStep: { stepIndex: 0, status: 'done', summary: 'Analysis complete' },
    };
    expect(event.planStep!.status).toBe('done');
    expect(event.planStep!.summary).toBe('Analysis complete');
  });

  it('should support thinking_end event type', () => {
    const event: AgentEvent = { type: 'thinking_end' };
    expect(event.type).toBe('thinking_end');
  });

  it('should support changes_summary event structure', () => {
    const event: AgentEvent = {
      type: 'changes_summary',
      changesSummary: {
        filesChanged: 3,
        linesAdded: 100,
        linesRemoved: 50,
        files: [
          { path: 'src/a.ts', status: 'M', added: 40, removed: 20 },
          { path: 'src/b.ts', status: 'A', added: 50, removed: 0 },
          { path: 'src/c.ts', status: 'M', added: 10, removed: 30 },
        ],
      },
    };
    expect(event.changesSummary!.filesChanged).toBe(3);
    expect(event.changesSummary!.linesAdded).toBe(100);
    expect(event.changesSummary!.files).toHaveLength(3);
  });

  it('should still support all existing event types', () => {
    const events: AgentEvent[] = [
      { type: 'text', text: 'hello' },
      { type: 'tool_call', toolCall: { name: 'read_file', parameters: { path: 'x' } } },
      { type: 'tool_result', toolResult: { toolName: 'read_file', success: true, content: '' } },
      { type: 'error', error: 'fail' },
      { type: 'done' },
      { type: 'mode_switch', mode: 'ask' },
      { type: 'self_correction', attempt: 1 },
      { type: 'compaction', text: 'compacted' },
      { type: 'verification', text: 'valid' },
      { type: 'skill_activated', text: 'react' },
      { type: 'phase_change', phase: 'reasoning' },
      { type: 'thinking', thinking: 'Let me think...' },
    ];
    expect(events).toHaveLength(12);
    events.forEach((e) => expect(e.type).toBeDefined());
  });
});

// ─── Phase Emissions (§8.9.1) ────────────────────────────────────────────────

describe('Phase emissions in normal mode', () => {
  it('should emit preparing phase first', async () => {
    const { agent } = createAgent();
    const events = await collectEvents(agent.processMessage('Hello'));
    const firstPhase = events.find((e) => e.type === 'phase_change');
    expect(firstPhase?.phase).toBe('preparing');
  });

  it('should emit reasoning phase before LLM call', async () => {
    const { agent } = createAgent();
    const events = await collectEvents(agent.processMessage('Hello'));
    const phases = events.filter((e) => e.type === 'phase_change').map((e) => e.phase);
    expect(phases).toContain('reasoning');
  });

  it('should emit processing phase during tool execution', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [
        {
          type: 'tool_call',
          toolCall: { name: 'read_file', parameters: { path: 'test.ts' } },
          toolCallId: 'call_1',
        },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'Read complete.' }, { type: 'done' }],
    ];

    const { agent, toolRegistry } = createAgent(llmResponses);
    toolRegistry.register({
      name: 'read_file',
      description: 'Read',
      group: 'read',
      parameters: [{ name: 'path', type: 'string', description: 'File path', required: true }],
      execute: async () => ({ success: true, content: 'file contents' }),
    });

    const events = await collectEvents(agent.processMessage('Read the file'));
    const phases = events.filter((e) => e.type === 'phase_change').map((e) => e.phase);
    expect(phases).toContain('processing');
  });

  it('should emit evaluating phase after tool result', async () => {
    const llmResponses: Array<StreamChunk[]> = [
      [
        {
          type: 'tool_call',
          toolCall: { name: 'search_files', parameters: { query: 'test' } },
          toolCallId: 'call_1',
        },
        { type: 'done' },
      ],
      [{ type: 'text', text: 'Found results.' }, { type: 'done' }],
    ];

    const { agent, toolRegistry } = createAgent(llmResponses);
    toolRegistry.register({
      name: 'search_files',
      description: 'Search',
      group: 'read',
      parameters: [{ name: 'query', type: 'string', description: 'Search query', required: true }],
      execute: async () => ({ success: true, content: 'match found' }),
    });

    const events = await collectEvents(agent.processMessage('Search for test'));
    const phases = events.filter((e) => e.type === 'phase_change').map((e) => e.phase);
    expect(phases).toContain('evaluating');
  });
});
