import type { Tool, ToolResult } from './types.js';
import { ModeEngine } from '../modes/mode-engine.js';

/**
 * Tool that lets the AI switch to a different mode during a conversation.
 * Used by the Orchestrator mode to delegate subtasks.
 */
export function createSwitchModeTool(modeEngine: ModeEngine): Tool {
  return {
    name: 'switch_mode',
    group: 'read', // low risk — always allowed
    description:
      'Switch to a different mode. Available modes: code, ask, plan, advanced, orchestrator. ' +
      'Use this when the current task requires a different set of capabilities.',
    parameters: [
      {
        name: 'mode',
        type: 'string',
        description:
          'The mode slug to switch to (e.g., "code", "ask", "plan", "advanced", "orchestrator").',
        required: true,
      },
      {
        name: 'reason',
        type: 'string',
        description: 'Brief explanation of why this mode switch is needed.',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const slug = params.mode as string;
      const reason = params.reason as string | undefined;

      if (!slug?.trim()) {
        return { success: false, content: 'Mode slug is required.' };
      }

      try {
        const mode = modeEngine.setActive(slug);
        return {
          success: true,
          content: `Switched to ${mode.name} mode.${reason ? ` Reason: ${reason}` : ''}`,
          metadata: { mode: slug, modeName: mode.name },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `Failed to switch mode: ${msg}` };
      }
    },
  };
}
