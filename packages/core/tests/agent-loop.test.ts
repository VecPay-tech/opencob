import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentLoop, type AgentEvent } from '../src/agent/agent-loop.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { ConversationManager } from '../src/conversation/conversation-manager.js';
import { ModeEngine } from '../src/modes/mode-engine.js';
import { RedactionEngine } from '../src/security/redaction-engine.js';
import type { Tool } from '../src/tools/types.js';
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
    this.responses = responses ?? [[{ type: 'text', text: 'Hello!' }, { type: 'done' }]];
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

function createAgent(
  llm?: LlmAdapter,
  options?: {
    workspaceRoot?: string;
    maxToolRounds?: number;
    enableCompaction?: boolean;
    enablePostEditVerification?: boolean;
    enableComplexityClassifier?: boolean;
  },
): AgentLoop {
  const modeEngine = new ModeEngine();
  const toolRegistry = new ToolRegistry(modeEngine);
  const conversationManager = new ConversationManager();

  return new AgentLoop(
    llm ?? new MockLlm(),
    toolRegistry,
    conversationManager,
    modeEngine,
    {
      maxToolRounds: options?.maxToolRounds ?? 10,
      maxContextTokens: 8192,
      workspaceRoot: options?.workspaceRoot,
      enableCompaction: options?.enableCompaction ?? false,
      enablePostEditVerification: options?.enablePostEditVerification ?? false,
      enableComplexityClassifier: options?.enableComplexityClassifier ?? true,
    },
    new RedactionEngine(),
  );
}

async function collectEvents(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('AgentLoop', () => {
  describe('basic message processing', () => {
    it('streams text response from LLM', async () => {
      const agent = createAgent(
        new MockLlm([[{ type: 'text', text: 'Hello world' }, { type: 'done' }]]),
      );
      const events = await collectEvents(agent.processMessage('hi'));

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0].text).toBe('Hello world');

      const doneEvents = events.filter((e) => e.type === 'done');
      expect(doneEvents).toHaveLength(1);
    });

    it('handles empty response from LLM', async () => {
      const agent = createAgent(new MockLlm([[{ type: 'done' }]]));
      const events = await collectEvents(agent.processMessage('hi'));
      const doneEvents = events.filter((e) => e.type === 'done');
      expect(doneEvents).toHaveLength(1);
    });

    it('handles LLM error gracefully', async () => {
      const errorLlm = new MockLlm();
      errorLlm.chat = async function* () {
        yield { type: 'error' as const, error: 'LLM unavailable' };
      };

      const agent = createAgent(errorLlm);
      const events = await collectEvents(agent.processMessage('test'));

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toContain('LLM unavailable');
    });

    it('handles LLM throwing exception', async () => {
      const throwLlm = new MockLlm();
      throwLlm.chat = async function* () {
        throw new Error('Connection refused');
      };

      const agent = createAgent(throwLlm);
      const events = await collectEvents(agent.processMessage('test'));

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toContain('Connection refused');
    });
  });

  // ─── Slash Commands ─────────────────────────────────────────────────────

  describe('slash commands', () => {
    it('/code switches to code mode', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/code'));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mode_switch');
      expect(events[0].mode).toContain('Code');
    });

    it('/ask switches to ask mode', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/ask'));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mode_switch');
    });

    it('/plan switches to plan mode', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/plan'));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mode_switch');
    });

    it('/new clears conversation', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/new'));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('done');
      expect(events[0].text).toContain('cleared');
    });

    it('/clear clears conversation', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/clear'));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('done');
      expect(events[0].text).toContain('cleared');
    });

    it('/help returns help text', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/help'));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('done');
      expect(events[0].text).toContain('/code');
      expect(events[0].text).toContain('/ask');
      expect(events[0].text).toContain('Available tools');
    });

    it('/undo without snapshot manager reports unavailable', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/undo'));

      expect(events).toHaveLength(1);
      expect(events[0].text).toContain('not available');
    });

    it('/advanced switches to advanced mode', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/advanced'));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mode_switch');
    });

    it('/orchestrator switches to orchestrator mode', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/orchestrator'));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mode_switch');
    });
  });

  // ─── Prompt-prefix commands ─────────────────────────────────────────────

  describe('prompt-prefix commands', () => {
    it('/explain with content is processed through LLM', async () => {
      const agent = createAgent(
        new MockLlm([[{ type: 'text', text: 'Here is the explanation' }, { type: 'done' }]]),
      );
      const events = await collectEvents(agent.processMessage('/explain function foo() {}'));

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);
    });

    it('/explain without content returns usage hint', async () => {
      const agent = createAgent();
      const events = await collectEvents(agent.processMessage('/explain'));

      // Since the slash command handler returns null for /explain with no content,
      // it falls through — but with empty trimmed remainder it actually gets usage
      expect(events).toHaveLength(1);
      expect(events[0].text).toContain('Usage');
    });

    it('/fix triggers explanation in LLM response', async () => {
      const agent = createAgent(
        new MockLlm([[{ type: 'text', text: 'Fixed the bug' }, { type: 'done' }]]),
      );
      const events = await collectEvents(agent.processMessage('/fix const x = undefined.y'));

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);
    });

    it('/test triggers test generation', async () => {
      const agent = createAgent(
        new MockLlm([[{ type: 'text', text: 'describe...' }, { type: 'done' }]]),
      );
      const events = await collectEvents(agent.processMessage('/test function add(a, b) {}'));

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);
    });

    it('/review triggers code review', async () => {
      const agent = createAgent(
        new MockLlm([[{ type: 'text', text: 'Issues found' }, { type: 'done' }]]),
      );
      const events = await collectEvents(agent.processMessage('/review let x = 1'));

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);
    });
  });

  // ─── Tool Calls ─────────────────────────────────────────────────────────

  describe('tool calls', () => {
    it('executes tool calls from LLM and feeds results back', async () => {
      // First call: LLM requests tool call; Second call: LLM responds with text
      const llm = new MockLlm([
        [
          {
            type: 'tool_call',
            toolCall: { name: 'read_file', parameters: { path: 'test.txt' } },
            toolCallId: 'call_1',
          },
        ],
        [{ type: 'text', text: 'File contents are: hello' }, { type: 'done' }],
      ]);

      const modeEngine = new ModeEngine();
      const toolRegistry = new ToolRegistry(modeEngine, {
        autoApprove: { read: true, edit: true, command: true, mcp: true, browser: true },
      });
      const readFileTool: Tool = {
        name: 'read_file',
        group: 'read',
        description: 'Read a file',
        parameters: [{ name: 'path', type: 'string', description: 'Path', required: true }],
        execute: async () => ({ success: true, content: 'hello' }),
      };
      toolRegistry.register(readFileTool);

      const agent = new AgentLoop(
        llm,
        toolRegistry,
        new ConversationManager(),
        modeEngine,
        { maxToolRounds: 10, maxContextTokens: 8192, enableCompaction: false },
        new RedactionEngine(),
      );

      const events = await collectEvents(agent.processMessage('read test.txt'));

      const toolCallEvents = events.filter((e) => e.type === 'tool_call');
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0].toolCall!.name).toBe('read_file');

      const toolResultEvents = events.filter((e) => e.type === 'tool_result');
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0].toolResult!.success).toBe(true);

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);
    });

    it('respects maxToolRounds limit', async () => {
      // LLM always requests a tool call — should hit the limit
      const infiniteToolLlm = new MockLlm();
      infiniteToolLlm.chat = async function* () {
        yield {
          type: 'tool_call' as const,
          toolCall: { name: 'noop', parameters: {} },
          toolCallId: 'call_x',
        };
      };

      const modeEngine = new ModeEngine();
      const toolRegistry = new ToolRegistry(modeEngine, {
        autoApprove: { read: true, edit: true, command: true, mcp: true, browser: true },
      });
      const noopTool: Tool = {
        name: 'noop',
        group: 'read',
        description: 'No-op',
        parameters: [],
        execute: async () => ({ success: true, content: 'ok' }),
      };
      toolRegistry.register(noopTool);

      const agent = new AgentLoop(
        infiniteToolLlm,
        toolRegistry,
        new ConversationManager(),
        modeEngine,
        { maxToolRounds: 3, maxContextTokens: 8192, enableCompaction: false },
        new RedactionEngine(),
      );

      const events = await collectEvents(agent.processMessage('loop'));

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);
      expect(errorEvents[0].error).toContain('maximum tool rounds');
    });
  });

  // ─── Self-correction ────────────────────────────────────────────────────

  describe('self-correction', () => {
    it('retries failed execute_command with self-correction', async () => {
      let callCount = 0;
      const llm = new MockLlm();
      llm.chat = async function* () {
        callCount++;
        if (callCount <= 2) {
          yield {
            type: 'tool_call' as const,
            toolCall: { name: 'execute_command', parameters: { command: 'npm test' } },
            toolCallId: `call_${callCount}`,
          };
        } else {
          yield { type: 'text' as const, text: 'Tests pass now!' };
          yield { type: 'done' as const };
        }
      };

      let execCount = 0;
      const modeEngine = new ModeEngine();
      const toolRegistry = new ToolRegistry(modeEngine, {
        autoApprove: { read: true, edit: true, command: true, mcp: true, browser: true },
      });
      const execTool: Tool = {
        name: 'execute_command',
        group: 'command',
        description: 'Run a command',
        parameters: [{ name: 'command', type: 'string', description: 'Command', required: true }],
        execute: async () => {
          execCount++;
          if (execCount === 1) {
            return { success: false, content: 'Error: test failed' };
          }
          return { success: true, content: 'All tests pass' };
        },
      };
      toolRegistry.register(execTool);

      const agent = new AgentLoop(
        llm,
        toolRegistry,
        new ConversationManager(),
        modeEngine,
        {
          maxToolRounds: 10,
          maxContextTokens: 8192,
          maxSelfCorrectionAttempts: 3,
          enableCompaction: false,
        },
        new RedactionEngine(),
      );

      const events = await collectEvents(agent.processMessage('run tests'));

      const correctionEvents = events.filter((e) => e.type === 'self_correction');
      expect(correctionEvents.length).toBeGreaterThan(0);
      expect(correctionEvents[0].text).toContain('self-correction');
    });
  });

  // ─── Mode & Utility ─────────────────────────────────────────────────────

  describe('utility methods', () => {
    it('setLlm updates the LLM adapter', async () => {
      const agent = createAgent(new MockLlm([[{ type: 'text', text: 'first' }, { type: 'done' }]]));

      // Process first message with original LLM
      const events1 = await collectEvents(agent.processMessage('hi'));
      expect(events1.find((e) => e.type === 'text')?.text).toBe('first');

      // Switch LLM
      agent.setLlm(new MockLlm([[{ type: 'text', text: 'second' }, { type: 'done' }]]));

      const events2 = await collectEvents(agent.processMessage('hi again'));
      expect(events2.find((e) => e.type === 'text')?.text).toBe('second');
    });

    it('getMode returns current active mode', () => {
      const agent = createAgent();
      const mode = agent.getMode();
      expect(mode.slug).toBe('code');
      expect(mode.name).toContain('Code');
    });
  });

  // ─── Custom Commands ────────────────────────────────────────────────────

  describe('custom commands', () => {
    it('handles custom slash commands from config', async () => {
      const modeEngine = new ModeEngine();
      const toolRegistry = new ToolRegistry(modeEngine);
      const conversationManager = new ConversationManager();

      const customCommands = new Map([
        ['scaffold', { description: 'Scaffold code', prompt: 'Create boilerplate for:' }],
      ]);

      const agent = new AgentLoop(
        new MockLlm([[{ type: 'text', text: 'Scaffolded!' }, { type: 'done' }]]),
        toolRegistry,
        conversationManager,
        modeEngine,
        {
          maxToolRounds: 10,
          maxContextTokens: 8192,
          customCommands,
          enableCompaction: false,
        },
        new RedactionEngine(),
      );

      const events = await collectEvents(agent.processMessage('/scaffold a React component'));
      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);
    });
  });

  // ─── Conversation Compaction Integration ────────────────────────────────

  describe('compaction integration', () => {
    it('triggers compaction when conversation is long', async () => {
      const modeEngine = new ModeEngine();
      const toolRegistry = new ToolRegistry(modeEngine);
      const conversationManager = new ConversationManager();

      // Pre-fill conversation with lots of messages to exceed 6000 token threshold
      // 6000 tokens ≈ 24000 chars. Add messages totaling ~30000 chars
      for (let i = 0; i < 30; i++) {
        conversationManager.addMessage({ role: 'user', content: 'A'.repeat(500) });
        conversationManager.addMessage({ role: 'assistant', content: 'B'.repeat(500) });
      }

      const agent = new AgentLoop(
        new MockLlm([[{ type: 'text', text: 'Compacted response' }, { type: 'done' }]]),
        toolRegistry,
        conversationManager,
        modeEngine,
        {
          maxToolRounds: 10,
          maxContextTokens: 8192,
          enableCompaction: true,
        },
        new RedactionEngine(),
      );

      const events = await collectEvents(agent.processMessage('continue'));
      const compactionEvents = events.filter((e) => e.type === 'compaction');
      expect(compactionEvents).toHaveLength(1);
      expect(compactionEvents[0].text).toContain('compacted');
    });
  });

  // ─── Skills Integration ─────────────────────────────────────────────────

  describe('skills integration', () => {
    it('activates matching skills based on message content', async () => {
      const mockSkillsLoader = {
        loadAll: async () => [
          {
            name: 'react-patterns',
            description: 'Guidelines for React component development',
            instructions: 'Always use functional components.',
            applyTo: [],
          },
        ],
        loadByName: async () => null,
        getMatchingSkills: async () => [],
      };

      const modeEngine = new ModeEngine();
      const toolRegistry = new ToolRegistry(modeEngine);
      const conversationManager = new ConversationManager();

      const agent = new AgentLoop(
        new MockLlm([[{ type: 'text', text: 'Done' }, { type: 'done' }]]),
        toolRegistry,
        conversationManager,
        modeEngine,
        {
          maxToolRounds: 10,
          maxContextTokens: 8192,
          enableCompaction: false,
          skillsLoader: mockSkillsLoader as any,
        },
        new RedactionEngine(),
      );

      const events = await collectEvents(
        agent.processMessage('Create a React component for user profile'),
      );
      const skillEvents = events.filter((e) => e.type === 'skill_activated');
      expect(skillEvents).toHaveLength(1);
      expect(skillEvents[0].text).toContain('react-patterns');
    });
  });

  // ─── RAG Integration ────────────────────────────────────────────────────

  describe('RAG integration', () => {
    it('injects RAG context when pipeline returns results', async () => {
      const mockRag = {
        retrieve: () => [
          {
            content: 'function helper() {}',
            source: 'file',
            filePath: 'src/utils.ts',
            startLine: 1,
            endLine: 1,
            score: 0.9,
          },
        ],
        index: async () => {},
      };

      const modeEngine = new ModeEngine();
      const toolRegistry = new ToolRegistry(modeEngine);
      const conversationManager = new ConversationManager();

      const agent = new AgentLoop(
        new MockLlm([[{ type: 'text', text: 'Used context' }, { type: 'done' }]]),
        toolRegistry,
        conversationManager,
        modeEngine,
        {
          maxToolRounds: 10,
          maxContextTokens: 8192,
          enableCompaction: false,
          ragPipeline: mockRag as any,
        },
        new RedactionEngine(),
      );

      const events = await collectEvents(agent.processMessage('tell me about helpers'));

      // The RAG context should be injected — verify by checking conversation messages
      const messages = conversationManager.getMessages();
      const systemMsgs = messages.filter((m) => m.role === 'system');
      const hasRagContext = systemMsgs.some((m) => m.content.includes('retrieved_context'));
      expect(hasRagContext).toBe(true);
    });
  });

  // ─── loadCustomCommands ─────────────────────────────────────────────────

  describe('loadCustomCommands', () => {
    it('loads commands from .opencob/commands/ directory', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cmds-'));
      const cmdDir = path.join(tmpDir, '.opencob', 'commands');
      fs.mkdirSync(cmdDir, { recursive: true });
      fs.writeFileSync(
        path.join(cmdDir, 'scaffold.md'),
        '---\ndescription: Scaffold code\n---\nCreate boilerplate for the project.',
      );

      const modeEngine = new ModeEngine();
      const toolRegistry = new ToolRegistry(modeEngine);
      const conversationManager = new ConversationManager();

      const agent = new AgentLoop(
        new MockLlm([[{ type: 'text', text: 'Done' }, { type: 'done' }]]),
        toolRegistry,
        conversationManager,
        modeEngine,
        {
          maxToolRounds: 10,
          maxContextTokens: 8192,
          workspaceRoot: tmpDir,
          enableCompaction: false,
        },
        new RedactionEngine(),
      );

      await agent.loadCustomCommands();
      // Now /scaffold should work as a custom command
      const events = await collectEvents(agent.processMessage('/scaffold a component'));
      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('skips when workspaceRoot is not set', async () => {
      const agent = createAgent();
      // Should not throw
      await agent.loadCustomCommands();
    });

    it('handles commands without frontmatter', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cmds2-'));
      const cmdDir = path.join(tmpDir, '.opencob', 'commands');
      fs.mkdirSync(cmdDir, { recursive: true });
      fs.writeFileSync(path.join(cmdDir, 'deploy.md'), 'Deploy the application to production.');

      const modeEngine = new ModeEngine();
      const toolRegistry = new ToolRegistry(modeEngine);
      const conversationManager = new ConversationManager();

      const agent = new AgentLoop(
        new MockLlm([[{ type: 'text', text: 'Deployed' }, { type: 'done' }]]),
        toolRegistry,
        conversationManager,
        modeEngine,
        {
          maxToolRounds: 10,
          maxContextTokens: 8192,
          workspaceRoot: tmpDir,
          enableCompaction: false,
        },
        new RedactionEngine(),
      );

      await agent.loadCustomCommands();
      const events = await collectEvents(agent.processMessage('/deploy now'));
      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ─── Mention Parser Integration ────────────────────────────────────────

  describe('mention parser integration', () => {
    it('processes @mentions when workspaceRoot is set', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mentions-'));
      fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello World');

      const agent = createAgent(
        new MockLlm([[{ type: 'text', text: 'Processed' }, { type: 'done' }]]),
        { workspaceRoot: tmpDir },
      );
      const events = await collectEvents(agent.processMessage('read @hello.txt'));
      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
