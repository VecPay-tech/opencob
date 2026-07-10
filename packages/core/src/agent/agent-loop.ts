import type { LlmAdapter } from '../llm/types.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ConversationManager } from '../conversation/conversation-manager.js';
import { ModeEngine } from '../modes/mode-engine.js';
import { RedactionEngine } from '../security/redaction-engine.js';
import { MentionParser } from '../context/mention-parser.js';
import { ConversationCompactor } from './conversation-compactor.js';
import { PostEditVerifier } from './post-edit-verifier.js';
import type { SnapshotManager } from '../checkpoints/snapshot-manager.js';
import type { RAGPipeline } from '../indexer/rag-pipeline.js';
import type { SkillsLoader } from '../skills/skills-loader.js';
import { OrchestratorEngine } from './orchestrator-engine.js';
import { CustomizationLoader } from './customization-loader.js';
import { ChangeTracker } from './change-tracker.js';
import { GitContextResolver } from './git-context-resolver.js';
import { SystemPromptBuilder } from './system-prompt-builder.js';
import { SlashCommandHandler } from './slash-command-handler.js';
import { ToolCallLoop, type ToolCallLoopOpts } from './tool-call-loop.js';
import { OrchestratorRunner } from './orchestrator-runner.js';
import type { AgentEvent, AgentConfig } from './agent-types.js';
import { DEFAULT_AGENT_CONFIG } from './agent-types.js';

export type { AgentPhase, AgentEvent, AgentConfig } from './agent-types.js';
const _gitResolver = new GitContextResolver();

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
  private ragPipeline: RAGPipeline | null;
  private skillsLoader: SkillsLoader | null;
  private customCommands: Map<string, { description: string; prompt: string }>;
  private orchestrator: OrchestratorEngine;
  private orchestratorRunner: OrchestratorRunner;
  private customizationLoader: CustomizationLoader | null;
  private config: AgentConfig;
  private changeTracker = new ChangeTracker();
  private promptBuilder: SystemPromptBuilder;
  private slashHandler: SlashCommandHandler;
  private toolCallLoop: ToolCallLoop;

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
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
    const root = this.config.workspaceRoot;
    this.mentionParser = root ? new MentionParser(root) : null;
    this.compactor = this.config.enableCompaction ? new ConversationCompactor(llm) : null;
    this.snapshotManager = snapshotManager ?? null;
    this.postEditVerifier =
      root && this.config.enablePostEditVerification ? new PostEditVerifier(root) : null;
    this.ragPipeline = this.config.ragPipeline ?? null;
    this.skillsLoader = this.config.skillsLoader ?? null;
    this.customCommands = this.config.customCommands ?? new Map();
    this.orchestrator = new OrchestratorEngine(llm, modeEngine);
    this.customizationLoader = root ? new CustomizationLoader(root) : null;
    this.promptBuilder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: this.customizationLoader,
      skillsLoader: this.skillsLoader,
      workspaceRoot: root,
    });
    this.slashHandler = new SlashCommandHandler({
      modeEngine,
      snapshotManager: this.snapshotManager,
      toolRegistry,
      customCommands: this.customCommands,
    });
    this.orchestratorRunner = new OrchestratorRunner(this.buildOrchestratorOpts());
    this.toolCallLoop = new ToolCallLoop(this.buildToolCallLoopOpts());
  }

  /** Hot-swap the LLM adapter (e.g. when user changes provider setting) */
  setLlmAdapter(adapter: LlmAdapter): void {
    this.llm = adapter;
    if (this.compactor) this.compactor = new ConversationCompactor(adapter);
    this.orchestrator = new OrchestratorEngine(adapter, this.modeEngine);
    this.orchestratorRunner = new OrchestratorRunner(this.buildOrchestratorOpts());
    this.toolCallLoop = new ToolCallLoop(this.buildToolCallLoopOpts());
  }

  /** Update the LLM adapter (alias for setLlmAdapter, used by CLI) */
  setLlm(llm: LlmAdapter): void {
    this.llm = llm;
    this.toolCallLoop = new ToolCallLoop(this.buildToolCallLoopOpts());
  }

  /** Get current mode */
  getMode() {
    return this.modeEngine.getActive();
  }

  /** Get file changes from the current turn (§8.4.1.1) */
  getTurnFileChanges() {
    return this.changeTracker.getChanges();
  }

  /** Load custom commands from .OpenCob/commands/ directory (F17) */
  async loadCustomCommands(): Promise<void> {
    if (!this.customizationLoader) return;
    const loaded = await this.customizationLoader.loadCustomCommands();
    for (const [name, cmd] of loaded) this.customCommands.set(name, cmd);
  }

  /** Process a user message and yield agent events (streaming) */
  async *processMessage(userMessage: string): AsyncIterable<AgentEvent> {
    const slashResult = this.slashHandler.handle(userMessage);
    if (slashResult.kind === 'event') {
      const cmd = userMessage.trim();
      if (cmd === '/new' || cmd === '/clear') this.conversationManager.clear();
      yield slashResult.event;
      return;
    }
    let effectiveMessage = userMessage;
    if (slashResult.kind === 'rewrite') effectiveMessage = slashResult.message;

    // Git-aware rewriting for /review and /create-pr (requires workspaceRoot)
    if (userMessage.trim().startsWith('/')) {
      const [cmd, ...rest] = userMessage.trim().split(/\s+/);
      const resolved = _gitResolver.resolveSlashCommand(
        cmd,
        rest.join(' '),
        this.config.workspaceRoot ?? process.cwd(),
      );
      if (resolved) {
        if ('error' in resolved) {
          yield { type: 'error', error: resolved.error };
          return;
        }
        effectiveMessage = resolved.message;
      }
    }

    yield { type: 'phase_change', phase: 'preparing' };
    this.changeTracker.reset();

    if (this.modeEngine.getActive().slug === 'orchestrator') {
      yield* this.runOrchestrator(effectiveMessage);
      return;
    }

    // Resolve @mentions
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

    // RAG context (F8.2)
    let ragContext = '';
    if (this.ragPipeline) {
      yield { type: 'thinking', text: 'Searching codebase for relevant context' };
      const hits = this.ragPipeline.retrieve(processedMessage, { topK: 5, minScore: 0.1 });
      if (hits.length > 0)
        ragContext = `\n\n<retrieved_context>\n${hits.map((r) => `<context source="${r.source}" file="${r.filePath}" lines="${r.startLine}-${r.endLine}" score="${r.score.toFixed(2)}">\n${r.content}\n</context>`).join('\n')}\n</retrieved_context>`;
    }

    // Skills (F19)
    let skillContext = '';
    if (this.skillsLoader) {
      try {
        yield { type: 'thinking', text: 'Checking for applicable skills' };
        const msgLower = processedMessage.toLowerCase();
        const skill = (await this.skillsLoader.loadAll()).find(
          (s) =>
            s.description &&
            s.description
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .some((w) => msgLower.includes(w)),
        );
        if (skill) {
          skillContext = `\n\n<activated_skill name="${skill.name}">\n${skill.instructions}\n</activated_skill>`;
          yield { type: 'skill_activated', text: `Skill activated: ${skill.name}` };
        }
      } catch {
        /* non-fatal */
      }
    }

    if (ragContext || skillContext)
      this.conversationManager.addMessage({
        role: 'system',
        content: (ragContext + skillContext).trim(),
      });

    if (this.snapshotManager) this.snapshotManager.startTurn();

    if (this.compactor) {
      const messages = this.conversationManager.getMessages();
      if (this.compactor.needsCompaction(messages)) {
        this.conversationManager.getActive().messages = await this.compactor.compact(messages);
        yield { type: 'compaction', text: 'Conversation compacted to fit context window.' };
      }
    }

    yield* this.toolCallLoop.run(this.promptBuilder.build(), this.config.maxContextTokens);
  }

  /** Non-streaming convenience wrapper — collects all events and returns text + tool calls */
  async run(
    prompt: string,
    _options?: { stream?: boolean; mode?: string },
  ): Promise<{
    content: string;
    toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  }> {
    let content = '';
    const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    for await (const event of this.processMessage(prompt)) {
      if (event.type === 'text' && event.text) content += event.text;
      else if (event.type === 'tool_call' && event.toolCall)
        toolCalls.push({ name: event.toolCall.name, params: event.toolCall.parameters });
    }
    return { content, toolCalls };
  }

  private buildOrchestratorOpts() {
    return {
      llm: this.llm,
      toolRegistry: this.toolRegistry,
      conversationManager: this.conversationManager,
      modeEngine: this.modeEngine,
      redactionEngine: this.redactionEngine,
      orchestrator: this.orchestrator,
      promptBuilder: this.promptBuilder,
      changeTracker: this.changeTracker,
      snapshotManager: this.snapshotManager,
      maxToolRounds: this.config.maxToolRounds,
      maxContextTokens: this.config.maxContextTokens,
    };
  }

  private buildToolCallLoopOpts(): ToolCallLoopOpts {
    return {
      llm: this.llm,
      toolRegistry: this.toolRegistry,
      conversationManager: this.conversationManager,
      redactionEngine: this.redactionEngine,
      changeTracker: this.changeTracker,
      maxToolRounds: this.config.maxToolRounds,
      maxSelfCorrectionAttempts: this.config.maxSelfCorrectionAttempts ?? 3,
      enablePostEditVerification: this.config.enablePostEditVerification ?? true,
      postEditVerifier: this.postEditVerifier,
      workspaceRoot: this.config.workspaceRoot,
      snapshotManager: this.snapshotManager,
      customizationLoader: this.customizationLoader,
    };
  }

  private runOrchestrator(userMessage: string): AsyncIterable<AgentEvent> {
    return this.orchestratorRunner.run(userMessage);
  }
}
