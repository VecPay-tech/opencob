import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationManager } from '../src/conversation/conversation-manager.js';

describe('ConversationManager', () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager();
  });

  it('creates a conversation on first access', () => {
    const conv = manager.getActive();
    expect(conv).toBeDefined();
    expect(conv.id).toBeTruthy();
    expect(conv.messages).toHaveLength(0);
  });

  it('adds messages to the active conversation', () => {
    manager.addMessage({ role: 'user', content: 'hello' });
    manager.addMessage({ role: 'assistant', content: 'hi' });
    expect(manager.getMessages()).toHaveLength(2);
  });

  it('auto-titles from first user message', () => {
    manager.addMessage({ role: 'user', content: 'How do I write a COBOL program?' });
    expect(manager.getActive().title).toBe('How do I write a COBOL program?');
  });

  it('truncates long titles', () => {
    const longMsg = 'a'.repeat(100);
    manager.addMessage({ role: 'user', content: longMsg });
    expect(manager.getActive().title.length).toBeLessThanOrEqual(83); // 80 + "..."
  });

  it('clears conversation', () => {
    manager.addMessage({ role: 'user', content: 'hello' });
    const newConv = manager.clear();
    expect(newConv.messages).toHaveLength(0);
    expect(manager.getMessages()).toHaveLength(0);
  });

  it('prepends system prompt for LLM', () => {
    manager.addMessage({ role: 'user', content: 'hello' });
    const messages = manager.getMessagesForLlm('You are OpenCob');
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('You are OpenCob');
    expect(messages[1].role).toBe('user');
  });

  it('lists conversations', () => {
    manager.addMessage({ role: 'user', content: 'first' });
    const id1 = manager.getActive().id;
    manager.create();
    manager.addMessage({ role: 'user', content: 'second' });

    const list = manager.list();
    expect(list).toHaveLength(2);
  });

  it('switches between conversations', () => {
    manager.addMessage({ role: 'user', content: 'first' });
    const id1 = manager.getActive().id;

    const conv2 = manager.create();
    manager.addMessage({ role: 'user', content: 'second' });

    manager.setActive(id1);
    expect(manager.getMessages()).toHaveLength(1);
    expect(manager.getMessages()[0].content).toBe('first');
  });

  it('context window trims older messages', () => {
    // Add many messages
    for (let i = 0; i < 50; i++) {
      manager.addMessage({ role: 'user', content: `Message ${i} ${'x'.repeat(100)}` });
      manager.addMessage({ role: 'assistant', content: `Response ${i} ${'y'.repeat(100)}` });
    }

    // Very small context window should trim older messages
    const messages = manager.getContextWindow('System prompt', 500);
    expect(messages.length).toBeLessThan(100);
    expect(messages[0].role).toBe('system');
    // Last message should be the most recent
    expect(messages[messages.length - 1].content).toContain('Response 49');
  });

  it('deletes a conversation', () => {
    manager.addMessage({ role: 'user', content: 'hello' });
    const id = manager.getActive().id;
    expect(manager.delete(id)).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });
});
