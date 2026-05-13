import type { LlmAdapter, ChatMessage, StreamChunk } from '../llm/types.js';
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
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';

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
    | 'skill_activated';
  text?: string;
  toolCall?: { name: string; parameters: Record<string, unknown> };
  toolResult?: ToolExecutionResult;
  error?: string;
  mode?: string;
  attempt?: number;
  complexity?: ComplexityScore;
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
  private config: AgentConfig;

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

    // Add user message to conversation
    // Parse @mentions and resolve context
    let processedMessage = effectiveMessage;
    let mentionContext = '';
    if (this.mentionParser) {
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

      // Stream LLM response
      let fullResponse = '';
      let pendingToolCall: { name: string; parameters: Record<string, unknown> } | null = null;

      try {
        for await (const chunk of this.llm.chat(redactedMessages)) {
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
        yield { type: 'done' };
        return;
      }

      // Save the assistant's response (including the tool call intent)
      if (fullResponse) {
        this.conversationManager.addMessage({
          role: 'assistant',
          content: fullResponse,
        });
      }

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
      const result = await this.toolRegistry.execute({
        toolName: pendingToolCall.name,
        parameters: pendingToolCall.parameters,
      });

      yield { type: 'tool_result', toolResult: result };

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
          toolCallId: `correction_${rounds}`,
        });

        continue; // Continue the loop — LLM will see the error and try to fix
      }

      // Add tool result to conversation
      this.conversationManager.addMessage({
        role: 'tool',
        content: result.content,
        name: pendingToolCall.name,
        toolCallId: `call_${rounds}`,
      });

      // Continue the loop — the LLM will see the tool result and either respond or call another tool
    }

    // Max rounds exceeded
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
      const customCmd = this.customCommands.get(cmdName)!;
      const remainder = trimmed.slice(command.length).trim();
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
    const tools = this.toolRegistry.listAvailable();

    const toolDocs = tools
      .map((t) => {
        const params = t.parameters
          .map(
            (p) => `  - ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`,
          )
          .join('\n');
        return `### ${t.name}\n${t.description}\nParameters:\n${params}`;
      })
      .join('\n\n');

    return [
      mode.roleDefinition,
      '',
      mode.customInstructions || '',
      '',
      '## Available Tools',
      '',
      toolDocs || 'No tools available in this mode.',
      '',
      '## Tool Usage',
      '',
      'When you need to use a tool, respond with a JSON tool call in this format:',
      '```json',
      '{"tool": "tool_name", "parameters": {"param1": "value1"}}',
      '```',
      '',
      'Wait for the tool result before continuing. Do not guess tool results.',
      'If a tool call fails, diagnose the error and try a different approach.',
      '',
      '## Guidelines',
      '',
      '- Be concise and direct in your responses.',
      '- When modifying files, use apply_diff for targeted changes and write_to_file for new files.',
      '- Always read a file before modifying it.',
      '- Explain what you are doing and why before making changes.',
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
}
