import type { LlmAdapter, ChatMessage } from '../llm/types.js';

/**
 * AI-powered prompt enhancement — refines user prompts before sending to the main LLM.
 * Improves clarity, adds context hints, and structures the request.
 */
export class PromptEnhancer {
  private llm: LlmAdapter;

  constructor(llm: LlmAdapter) {
    this.llm = llm;
  }

  /** Enhance a user prompt for better LLM results */
  async enhance(
    userPrompt: string,
    context?: { mode?: string; recentFiles?: string[] },
  ): Promise<string> {
    // Short prompts (< 20 chars) likely don't benefit from enhancement
    if (userPrompt.length < 20) return userPrompt;

    const enhanceMessages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are a prompt refinement assistant. Your job is to take a user's coding request and make it clearer and more specific for an AI coding assistant. 

Rules:
- Keep the original intent intact
- Add specificity where the user was vague
- If the request mentions files, keep those references
- Don't add requirements the user didn't imply
- Return ONLY the enhanced prompt text, nothing else
- Keep it concise — don't make it much longer than the original
${context?.mode ? `- The user is in "${context.mode}" mode` : ''}
${context?.recentFiles?.length ? `- Recently edited files: ${context.recentFiles.join(', ')}` : ''}`,
      },
      {
        role: 'user',
        content: `Enhance this prompt:\n\n${userPrompt}`,
      },
    ];

    try {
      let enhanced = '';
      for await (const chunk of this.llm.chat(enhanceMessages, {
        temperature: 0.3,
        maxTokens: 512,
      })) {
        if (chunk.type === 'text' && chunk.text) {
          enhanced += chunk.text;
        }
      }
      return enhanced.trim() || userPrompt;
    } catch {
      // Fallback: return original prompt
      return userPrompt;
    }
  }
}
