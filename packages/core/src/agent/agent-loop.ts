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
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { execSync } from 'node:child_process';

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

    // Handle prompt-prefix slash commands (/explain, /fix, /test, /review, /create-pr)
    let effectiveMessage = userMessage;
    const trimmed = userMessage.trim();
    if (trimmed.startsWith('/')) {
      const [cmd] = trimmed.split(/\s+/);
      // Strip mode-switch commands that passed through (had trailing text)
      const modeOnlyCmds = ['/plan', '/orchestrator', '/code', '/ask', '/advanced'];
      if (modeOnlyCmds.includes(cmd)) {
        effectiveMessage = trimmed.slice(cmd.length).trim();
      }
      const promptCommands: Record<string, string> = {
        '/explain':
          'Explain the following code in detail. What does it do, how does it work, and what are the key patterns used?\n\n',
        '/fix':
          'Analyze the following code for bugs, errors, and issues. Fix all problems you find and explain each fix.\n\n',
        '/test':
          'Generate comprehensive unit tests for the following code. Cover edge cases, error paths, and typical usage.\n\n',
        '/diagram':
          'Generate the most relevant diagram for the following code/context. Prefer Mermaid output and include a short explanation of what the diagram shows. If a specific section is referenced, focus the diagram on that section.\n\n',
        '/review':
          'Review the following code for quality, security, performance, and maintainability issues. Suggest improvements.\n\n',
      };
      if (cmd === '/review') {
        const remainder = trimmed.slice(cmd.length).trim();
        // Detect branch name argument (F17: /review <branch>)
        if (remainder && this.looksLikeBranch(remainder)) {
          const diff = this.resolveGitBranchDiff(remainder);
          effectiveMessage =
            `Review the following branch diff (comparing "${remainder}" against HEAD) for quality, security, performance, and maintainability issues. Provide a comprehensive analysis with specific improvement suggestions.\n\n` +
            diff;
        } else if (!remainder) {
          // /review alone → review uncommitted changes
          const diff = this.resolveGitBranchDiff('HEAD');
          effectiveMessage =
            'Review the following uncommitted changes for quality, security, performance, and maintainability issues. Suggest improvements.\n\n' +
            diff;
        } else {
          effectiveMessage = promptCommands['/review'] + remainder;
        }
      } else if (cmd === '/create-pr') {
        const baseBranch = trimmed.slice(cmd.length).trim() || 'main';
        const prContext = this.resolveGitPrContext(baseBranch);
        effectiveMessage =
          `Generate a pull request title and description for the following changes (comparing current branch against "${baseBranch}"). ` +
          `Use Conventional Commit style for the title. Structure the description with: ## Summary, ## Changes, ## Testing.\n\n` +
          prContext;
      } else if (cmd in promptCommands) {
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

  private handleSlashCommand(input: string): AgentEvent | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;

    const [command] = trimmed.split(/\s+/);
    const modeCommands: Record<string, string> = {
      '/code': 'code',
      '/ask': 'ask',
      '/plan': 'orchestrator',
      '/advanced': 'advanced',
      '/orchestrator': 'orchestrator',
    };

    if (command in modeCommands) {
      const slug = modeCommands[command];
      this.modeEngine.setActive(slug);
      const mode = this.modeEngine.getActive();
      // If there's text after the command, don't return — let processMessage handle it
      const remainder = trimmed.slice(command.length).trim();
      if (remainder) {
        return null; // mode is set, processMessage will use it with the full input
      }
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
        '  /diagram     — Generate a relevant diagram from code/context',
        '  /review      — Review code or branch for issues',
        '  /create-pr   — Generate PR title and description',
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
      '/diagram':
        'Generate the most relevant diagram for the following code/context. Prefer Mermaid output and include a short explanation of what the diagram shows. If a specific section is referenced, focus the diagram on that section.\n\n',
      '/review':
        'Review the following code for quality, security, performance, and maintainability issues. Suggest improvements.\n\n',
      '/create-pr': '', // Handled specially in processMessage
    };

    if (command in promptCommands) {
      const remainder = trimmed.slice(command.length).trim();
      // Commands that can run without explicit arguments
      if (
        !remainder &&
        command !== '/create-pr' &&
        command !== '/review' &&
        command !== '/diagram'
      ) {
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

  /** Heuristic: does the string look like a git branch/ref name? */
  private looksLikeBranch(input: string): boolean {
    // Branch names: alphanumeric, slashes, hyphens, dots, underscores — no spaces, no @, no file extensions with path separators
    if (input.includes(' ') || input.startsWith('@') || input.startsWith('/')) return false;
    // If it has a common file extension, it's probably a file reference
    if (/\.(ts|js|py|java|go|rs|c|h|cbl|cob|rpg|pli|md|yaml|json|xml|html|css)$/i.test(input))
      return false;
    // Must match git ref pattern
    return /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(input);
  }

  /** Resolve git diff between a branch and HEAD (F17: /review <branch>) */
  private resolveGitBranchDiff(branch: string): string {
    if (!this.config.workspaceRoot) return `(no workspace root — cannot resolve git diff)`;
    try {
      const diff = execSync(
        `git diff ${branch}...HEAD --stat && echo --- && git diff ${branch}...HEAD`,
        {
          cwd: this.config.workspaceRoot,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          timeout: 15000,
        },
      );
      return diff || '(no differences found)';
    } catch {
      try {
        // Fallback: try simple diff without merge-base
        const diff = execSync(`git diff ${branch} HEAD`, {
          cwd: this.config.workspaceRoot,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          timeout: 15000,
        });
        return diff || '(no differences found)';
      } catch {
        return `(unable to resolve diff — branch "${branch}" may not exist)`;
      }
    }
  }

  /** Resolve context for PR creation (F17: /create-pr) */
  private resolveGitPrContext(baseBranch: string): string {
    if (!this.config.workspaceRoot) return `(no workspace root — cannot resolve git context)`;
    const parts: string[] = [];
    try {
      const currentBranch = execSync('git branch --show-current', {
        cwd: this.config.workspaceRoot,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      parts.push(`Current branch: ${currentBranch}`);
      parts.push(`Base branch: ${baseBranch}`);
    } catch {
      parts.push(`Base branch: ${baseBranch}`);
    }
    try {
      const log = execSync(`git log ${baseBranch}..HEAD --oneline`, {
        cwd: this.config.workspaceRoot,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (log) {
        parts.push(`\nCommits:\n${log}`);
      }
    } catch {
      // Ignore
    }
    try {
      const diff = execSync(`git diff ${baseBranch}...HEAD --stat`, {
        cwd: this.config.workspaceRoot,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      if (diff) {
        parts.push(`\nFiles changed:\n${diff}`);
      }
    } catch {
      // Ignore
    }
    try {
      const fullDiff = execSync(`git diff ${baseBranch}...HEAD`, {
        cwd: this.config.workspaceRoot,
        encoding: 'utf-8',
        maxBuffer: 512 * 1024,
        timeout: 15000,
      });
      if (fullDiff) {
        // Truncate if very large
        const truncated =
          fullDiff.length > 50000
            ? fullDiff.slice(0, 50000) + '\n\n... (diff truncated — too large)'
            : fullDiff;
        parts.push(`\nFull diff:\n${truncated}`);
      }
    } catch {
      // Ignore
    }
    return parts.join('\n') || '(unable to resolve git context)';
  }

  private buildSystemPrompt(): string {
    const mode = this.modeEngine.getActive();
    const repoTree = this.buildCompactRepoTree();

    const parts = [
      mode.roleDefinition,
      '',
      mode.customInstructions || '',
      '',
      '## Guidelines',
      '',
      '- Be concise and direct in your responses.',
      '- Use the available tools to accomplish tasks. Call tools rather than describing what you would do.',
      '- When users ask about architecture, flow, dependencies, or structure, prefer calling generate_diagram and briefly explain the result.',
      '- When modifying files, use apply_diff for targeted changes and write_to_file for new files.',
      '- Always read a file before modifying it.',
      '- Explain what you are doing and why before making changes.',
      '- If a tool call fails, diagnose the error and try a different approach.',
      repoTree ? `\n## Workspace Structure\n\n\`\`\`\n${repoTree}\n\`\`\`` : '',
    ];

    // Inject customization (instructions, CODEOWNERS-scoped) and lifecycle hooks
    if (this.customizationLoader) {
      const resolved = this.customizationLoader.resolve([]);
      if (resolved.systemPromptAdditions.length > 0) {
        parts.push('\n## Project Instructions\n');
        parts.push(...resolved.systemPromptAdditions);
      }

      // Fire onChatStart hooks
      const hookResult = this.customizationLoader.fireHook({ event: 'onChatStart' });
      if (hookResult.instructions.length > 0) {
        parts.push('\n## Active Hooks\n');
        parts.push(...hookResult.instructions);
      }
    }

    // Self-help knowledge: tell the agent where docs are
    if (this.config.workspaceRoot) {
      const docsPath = nodePath.join(this.config.workspaceRoot, 'docs', 'pages');
      try {
        const fsStat = require('node:fs');
        if (fsStat.existsSync(docsPath)) {
          parts.push('\n## Self-Help Documentation\n');
          parts.push(
            'When users ask how to use OpenCob, configure features, write instructions, or troubleshoot issues, ' +
              'read the relevant MDX file from docs/pages/ to provide accurate guidance. Key docs:\n' +
              '- docs/pages/installation.mdx — Installation & setup\n' +
              '- docs/pages/getting-started.mdx — First steps, slash commands, modes\n' +
              '- docs/pages/customization.mdx — Instructions, agents, prompts, .opencob/ structure\n' +
              '- docs/pages/hooks.mdx — Lifecycle hooks (events, creation, examples)\n' +
              '- docs/pages/codeowners.mdx — CODEOWNERS integration & owner-scoped instructions\n' +
              '- docs/pages/modes.mdx — Operating modes & custom agents\n' +
              '- docs/pages/tools.mdx — Available tools & approval settings\n' +
              '- docs/pages/commands.mdx — Commands, shortcuts, settings reference\n' +
              '- docs/pages/mcp.mdx — MCP server configuration\n' +
              '- docs/pages/troubleshooting.mdx — Common issues & fixes\n' +
              '\nRead the appropriate file and use its content to answer the user accurately.',
          );
        }
      } catch {
        /* ignore */
      }
    }

    return parts.filter(Boolean).join('\n');
  }

  /** Build a compact repo tree for system prompt context (F6.4) */
  private buildCompactRepoTree(): string {
    if (!this.config.workspaceRoot) return '';
    try {
      const root = this.config.workspaceRoot;
      const lines: string[] = [];
      const maxLines = 60;

      const walk = (dir: string, prefix: string, depth: number): void => {
        if (depth > 3 || lines.length >= maxLines) return;
        let entries: import('node:fs').Dirent[];
        try {
          entries = require('node:fs').readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        // Skip common non-essential directories
        const skip = new Set([
          'node_modules',
          '.git',
          'dist',
          'build',
          '.next',
          '.turbo',
          'coverage',
          '.nyc_output',
          '__pycache__',
          '.venv',
          'target',
        ]);
        entries = entries
          .filter((e: import('node:fs').Dirent) => !skip.has(e.name) && !e.name.startsWith('.'))
          .sort((a: import('node:fs').Dirent, b: import('node:fs').Dirent) =>
            a.isDirectory() === b.isDirectory()
              ? a.name.localeCompare(b.name)
              : a.isDirectory()
                ? -1
                : 1,
          );

        for (let i = 0; i < entries.length && lines.length < maxLines; i++) {
          const entry = entries[i];
          const isLast = i === entries.length - 1;
          const connector = isLast ? '└── ' : '├── ';
          const childPrefix = prefix + (isLast ? '    ' : '│   ');
          lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}`);
          if (entry.isDirectory()) {
            walk(nodePath.join(dir, entry.name), childPrefix, depth + 1);
          }
        }
      };

      const rootName = nodePath.basename(root);
      lines.push(`${rootName}/`);
      walk(root, '', 0);

      if (lines.length >= maxLines) {
        lines.push('... (truncated)');
      }

      return lines.join('\n');
    } catch {
      return '';
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

        const systemPrompt = this.buildSystemPrompt();
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

      const systemPrompt = this.buildSystemPrompt();
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
