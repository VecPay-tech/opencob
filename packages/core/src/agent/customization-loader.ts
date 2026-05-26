import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  /** Full Markdown body (becomes agent system prompt) */
  body: string;
}

export interface InstructionFile {
  /** Optional description */
  description: string;
  /** Glob pattern for which files this instruction applies to */
  applyTo: string;
  /** Markdown body with instructions */
  body: string;
  /** Resolved file path (for debugging) */
  sourcePath: string;
}

export interface PromptTemplate {
  name: string;
  description: string;
  /** Variables the prompt template expects */
  variables: PromptVariable[];
  /** Optional mode to activate for execution */
  mode?: string;
  /** Markdown body with {{variable}} placeholders */
  body: string;
}

export interface PromptVariable {
  name: string;
  description?: string;
  options?: string[];
}

export interface CustomizationContext {
  /** Global project instructions (always injected) */
  projectInstructions: string;
  /** Agent definitions available for selection */
  agents: AgentDefinition[];
  /** All instruction files (filtered by applyTo at resolution time) */
  instructions: InstructionFile[];
  /** Prompt templates (invokable as slash commands) */
  prompts: PromptTemplate[];
}

export interface ResolvedInstructions {
  /** Assembled system prompt additions in priority order */
  systemPromptAdditions: string[];
  /** Active agent (if selected) */
  activeAgent?: AgentDefinition;
  /** Matched instructions for the current file context */
  matchedInstructions: InstructionFile[];
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * §3.20 Agent Customization System
 *
 * Loads .agent.md, .instructions.md, .prompt.md, and opencob-instructions.md
 * files from .opencob/ directory to build customized agent contexts.
 */
export class CustomizationLoader {
  private workspaceRoot: string;
  private configDir: string;
  private cache: CustomizationContext | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    // Support both .opencob/ and .OpenCob/ directory names
    const lowerDir = path.join(workspaceRoot, '.opencob');
    const upperDir = path.join(workspaceRoot, '.OpenCob');
    this.configDir = fs.existsSync(lowerDir) ? lowerDir : upperDir;
  }

  /** Load all customization files. Results are cached until invalidate() is called. */
  load(): CustomizationContext {
    if (this.cache) return this.cache;

    const ctx: CustomizationContext = {
      projectInstructions: this.loadProjectInstructions(),
      agents: this.loadAgents(),
      instructions: this.loadInstructions(),
      prompts: this.loadPrompts(),
    };

    this.cache = ctx;
    return ctx;
  }

  /** Invalidate the cache (e.g., on file-system changes) */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Resolve instructions for a given set of active file paths and optional agent name.
   * Returns assembled system prompt additions in priority order.
   */
  resolve(activeFiles: string[], agentName?: string): ResolvedInstructions {
    const ctx = this.load();
    const result: ResolvedInstructions = {
      systemPromptAdditions: [],
      matchedInstructions: [],
    };

    // 1. Active agent persona
    if (agentName) {
      const agent = ctx.agents.find((a) => a.name === agentName);
      if (agent) {
        result.activeAgent = agent;
        result.systemPromptAdditions.push(agent.body);
      }
    }

    // 2. Project-level instructions (always injected)
    if (ctx.projectInstructions) {
      result.systemPromptAdditions.push(ctx.projectInstructions);
    }

    // 3. File-specific instructions (matched by applyTo glob)
    const matched: InstructionFile[] = [];
    for (const instruction of ctx.instructions) {
      const matches = activeFiles.some((fp) => this.matchGlob(fp, instruction.applyTo));
      if (matches) {
        matched.push(instruction);
      }
    }

    // Sort by specificity (more specific patterns first)
    matched.sort((a, b) => b.applyTo.length - a.applyTo.length);

    result.matchedInstructions = matched;
    for (const inst of matched) {
      result.systemPromptAdditions.push(inst.body);
    }

    return result;
  }

  /** Get a prompt template by name (for slash command invocation) */
  getPromptTemplate(name: string): PromptTemplate | undefined {
    const ctx = this.load();
    return ctx.prompts.find((p) => p.name === name);
  }

  /** Render a prompt template with variable substitutions */
  renderPromptTemplate(template: PromptTemplate, variables: Record<string, string>): string {
    let rendered = template.body;
    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return rendered;
  }

  /** List available agent names */
  listAgents(): string[] {
    return this.load().agents.map((a) => a.name);
  }

  /** List available prompt template names (for slash command discovery) */
  listPromptTemplates(): string[] {
    return this.load().prompts.map((p) => p.name);
  }

  /** Get tools allowed for a specific agent */
  getAgentTools(agentName: string): string[] {
    const agent = this.load().agents.find((a) => a.name === agentName);
    return agent?.tools ?? [];
  }

  // ─── Private Loaders ─────────────────────────────────────────────────────

  private loadProjectInstructions(): string {
    // Try multiple filenames
    const candidates = [
      path.join(this.configDir, 'opencob-instructions.md'),
      path.join(this.workspaceRoot, '.opencob-instructions.md'),
      path.join(this.configDir, 'OpenCob-instructions.md'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          return fs.readFileSync(candidate, 'utf-8').trim();
        } catch {
          continue;
        }
      }
    }
    return '';
  }

  private loadAgents(): AgentDefinition[] {
    const dir = path.join(this.configDir, 'agents');
    if (!fs.existsSync(dir)) return [];

    const agents: AgentDefinition[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.agent.md')) continue;
        const filePath = path.join(dir, entry.name);
        const agent = this.parseAgentFile(filePath);
        if (agent) agents.push(agent);
      }
    } catch {
      // Directory read error — return empty
    }
    return agents;
  }

  private loadInstructions(): InstructionFile[] {
    const dir = path.join(this.configDir, 'instructions');
    if (!fs.existsSync(dir)) return [];

    const instructions: InstructionFile[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.instructions.md')) continue;
        const filePath = path.join(dir, entry.name);
        const instruction = this.parseInstructionFile(filePath);
        if (instruction) instructions.push(instruction);
      }
    } catch {
      // Directory read error — return empty
    }
    return instructions;
  }

  private loadPrompts(): PromptTemplate[] {
    const dir = path.join(this.configDir, 'prompts');
    if (!fs.existsSync(dir)) return [];

    const prompts: PromptTemplate[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.prompt.md')) continue;
        const filePath = path.join(dir, entry.name);
        const prompt = this.parsePromptFile(filePath, entry.name);
        if (prompt) prompts.push(prompt);
      }
    } catch {
      // Directory read error — return empty
    }
    return prompts;
  }

  // ─── File Parsers ────────────────────────────────────────────────────────

  private parseAgentFile(filePath: string): AgentDefinition | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(content);

      const name = (frontmatter.name as string) ?? path.basename(filePath, '.agent.md');
      const description = (frontmatter.description as string) ?? '';
      const tools = (frontmatter.tools as string[]) ?? [];

      return { name, description, tools, body: body.trim() };
    } catch {
      return null;
    }
  }

  private parseInstructionFile(filePath: string): InstructionFile | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(content);

      const applyTo = frontmatter.applyTo as string;
      if (!applyTo) return null; // Instructions without applyTo are invalid

      const description = (frontmatter.description as string) ?? '';

      return { description, applyTo, body: body.trim(), sourcePath: filePath };
    } catch {
      return null;
    }
  }

  private parsePromptFile(filePath: string, filename: string): PromptTemplate | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(content);

      const name = (frontmatter.name as string) ?? filename.replace(/\.prompt\.md$/, '');
      const description = (frontmatter.description as string) ?? '';
      const mode = frontmatter.mode as string | undefined;

      // Parse variables from frontmatter
      const variables: PromptVariable[] = [];
      const rawVars = frontmatter.variables;
      if (Array.isArray(rawVars)) {
        for (const v of rawVars) {
          if (typeof v === 'string') {
            variables.push({ name: v });
          } else if (typeof v === 'object' && v !== null) {
            variables.push({
              name: (v as Record<string, unknown>).name as string,
              description: (v as Record<string, unknown>).description as string | undefined,
              options: (v as Record<string, unknown>).options as string[] | undefined,
            });
          }
        }
      }

      return { name, description, variables, mode, body: body.trim() };
    } catch {
      return null;
    }
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  private parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
  } {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      return { frontmatter: {}, body: content };
    }

    const fmBlock = fmMatch[1];
    const body = fmMatch[2];
    const frontmatter: Record<string, unknown> = {};

    // Simple YAML parser for frontmatter
    const lines = fmBlock.split('\n');
    let currentKey = '';
    let currentArray: unknown[] | null = null;

    for (const line of lines) {
      // Array continuation (indented "- item")
      if (currentArray !== null && line.match(/^\s+-\s+/)) {
        const value = line.replace(/^\s+-\s+/, '').trim();
        // Check if it's a nested object (has "key: value" inside)
        if (value.includes(':')) {
          const obj: Record<string, unknown> = {};
          // Parse simple key-value pairs in the value
          const parts = value.split(/,\s*/);
          for (const part of parts) {
            const kv = part.match(/^(\w+):\s*(.+)$/);
            if (kv) {
              const [, k, v] = kv;
              obj[k] = this.parseYamlValue(v);
            }
          }
          if (Object.keys(obj).length > 0) {
            currentArray.push(obj);
          } else {
            currentArray.push(this.parseYamlValue(value));
          }
        } else {
          currentArray.push(this.parseYamlValue(value));
        }
        continue;
      }

      // Close current array if a new top-level key appears
      if (currentArray !== null && !line.match(/^\s/) && line.includes(':')) {
        frontmatter[currentKey] = currentArray;
        currentArray = null;
      }

      // Top-level "key: value" or "key:"
      const kvMatch = line.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        currentKey = key;

        if (!value || value.trim() === '') {
          // Start of array or empty value
          currentArray = [];
        } else if (value.startsWith('[') && value.endsWith(']')) {
          // Inline array: [item1, item2]
          const inner = value.slice(1, -1).trim();
          frontmatter[key] = inner
            ? inner.split(',').map((s) => this.parseYamlValue(s.trim()))
            : [];
          currentArray = null;
        } else {
          frontmatter[key] = this.parseYamlValue(value);
          currentArray = null;
        }
      }
    }

    // Close any trailing array
    if (currentArray !== null) {
      frontmatter[currentKey] = currentArray;
    }

    return { frontmatter, body };
  }

  private parseYamlValue(value: string): string | number | boolean {
    // Remove surrounding quotes
    const unquoted = value.replace(/^['"]|['"]$/g, '');
    if (unquoted === 'true') return true;
    if (unquoted === 'false') return false;
    const num = Number(unquoted);
    if (!isNaN(num) && unquoted !== '') return num;
    return unquoted;
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    // Normalize the file path to use forward slashes
    const normalized = filePath.replace(/\\/g, '/');
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '§§') // placeholder for **
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*');
    try {
      return new RegExp(`^${regexStr}$`).test(normalized);
    } catch {
      return false;
    }
  }
}
