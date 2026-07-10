import type { LlmAdapter } from '../llm/types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ConversationManager } from '../conversation/conversation-manager.js';
import type { RedactionEngine } from '../security/redaction-engine.js';
import type { SnapshotManager } from '../checkpoints/snapshot-manager.js';
import type { ModeEngine } from '../modes/mode-engine.js';
import type { AgentEvent } from './agent-types.js';
import type { OrchestratorEngine } from './orchestrator-engine.js';
import type { ChangeTracker } from './change-tracker.js';
import type { SystemPromptBuilder } from './system-prompt-builder.js';

export interface OrchestratorRunnerOpts {
  llm: LlmAdapter;
  toolRegistry: ToolRegistry;
  conversationManager: ConversationManager;
  modeEngine: ModeEngine;
  redactionEngine: RedactionEngine;
  orchestrator: OrchestratorEngine;
  promptBuilder: SystemPromptBuilder;
  changeTracker: ChangeTracker;
  snapshotManager: SnapshotManager | null;
  maxToolRounds: number;
  maxContextTokens: number;
}

/**
 * Handles orchestrator-mode execution: decomposes a user message into
 * a plan, runs each subtask with a full tool loop, then consolidates
 * results into a single summary. (§3.17, §8.9.4)
 */
export class OrchestratorRunner {
  constructor(private readonly opts: OrchestratorRunnerOpts) {}

  async *run(userMessage: string): AsyncIterable<AgentEvent> {
    const {
      llm,
      toolRegistry,
      conversationManager,
      modeEngine,
      redactionEngine,
      orchestrator,
      promptBuilder,
      changeTracker,
      snapshotManager,
      maxToolRounds,
      maxContextTokens,
    } = this.opts;

    yield { type: 'phase_change', phase: 'planning' };
    yield { type: 'thinking', thinking: 'Decomposing task into subtasks...' };

    const plan = await orchestrator.decompose(userMessage);

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
      orchestrator.switchToMode(subtask);

      // Build focused prompt with prior context
      const subtaskPrompt = orchestrator.buildSubtaskPrompt(plan, subtask);

      yield { type: 'phase_change', phase: 'reasoning' };
      yield { type: 'thinking', thinking: `Working on step ${subtask.id}: ${subtask.description}` };

      // Add subtask prompt to conversation
      conversationManager.addMessage({ role: 'user', content: subtaskPrompt });

      // Full tool loop for this subtask (same logic as processMessage main loop)
      let subtaskRounds = 0;
      let stepResult = '';
      let stepFailed = false;
      let stepFailureReason = 'Step failed';

      while (subtaskRounds < maxToolRounds) {
        subtaskRounds++;

        const systemPrompt = promptBuilder.build();
        const messages = conversationManager.getContextWindow(systemPrompt, maxContextTokens);
        const redactedMessages = redactionEngine.redactMessages(messages);
        const toolDefs = toolRegistry.getToolDefinitions();

        yield { type: 'phase_change', phase: 'reasoning' };
        yield {
          type: 'thinking',
          thinking: `Generating response${subtaskRounds > 1 ? ' (round ' + subtaskRounds + ')' : ''}`,
        };

        let fullResponse = '';
        let pendingToolCall: { name: string; parameters: Record<string, unknown> } | null = null;
        let pendingToolCallId = '';

        try {
          for await (const chunk of llm.chat(redactedMessages, { tools: toolDefs })) {
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
          stepFailureReason = msg;
        }

        if (stepFailed) break;

        // No tool call → subtask complete
        if (!pendingToolCall) {
          stepResult = fullResponse;
          if (fullResponse) {
            conversationManager.addMessage({ role: 'assistant', content: fullResponse });
          }
          break;
        }

        // Save assistant response with tool call
        conversationManager.addMessage({
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
        if (snapshotManager) {
          const editTools = ['write_to_file', 'apply_diff', 'insert_content', 'multi_edit'];
          if (editTools.includes(pendingToolCall.name)) {
            const filePath = pendingToolCall.parameters.path as string;
            if (filePath) snapshotManager.captureFile(filePath);
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
        const result = await toolRegistry.execute({
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
              const fileContent = typeof result.content === 'string' ? result.content : '';
              changeTracker.track(filePath, fileContent, pendingToolCall.name);
            }
          }
        }

        // Add tool result to conversation
        conversationManager.addMessage({
          role: 'tool',
          content: result.content,
          name: pendingToolCall.name,
          toolCallId: pendingToolCallId,
        });
      }

      // Mark subtask done or failed
      if (stepFailed) {
        subtask.status = 'failed';
        subtask.result = stepFailureReason;
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
    modeEngine.setActive('orchestrator');

    // Final consolidation pass: summarize all step results into one response
    const completedSteps = plan.subtasks.filter((s) => s.status === 'done' && s.result);
    if (completedSteps.length > 0) {
      yield { type: 'phase_change', phase: 'reasoning' };
      yield { type: 'thinking', thinking: 'Consolidating results into final summary' };

      const summaryContext = completedSteps
        .map((s) => `## Step ${s.id}: ${s.description}\n${s.result}`)
        .join('\n\n');

      const summaryPrompt =
        `You completed a multi-step task with the following results from each step. Provide a single consolidated, well-structured summary that combines the key findings from all steps into one coherent response. Be concise but comprehensive. Do not repeat the step structure — synthesize the information naturally.\n\n` +
        summaryContext;

      conversationManager.addMessage({ role: 'user', content: summaryPrompt });

      const systemPrompt = promptBuilder.build();
      const messages = conversationManager.getContextWindow(systemPrompt, maxContextTokens);
      const redactedMessages = redactionEngine.redactMessages(messages);

      let summaryText = '';
      try {
        for await (const chunk of llm.chat(redactedMessages)) {
          if (chunk.type === 'text' && chunk.text) {
            summaryText += chunk.text;
            yield { type: 'text', text: chunk.text };
          }
        }
        if (summaryText) {
          conversationManager.addMessage({ role: 'assistant', content: summaryText });
        }
      } catch {
        // Summary failed — step results are already available
      }

      yield { type: 'thinking_end' };
    }

    // Emit changes summary if any files were modified
    const summary = changeTracker.buildSummaryEvent();
    if (summary) yield summary;

    yield { type: 'done' };
  }
}
