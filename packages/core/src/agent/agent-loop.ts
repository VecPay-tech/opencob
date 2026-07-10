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
import { CustomizationLoader } from './customization-loader.js';
import type { HookContext } from './hooks-engine.js';
import { ChangeTracker } from './change-tracker.js';
import { GitContextResolver } from './git-context-resolver.js';
import { SystemPromptBuilder } from './system-prompt-builder.js';
import { SlashCommandHandler } from './slash-command-handler.js';
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
  private customizationLoader: CustomizationLoader | null;
  private config: AgentConfig;
  private changeTracker = new ChangeTracker();
  private gitResolver = new GitContextResolver();
  private promptBuilder: SystemPromptBuilder;
  private slashHandler: SlashCommandHandler;

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
    this.customizationLoader = this.config.workspaceRoot
      ? new CustomizationLoader(this.config.workspaceRoot)
      : null;
    this.promptBuilder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: this.customizationLoader,
      skillsLoader: this.config.skillsLoader ?? null,
      workspaceRoot: this.config.workspaceRoot,
    });
    this.slashHandler = new SlashCommandHandler({
      modeEngine,
      snapshotManager: snapshotManager ?? null,
      toolRegistry,
      customCommands: this.customCommands,
    });
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
    // Handle slash commands (mode switches, rewrites, and passthrough)
    const slashResult = this.slashHandler.handle(userMessage);
    if (slashResult.kind === 'event') {
      yield slashResult.event;
      return;
    }
    let effectiveMessage = userMessage;
    if (slashResult.kind === 'rewrite') effectiveMessage = slashResult.message;

    // Emit preparing phase
    yield { type: 'phase_change', phase: 'preparing' };

    // Reset file changes tracking for this turn
    this.changeTracker.reset();

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
      yield { type: 'thinking', text: 'Resolving file references and mentions' };
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
      yield { type: 'thinking', text: 'Searching codebase for relevant context' };
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
        yield { type: 'thinking', text: 'Checking for applicable skills' };
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
      const systemPrompt = this.promptBuilder.build();
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
      yield {
        type: 'thinking',
        text: 'Generating response' + (rounds > 1 ? ' (round ' + rounds + ')' : ''),
      };

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

      // Fallback: detect JSON text that looks like a tool call (model didn't use function calling)
      if (!pendingToolCall && fullResponse) {
        const parsed = this.tryParseTextToolCall(fullResponse);
        if (parsed) {
          pendingToolCall = parsed;
          pendingToolCallId = `text_call_${rounds}`;
          yield { type: 'phase_change', phase: 'analysing' };
          yield { type: 'tool_call', toolCall: parsed };
          // Clear the text so we don't display the JSON
          fullResponse = '';
        }
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
        const changeSummary = this.changeTracker.buildSummaryEvent();
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
      yield {
        type: 'thinking',
        text:
          'Executing ' +
          pendingToolCall.name +
          (pendingToolCall.parameters.path ? ': ' + pendingToolCall.parameters.path : ''),
      };

      // Fire onToolCallBefore hook
      if (this.customizationLoader) {
        const hookCtx: HookContext = {
          event: 'onToolCallBefore',
          toolName: pendingToolCall.name,
          filePath: pendingToolCall.parameters.path as string | undefined,
        };
        this.customizationLoader.fireHook(hookCtx);
      }

      const result = await this.toolRegistry.execute({
        toolName: pendingToolCall.name,
        parameters: pendingToolCall.parameters,
      });

      // Fire onToolCallAfter hook
      if (this.customizationLoader) {
        const hookCtx: HookContext = {
          event: 'onToolCallAfter',
          toolName: pendingToolCall.name,
          filePath: pendingToolCall.parameters.path as string | undefined,
          data: { success: result.success },
        };
        this.customizationLoader.fireHook(hookCtx);
      }

      yield { type: 'phase_change', phase: 'evaluating' };
      yield {
        type: 'thinking',
        text: result.success ? 'Tool completed successfully' : 'Tool returned an error',
      };
      yield { type: 'tool_result', toolResult: result };

      // Track file changes for changes summary bar (§8.4.1.1)
      if (result.success) {
        const writeTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
        if (writeTools.includes(pendingToolCall.name)) {
          const filePath = pendingToolCall.parameters.path as string | undefined;
          if (filePath) {
            // Use the file content from parameters for accurate line counting
            const fileContent = (pendingToolCall.parameters.content as string) || '';
            this.changeTracker.track(filePath, fileContent, pendingToolCall.name);

            // Fire onFileChange hook
            if (this.customizationLoader) {
              this.customizationLoader.fireHook({ event: 'onFileChange', filePath });
            }
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
    const maxRoundsSummary = this.changeTracker.buildSummaryEvent();
    if (maxRoundsSummary) yield maxRoundsSummary;
    yield {
      type: 'error',
      error: `Agent reached maximum tool rounds (${this.config.maxToolRounds}). Stopping.`,
    };
    yield { type: 'done' };
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

  /**
   * Try to parse a text response as a JSON tool call.
   * Some models output tool parameters as plain text JSON instead of using function calling.
   * Detects patterns like: {"path":"...", "content":"..."} → write_to_file
   */
  private tryParseTextToolCall(
    text: string,
  ): { name: string; parameters: Record<string, unknown> } | null {
    const trimmed = text.trim();
    // Must look like JSON object
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== 'object' || obj === null) return null;

      // Pattern: { path: "...", content: "..." } → write_to_file
      if (typeof obj.path === 'string' && typeof obj.content === 'string' && obj.path.length > 0) {
        return { name: 'write_to_file', parameters: { path: obj.path, content: obj.content } };
      }

      // Pattern: { name: "tool_name", parameters: {...} } → direct tool call
      if (typeof obj.name === 'string' && typeof obj.parameters === 'object') {
        return { name: obj.name, parameters: obj.parameters };
      }

      return null;
    } catch {
      return null;
    }
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
    return this.changeTracker.getChanges();
  }

  /** Non-streaming convenience method — runs processMessage and collects results */
  async run(
    prompt: string,
    _options?: { stream?: boolean; mode?: string },
  ): Promise<{
    content: string;
    toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  }> {
    let content = '';
    const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    let lastTextBeforeToolCall = '';
    for await (const event of this.processMessage(prompt)) {
      if (event.type === 'text' && event.text) {
        lastTextBeforeToolCall += event.text;
        content += event.text;
      } else if (event.type === 'tool_call' && event.toolCall) {
        toolCalls.push({ name: event.toolCall.name, params: event.toolCall.parameters });
        // If text accumulated before this tool call looks like JSON params, remove it from content
        const trimmed = lastTextBeforeToolCall.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          content = content.slice(0, content.length - lastTextBeforeToolCall.length);
        }
        lastTextBeforeToolCall = '';
      } else if (event.type !== 'text') {
        lastTextBeforeToolCall = '';
      }
    }
    return { content, toolCalls };
  }

  /**
   * Orchestrator mode — decompose task into plan, emit plan_created,
   * execute steps sequentially with full tool loop, emit plan_step_update per step (§3.17, §8.9.4)
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

    // Execute each subtask sequentially with full tool loop
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

      // Add subtask prompt to conversation
      this.conversationManager.addMessage({ role: 'user', content: subtaskPrompt });

      // Full tool loop for this subtask (same logic as processMessage main loop)
      let subtaskRounds = 0;
      let stepResult = '';
      let stepFailed = false;

      while (subtaskRounds < this.config.maxToolRounds) {
        subtaskRounds++;

        const systemPrompt = this.promptBuilder.build();
        const messages = this.conversationManager.getContextWindow(
          systemPrompt,
          this.config.maxContextTokens,
        );
        const redactedMessages = this.redactionEngine.redactMessages(messages);
        const toolDefs = this.toolRegistry.getToolDefinitions();

        yield { type: 'phase_change', phase: 'reasoning' };
        yield {
          type: 'thinking',
          thinking: `Generating response${subtaskRounds > 1 ? ' (round ' + subtaskRounds + ')' : ''}`,
        };

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
                  pendingToolCallId = chunk.toolCallId ?? `call_${subtask.id}_${subtaskRounds}`;
                  yield { type: 'phase_change', phase: 'analysing' };
                  yield { type: 'tool_call', toolCall: chunk.toolCall };
                }
                break;
              case 'error':
                yield { type: 'error', error: chunk.error };
                stepFailed = true;
                break;
              case 'done':
                break;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          yield { type: 'error', error: msg };
          stepFailed = true;
        }

        if (stepFailed) break;

        // No tool call → subtask complete
        if (!pendingToolCall) {
          stepResult = fullResponse;
          if (fullResponse) {
            this.conversationManager.addMessage({ role: 'assistant', content: fullResponse });
          }
          break;
        }

        // Save assistant response with tool call
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

        // Capture snapshot for undo
        if (this.snapshotManager) {
          const editTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
          if (editTools.includes(pendingToolCall.name)) {
            const filePath = pendingToolCall.parameters.path as string;
            if (filePath) this.snapshotManager.captureFile(filePath);
          }
        }

        // Execute the tool
        yield { type: 'phase_change', phase: 'processing' };
        yield {
          type: 'thinking',
          thinking:
            'Executing ' +
            pendingToolCall.name +
            (pendingToolCall.parameters.path ? ': ' + pendingToolCall.parameters.path : ''),
        };
        const result = await this.toolRegistry.execute({
          toolName: pendingToolCall.name,
          parameters: pendingToolCall.parameters,
        });

        yield { type: 'phase_change', phase: 'evaluating' };
        yield {
          type: 'thinking',
          thinking: result.success ? 'Tool completed successfully' : 'Tool returned an error',
        };
        yield { type: 'tool_result', toolResult: result };

        // Track file changes
        if (result.success) {
          const writeTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
          if (writeTools.includes(pendingToolCall.name)) {
            const filePath = pendingToolCall.parameters.path as string | undefined;
            if (filePath) {
              const fileContent = (pendingToolCall.parameters.content as string) || '';
              this.changeTracker.track(filePath, fileContent, pendingToolCall.name);
            }
          }
        }

        // Add tool result to conversation
        this.conversationManager.addMessage({
          role: 'tool',
          content: result.content,
          name: pendingToolCall.name,
          toolCallId: pendingToolCallId,
        });
      }

      // Mark subtask done or failed
      if (stepFailed) {
        subtask.status = 'failed';
        subtask.result = 'Step failed';
        yield { type: 'thinking_end' };
        yield {
          type: 'plan_step_update',
          planStep: { stepIndex: subtask.id - 1, status: 'failed', summary: subtask.result },
        };
      } else {
        subtask.status = 'done';
        subtask.result = stepResult.slice(0, 500);
        yield { type: 'thinking_end' };
        yield {
          type: 'plan_step_update',
          planStep: { stepIndex: subtask.id - 1, status: 'done', summary: subtask.result },
        };
      }
    }

    // Restore original mode
    this.modeEngine.setActive('orchestrator');

    // Final consolidation pass: summarize all step results into one response
    const completedSteps = plan.subtasks.filter((s) => s.status === 'done' && s.result);
    if (completedSteps.length > 0) {
      yield { type: 'phase_change', phase: 'reasoning' };
      yield { type: 'thinking', thinking: 'Consolidating results into final summary' };

      const summaryContext = completedSteps
        .map((s) => `## Step ${s.id}: ${s.description}\n${s.result}`)
        .join('\n\n');

      const summaryPrompt = `You completed a multi-step task with the following results from each step. Provide a single consolidated, well-structured summary that combines the key findings from all steps into one coherent response. Be concise but comprehensive. Do not repeat the step structure — synthesize the information naturally.\n\n${summaryContext}`;

      this.conversationManager.addMessage({ role: 'user', content: summaryPrompt });

      const systemPrompt = this.promptBuilder.build();
      const messages = this.conversationManager.getContextWindow(
        systemPrompt,
        this.config.maxContextTokens,
      );
      const redactedMessages = this.redactionEngine.redactMessages(messages);

      let summaryText = '';
      try {
        for await (const chunk of this.llm.chat(redactedMessages)) {
          if (chunk.type === 'text' && chunk.text) {
            summaryText += chunk.text;
            yield { type: 'text', text: chunk.text };
          }
        }
        if (summaryText) {
          this.conversationManager.addMessage({ role: 'assistant', content: summaryText });
        }
      } catch {
        // Summary failed — step results are already available
      }

      yield { type: 'thinking_end' };
    }

    // Emit changes summary if any files were modified
    const summary = this.changeTracker.buildSummaryEvent();
    if (summary) yield summary;

    yield { type: 'done' };
  }
}
