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

  it('detects unclosed XML tags', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.html'), '<div><p>Hello</div>');
    const r = await verifier.verify('bad.html');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('Unclosed');
  });

  it('passes valid XML', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.html'), '<div><p>Hello</p></div>');
    const r = await verifier.verify('ok.html');
    expect(r.valid).toBe(true);
  });

  it('handles self-closing XML tags', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.xml'), '<root><br /><input /></root>');
    const r = await verifier.verify('ok.xml');
    expect(r.valid).toBe(true);
  });

  it('detects mismatched bracket in Python', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad2.py'), 'x = [1, 2, 3\ny = 4\n');
    const r = await verifier.verify('bad2.py');
    expect(r.valid).toBe(false);
  });

  it('passes valid Python', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.py'), 'def foo():\n    return [1, 2]\n');
    const r = await verifier.verify('ok.py');
    expect(r.valid).toBe(true);
  });

  it('validates .mjs extension as JavaScript', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.mjs'), 'export function foo() {\n');
    const r = await verifier.verify('bad.mjs');
    expect(r.valid).toBe(false);
  });

  it('validates .cjs extension as JavaScript', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.cjs'), 'module.exports = { a: 1 };\n');
    const r = await verifier.verify('ok.cjs');
    expect(r.valid).toBe(true);
  });

  it('validates .jsx extension', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.jsx'), 'const App = () => <div>Hello</div>;\n');
    const r = await verifier.verify('ok.jsx');
    expect(r.valid).toBe(true);
  });

  it('validates .htm extension as XML', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.htm'), '<html><body></body></html>');
    const r = await verifier.verify('ok.htm');
    expect(r.valid).toBe(true);
  });

  it('validates .yml extension as YAML', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.yml'), 'key:\n\tvalue: 1\n');
    const r = await verifier.verify('bad.yml');
    expect(r.valid).toBe(false);
  });

  it('detects unexpected closing bracket', async () => {
    fs.writeFileSync(path.join(tmpDir, 'extra.ts'), 'const x = 1;\n}\n');
    const r = await verifier.verify('extra.ts');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('unexpected closing');
  });

  it('detects mismatched brackets', async () => {
    fs.writeFileSync(path.join(tmpDir, 'mismatch.ts'), 'function foo(a: number] {}\n');
    const r = await verifier.verify('mismatch.ts');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('mismatched');
  });

  it('handles code with comments and strings correctly', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'complex.ts'),
      `// This is a comment with { unmatched
const str = "hello { world }";
const fn = () => {
  return [1, 2, 3];
};
/* block comment { } */
`,
    );
    const r = await verifier.verify('complex.ts');
    expect(r.valid).toBe(true);
  });

  it('detects unterminated string (odd double quotes)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'str.ts'), 'const x = "unterminated;\n');
    const r = await verifier.verify('str.ts');
    expect(r.valid).toBe(false);
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

  it('counts @mentions and increases score', () => {
    const withMentions = classifier.classify(
      'Fix @file1.ts @file2.ts @file3.ts @file4.ts please',
      0,
      0,
    );
    const without = classifier.classify('Fix the bug please', 0, 0);
    expect(withMentions.score).toBeGreaterThan(without.score);
  });

  it('reduces score for short questions with ?', () => {
    const question = classifier.classify('what?', 0, 0);
    expect(question.level).toBe('low');
    expect(question.score).toBeLessThan(25);
  });

  it('classifies medium-length messages appropriately', () => {
    const medium = classifier.classify('A'.repeat(250), 3, 2);
    expect(medium.level).toBe('medium');
  });

  it('classifies high complexity with all signals', () => {
    const high = classifier.classify(
      'Refactor ' + 'x'.repeat(600) + ' @a @b @c @d multiple files',
      12,
      11,
    );
    expect(high.level).toBe('high');
    expect(high.adjustedMaxTokens).toBe(8192);
    expect(high.adjustedTemperature).toBe(0.7);
  });

  it('clamps score between 0 and 100', () => {
    // Very simple — should not go below 0
    const verySimple = classifier.classify('what is this?', 0, 0);
    expect(verySimple.score).toBeGreaterThanOrEqual(0);

    // Very complex — should not exceed 100
    const veryComplex = classifier.classify(
      'Refactor and redesign and migrate the entire project across files optimize performance security audit review all',
      20,
      20,
    );
    expect(veryComplex.score).toBeLessThanOrEqual(100);
  });

  it('returns low temperature for simple tasks', () => {
    const low = classifier.classify('explain what is a function?', 0, 0);
    expect(low.adjustedTemperature).toBe(0.3);
  });

  it('returns medium temperature for moderate tasks', () => {
    const med = classifier.classify('A'.repeat(250), 3, 2);
    expect(med.adjustedTemperature).toBe(0.5);
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

  it('validates mode — falls back to code for unknown modes', () => {
    const engine = new OrchestratorEngine(mockLlm as any, mockModeEngine as any);
    const result = (engine as any).validateMode('unknown_mode');
    expect(result).toBe('code');
  });

  it('validates mode — accepts valid modes', () => {
    const engine = new OrchestratorEngine(mockLlm as any, mockModeEngine as any);
    expect((engine as any).validateMode('code')).toBe('code');
    expect((engine as any).validateMode('ask')).toBe('ask');
    expect((engine as any).validateMode('plan')).toBe('plan');
    expect((engine as any).validateMode('advanced')).toBe('advanced');
  });

  it('builds prompt without completed context when no subtasks are done', () => {
    const engine = new OrchestratorEngine(mockLlm as any, mockModeEngine as any);
    const plan = {
      goal: 'do something',
      subtasks: [{ id: 1, description: 'first task', mode: 'code', status: 'pending' }],
    };
    const prompt = (engine as any).buildSubtaskPrompt(plan, plan.subtasks[0]);
    expect(prompt).toContain('first task');
    expect(prompt).not.toContain('Previous subtask results');
  });

  it('fallbackPlan assigns plan mode for design requests', () => {
    const engine = new OrchestratorEngine(mockLlm as any, mockModeEngine as any);
    const plan = (engine as any).fallbackPlan('design the new API architecture');
    expect(plan.subtasks[0].mode).toBe('plan');
    expect(plan.subtasks.length).toBe(2); // plan + implement
  });

  it('fallbackPlan assigns code mode for generic requests', () => {
    const engine = new OrchestratorEngine(mockLlm as any, mockModeEngine as any);
    const plan = (engine as any).fallbackPlan('add a login button');
    expect(plan.subtasks[0].mode).toBe('code');
    expect(plan.subtasks.length).toBe(1);
  });

  it('decomposes with LLM when it returns valid JSON', async () => {
    const jsonLlm = {
      chat: async function* () {
        yield {
          type: 'text',
          text: '[{"description": "Analyze code", "mode": "ask"}, {"description": "Fix bug", "mode": "code"}]',
        };
        yield { type: 'done' };
      },
      listModels: async () => [],
    };

    const engine = new OrchestratorEngine(jsonLlm as any, mockModeEngine as any);
    const plan = await engine.decompose('Analyze and fix the login bug');
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[0].mode).toBe('ask');
    expect(plan.subtasks[1].mode).toBe('code');
    expect(plan.subtasks[0].status).toBe('pending');
  });
});
