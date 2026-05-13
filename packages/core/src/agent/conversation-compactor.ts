import type { LlmAdapter, ChatMessage } from '../llm/types.js';

/**
 * Conversation compaction — summarizes older turns to stay within context window.
 * When conversation gets too long, older messages are replaced with a summary.
 */
export class ConversationCompactor {
  private llm: LlmAdapter;
  private triggerThreshold: number;
  private keepRecentMessages: number;

  constructor(
    llm: LlmAdapter,
    options?: {
      /** Estimated token count that triggers compaction (default: 6000) */
      triggerThreshold?: number;
      /** Number of recent messages to keep uncompacted (default: 6) */
      keepRecentMessages?: number;
    },
  ) {
    this.llm = llm;
    this.triggerThreshold = options?.triggerThreshold ?? 6000;
    this.keepRecentMessages = options?.keepRecentMessages ?? 6;
  }

  /** Check if compaction is needed based on estimated token count */
  needsCompaction(messages: ChatMessage[]): boolean {
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    return estimatedTokens > this.triggerThreshold;
  }

  /** Compact older messages into a summary, keeping recent messages intact */
  async compact(messages: ChatMessage[]): Promise<ChatMessage[]> {
    if (messages.length <= this.keepRecentMessages) {
      return messages;
    }

    // Split: older messages to summarize, recent to keep
    const olderMessages = messages.slice(0, messages.length - this.keepRecentMessages);
    const recentMessages = messages.slice(messages.length - this.keepRecentMessages);

    // Build a summary of older messages
    const summaryText = await this.summarize(olderMessages);

    // Return: [summary message] + recent messages
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `[Conversation Summary]\nThe following is a summary of the earlier conversation:\n${summaryText}`,
    };

    return [summaryMessage, ...recentMessages];
  }

  private async summarize(messages: ChatMessage[]): Promise<string> {
    const conversationText = messages
      .map((m) => {
        const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? `Tool(${m.name ?? 'unknown'})` : 'System';
        return `${role}: ${m.content.slice(0, 500)}${m.content.length > 500 ? '...' : ''}`;
      })
      .join('\n\n');

    const summaryPrompt: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a concise summarizer. Summarize the following conversation, preserving key facts, decisions, file paths mentioned, code changes made, and any important context. Be brief but complete.',
      },
      {
        role: 'user',
        content: `Summarize this conversation:\n\n${conversationText}`,
      },
    ];

    try {
      let summary = '';
      for await (const chunk of this.llm.chat(summaryPrompt)) {
        if (chunk.type === 'text' && chunk.text) {
          summary += chunk.text;
        }
      }
      return summary || this.fallbackSummary(messages);
    } catch {
      return this.fallbackSummary(messages);
    }
  }

  /** Fallback summary when LLM is unavailable — extract key facts */
  private fallbackSummary(messages: ChatMessage[]): string {
    const userMessages = messages.filter((m) => m.role === 'user');
    const toolCalls = messages.filter((m) => m.role === 'tool');

    const topics = userMessages.map((m) => m.content.slice(0, 100)).join('; ');
    const toolNames = [...new Set(toolCalls.map((m) => m.name).filter(Boolean))].join(', ');

    return [
      `${messages.length} messages compacted.`,
      `User topics: ${topics}`,
      toolNames ? `Tools used: ${toolNames}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
