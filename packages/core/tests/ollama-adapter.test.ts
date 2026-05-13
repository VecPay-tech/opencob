import { describe, it, expect } from 'vitest';
import { OllamaAdapter } from '../src/llm/ollama-adapter.js';

describe('OllamaAdapter', () => {
  it('should have correct name', () => {
    const adapter = new OllamaAdapter();
    expect(adapter.name).toBe('ollama');
  });

  it('should accept custom config', () => {
    const adapter = new OllamaAdapter({
      baseUrl: 'http://localhost:9999',
      chatModel: 'llama3:8b',
    });
    expect(adapter.name).toBe('ollama');
  });

  it('should return false when Ollama is not running', async () => {
    const adapter = new OllamaAdapter({ baseUrl: 'http://127.0.0.1:99999' });
    const available = await adapter.isAvailable();
    expect(available).toBe(false);
  });
});
