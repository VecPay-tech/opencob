import { describe, it, expect } from 'vitest';
import { ModeEngine, BUILT_IN_MODES } from '../src/modes/mode-engine.js';

describe('ModeEngine', () => {
  it('should start in code mode', () => {
    const engine = new ModeEngine();
    expect(engine.getActive().slug).toBe('code');
  });

  it('should have 5 built-in modes', () => {
    const engine = new ModeEngine();
    expect(engine.listModes()).toHaveLength(5);
  });

  it('should switch modes', () => {
    const engine = new ModeEngine();
    const mode = engine.setActive('ask');
    expect(mode.slug).toBe('ask');
    expect(mode.name).toBe('❓ Ask');
  });

  it('should throw on unknown mode', () => {
    const engine = new ModeEngine();
    expect(() => engine.setActive('nonexistent')).toThrow('Unknown mode: nonexistent');
  });

  it('should check tool group permissions', () => {
    const engine = new ModeEngine();
    engine.setActive('code');
    expect(engine.isToolGroupAllowed('read')).toBe(true);
    expect(engine.isToolGroupAllowed('edit')).toBe(true);
    expect(engine.isToolGroupAllowed('command')).toBe(true);
    expect(engine.isToolGroupAllowed('mcp')).toBe(false);
  });

  it('should restrict edit in plan mode to markdown', () => {
    const engine = new ModeEngine();
    engine.setActive('plan');
    expect(engine.isToolGroupAllowed('edit')).toBe(true);
    expect(engine.getEditRestriction()).toBe('\\.md$');
  });

  it('should have no tools in orchestrator mode', () => {
    const engine = new ModeEngine();
    engine.setActive('orchestrator');
    expect(engine.isToolGroupAllowed('read')).toBe(false);
    expect(engine.isToolGroupAllowed('edit')).toBe(false);
    expect(engine.isToolGroupAllowed('command')).toBe(false);
  });

  it('should allow custom modes to override built-in', () => {
    const customCode = {
      ...BUILT_IN_MODES[0],
      name: '💻 Code (Custom)',
      customInstructions: 'Use Python only',
    };
    const engine = new ModeEngine([customCode]);
    engine.setActive('code');
    expect(engine.getActive().name).toBe('💻 Code (Custom)');
  });

  it('should allow adding new custom modes', () => {
    const engine = new ModeEngine([
      {
        slug: 'reviewer',
        name: '🔍 Reviewer',
        roleDefinition: 'You are a code reviewer.',
        groups: ['read'],
      },
    ]);
    expect(engine.listModes()).toHaveLength(6);
    const mode = engine.setActive('reviewer');
    expect(mode.name).toBe('🔍 Reviewer');
  });

  it('should register a mode dynamically', () => {
    const engine = new ModeEngine();
    expect(engine.listModes()).toHaveLength(5);
    engine.registerMode({
      slug: 'debug',
      name: '🐛 Debug',
      roleDefinition: 'You are a debugging expert.',
      groups: ['read', 'command'],
    });
    expect(engine.listModes()).toHaveLength(6);
    const mode = engine.setActive('debug');
    expect(mode.name).toBe('🐛 Debug');
  });
});
