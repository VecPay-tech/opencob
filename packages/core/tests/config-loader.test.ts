import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../src/config/config-loader.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('ConfigLoader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return defaults when no config files exist', async () => {
    const loader = new ConfigLoader(tmpDir);
    const config = await loader.load();
    expect(config.model.provider).toBe('ollama');
    expect(config.model.chat).toBe('qwen2.5-coder:7b');
    expect(config.autoApprove.read).toBe(false);
    expect(config.customModes).toEqual([]);
  });

  it('should load project config from .OpenCob/config.json', async () => {
    const OpenCobDir = path.join(tmpDir, '.OpenCob');
    await fs.mkdir(OpenCobDir, { recursive: true });
    await fs.writeFile(
      path.join(OpenCobDir, 'config.json'),
      JSON.stringify({
        model: { chat: 'llama3:8b' },
        autoApprove: { read: true },
      }),
    );

    const loader = new ConfigLoader(tmpDir);
    const config = await loader.load();
    expect(config.model.chat).toBe('llama3:8b');
    expect(config.model.provider).toBe('ollama'); // default preserved
    expect(config.autoApprove.read).toBe(true);
    expect(config.autoApprove.edit).toBe(false); // default preserved
  });

  it('should load custom modes from .OpenCob/custom_modes.json', async () => {
    const OpenCobDir = path.join(tmpDir, '.OpenCob');
    await fs.mkdir(OpenCobDir, { recursive: true });
    await fs.writeFile(
      path.join(OpenCobDir, 'custom_modes.json'),
      JSON.stringify({
        customModes: [
          {
            slug: 'cobol-expert',
            name: '🏦 COBOL Expert',
            roleDefinition: 'You are a COBOL expert.',
            groups: ['read', 'edit'],
          },
        ],
      }),
    );

    const loader = new ConfigLoader(tmpDir);
    const config = await loader.load();
    expect(config.customModes).toHaveLength(1);
    expect(config.customModes[0].slug).toBe('cobol-expert');
    expect(config.customModes[0].groups).toEqual(['read', 'edit']);
  });

  it('should load mode-specific rules from rules-{slug}/ directories', async () => {
    const rulesDir = path.join(tmpDir, '.OpenCob', 'rules-code');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, 'style.md'), 'Always use semicolons in TypeScript.');
    await fs.writeFile(path.join(rulesDir, 'naming.md'), 'Use camelCase for variables.');

    const loader = new ConfigLoader(tmpDir);
    const config = await loader.load();
    expect(config.modeRules['code']).toHaveLength(2);
    expect(config.modeRules['code']).toContain('Always use semicolons in TypeScript.');
    expect(config.modeRules['code']).toContain('Use camelCase for variables.');
  });

  it('should deep-merge nested config objects', async () => {
    const OpenCobDir = path.join(tmpDir, '.OpenCob');
    await fs.mkdir(OpenCobDir, { recursive: true });
    await fs.writeFile(
      path.join(OpenCobDir, 'config.json'),
      JSON.stringify({
        model: { completion: 'deepseek-coder:1.3b' },
        contextWindow: { maxTokens: 16384 },
      }),
    );

    const loader = new ConfigLoader(tmpDir);
    const config = await loader.load();
    expect(config.model.completion).toBe('deepseek-coder:1.3b');
    expect(config.model.chat).toBe('qwen2.5-coder:7b'); // default
    expect(config.model.provider).toBe('ollama'); // default
    expect(config.contextWindow.maxTokens).toBe(16384);
  });

  it('should handle invalid JSON gracefully', async () => {
    const OpenCobDir = path.join(tmpDir, '.OpenCob');
    await fs.mkdir(OpenCobDir, { recursive: true });
    await fs.writeFile(path.join(OpenCobDir, 'config.json'), '{ invalid json }');

    const loader = new ConfigLoader(tmpDir);
    const config = await loader.load();
    // Should fall back to defaults
    expect(config.model.provider).toBe('ollama');
  });
});
