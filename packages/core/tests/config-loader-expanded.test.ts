import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../src/config/config-loader.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('ConfigLoader — expanded coverage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('defaults', () => {
    it('loads default config when no files exist', async () => {
      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.model.provider).toBe('ollama');
      expect(config.model.chat).toBe('qwen2.5-coder:7b');
      expect(config.autoApprove.read).toBe(false);
      expect(config.autoApprove.edit).toBe(false);
      expect(config.contextWindow.maxTokens).toBe(8192);
      expect(config.customModes).toHaveLength(0);
    });

    it('getConfig returns default before load', () => {
      const loader = new ConfigLoader(tmpDir);
      const config = loader.getConfig();
      expect(config.model.provider).toBe('ollama');
    });
  });

  describe('JSON config loading', () => {
    it('loads project-level config.json', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'config.json'),
        JSON.stringify({
          model: { provider: 'openai-compatible', chat: 'gpt-4o' },
          autoApprove: { read: true },
        }),
      );

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.model.provider).toBe('openai-compatible');
      expect(config.model.chat).toBe('gpt-4o');
      expect(config.autoApprove.read).toBe(true);
      // Other defaults preserved
      expect(config.autoApprove.edit).toBe(false);
    });

    it('handles invalid JSON gracefully', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.json'), 'not valid json!!!');

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      // Falls back to defaults
      expect(config.model.provider).toBe('ollama');
    });
  });

  describe('YAML config loading', () => {
    it('loads config.yaml with simple scalars', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'config.yaml'),
        `model:
  provider: openai-compatible
  chat: gpt-4o
  baseUrl: "http://localhost:4000"
autoApprove:
  read: true
  edit: true
contextWindow:
  maxTokens: 16384
`,
      );

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.model.provider).toBe('openai-compatible');
      expect(config.model.chat).toBe('gpt-4o');
      expect(config.model.baseUrl).toBe('http://localhost:4000');
      expect(config.autoApprove.read).toBe(true);
      expect(config.autoApprove.edit).toBe(true);
      expect(config.contextWindow.maxTokens).toBe(16384);
    });

    it('parses YAML booleans and null correctly', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'config.yaml'),
        `autoApprove:
  read: True
  edit: FALSE
  command: true
  mcp: false
`,
      );

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.autoApprove.read).toBe(true);
      expect(config.autoApprove.edit).toBe(false);
      expect(config.autoApprove.command).toBe(true);
      expect(config.autoApprove.mcp).toBe(false);
    });

    it('handles comments and empty lines in YAML', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'config.yaml'),
        `# Comment line
model:
  # Another comment
  provider: ollama

  chat: mistral

contextWindow:
  maxTokens: 4096
`,
      );

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.model.provider).toBe('ollama');
      expect(config.model.chat).toBe('mistral');
      expect(config.contextWindow.maxTokens).toBe(4096);
    });
  });

  describe('custom modes', () => {
    it('loads custom modes from custom_modes.json', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'custom_modes.json'),
        JSON.stringify({
          customModes: [
            {
              slug: 'reviewer',
              name: 'Code Reviewer',
              roleDefinition: 'You review code for bugs',
              groups: ['read'],
            },
          ],
        }),
      );

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.customModes).toHaveLength(1);
      expect(config.customModes[0].slug).toBe('reviewer');
      expect(config.customModes[0].name).toBe('Code Reviewer');
    });

    it('deduplicates custom modes by slug', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'custom_modes.json'),
        JSON.stringify({
          customModes: [
            { slug: 'test', name: 'First', roleDefinition: 'first', groups: ['read'] },
            { slug: 'test', name: 'Second', roleDefinition: 'second', groups: ['read', 'edit'] },
          ],
        }),
      );

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.customModes).toHaveLength(1);
      expect(config.customModes[0].name).toBe('Second');
    });
  });

  describe('mode rules', () => {
    it('loads rules from rules-<slug>/ directories', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      const rulesDir = path.join(configDir, 'rules-code');
      await fs.mkdir(rulesDir, { recursive: true });
      await fs.writeFile(path.join(rulesDir, 'always-test.md'), 'Always write tests');
      await fs.writeFile(path.join(rulesDir, 'use-types.md'), 'Use strict TypeScript types');

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.modeRules['code']).toHaveLength(2);
      expect(config.modeRules['code']).toContain('Always write tests');
      expect(config.modeRules['code']).toContain('Use strict TypeScript types');
    });

    it('loads general rules from .OpenCob/rules/', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      const rulesDir = path.join(configDir, 'rules');
      await fs.mkdir(rulesDir, { recursive: true });
      await fs.writeFile(path.join(rulesDir, 'general.md'), 'Be concise');

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.modeRules['_general']).toContain('Be concise');
    });

    it('loads .OpenCobrules file', async () => {
      await fs.writeFile(path.join(tmpDir, '.OpenCobrules'), 'Rule from OpenCobrules file');

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.modeRules['_general']).toContain('Rule from OpenCobrules file');
    });

    it('loads AGENTS.md file', async () => {
      await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Agent rules\nBe helpful');

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      expect(config.modeRules['_general']).toContain('# Agent rules\nBe helpful');
    });
  });

  describe('deep merge', () => {
    it('merges nested objects without overwriting siblings', async () => {
      const configDir = path.join(tmpDir, '.OpenCob');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'config.json'),
        JSON.stringify({
          model: { chat: 'custom-model' },
        }),
      );

      const loader = new ConfigLoader(tmpDir);
      const config = await loader.load();
      // chat is overridden but provider and baseUrl should keep defaults
      expect(config.model.chat).toBe('custom-model');
      expect(config.model.provider).toBe('ollama');
      expect(config.model.baseUrl).toBe('http://127.0.0.1:11434');
    });
  });
});
