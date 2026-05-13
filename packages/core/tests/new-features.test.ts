import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PostEditVerifier } from '../src/agent/post-edit-verifier.js';
import { TaskComplexityClassifier } from '../src/agent/task-complexity.js';
import { OrchestratorEngine } from '../src/agent/orchestrator-engine.js';

// ─── Post-Edit Verifier ─────────────────────────────────────────────────────
describe('PostEditVerifier', () => {
  let tmpDir: string;
  let verifier: PostEditVerifier;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pev-'));
    verifier = new PostEditVerifier(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates correct JSON', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.json'), '{"a": 1}');
    const r = await verifier.verify('ok.json');
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('catches invalid JSON', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), '{a: 1}');
    const r = await verifier.verify('bad.json');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('detects unmatched brackets in JS', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.ts'), 'function foo() {\n  if (true) {\n}\n');
    const r = await verifier.verify('bad.ts');
    expect(r.valid).toBe(false);
  });

  it('passes valid JS', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.ts'), 'function foo() {\n  return 1;\n}\n');
    const r = await verifier.verify('ok.ts');
    expect(r.valid).toBe(true);
  });

  it('detects tabs in YAML', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.yaml'), 'key:\n\tvalue: 1\n');
    const r = await verifier.verify('bad.yaml');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('tab');
  });

  it('passes valid YAML', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.yaml'), 'key:\n  value: 1\n');
    const r = await verifier.verify('ok.yaml');
    expect(r.valid).toBe(true);
  });

  it('detects mixed indentation in Python', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.py'), 'def foo():\n\t x = 1\n');
    const r = await verifier.verify('bad.py');
    expect(r.valid).toBe(false);
  });

  it('handles missing files gracefully', async () => {
    const r = await verifier.verify('nonexistent.json');
    expect(r.valid).toBe(true);
  });

  it('skips unknown extensions', async () => {
    fs.writeFileSync(path.join(tmpDir, 'data.bin'), 'garbage');
    const r = await verifier.verify('data.bin');
    expect(r.valid).toBe(true);
  });
});

// ─── Task Complexity Classifier ──────────────────────────────────────────────
describe('TaskComplexityClassifier', () => {
  let classifier: TaskComplexityClassifier;

  beforeEach(() => {
    classifier = new TaskComplexityClassifier();
  });

  it('classifies simple questions as low', () => {
    const result = classifier.classify('what is this?', 0, 0);
    expect(result.level).toBe('low');
    expect(result.score).toBeLessThan(35);
  });

  it('classifies complex requests higher than simple', () => {
    const simple = classifier.classify('what is this?', 0, 0);
    const complex = classifier.classify(
      'Refactor the entire authentication module to use JWT tokens, implement refresh token rotation, add rate limiting, and write comprehensive integration tests for all endpoints. Also update the database schema and migration files.',
      10,
      5,
    );
    expect(complex.score).toBeGreaterThan(simple.score);
  });

  it('increases score with context files and turn depth', () => {
    const base = classifier.classify('fix the bug', 0, 0);
    const withContext = classifier.classify('fix the bug', 8, 6);
    expect(withContext.score).toBeGreaterThan(base.score);
  });

  it('adjusts tokens based on complexity', () => {
    const low = classifier.classify('what?', 0, 0);
    const high = classifier.classify(
      'Refactor and redesign the architecture with multi-file changes across the entire codebase',
      15,
      8,
    );
    expect(high.adjustedMaxTokens).toBeGreaterThan(low.adjustedMaxTokens);
  });

  it('provides a reason string', () => {
    const result = classifier.classify('test', 0, 0);
    expect(result.reason).toBeTruthy();
  });
});

// ─── Orchestrator Engine ─────────────────────────────────────────────────────
describe('OrchestratorEngine', () => {
  const mockLlm = {
    chat: async () => ({ content: '', finishReason: 'stop' as const }),
    streamChat: async function* () {
      yield { content: '', done: true };
    },
    listModels: async () => [],
    modelId: 'test',
  };

  const mockModeEngine = {
    getActive: () => ({
      slug: 'code',
      name: 'Code',
      roleDefinition: 'You write code',
      allowedTools: [],
    }),
    setMode: () => {},
    listModes: () => [],
    addMode: () => {},
  };

  it('creates a fallback plan when LLM fails', async () => {
    const engine = new OrchestratorEngine(mockLlm as any, mockModeEngine as any);
    const plan = await engine.decompose('Fix the bug and explain it');
    // Should get fallback plan
    expect(plan.goal).toBe('Fix the bug and explain it');
    expect(plan.subtasks.length).toBeGreaterThan(0);
  });

  it('fallbackPlan assigns mode based on keywords', () => {
    const engine = new OrchestratorEngine(mockLlm as any, mockModeEngine as any);
    const planAsk = (engine as any).fallbackPlan('explain the code');
    expect(planAsk.subtasks[0].mode).toBe('ask');
    const planCode = (engine as any).fallbackPlan('implement the feature');
    expect(planCode.subtasks[0].mode).toBe('code');
  });

  it('builds subtask prompts with context from completed tasks', () => {
    const engine = new OrchestratorEngine(mockLlm as any, mockModeEngine as any);
    const plan = {
      goal: 'fix and explain',
      subtasks: [
        {
          id: 1,
          description: 'analyze',
          mode: 'ask',
          status: 'done',
          result: 'Found issue in auth.ts',
        },
        { id: 2, description: 'fix the bug', mode: 'code', status: 'pending' },
      ],
    };
    const prompt = (engine as any).buildSubtaskPrompt(plan, plan.subtasks[1]);
    expect(prompt).toContain('fix the bug');
    expect(prompt).toContain('Found issue in auth.ts');
  });
});
