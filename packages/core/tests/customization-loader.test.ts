import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CustomizationLoader } from '../src/agent/customization-loader.js';

describe('CustomizationLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-loader-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupConfigDir(structure: Record<string, string>): void {
    for (const [relPath, content] of Object.entries(structure)) {
      const absPath = path.join(tmpDir, '.opencob', relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content);
    }
  }

  // ─── Loading ──────────────────────────────────────────────────────────

  describe('load()', () => {
    it('returns empty context when .opencob/ does not exist', () => {
      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.projectInstructions).toBe('');
      expect(ctx.agents).toHaveLength(0);
      expect(ctx.instructions).toHaveLength(0);
      expect(ctx.prompts).toHaveLength(0);
    });

    it('loads project instructions from opencob-instructions.md', () => {
      setupConfigDir({
        'opencob-instructions.md': '# Project\n\nUse TypeScript.\nNo any types.',
      });
      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.projectInstructions).toContain('Use TypeScript');
      expect(ctx.projectInstructions).toContain('No any types');
    });

    it('caches results until invalidated', () => {
      setupConfigDir({ 'opencob-instructions.md': 'Initial' });
      const loader = new CustomizationLoader(tmpDir);

      const ctx1 = loader.load();
      expect(ctx1.projectInstructions).toBe('Initial');

      // Modify file — should still return cached
      fs.writeFileSync(path.join(tmpDir, '.opencob', 'opencob-instructions.md'), 'Updated');
      const ctx2 = loader.load();
      expect(ctx2.projectInstructions).toBe('Initial');

      // After invalidation, should reload
      loader.invalidate();
      const ctx3 = loader.load();
      expect(ctx3.projectInstructions).toBe('Updated');
    });
  });

  // ─── Agents ───────────────────────────────────────────────────────────

  describe('agents', () => {
    it('loads agent definitions from agents/ directory', () => {
      setupConfigDir({
        'agents/modernizer.agent.md': `---
name: cobol-modernizer
description: COBOL to Java modernization
tools: [read_file, write_file, apply_diff]
---

# COBOL Modernizer

You specialize in COBOL modernization.`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.agents).toHaveLength(1);
      expect(ctx.agents[0].name).toBe('cobol-modernizer');
      expect(ctx.agents[0].description).toBe('COBOL to Java modernization');
      expect(ctx.agents[0].tools).toEqual(['read_file', 'write_file', 'apply_diff']);
      expect(ctx.agents[0].body).toContain('COBOL Modernizer');
    });

    it('ignores non-.agent.md files', () => {
      setupConfigDir({
        'agents/notes.md': '# Not an agent',
        'agents/modernizer.agent.md': `---
name: test-agent
description: Test
tools: []
---

Agent body`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.agents).toHaveLength(1);
      expect(ctx.agents[0].name).toBe('test-agent');
    });

    it('uses filename as agent name when frontmatter name is missing', () => {
      setupConfigDir({
        'agents/my-agent.agent.md': `---
description: A test agent
tools: [read_file]
---

Body here`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.agents[0].name).toBe('my-agent');
    });

    it('handles agent file with no frontmatter', () => {
      setupConfigDir({
        'agents/simple.agent.md': '# Simple Agent\n\nJust a body.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.agents).toHaveLength(1);
      expect(ctx.agents[0].name).toBe('simple');
      expect(ctx.agents[0].tools).toEqual([]);
      expect(ctx.agents[0].body).toContain('Simple Agent');
    });

    it('listAgents() returns agent names', () => {
      setupConfigDir({
        'agents/a.agent.md': '---\nname: alpha\ntools: []\n---\nBody',
        'agents/b.agent.md': '---\nname: beta\ntools: []\n---\nBody',
      });

      const loader = new CustomizationLoader(tmpDir);
      expect(loader.listAgents()).toEqual(expect.arrayContaining(['alpha', 'beta']));
    });

    it('getAgentTools() returns tool list for named agent', () => {
      setupConfigDir({
        'agents/dev.agent.md': '---\nname: dev\ntools: [read_file, write_file]\n---\nBody',
      });

      const loader = new CustomizationLoader(tmpDir);
      expect(loader.getAgentTools('dev')).toEqual(['read_file', 'write_file']);
    });

    it('getAgentTools() returns empty array for unknown agent', () => {
      const loader = new CustomizationLoader(tmpDir);
      expect(loader.getAgentTools('nonexistent')).toEqual([]);
    });
  });

  // ─── Instructions ─────────────────────────────────────────────────────

  describe('instructions', () => {
    it('loads instruction files with applyTo patterns', () => {
      setupConfigDir({
        'instructions/api.instructions.md': `---
description: API conventions
applyTo: "src/api/**/*.ts"
---

# API Rules

- Validate with zod
- Return typed responses`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.instructions).toHaveLength(1);
      expect(ctx.instructions[0].description).toBe('API conventions');
      expect(ctx.instructions[0].applyTo).toBe('src/api/**/*.ts');
      expect(ctx.instructions[0].body).toContain('Validate with zod');
    });

    it('ignores instruction files without applyTo', () => {
      setupConfigDir({
        'instructions/bad.instructions.md': `---
description: No applyTo
---

Instructions without scope`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.instructions).toHaveLength(0);
    });

    it('ignores non-.instructions.md files', () => {
      setupConfigDir({
        'instructions/readme.md': '# Readme',
        'instructions/api.instructions.md': '---\napplyTo: "src/**"\ndescription: test\n---\nBody',
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.instructions).toHaveLength(1);
    });
  });

  // ─── Prompts ──────────────────────────────────────────────────────────

  describe('prompts', () => {
    it('loads prompt templates with variables', () => {
      setupConfigDir({
        'prompts/create-endpoint.prompt.md': `---
name: create-api-endpoint
description: Scaffold a new REST endpoint
mode: code
variables:
  - name: endpoint_name, description: Name of the endpoint
  - name: method, description: HTTP method, options: [GET, POST, PUT, DELETE]
  - name: path, description: URL path
---

# Create Endpoint

Create a {{method}} endpoint at \`{{path}}\` named \`{{endpoint_name}}\`.`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.prompts).toHaveLength(1);
      expect(ctx.prompts[0].name).toBe('create-api-endpoint');
      expect(ctx.prompts[0].description).toBe('Scaffold a new REST endpoint');
      expect(ctx.prompts[0].mode).toBe('code');
      expect(ctx.prompts[0].variables).toHaveLength(3);
      expect(ctx.prompts[0].body).toContain('{{method}}');
    });

    it('uses filename as name when frontmatter name is missing', () => {
      setupConfigDir({
        'prompts/review-code.prompt.md': `---
description: Review code
---

Review the code.`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.prompts[0].name).toBe('review-code');
    });

    it('handles simple string variables array', () => {
      setupConfigDir({
        'prompts/simple.prompt.md': `---
name: simple
description: Simple prompt
variables:
  - varA
  - varB
---

Use {{varA}} and {{varB}}.`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.prompts[0].variables).toHaveLength(2);
      expect(ctx.prompts[0].variables[0].name).toBe('varA');
      expect(ctx.prompts[0].variables[1].name).toBe('varB');
    });

    it('listPromptTemplates() returns template names', () => {
      setupConfigDir({
        'prompts/a.prompt.md': '---\nname: alpha\ndescription: A\n---\nBody',
        'prompts/b.prompt.md': '---\nname: beta\ndescription: B\n---\nBody',
      });

      const loader = new CustomizationLoader(tmpDir);
      expect(loader.listPromptTemplates()).toEqual(expect.arrayContaining(['alpha', 'beta']));
    });

    it('getPromptTemplate() returns template by name', () => {
      setupConfigDir({
        'prompts/test.prompt.md': '---\nname: my-template\ndescription: Test\n---\nBody',
      });

      const loader = new CustomizationLoader(tmpDir);
      const tmpl = loader.getPromptTemplate('my-template');
      expect(tmpl).toBeDefined();
      expect(tmpl!.name).toBe('my-template');
    });

    it('getPromptTemplate() returns undefined for unknown name', () => {
      const loader = new CustomizationLoader(tmpDir);
      expect(loader.getPromptTemplate('nonexistent')).toBeUndefined();
    });
  });

  // ─── Render Prompt Template ───────────────────────────────────────────

  describe('renderPromptTemplate()', () => {
    it('substitutes variables in template body', () => {
      const loader = new CustomizationLoader(tmpDir);
      const template = {
        name: 'test',
        description: 'Test',
        variables: [{ name: 'method' }, { name: 'path' }],
        body: 'Create a {{method}} endpoint at {{path}}.',
      };

      const result = loader.renderPromptTemplate(template, {
        method: 'POST',
        path: '/api/users',
      });
      expect(result).toBe('Create a POST endpoint at /api/users.');
    });

    it('handles multiple occurrences of same variable', () => {
      const loader = new CustomizationLoader(tmpDir);
      const template = {
        name: 'test',
        description: '',
        variables: [{ name: 'name' }],
        body: 'Hello {{name}}! Welcome {{name}}.',
      };

      const result = loader.renderPromptTemplate(template, { name: 'World' });
      expect(result).toBe('Hello World! Welcome World.');
    });

    it('leaves unknown variables as-is', () => {
      const loader = new CustomizationLoader(tmpDir);
      const template = {
        name: 'test',
        description: '',
        variables: [],
        body: 'Value: {{unknown}}',
      };

      const result = loader.renderPromptTemplate(template, {});
      expect(result).toBe('Value: {{unknown}}');
    });
  });

  // ─── Resolution ───────────────────────────────────────────────────────

  describe('resolve()', () => {
    it('includes project instructions in resolution', () => {
      setupConfigDir({
        'opencob-instructions.md': '# Global\n\nAlways do this.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const resolved = loader.resolve([]);
      expect(resolved.systemPromptAdditions).toHaveLength(1);
      expect(resolved.systemPromptAdditions[0]).toContain('Always do this');
    });

    it('matches instructions by applyTo glob', () => {
      setupConfigDir({
        'instructions/api.instructions.md': `---
applyTo: "src/api/**/*.ts"
description: API rules
---

Use zod.`,
        'instructions/tests.instructions.md': `---
applyTo: "**/*.test.ts"
description: Test rules
---

Use vitest.`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const resolved = loader.resolve(['src/api/routes/users.ts']);
      expect(resolved.matchedInstructions).toHaveLength(1);
      expect(resolved.matchedInstructions[0].body).toContain('Use zod');
    });

    it('matches multiple instructions for same file', () => {
      setupConfigDir({
        'instructions/ts.instructions.md': `---
applyTo: "**/*.ts"
description: TypeScript rules
---

TS rules.`,
        'instructions/test.instructions.md': `---
applyTo: "**/*.test.ts"
description: Test rules
---

Test rules.`,
      });

      const loader = new CustomizationLoader(tmpDir);
      const resolved = loader.resolve(['src/foo.test.ts']);
      expect(resolved.matchedInstructions).toHaveLength(2);
    });

    it('includes active agent body in systemPromptAdditions', () => {
      setupConfigDir({
        'agents/dev.agent.md': '---\nname: dev\ntools: [read_file]\n---\nYou are a dev agent.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const resolved = loader.resolve([], 'dev');
      expect(resolved.activeAgent).toBeDefined();
      expect(resolved.activeAgent!.name).toBe('dev');
      expect(resolved.systemPromptAdditions[0]).toContain('dev agent');
    });

    it('returns no activeAgent when agent name not found', () => {
      const loader = new CustomizationLoader(tmpDir);
      const resolved = loader.resolve([], 'nonexistent');
      expect(resolved.activeAgent).toBeUndefined();
    });

    it('orders additions: agent, project, matched instructions (by specificity)', () => {
      setupConfigDir({
        'opencob-instructions.md': 'Project instructions.',
        'agents/dev.agent.md': '---\nname: dev\ntools: []\n---\nAgent persona.',
        'instructions/api.instructions.md':
          '---\napplyTo: "src/api/**/*.ts"\ndescription: API\n---\nAPI rules.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const resolved = loader.resolve(['src/api/routes/users.ts'], 'dev');
      expect(resolved.systemPromptAdditions).toHaveLength(3);
      expect(resolved.systemPromptAdditions[0]).toContain('Agent persona');
      expect(resolved.systemPromptAdditions[1]).toContain('Project instructions');
      expect(resolved.systemPromptAdditions[2]).toContain('API rules');
    });
  });

  // ─── Glob Matching ────────────────────────────────────────────────────

  describe('glob matching', () => {
    it('matches ** patterns', () => {
      setupConfigDir({
        'instructions/all-ts.instructions.md':
          '---\napplyTo: "**/*.ts"\ndescription: TS\n---\nRules.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const resolved = loader.resolve(['src/deep/nested/file.ts']);
      expect(resolved.matchedInstructions).toHaveLength(1);
    });

    it('does not match non-matching extensions', () => {
      setupConfigDir({
        'instructions/ts.instructions.md': '---\napplyTo: "**/*.ts"\ndescription: TS\n---\nRules.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const resolved = loader.resolve(['src/file.js']);
      expect(resolved.matchedInstructions).toHaveLength(0);
    });

    it('matches single-level * patterns', () => {
      setupConfigDir({
        'instructions/root.instructions.md':
          '---\napplyTo: "src/*.ts"\ndescription: Root\n---\nRules.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const resolved1 = loader.resolve(['src/index.ts']);
      expect(resolved1.matchedInstructions).toHaveLength(1);

      const resolved2 = loader.resolve(['src/sub/index.ts']);
      expect(resolved2.matchedInstructions).toHaveLength(0);
    });

    it('handles backslash paths (Windows)', () => {
      setupConfigDir({
        'instructions/api.instructions.md':
          '---\napplyTo: "src/api/**/*.ts"\ndescription: API\n---\nRules.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const resolved = loader.resolve(['src\\api\\routes\\users.ts']);
      expect(resolved.matchedInstructions).toHaveLength(1);
    });
  });

  // ─── .OpenCob/ (uppercase) support ────────────────────────────────────

  describe('case-insensitive config dir', () => {
    it('falls back to .OpenCob/ when .opencob/ does not exist', () => {
      // Create .OpenCob/ instead of .opencob/
      const upperDir = path.join(tmpDir, '.OpenCob');
      fs.mkdirSync(upperDir, { recursive: true });
      fs.writeFileSync(path.join(upperDir, 'opencob-instructions.md'), 'Upper case dir.');

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.projectInstructions).toBe('Upper case dir.');
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty .opencob/ directory', () => {
      fs.mkdirSync(path.join(tmpDir, '.opencob'), { recursive: true });
      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.projectInstructions).toBe('');
      expect(ctx.agents).toHaveLength(0);
    });

    it('handles malformed frontmatter gracefully', () => {
      setupConfigDir({
        'agents/bad.agent.md': '---\nthis is not: [valid yaml\n---\nBody.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      // Should still parse what it can
      expect(ctx.agents).toHaveLength(1);
    });

    it('handles agent file with empty tools list', () => {
      setupConfigDir({
        'agents/empty.agent.md': '---\nname: empty\ndescription: test\ntools: []\n---\nBody.',
      });

      const loader = new CustomizationLoader(tmpDir);
      const ctx = loader.load();
      expect(ctx.agents[0].tools).toEqual([]);
    });
  });
});
