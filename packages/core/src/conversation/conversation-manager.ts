import type { ChatMessage } from '../llm/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  modeSlug: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  modeSlug: string;
}

export class ConversationManager {
  private conversations: Map<string, Conversation> = new Map();
  private activeId: string | null = null;
  private persistencePath?: string;

  constructor(options?: { persistencePath?: string }) {
    this.persistencePath = options?.persistencePath;
    this.loadFromDisk();
  }

  /** Create a new conversation and make it active */
  create(modeSlug: string = 'code'): Conversation {
    const id = crypto.randomUUID();
    const now = Date.now();
    const conversation: Conversation = {
      id,
      title: 'New Conversation',
      messages: [],
      createdAt: now,
      updatedAt: now,
      modeSlug,
    };
    this.conversations.set(id, conversation);
    this.activeId = id;
    this.saveToDisk();
    return conversation;
  }

  /** Get the active conversation, creating one if none exists */
  getActive(): Conversation {
    if (this.activeId) {
      const conv = this.conversations.get(this.activeId);
      if (conv) return conv;
    }
    return this.create();
  }

  /** Set the active conversation by ID */
  setActive(id: string): Conversation {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    this.activeId = id;
    this.saveToDisk();
    return conv;
  }

  /** Add a message to the active conversation */
  addMessage(message: ChatMessage): void {
    const conv = this.getActive();
    conv.messages.push(message);
    conv.updatedAt = Date.now();

    // Auto-title from first user message
    if (conv.title === 'New Conversation' && message.role === 'user') {
      conv.title = message.content.slice(0, 80) + (message.content.length > 80 ? '...' : '');
    }

    this.saveToDisk();
  }

  /** Get messages for the active conversation */
  getMessages(): ChatMessage[] {
    return this.getActive().messages;
  }

  /** Get messages formatted for LLM (with system prompt prepended) */
  getMessagesForLlm(systemPrompt: string): ChatMessage[] {
    const messages = this.getMessages();
    return [{ role: 'system', content: systemPrompt }, ...messages];
  }

  /** Clear the active conversation */
  clear(): Conversation {
    const modeSlug = this.activeId
      ? (this.conversations.get(this.activeId)?.modeSlug ?? 'code')
      : 'code';
    return this.create(modeSlug);
  }

  /** List all conversations */
  list(): ConversationSummary[] {
    return Array.from(this.conversations.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
        modeSlug: c.modeSlug,
      }));
  }

  /** Delete a conversation */
  delete(id: string): boolean {
    if (this.activeId === id) {
      this.activeId = null;
    }
    const deleted = this.conversations.delete(id);
    if (deleted) {
      this.saveToDisk();
    }
    return deleted;
  }

  private loadFromDisk(): void {
    if (!this.persistencePath) return;

    try {
      if (!fs.existsSync(this.persistencePath)) return;
      const raw = fs.readFileSync(this.persistencePath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        activeId: string | null;
        conversations: Conversation[];
      };

      this.conversations.clear();
      for (const conv of parsed.conversations ?? []) {
        this.conversations.set(conv.id, conv);
      }

      this.activeId = parsed.activeId;
      if (this.activeId && !this.conversations.has(this.activeId)) {
        this.activeId = null;
      }
    } catch {
      // Corrupt conversation state should not block startup.
      this.conversations.clear();
      this.activeId = null;
    }
  }

  private saveToDisk(): void {
    if (!this.persistencePath) return;

    try {
      fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
      const serialized = {
        activeId: this.activeId,
        conversations: Array.from(this.conversations.values()),
      };
      fs.writeFileSync(this.persistencePath, JSON.stringify(serialized, null, 2), 'utf-8');
    } catch {
      // Persistence failures are non-fatal in CE.
    }
  }

  /** Build a context-window-aware message list, trimming older messages if needed */
  getContextWindow(systemPrompt: string, maxTokenEstimate: number): ChatMessage[] {
    const system: ChatMessage = { role: 'system', content: systemPrompt };
    const messages = this.getMessages();

    // Rough token estimate: ~4 chars per token
    const systemTokens = Math.ceil(systemPrompt.length / 4);
    let budget = maxTokenEstimate - systemTokens;

    // Work backwards to include recent messages first
    const included: ChatMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokenEstimate = Math.ceil(messages[i].content.length / 4);
      if (budget - tokenEstimate < 0 && included.length > 0) break;
      budget -= tokenEstimate;
      included.unshift(messages[i]);
    }

    return [system, ...included];
  }

  /** Export a conversation as Markdown (F1.3) */
  exportAsMarkdown(id?: string): string {
    const conv = id ? this.conversations.get(id) : this.getActive();
    if (!conv) throw new Error(`Conversation not found: ${id ?? 'active'}`);

    const header =
      `# ${conv.title}\n\n` +
      `**Mode:** ${conv.modeSlug} | **Created:** ${new Date(conv.createdAt).toISOString()} | **Messages:** ${conv.messages.length}\n\n---\n\n`;

    const body = conv.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const label = m.role === 'user' ? '## 🧑 User' : '## 🤖 Assistant';
        return `${label}\n\n${m.content}\n`;
      })
      .join('\n---\n\n');

    return header + body;
  }
}
