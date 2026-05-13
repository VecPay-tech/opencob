// OpenCob Core Engine
// Re-exports all public APIs

// Modes
export { ModeEngine, type Mode, type ModeSlug, BUILT_IN_MODES } from './modes/mode-engine.js';

// Tools
export { type Tool, type ToolResult, type ToolGroup } from './tools/types.js';
export {
  ToolRegistry,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ApprovalCallback,
  type AutoApproveConfig,
  type CommandAllowlistEntry,
  type CommandRiskAssessment,
} from './tools/tool-registry.js';
export { createReadFileTool } from './tools/read-file.js';
export { createListFilesTool } from './tools/list-files.js';
export { createSearchFilesTool } from './tools/search-files.js';
export { createWriteFileTool } from './tools/write-file.js';
export { createApplyDiffTool } from './tools/apply-diff.js';
export { createExecuteCommandTool } from './tools/execute-command.js';
export { createAskFollowupTool } from './tools/ask-followup.js';
export { createSwitchModeTool } from './tools/switch-mode.js';
export { createListCodeDefinitionsTool } from './tools/list-code-definitions.js';
export { createInsertContentTool } from './tools/insert-content.js';
export { createUndoLastTurnTool } from './tools/undo-last-turn.js';
export { createUseMcpTool } from './tools/use-mcp-tool.js';
export { createAnalyzeCodeTool } from './tools/analyze-code.js';
export { createGenerateDiagramTool } from './tools/generate-diagram.js';
export { createSemanticSearchTool } from './tools/semantic-search.js';
export { createFindReferencesTool, createShowImpactChainTool } from './tools/legacy-tools.js';
export { createMultiEditTool } from './tools/multi-edit.js';
export { createManageTodoTool } from './tools/manage-todo.js';

// LLM
export {
  type LlmAdapter,
  type ChatMessage,
  type StreamChunk,
  type CompletionRequest,
  type CompletionResponse,
} from './llm/types.js';
export { OllamaAdapter } from './llm/ollama-adapter.js';
export {
  LiteLLMAdapter,
  OpenAICompatibleAdapter,
  PROVIDER_PRESETS,
  type OpenAICompatibleConfig,
  type LiteLLMConfig,
} from './llm/litellm-adapter.js';
export { ModelRouter, type ModelRouteConfig, type TaskType } from './llm/model-router.js';

// Agent
export { AgentLoop, type AgentEvent, type AgentConfig } from './agent/agent-loop.js';
export { ConversationCompactor } from './agent/conversation-compactor.js';
export { PromptEnhancer } from './agent/prompt-enhancer.js';
export { PostEditVerifier, type VerificationResult } from './agent/post-edit-verifier.js';
export { TaskComplexityClassifier, type ComplexityScore } from './agent/task-complexity.js';
export {
  OrchestratorEngine,
  type Subtask,
  type OrchestratorPlan,
} from './agent/orchestrator-engine.js';

// Conversation
export {
  ConversationManager,
  type Conversation,
  type ConversationSummary,
} from './conversation/conversation-manager.js';

// Context
export {
  MentionParser,
  type ContextMention,
  type MentionParseResult,
} from './context/mention-parser.js';

// Configuration
export { ConfigLoader, type OpenCobConfig, type CustomModeConfig } from './config/config-loader.js';

// Security
export {
  RedactionEngine,
  type RedactionRule,
  type RedactionResult,
} from './security/redaction-engine.js';
export { FileFilter } from './security/file-filter.js';

// MCP
export {
  MCPClient,
  type MCPServerConfig,
  type MCPTool,
  type MCPToolResult,
} from './mcp/mcp-client.js';

// Checkpoints
export {
  SnapshotManager,
  type FileSnapshot,
  type TurnSnapshot,
} from './checkpoints/snapshot-manager.js';

// Findings
export { FindingsScanner, type Finding } from './findings/findings-scanner.js';

// Skills
export { SkillsLoader, type Skill } from './skills/skills-loader.js';

// Indexer & RAG (F8)
export {
  WorkspaceIndexer,
  type CodeDefinition,
  type FileDependency,
  type CodeChunk,
  type IndexStatus,
} from './indexer/workspace-indexer.js';
export {
  RAGPipeline,
  VectorStore,
  type RetrievedContext,
  type RetrievalOptions,
} from './indexer/rag-pipeline.js';

// Legacy Language Support (F14)
export {
  CobolParser,
  type CobolProgram,
  type CobolParagraph,
  type CobolCopybook,
  type CobolDataItem,
} from './legacy/cobol-parser.js';
export {
  RpgParser,
  type RpgProgram,
  type RpgProcedure,
  type RpgDataStructure,
} from './legacy/rpg-parser.js';
export {
  PliParser,
  type PliProgram,
  type PliProcedure,
  type PliDeclaration,
  type PliStructure,
} from './legacy/pli-parser.js';

// Modernization Assistant (F15)
export {
  ModernizationAssistant,
  type TranslationSuggestion,
  type GeneratedEntity,
  type GeneratedTestStub,
} from './legacy/modernization-assistant.js';

// Literate Coding (F18)
export {
  LiterateCodingEngine,
  type LiterateBlock,
  type LiterateResult,
} from './literate/literate-coding.js';
