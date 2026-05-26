import type { LlmAdapter } from '../llm/types.js';
import type { ToolExecutionResult } from '../tools/tool-registry.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ConversationManager } from '../conversation/conversation-manager.js';
import { ModeEngine } from '../modes/mode-engine.js';
import { RedactionEngine } from '../security/redaction-engine.js';
import { MentionParser } from '../context/mention-parser.js';
import { ConversationCompactor } from './conversation-compactor.js';
import { PostEditVerifier } from './post-edit-verifier.js';
import { TaskComplexityClassifier, type ComplexityScore } from './task-complexity.js';
import type { SnapshotManager } from '../checkpoints/snapshot-manager.js';
import type { RAGPipeline } from '../indexer/rag-pipeline.js';
import type { SkillsLoader } from '../skills/skills-loader.js';
import { OrchestratorEngine } from './orchestrator-engine.js';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';

export type AgentPhase =
  | 'preparing'
  | 'gathering_context'
  | 'planning'
  | 'reasoning'
  | 'analysing'
  | 'processing'
  | 'evaluating'
  | 'writing_code'
  | 'verifying'
  | 'summarizing';

export interface AgentEvent {
  type:
    | 'text'
    | 'tool_call'
    | 'tool_result'
    | 'error'
    | 'done'
    | 'mode_switch'
    | 'self_correction'
    | 'compaction'
    | 'verification'
    | 'skill_activated'
    | 'phase_change'
    | 'thinking'
    | 'thinking_end'
    | 'plan_created'
    | 'plan_step_update'
    | 'changes_summary';
  text?: string;
  toolCall?: { name: string; parameters: Record<string, unknown> };
  toolResult?: ToolExecutionResult;
  error?: string;
  mode?: string;
  attempt?: number;
  complexity?: ComplexityScore;
  phase?: AgentPhase;
  thinking?: string;
  plan?: { goal: string; steps: Array<{ id: number; description: string; mode: string }> };
  planStep?: {
    stepIndex: number;
    status: 'pending' | 'running' | 'done' | 'failed';
    summary?: string;
  };
  changesSummary?: {
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    files: Array<{ path: string; status: 'M' | 'A' | 'D' | 'R'; added: number; removed: number }>;
  };
}

export interface AgentConfig {
  maxToolRounds: number;
  maxContextTokens: number;
  workspaceRoot?: string;
  maxSelfCorrectionAttempts?: number;
  enableCompaction?: boolean;
  enablePostEditVerification?: boolean;
  enableComplexityClassifier?: boolean;
  ragPipeline?: RAGPipeline;
  skillsLoader?: SkillsLoader;
  customCommands?: Map<string, { description: string; prompt: string }>;
}

const DEFAULT_CONFIG: AgentConfig = {
  maxToolRounds: 10,
  maxContextTokens: 8192,
  maxSelfCorrectionAttempts: 3,
  enableCompaction: true,
  enablePostEditVerification: true,
  enableComplexityClassifier: true,
};

export class AgentLoop {
  private llm: LlmAdapter;
  private toolRegistry: ToolRegistry;
  private conversationManager: ConversationManager;
  private modeEngine: ModeEngine;
  private redactionEngine: RedactionEngine;
  private mentionParser: MentionParser | null;
  private compactor: ConversationCompactor | null;
  private snapshotManager: SnapshotManager | null;
  private postEditVerifier: PostEditVerifier | null;
  private complexityClassifier: TaskComplexityClassifier;
  private ragPipeline: RAGPipeline | null;
  private skillsLoader: SkillsLoader | null;
  private customCommands: Map<string, { description: string; prompt: string }>;
  private orchestrator: OrchestratorEngine;
  private config: AgentConfig;
  private turnFileChanges: Array<{
    path: string;
    status: 'M' | 'A' | 'D' | 'R';
    added: number;
    removed: number;
  }> = [];

  constructor(
    llm: LlmAdapter,
    toolRegistry: ToolRegistry,
    conversationManager: ConversationManager,
    modeEngine: ModeEngine,
    config?: Partial<AgentConfig>,
    redactionEngine?: RedactionEngine,
    snapshotManager?: SnapshotManager,
  ) {
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.conversationManager = conversationManager;
    this.modeEngine = modeEngine;
    this.redactionEngine = redactionEngine ?? new RedactionEngine();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.mentionParser = this.config.workspaceRoot
      ? new MentionParser(this.config.workspaceRoot)
      : null;
    this.compactor = this.config.enableCompaction ? new ConversationCompactor(llm) : null;
    this.snapshotManager = snapshotManager ?? null;
    this.postEditVerifier =
      this.config.workspaceRoot && this.config.enablePostEditVerification
        ? new PostEditVerifier(this.config.workspaceRoot)
        : null;
    this.complexityClassifier = new TaskComplexityClassifier();
    this.ragPipeline = this.config.ragPipeline ?? null;
    this.skillsLoader = this.config.skillsLoader ?? null;
    this.customCommands = this.config.customCommands ?? new Map();
    this.orchestrator = new OrchestratorEngine(llm, modeEngine);
  }

  /** Hot-swap the LLM adapter (e.g. when user changes provider setting) */
  setLlmAdapter(adapter: LlmAdapter): void {
    this.llm = adapter;
    if (this.compactor) {
      this.compactor = new ConversationCompactor(adapter);
    }
    this.orchestrator = new OrchestratorEngine(adapter, this.modeEngine);
  }

  /** Process a user message and yield agent events (streaming) */
  async *processMessage(userMessage: string): AsyncIterable<AgentEvent> {
    // Handle slash commands
    const slashResult = this.handleSlashCommand(userMessage);
    if (slashResult) {
      yield slashResult;
      return;
    }

    // Handle prompt-prefix slash commands (/explain, /fix, /test, /review)
    let effectiveMessage = userMessage;
    const trimmed = userMessage.trim();
    if (trimmed.startsWith('/')) {
      const [cmd] = trimmed.split(/\s+/);
      const promptCommands: Record<string, string> = {
        '/explain':
          'Explain the following code in detail. What does it do, how does it work, and what are the key patterns used?\n\n',
        '/fix':
          'Analyze the following code for bugs, errors, and issues. Fix all problems you find and explain each fix.\n\n',
        '/test':
          'Generate comprehensive unit tests for the following code. Cover edge cases, error paths, and typical usage.\n\n',
        '/review':
          'Review the following code for quality, security, performance, and maintainability issues. Suggest improvements.\n\n',
      };
      if (cmd in promptCommands) {
        const remainder = trimmed.slice(cmd.length).trim();
        effectiveMessage = promptCommands[cmd] + remainder;
      } else {
        // Check custom commands (F17)
        const cmdName = cmd.slice(1);
        if (this.customCommands.has(cmdName)) {
          const customCmd = this.customCommands.get(cmdName)!;
          const remainder = trimmed.slice(cmd.length).trim();
          effectiveMessage = customCmd.prompt + '\n\n' + remainder;
        }
      }
    }

    // Emit preparing phase
    yield { type: 'phase_change', phase: 'preparing' };

    // Reset file changes tracking for this turn
    this.turnFileChanges = [];

    // Orchestrator mode delegation (§3.17, §8.9.4)
    const activeMode = this.modeEngine.getActive();
    if (activeMode.slug === 'orchestrator') {
      yield* this.runOrchestrator(effectiveMessage);
      return;
    }

    // Add user message to conversation
    // Parse @mentions and resolve context
    let processedMessage = effectiveMessage;
    let mentionContext = '';
    if (this.mentionParser) {
      yield { type: 'phase_change', phase: 'gathering_context' };
      const parsed = await this.mentionParser.parse(effectiveMessage);
      processedMessage = parsed.cleanText;
      mentionContext = parsed.contextBlock;
    }

    this.conversationManager.addMessage({
      role: 'user',
      content: processedMessage + mentionContext,
    });

    // Auto-inject RAG context (F8.2)
    let ragContext = '';
    if (this.ragPipeline) {
      const retrieved = this.ragPipeline.retrieve(processedMessage, { topK: 5, minScore: 0.1 });
      if (retrieved.length > 0) {
        const snippets = retrieved
          .map(
            (r) =>
              `<context source="${r.source}" file="${r.filePath}" lines="${r.startLine}-${r.endLine}" score="${r.score.toFixed(2)}">\n${r.content}\n</context>`,
          )
          .join('\n');
        ragContext = `\n\n<retrieved_context>\n${snippets}\n</retrieved_context>`;
      }
    }

    // Auto-activate matching skills (F19)
    let skillContext = '';
    if (this.skillsLoader) {
      try {
        const skills = await this.skillsLoader.loadAll();
        const matchingSkills = skills.filter((s) => {
          if (!s.description) return false;
          const desc = s.description.toLowerCase();
          const msg = processedMessage.toLowerCase();
          // Simple keyword matching between skill description and user message
          const descWords = desc.split(/\s+/).filter((w) => w.length > 3);
          return descWords.some((w) => msg.includes(w));
        });

        if (matchingSkills.length > 0) {
          const skill = matchingSkills[0]; // Use best match
          skillContext = `\n\n<activated_skill name="${skill.name}">\n${skill.instructions}\n</activated_skill>`;
          yield { type: 'skill_activated', text: `Skill activated: ${skill.name}` };
        }
      } catch {
        // Skills loading failure is non-fatal
      }
    }

    // Inject RAG + skill context into the conversation (as system context)
    if (ragContext || skillContext) {
      this.conversationManager.addMessage({
        role: 'system',
        content: (ragContext + skillContext).trim(),
      });
    }

    // Start a new turn snapshot for undo support
    if (this.snapshotManager) {
      this.snapshotManager.startTurn();
    }

    // Check if conversation needs compaction
    if (this.compactor) {
      const messages = this.conversationManager.getMessages();
      if (this.compactor.needsCompaction(messages)) {
        const compacted = await this.compactor.compact(messages);
        // Replace conversation messages with compacted version
        const conv = this.conversationManager.getActive();
        conv.messages = compacted;
        yield { type: 'compaction', text: 'Conversation compacted to fit context window.' };
      }
    }

    // Run the agent loop (LLM call → tool calls → LLM call → ...)
    let rounds = 0;
    let selfCorrectionAttempts = 0;
    const maxCorrections = this.config.maxSelfCorrectionAttempts ?? 3;

    while (rounds < this.config.maxToolRounds) {
      rounds++;

      // Build messages for LLM
      const systemPrompt = this.buildSystemPrompt();
      const messages = this.conversationManager.getContextWindow(
        systemPrompt,
        this.config.maxContextTokens,
      );

      // Redact secrets before sending to LLM
      const redactedMessages = this.redactionEngine.redactMessages(messages);

      // Get tool definitions for native function calling
      const toolDefs = this.toolRegistry.getToolDefinitions();

      // Emit reasoning phase before LLM call
      yield { type: 'phase_change', phase: 'reasoning' };

      // Stream LLM response
      let fullResponse = '';
      let pendingToolCall: { name: string; parameters: Record<string, unknown> } | null = null;
      let pendingToolCallId = '';

      try {
        for await (const chunk of this.llm.chat(redactedMessages, { tools: toolDefs })) {
          switch (chunk.type) {
            case 'text':
              if (chunk.text) {
                fullResponse += chunk.text;
                yield { type: 'text', text: chunk.text };
              }
              break;

            case 'tool_call':
              if (chunk.toolCall) {
                pendingToolCall = chunk.toolCall;
                pendingToolCallId = chunk.toolCallId ?? `call_${rounds}`;
                yield { type: 'phase_change', phase: 'analysing' };
                yield { type: 'tool_call', toolCall: chunk.toolCall };
              }
              break;

            case 'error':
              yield { type: 'error', error: chunk.error };
              this.conversationManager.addMessage({
                role: 'assistant',
                content: `Error: ${chunk.error}`,
              });
              return;

            case 'done':
              break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', error: msg };
        return;
      }

      // If no tool call, we're done — save assistant response
      if (!pendingToolCall) {
        if (fullResponse) {
          this.conversationManager.addMessage({
            role: 'assistant',
            content: fullResponse,
          });
        }
        // Emit changes summary if files were modified during this turn (§8.4.1.1)
        const changeSummary = this.buildChangesSummaryEvent();
        if (changeSummary) yield changeSummary;
        yield { type: 'done' };
        return;
      }

      // Save the assistant's response (including the tool call intent)
      this.conversationManager.addMessage({
        role: 'assistant',
        content: fullResponse || '',
        toolCalls: [
          {
            id: pendingToolCallId,
            type: 'function',
            function: {
              name: pendingToolCall.name,
              arguments: JSON.stringify(pendingToolCall.parameters),
            },
          },
        ],
      });

      // Capture file snapshot before modification (for undo support)
      if (this.snapshotManager && pendingToolCall) {
        const editTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
        if (editTools.includes(pendingToolCall.name)) {
          const filePath = pendingToolCall.parameters.path as string;
          if (filePath) {
            this.snapshotManager.captureFile(filePath);
          }
        }
      }

      // Execute the tool
      yield { type: 'phase_change', phase: 'processing' };
      const result = await this.toolRegistry.execute({
        toolName: pendingToolCall.name,
        parameters: pendingToolCall.parameters,
      });

      yield { type: 'phase_change', phase: 'evaluating' };
      yield { type: 'tool_result', toolResult: result };

      // Track file changes for changes summary bar (§8.4.1.1)
      if (result.success) {
        const writeTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
        if (writeTools.includes(pendingToolCall.name)) {
          const filePath = pendingToolCall.parameters.path as string | undefined;
          if (filePath) {
            this.trackFileChange(filePath, result.content);
          }
        }
      }

      // Post-edit verification (F6.4): auto-check syntax after write tools
      if (this.postEditVerifier && result.success) {
        const writeTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
        if (writeTools.includes(pendingToolCall.name)) {
          const filePaths: string[] = [];
          const p = pendingToolCall.parameters.path as string | undefined;
          if (p) filePaths.push(p);
          for (const fp of filePaths) {
            const verification = await this.postEditVerifier.verify(fp);
            if (!verification.valid) {
              const errMsg = `Post-edit verification failed for ${fp}:\n${verification.errors.join('\n')}`;
              yield { type: 'verification', text: errMsg };
              // Add to conversation so LLM can self-correct
              this.conversationManager.addMessage({
                role: 'system',
                content: `[POST-EDIT WARNING] ${errMsg}\nPlease review and fix these syntax issues.`,
              });
            }
          }
        }
      }

      // Self-correction: if execute_command failed (non-zero exit), try to diagnose and fix
      if (
        !result.success &&
        pendingToolCall.name === 'execute_command' &&
        selfCorrectionAttempts < maxCorrections
      ) {
        selfCorrectionAttempts++;
        yield {
          type: 'self_correction',
          text: `Build/test failed — attempting self-correction (attempt ${selfCorrectionAttempts}/${maxCorrections})`,
          attempt: selfCorrectionAttempts,
        };

        // Add error context so LLM can diagnose
        this.conversationManager.addMessage({
          role: 'tool',
          content: `[SELF-CORRECTION] The command failed. Here is the error output:\n${result.content}\n\nPlease diagnose the error and fix the issue. This is self-correction attempt ${selfCorrectionAttempts} of ${maxCorrections}.`,
          name: pendingToolCall.name,
          toolCallId: pendingToolCallId,
        });

        continue; // Continue the loop — LLM will see the error and try to fix
      }

      // Add tool result to conversation
      this.conversationManager.addMessage({
        role: 'tool',
        content: result.content,
        name: pendingToolCall.name,
        toolCallId: pendingToolCallId,
      });

      // Continue the loop — the LLM will see the tool result and either respond or call another tool
    }

    // Max rounds exceeded
    const maxRoundsSummary = this.buildChangesSummaryEvent();
    if (maxRoundsSummary) yield maxRoundsSummary;
    yield {
      type: 'error',
      error: `Agent reached maximum tool rounds (${this.config.maxToolRounds}). Stopping.`,
    };
    yield { type: 'done' };
  }

  private handleSlashCommand(input: string): AgentEvent | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;

    const [command] = trimmed.split(/\s+/);
    const modeCommands: Record<string, string> = {
      '/code': 'code',
      '/ask': 'ask',
      '/plan': 'plan',
      '/advanced': 'advanced',
      '/orchestrator': 'orchestrator',
    };

    if (command in modeCommands) {
      const slug = modeCommands[command];
      this.modeEngine.setActive(slug);
      const mode = this.modeEngine.getActive();
      return { type: 'mode_switch', mode: mode.name, text: `Switched to ${mode.name} mode` };
    }

    if (command === '/new' || command === '/clear') {
      this.conversationManager.clear();
      return { type: 'done', text: 'Conversation cleared.' };
    }

    if (command === '/undo') {
      if (!this.snapshotManager) {
        return { type: 'done', text: 'Undo not available — no snapshot manager configured.' };
      }
      const result = this.snapshotManager.undoLastTurn();
      if (!result) {
        return { type: 'done', text: 'Nothing to undo.' };
      }
      const fileList = result.restoredFiles.join('\n  ');
      return {
        type: 'done',
        text: `Undid turn ${result.turnId}. Restored ${result.restoredFiles.length} file(s):\n  ${fileList}`,
      };
    }

    if (command === '/help') {
      const available = this.toolRegistry.listAvailable();
      const toolList = available.map((t) => `  ${t.name} — ${t.description}`).join('\n');
      const customCmdList =
        this.customCommands.size > 0
          ? Array.from(this.customCommands.entries())
              .map(([name, cmd]) => `  /${name} — ${cmd.description}`)
              .join('\n')
          : '';
      const help = [
        'Available commands:',
        '  /code        — Switch to Code mode',
        '  /ask         — Switch to Ask mode',
        '  /plan        — Switch to Plan mode',
        '  /advanced    — Switch to Advanced mode',
        '  /orchestrator — Switch to Orchestrator mode',
        '  /new         — Start a new conversation',
        '  /clear       — Clear conversation',
        "  /undo        — Undo last turn's file changes",
        '  /explain     — Explain selected code or file',
        '  /fix         — Fix errors in code',
        '  /test        — Generate tests',
        '  /review      — Review code for issues',
        '  /help        — Show this help',
        customCmdList ? `\nCustom commands:\n${customCmdList}` : '',
        '',
        `Available tools (${this.modeEngine.getActive().name} mode):`,
        toolList || '  (no tools available in this mode)',
      ]
        .filter(Boolean)
        .join('\n');

      return { type: 'done', text: help };
    }

    // Slash commands that inject a prompt prefix and continue to the agent loop
    const promptCommands: Record<string, string> = {
      '/explain':
        'Explain the following code in detail. What does it do, how does it work, and what are the key patterns used?\n\n',
      '/fix':
        'Analyze the following code for bugs, errors, and issues. Fix all problems you find and explain each fix.\n\n',
      '/test':
        'Generate comprehensive unit tests for the following code. Cover edge cases, error paths, and typical usage.\n\n',
      '/review':
        'Review the following code for quality, security, performance, and maintainability issues. Suggest improvements.\n\n',
    };

    if (command in promptCommands) {
      const remainder = trimmed.slice(command.length).trim();
      if (!remainder) {
        return { type: 'done', text: `Usage: ${command} <code or file reference>` };
      }
      // Return null so processMessage handles it — but rewrite the message with the prompt prefix
      return null;
    }

    // Custom commands from .OpenCob/commands/ (F17)
    const cmdName = command.slice(1); // remove leading /
    if (this.customCommands.has(cmdName)) {
      const _customCmd = this.customCommands.get(cmdName)!;
      const _remainder = trimmed.slice(command.length).trim();
      // Return null so processMessage rewrites it with the custom prompt
      return null;
    }

    return null;
  }

  /** Load custom commands from .OpenCob/commands/ directory (F17) */
  async loadCustomCommands(): Promise<void> {
    if (!this.config.workspaceRoot) return;

    const dirs = [
      nodePath.resolve(this.config.workspaceRoot, '.OpenCob', 'commands'),
      nodePath.resolve(this.config.workspaceRoot, '.opencob', 'commands'),
    ];

    // Also check global commands
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (home) {
      dirs.push(nodePath.resolve(home, '.OpenCob', 'commands'));
      dirs.push(nodePath.resolve(home, '.opencob', 'commands'));
    }

    for (const dir of dirs) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const content = await fs.readFile(nodePath.resolve(dir, file), 'utf-8');
          const name = nodePath.basename(file, nodePath.extname(file));

          // Parse YAML frontmatter
          let description = name;
          let prompt = content;
          if (content.startsWith('---')) {
            const endIdx = content.indexOf('---', 3);
            if (endIdx > 0) {
              const frontmatter = content.slice(3, endIdx);
              const descMatch = frontmatter.match(/description:\s*(.+)/);
              if (descMatch) description = descMatch[1].trim();
              prompt = content.slice(endIdx + 3).trim();
            }
          }

          // Project commands override global
          this.customCommands.set(name, { description, prompt });
        }
      } catch {
        // Directory doesn't exist — skip
      }
    }
  }

  private buildSystemPrompt(): string {
    const mode = this.modeEngine.getActive();

    return [
      mode.roleDefinition,
      '',
      mode.customInstructions || '',
      '',
      '## Guidelines',
      '',
      '- Be concise and direct in your responses.',
      '- Use the available tools to accomplish tasks. Call tools rather than describing what you would do.',
      '- When modifying files, use apply_diff for targeted changes and write_to_file for new files.',
      '- Always read a file before modifying it.',
      '- Explain what you are doing and why before making changes.',
      '- If a tool call fails, diagnose the error and try a different approach.',
    ].join('\n');
  }

  /** Update the LLM adapter (e.g., when user switches models) */
  setLlm(llm: LlmAdapter): void {
    this.llm = llm;
  }

  /** Get current mode */
  getMode() {
    return this.modeEngine.getActive();
  }

  /** Get file changes from the current turn (§8.4.1.1) */
  getTurnFileChanges() {
    return this.turnFileChanges;
  }

  /** Track a file change after a successful write tool (§8.4.1.1) */
  private trackFileChange(filePath: string, resultContent: string): void {
    // Parse lines added/removed from result content heuristically
    const lines = resultContent.split('\n');
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    // If no diff markers, estimate from content length
    if (added === 0 && removed === 0) {
      added = Math.max(1, Math.ceil(resultContent.length / 80));
    }

    const existing = this.turnFileChanges.find((f) => f.path === filePath);
    if (existing) {
      existing.added += added;
      existing.removed += removed;
    } else {
      this.turnFileChanges.push({ path: filePath, status: 'M', added, removed });
    }
  }

  /** Emit changes summary event (§8.4.1.1) */
  private buildChangesSummaryEvent(): AgentEvent | null {
    if (this.turnFileChanges.length === 0) return null;
    const totalAdded = this.turnFileChanges.reduce((s, f) => s + f.added, 0);
    const totalRemoved = this.turnFileChanges.reduce((s, f) => s + f.removed, 0);
    return {
      type: 'changes_summary',
      changesSummary: {
        filesChanged: this.turnFileChanges.length,
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        files: [...this.turnFileChanges],
      },
    };
  }

  /**
   * Orchestrator mode — decompose task into plan, emit plan_created,
   * execute steps sequentially, emit plan_step_update per step (§3.17, §8.9.4)
   */
  private async *runOrchestrator(userMessage: string): AsyncIterable<AgentEvent> {
    yield { type: 'phase_change', phase: 'planning' };
    yield { type: 'thinking', thinking: 'Decomposing task into subtasks...' };

    const plan = await this.orchestrator.decompose(userMessage);

    // Emit plan_created with steps
    yield {
      type: 'plan_created',
      plan: {
        goal: plan.goal,
        steps: plan.subtasks.map((s) => ({ id: s.id, description: s.description, mode: s.mode })),
      },
    };
    yield { type: 'thinking_end' };

    // Execute each subtask sequentially
    for (const subtask of plan.subtasks) {
      subtask.status = 'running';
      yield {
        type: 'plan_step_update',
        planStep: { stepIndex: subtask.id - 1, status: 'running' },
      };

      // Switch to the subtask's mode
      this.orchestrator.switchToMode(subtask);

      // Build focused prompt with prior context
      const subtaskPrompt = this.orchestrator.buildSubtaskPrompt(plan, subtask);

      yield { type: 'phase_change', phase: 'reasoning' };
      yield { type: 'thinking', thinking: `Working on step ${subtask.id}: ${subtask.description}` };

      // Add subtask prompt to conversation and run inference
      this.conversationManager.addMessage({ role: 'user', content: subtaskPrompt });

      const systemPrompt = this.buildSystemPrompt();
      const messages = this.conversationManager.getContextWindow(
        systemPrompt,
        this.config.maxContextTokens,
      );
      const redactedMessages = this.redactionEngine.redactMessages(messages);

      let stepResult = '';
      try {
        for await (const chunk of this.llm.chat(redactedMessages)) {
          if (chunk.type === 'text' && chunk.text) {
            stepResult += chunk.text;
            yield { type: 'text', text: chunk.text };
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        subtask.status = 'failed';
        subtask.result = msg;
        yield { type: 'thinking_end' };
        yield {
          type: 'plan_step_update',
          planStep: { stepIndex: subtask.id - 1, status: 'failed', summary: msg },
        };
        continue;
      }

      subtask.status = 'done';
      subtask.result = stepResult.slice(0, 500);
      this.conversationManager.addMessage({ role: 'assistant', content: stepResult });

      yield { type: 'thinking_end' };
      yield {
        type: 'plan_step_update',
        planStep: { stepIndex: subtask.id - 1, status: 'done', summary: subtask.result },
      };
    }

    // Restore original mode
    this.modeEngine.setActive('orchestrator');

    // Emit changes summary if any files were modified
    const summary = this.buildChangesSummaryEvent();
    if (summary) yield summary;

    yield { type: 'done' };
  }
}
