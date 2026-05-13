import type { LlmAdapter, ChatMessage } from '../llm/types.js';
import { ModeEngine } from '../modes/mode-engine.js';

export interface Subtask {
  id: number;
  description: string;
  mode: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
}

export interface OrchestratorPlan {
  goal: string;
  subtasks: Subtask[];
}

/**
 * F6.3 Orchestrator Mode — Breaks complex tasks into subtasks
 * and delegates to Code/Plan/Ask modes.
 */
export class OrchestratorEngine {
  constructor(
    private readonly llm: LlmAdapter,
    private readonly modeEngine: ModeEngine,
  ) {}

  /**
   * Decompose a complex task into subtasks with assigned modes.
   * Uses the LLM to generate the plan.
   */
  async decompose(userGoal: string): Promise<OrchestratorPlan> {
    const systemPrompt = `You are a task orchestrator. Break down the user's request into specific subtasks.
For each subtask, assign the most appropriate mode:
- "code" — for writing, modifying, or refactoring code
- "ask" — for answering questions, research, or explanations
- "plan" — for planning, design, or documentation

Respond with a JSON array of subtasks:
[{"description": "...", "mode": "code|ask|plan"}]

Keep subtasks focused and actionable. Use 2-5 subtasks typically.
Respond ONLY with valid JSON.`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userGoal },
    ];

    let response = '';
    try {
      for await (const chunk of this.llm.chat(messages)) {
        if (chunk.type === 'text' && chunk.text) {
          response += chunk.text;
        }
      }

      // Extract JSON from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return this.fallbackPlan(userGoal);
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<{ description: string; mode: string }>;
      const subtasks: Subtask[] = parsed.map((item, i) => ({
        id: i + 1,
        description: item.description,
        mode: this.validateMode(item.mode),
        status: 'pending' as const,
      }));

      return { goal: userGoal, subtasks };
    } catch {
      return this.fallbackPlan(userGoal);
    }
  }

  /**
   * Generate a simple mode-based plan when LLM decomposition fails.
   */
  private fallbackPlan(goal: string): OrchestratorPlan {
    const lower = goal.toLowerCase();

    // Heuristic: determine if this is a code task, planning task, or question
    const subtasks: Subtask[] = [];

    if (lower.includes('plan') || lower.includes('design') || lower.includes('architect')) {
      subtasks.push({
        id: 1,
        description: `Create a plan for: ${goal}`,
        mode: 'plan',
        status: 'pending',
      });
      subtasks.push({
        id: 2,
        description: 'Implement the plan',
        mode: 'code',
        status: 'pending',
      });
    } else if (lower.includes('explain') || lower.includes('what') || lower.includes('how') || lower.includes('why')) {
      subtasks.push({
        id: 1,
        description: goal,
        mode: 'ask',
        status: 'pending',
      });
    } else {
      subtasks.push({
        id: 1,
        description: goal,
        mode: 'code',
        status: 'pending',
      });
    }

    return { goal, subtasks };
  }

  private validateMode(mode: string): string {
    const valid = ['code', 'ask', 'plan', 'advanced'];
    return valid.includes(mode) ? mode : 'code';
  }

  /** Switch to the appropriate mode for a subtask */
  switchToMode(subtask: Subtask): void {
    this.modeEngine.setActive(subtask.mode);
  }

  /** Build a focused prompt for a subtask with orchestration context */
  buildSubtaskPrompt(plan: OrchestratorPlan, subtask: Subtask): string {
    const completedContext = plan.subtasks
      .filter((s) => s.status === 'done' && s.result)
      .map((s) => `[Subtask ${s.id}: ${s.description}]\nResult: ${s.result}`)
      .join('\n\n');

    const parts = [
      `## Orchestrated Task`,
      `Overall goal: ${plan.goal}`,
      `Current subtask (${subtask.id}/${plan.subtasks.length}): ${subtask.description}`,
    ];

    if (completedContext) {
      parts.push('', '## Previous subtask results:', completedContext);
    }

    parts.push('', '## Instructions:', `Focus on this specific subtask: ${subtask.description}`);

    return parts.join('\n');
  }
}
