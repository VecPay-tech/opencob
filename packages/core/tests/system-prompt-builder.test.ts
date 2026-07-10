import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder } from '../src/agent/system-prompt-builder.js';
import { ModeEngine } from '../src/modes/mode-engine.js';

describe('SystemPromptBuilder', () => {
  it('includes mode roleDefinition in output', () => {
    const modeEngine = new ModeEngine();
    const builder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: null,
      skillsLoader: null,
    });
    const prompt = builder.build();
    const mode = modeEngine.getActive();
    expect(prompt).toContain(mode.roleDefinition);
  });

  it('includes Guidelines section', () => {
    const modeEngine = new ModeEngine();
    const builder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: null,
      skillsLoader: null,
    });
    expect(builder.build()).toContain('## Guidelines');
  });

  it('includes Workspace Structure when workspaceRoot is set', () => {
    const modeEngine = new ModeEngine();
    const builder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: null,
      skillsLoader: null,
      workspaceRoot: process.cwd(),
    });
    const prompt = builder.build();
    expect(prompt).toContain('## Workspace Structure');
  });

  it('omits Workspace Structure when workspaceRoot is undefined', () => {
    const modeEngine = new ModeEngine();
    const builder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: null,
      skillsLoader: null,
    });
    expect(builder.build()).not.toContain('## Workspace Structure');
  });
});
