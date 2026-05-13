import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  /** Glob patterns for files this skill applies to */
  applyTo?: string[];
  /** Files bundled with the skill */
  supportingFiles?: string[];
}

/**
 * Loads reusable instruction sets from .OpenCob/skills/ directory.
 * Skills are Markdown files with optional YAML frontmatter.
 */
export class SkillsLoader {
  private workspaceRoot: string;
  private globalDir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    this.globalDir = path.join(home, '.OpenCob', 'skills');
  }

  /** Load all skills from global and project directories */
  async loadAll(): Promise<Skill[]> {
    const skills: Skill[] = [];

    // Global skills (lower priority)
    skills.push(...this.loadFromDirectory(this.globalDir));

    // Project skills (higher priority — override by name)
    const projectDir = path.join(this.workspaceRoot, '.OpenCob', 'skills');
    const projectSkills = this.loadFromDirectory(projectDir);

    // Merge: project skills override global skills with same name
    for (const ps of projectSkills) {
      const idx = skills.findIndex((s) => s.name === ps.name);
      if (idx >= 0) {
        skills[idx] = ps;
      } else {
        skills.push(ps);
      }
    }

    return skills;
  }

  /** Load a specific skill by name */
  async loadByName(name: string): Promise<Skill | null> {
    const all = await this.loadAll();
    return all.find((s) => s.name === name) ?? null;
  }

  /** Get skills that match a given file path */
  async getMatchingSkills(filePath: string): Promise<Skill[]> {
    const all = await this.loadAll();
    return all.filter((s) => {
      if (!s.applyTo || s.applyTo.length === 0) return false;
      return s.applyTo.some((pattern) => this.matchGlob(filePath, pattern));
    });
  }

  private loadFromDirectory(dir: string): Skill[] {
    if (!fs.existsSync(dir)) return [];

    const skills: Skill[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Skill as a directory with SKILL.md inside
        const skillFile = path.join(dir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          const skill = this.parseSkillFile(skillFile, entry.name);
          if (skill) skills.push(skill);
        }
      } else if (entry.name.endsWith('.md')) {
        // Skill as a single Markdown file
        const skillFile = path.join(dir, entry.name);
        const name = entry.name.replace(/\.md$/, '');
        const skill = this.parseSkillFile(skillFile, name);
        if (skill) skills.push(skill);
      }
    }

    return skills;
  }

  private parseSkillFile(filePath: string, fallbackName: string): Skill | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(content);

      return {
        name: (frontmatter.name as string) ?? fallbackName,
        description: (frontmatter.description as string) ?? '',
        instructions: body.trim(),
        applyTo: frontmatter.applyTo as string[] | undefined,
        supportingFiles: frontmatter.supportingFiles as string[] | undefined,
      };
    } catch {
      return null;
    }
  }

  private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      return { frontmatter: {}, body: content };
    }

    const fmBlock = fmMatch[1];
    const body = fmMatch[2];
    const frontmatter: Record<string, unknown> = {};

    // Simple YAML parser for flat key-value pairs and arrays
    for (const line of fmBlock.split('\n')) {
      const kvMatch = line.match(/^(\w+):\s*(.+)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        // Handle array syntax: [item1, item2]
        if (value.startsWith('[') && value.endsWith(']')) {
          frontmatter[key] = value
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
        } else {
          frontmatter[key] = value.replace(/^['"]|['"]$/g, '');
        }
      }
    }

    return { frontmatter, body };
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    // Simple glob matching — handles *.ext and **/*.ext patterns
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    try {
      return new RegExp(`^${regexStr}$`).test(filePath);
    } catch {
      return false;
    }
  }
}
