import { describe, it, expect } from 'vitest';
import { SlashCommandHandler } from '../src/agent/slash-command-handler.js';
import { ModeEngine } from '../src/modes/mode-engine.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

function makeHandler() {
  const modeEngine = new ModeEngine();
  const toolRegistry = new ToolRegistry([], modeEngine);
  return new SlashCommandHandler({
    modeEngine,
    snapshotManager: null,
    toolRegistry,
    customCommands: new Map(),
  });
}

describe('SlashCommandHandler', () => {
  it('returns passthrough for non-slash input', () => {
    const h = makeHandler();
    expect(h.handle('hello world').kind).toBe('passthrough');
  });

  it('/code switches mode and returns event', () => {
    const h = makeHandler();
    const result = h.handle('/code');
    expect(result.kind).toBe('event');
    if (result.kind === 'event') expect(result.event.type).toBe('mode_switch');
  });

  it('/new returns done event', () => {
    const h = makeHandler();
    const result = h.handle('/new');
    expect(result.kind).toBe('event');
    if (result.kind === 'event') expect(result.event.type).toBe('done');
  });

  it('/explain returns rewrite with prefix', () => {
    const h = makeHandler();
    const result = h.handle('/explain some code');
    expect(result.kind).toBe('rewrite');
    if (result.kind === 'rewrite') expect(result.message).toContain('Explain');
  });

  it('/explain without args returns usage event', () => {
    const h = makeHandler();
    const result = h.handle('/explain');
    expect(result.kind).toBe('event');
    if (result.kind === 'event') expect(result.event.text).toContain('Usage');
  });

  it('custom command returns rewrite with custom prompt', () => {
    const modeEngine = new ModeEngine();
    const toolRegistry = new ToolRegistry([], modeEngine);
    const customCommands = new Map([
      ['myCmd', { description: 'test', prompt: 'Do custom thing:' }],
    ]);
    const h = new SlashCommandHandler({
      modeEngine,
      snapshotManager: null,
      toolRegistry,
      customCommands,
    });
    const result = h.handle('/myCmd context');
    expect(result.kind).toBe('rewrite');
    if (result.kind === 'rewrite') expect(result.message).toContain('Do custom thing:');
  });
});
