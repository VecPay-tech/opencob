import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationManager } from '../src/conversation/conversation-manager.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('ConversationManager — expanded coverage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('persistence', () => {
    it('persists conversations to disk', () => {
      const persistPath = path.join(tmpDir, 'conversations.json');
      const manager = new ConversationManager({ persistencePath: persistPath });
      manager.addMessage({ role: 'user', content: 'hello persistence' });
      const convId = manager.getActive().id;

      // File should exist
      expect(fs.existsSync(persistPath)).toBe(true);

      // Load in new manager
      const manager2 = new ConversationManager({ persistencePath: persistPath });
      const conv = manager2.getActive();
      expect(conv.id).toBe(convId);
      expect(conv.messages[0].content).toBe('hello persistence');
    });

    it('handles corrupt persistence file gracefully', () => {
      const persistPath = path.join(tmpDir, 'conversations.json');
      fs.writeFileSync(persistPath, 'not valid json!!!');

      // Should not throw, just start fresh
      const manager = new ConversationManager({ persistencePath: persistPath });
      expect(manager.list()).toHaveLength(0);
    });

    it('recovers from invalid activeId in state', () => {
      const persistPath = path.join(tmpDir, 'conversations.json');
      fs.writeFileSync(
        persistPath,
        JSON.stringify({
          activeId: 'non-existent-id',
          conversations: [
            {
              id: 'abc123',
              title: 'Test',
              messages: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
              modeSlug: 'code',
            },
          ],
        }),
      );

      const manager = new ConversationManager({ persistencePath: persistPath });
      // Should create a new active since 'non-existent-id' doesn't exist
      // getActive() will create a new one
      const conv = manager.getActive();
      expect(conv).toBeDefined();
    });

    it('creates directory if needed for persistence', () => {
      const deepPath = path.join(tmpDir, 'deep', 'nested', 'conversations.json');
      const manager = new ConversationManager({ persistencePath: deepPath });
      manager.addMessage({ role: 'user', content: 'test' });
      expect(fs.existsSync(deepPath)).toBe(true);
    });
  });

  describe('rename', () => {
    it('renames a conversation', () => {
      const manager = new ConversationManager();
      manager.addMessage({ role: 'user', content: 'test' });
      const id = manager.getActive().id;
      const renamed = manager.rename(id, 'My Custom Title');
      expect(renamed.title).toBe('My Custom Title');
    });

    it('throws for nonexistent conversation', () => {
      const manager = new ConversationManager();
      expect(() => manager.rename('nonexistent', 'Title')).toThrow('not found');
    });

    it('sets default title when empty string given', () => {
      const manager = new ConversationManager();
      manager.addMessage({ role: 'user', content: 'test' });
      const id = manager.getActive().id;
      const renamed = manager.rename(id, '   ');
      expect(renamed.title).toBe('New Conversation');
    });
  });

  describe('multiple conversations', () => {
    it('creates multiple conversations and switches between them', () => {
      const manager = new ConversationManager();
      manager.addMessage({ role: 'user', content: 'first' });
      const id1 = manager.getActive().id;

      manager.create('ask');
      manager.addMessage({ role: 'user', content: 'second' });
      const id2 = manager.getActive().id;

      expect(id1).not.toBe(id2);
      expect(manager.list()).toHaveLength(2);

      manager.setActive(id1);
      expect(manager.getMessages()[0].content).toBe('first');
    });

    it('throws when setting unknown active id', () => {
      const manager = new ConversationManager();
      expect(() => manager.setActive('nonexistent')).toThrow('not found');
    });

    it('deletes active conversation and leaves activeId null', () => {
      const manager = new ConversationManager();
      manager.addMessage({ role: 'user', content: 'msg' });
      const id = manager.getActive().id;
      manager.delete(id);

      // Getting active should create a new conversation
      const newConv = manager.getActive();
      expect(newConv.id).not.toBe(id);
      expect(newConv.messages).toHaveLength(0);
    });

    it('delete returns false for nonexistent id', () => {
      const manager = new ConversationManager();
      expect(manager.delete('nonexistent')).toBe(false);
    });
  });

  describe('context window', () => {
    it('includes all messages when under budget', () => {
      const manager = new ConversationManager();
      manager.addMessage({ role: 'user', content: 'short' });
      manager.addMessage({ role: 'assistant', content: 'reply' });
      const window = manager.getContextWindow('System', 10000);
      expect(window).toHaveLength(3); // system + 2 messages
    });

    it('trims old messages when over budget', () => {
      const manager = new ConversationManager();
      for (let i = 0; i < 100; i++) {
        manager.addMessage({ role: 'user', content: `Message ${i} ${'x'.repeat(200)}` });
        manager.addMessage({ role: 'assistant', content: `Reply ${i} ${'y'.repeat(200)}` });
      }
      const window = manager.getContextWindow('System', 500);
      expect(window.length).toBeLessThan(200);
      expect(window[0].role).toBe('system');
      // Last message should be the most recent
      expect(window[window.length - 1].content).toContain('Reply 99');
    });

    it('always includes at least one message even if over budget', () => {
      const manager = new ConversationManager();
      manager.addMessage({ role: 'user', content: 'x'.repeat(10000) });
      const window = manager.getContextWindow('System', 10);
      expect(window.length).toBeGreaterThanOrEqual(2); // system + 1
    });
  });

  describe('mode preservation', () => {
    it('creates conversation with specified mode', () => {
      const manager = new ConversationManager();
      const conv = manager.create('ask');
      expect(conv.modeSlug).toBe('ask');
    });

    it('clear preserves current mode', () => {
      const manager = new ConversationManager();
      manager.create('ask');
      manager.addMessage({ role: 'user', content: 'test' });
      const newConv = manager.clear();
      expect(newConv.modeSlug).toBe('ask');
    });
  });
});
