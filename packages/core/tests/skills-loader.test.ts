import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillsLoader } from '../src/skills/skills-loader.js';

describe('SkillsLoader', () => {
  let tmpDir: string;
  let loader: SkillsLoader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenCob-skills-'));
    loader = new SkillsLoader(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads skills from .OpenCob/skills/ directory', async () => {
    const skillsDir = path.join(tmpDir, '.OpenCob', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'test-skill.md'),
      `---
name: test-skill
description: A test skill
---
You are a testing expert.
`,
    );

    const skills = await loader.loadAll();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('test-skill');
    expect(skills[0].description).toBe('A test skill');
    expect(skills[0].instructions).toContain('testing expert');
  });

  it('loads skill from directory with SKILL.md', async () => {
    const skillDir = path.join(tmpDir, '.OpenCob', 'skills', 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: My custom skill
---
Custom instructions here.
`,
    );

    const skills = await loader.loadAll();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('my-skill');
  });

  it('returns empty array when no skills directory exists', async () => {
    const skills = await loader.loadAll();
    expect(skills).toHaveLength(0);
  });

  it('loads a specific skill by name', async () => {
    const skillsDir = path.join(tmpDir, '.OpenCob', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'target.md'),
      `---
name: target
description: Target skill
---
Instructions for target.
`,
    );

    const skill = await loader.loadByName('target');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('target');
  });

  it('returns null for non-existent skill name', async () => {
    const skill = await loader.loadByName('nonexistent');
    expect(skill).toBeNull();
  });

  it('parses frontmatter with applyTo patterns', async () => {
    const skillsDir = path.join(tmpDir, '.OpenCob', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'ts-skill.md'),
      `---
name: ts-skill
description: TypeScript skill
applyTo: [*.ts, *.tsx]
---
TypeScript specific instructions.
`,
    );

    const skills = await loader.loadAll();
    expect(skills[0].applyTo).toEqual(['*.ts', '*.tsx']);
  });

  it('matches skills by file path', async () => {
    const skillsDir = path.join(tmpDir, '.OpenCob', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'py-skill.md'),
      `---
name: py-skill
description: Python skill
applyTo: [*.py]
---
Python instructions.
`,
    );

    const matching = await loader.getMatchingSkills('test.py');
    expect(matching).toHaveLength(1);

    const noMatch = await loader.getMatchingSkills('test.ts');
    expect(noMatch).toHaveLength(0);
  });

  it('handles malformed skill files gracefully', async () => {
    const skillsDir = path.join(tmpDir, '.OpenCob', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'bad.md'), 'No frontmatter, just content');

    const skills = await loader.loadAll();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('bad'); // Uses filename as fallback
    expect(skills[0].instructions).toContain('No frontmatter');
  });
});
