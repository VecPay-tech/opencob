import type { Tool, ToolResult } from './types.js';

/**
 * Tool that lets the AI ask the user a follow-up question.
 * The question is returned as the tool result content so the
 * caller (agent loop / UI) can present it to the user.
 */
export function createAskFollowupTool(): Tool {
  return {
    name: 'ask_followup_question',
    group: 'meta', // always allowed — no file system access
    description:
      'Ask the user a follow-up question to gather more information before proceeding. ' +
      'Use this when the request is ambiguous or you need clarification.',
    parameters: [
      {
        name: 'question',
        type: 'string',
        description: 'The question to ask the user.',
        required: true,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const question = params.question as string;
      if (!question?.trim()) {
        return { success: false, content: 'Question text is required.' };
      }
      // The agent loop / UI layer reads this result and presents
      // the question to the user, feeding the answer back as a new message.
      return {
        success: true,
        content: question,
        metadata: { type: 'followup_question' },
      };
    },
  };
}
