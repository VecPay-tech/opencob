import { describe, it, expect, beforeEach } from 'vitest';
import { createAskFollowupTool } from '../src/tools/ask-followup.js';
import { createSwitchModeTool } from '../src/tools/switch-mode.js';
import { ModeEngine } from '../src/modes/mode-engine.js';

describe('ask_followup_question tool', () => {
  const tool = createAskFollowupTool();

  it('should have correct metadata', () => {
    expect(tool.name).toBe('ask_followup_question');
    expect(tool.group).toBe('meta');
    expect(tool.parameters).toHaveLength(1);
    expect(tool.parameters[0].name).toBe('question');
  });

  it('should return the question text on success', async () => {
    const result = await tool.execute({ question: 'What file should I modify?' });
    expect(result.success).toBe(true);
    expect(result.content).toBe('What file should I modify?');
    expect(result.metadata?.type).toBe('followup_question');
  });

  it('should fail when question is empty', async () => {
    const result = await tool.execute({ question: '' });
    expect(result.success).toBe(false);
  });

  it('should fail when question is missing', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
  });
});

describe('switch_mode tool', () => {
  let modeEngine: ModeEngine;
  let tool: ReturnType<typeof createSwitchModeTool>;

  beforeEach(() => {
    modeEngine = new ModeEngine();
    tool = createSwitchModeTool(modeEngine);
  });

  it('should have correct metadata', () => {
    expect(tool.name).toBe('switch_mode');
    expect(tool.group).toBe('meta');
    expect(tool.parameters).toHaveLength(2);
  });

  it('should switch mode successfully', async () => {
    const result = await tool.execute({ mode: 'ask' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Ask');
    expect(modeEngine.getActive().slug).toBe('ask');
  });

  it('should switch to plan mode', async () => {
    const result = await tool.execute({ mode: 'plan', reason: 'need to plan first' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Plan');
    expect(result.content).toContain('need to plan first');
    expect(modeEngine.getActive().slug).toBe('plan');
  });

  it('should fail for empty mode slug', async () => {
    const result = await tool.execute({ mode: '' });
    expect(result.success).toBe(false);
  });

  it('should fail for unknown mode', async () => {
    const result = await tool.execute({ mode: 'nonexistent-mode' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('Failed');
  });
});
