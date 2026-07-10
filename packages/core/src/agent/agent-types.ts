import type { ToolExecutionResult } from '../tools/tool-registry.js';
import type { ComplexityScore } from './task-complexity.js';
import type { RAGPipeline } from '../indexer/rag-pipeline.js';
import type { SkillsLoader } from '../skills/skills-loader.js';

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

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxToolRounds: 10,
  maxContextTokens: 8192,
  maxSelfCorrectionAttempts: 3,
  enableCompaction: true,
  enablePostEditVerification: true,
  enableComplexityClassifier: true,
};
