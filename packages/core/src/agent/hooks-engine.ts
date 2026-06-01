import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export type HookEvent =
  | 'onFileChange'
  | 'onFileSave'
  | 'onChatStart'
  | 'onChatEnd'
  | 'onToolCallBefore'
  | 'onToolCallAfter'
  | 'onModeSwitch'
  | 'onPlanCreated'
  | 'onError';

export interface HookDefinition {
  /** Hook name (derived from filename) */
  name: string;
  /** Which event triggers this hook */
  event: HookEvent;
  /** Optional file glob — hook only fires for matching files */
  applyTo?: string;
  /** Optional description */
  description?: string;
  /** The instruction body to inject when the hook fires */
  body: string;
  /** Source file path */
  sourcePath: string;
}

export interface HookContext {
  /** The event that triggered the hook */
  event: HookEvent;
  /** File path involved (if applicable) */
  filePath?: string;
  /** Tool name (for tool hooks) */
  toolName?: string;
  /** Additional data */
  data?: Record<string, unknown>;
}

export interface HookResult {
  /** Instructions to inject into the system prompt */
  instructions: string[];
  /** Hooks that fired */
  firedHooks: HookDefinition[];
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Lifecycle Hooks System
 *
 * Loads hook definitions from .opencob/hooks/*.md files.
 * Hooks inject additional instructions when specific events fire.
 *
 * Hook file format (YAML frontmatter + markdown body):
 *   event: onFileChange
 *   applyTo: "src/components/*.tsx"
 *   description: Enforce React component guidelines on change
 */
export class HooksEngine {
  private hooks: HookDefinition[] = [];
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.load();
  }

  /** Load all hook definitions from .opencob/hooks/ */
  private load(): void {
    const dirs = [
      path.join(this.workspaceRoot, '.opencob', 'hooks'),
      path.join(this.workspaceRoot, '.OpenCob', 'hooks'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const filePath = path.join(dir, entry.name);
          const hook = this.parseHookFile(filePath, entry.name);
          if (hook) this.hooks.push(hook);
        }
      } catch {
        // Skip on error
      }
    }

    // Also load global hooks
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (home) {
      const globalDirs = [
        path.join(home, '.opencob', 'hooks'),
        path.join(home, '.OpenCob', 'hooks'),
      ];
      for (const dir of globalDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
            const filePath = path.join(dir, entry.name);
            const hook = this.parseHookFile(filePath, entry.name);
            if (hook) this.hooks.push(hook);
          }
        } catch {
          // Skip
        }
      }
    }
  }

  /** Reload hooks (e.g., after file changes) */
  reload(): void {
    this.hooks = [];
    this.load();
  }

  /** Fire hooks for a given event and return instructions to inject */
  fire(context: HookContext): HookResult {
    const result: HookResult = { instructions: [], firedHooks: [] };

    for (const hook of this.hooks) {
      if (hook.event !== context.event) continue;

      // Check applyTo pattern if present
      if (hook.applyTo && context.filePath) {
        const relativePath = path
          .relative(this.workspaceRoot, context.filePath)
          .replace(/\\/g, '/');
        if (!this.matchGlob(relativePath, hook.applyTo)) continue;
      }

      // Hook matches — include its instructions
      result.instructions.push(hook.body);
      result.firedHooks.push(hook);
    }

    return result;
  }

  /** Get all registered hooks */
  getHooks(): HookDefinition[] {
    return [...this.hooks];
  }

  /** Get hooks for a specific event */
  getHooksForEvent(event: HookEvent): HookDefinition[] {
    return this.hooks.filter((h) => h.event === event);
  }

  // ─── Parsing ───────────────────────────────────────────────────────────────

  private parseHookFile(filePath: string, filename: string): HookDefinition | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(content);

      const event = frontmatter.event as HookEvent;
      if (!event || !this.isValidEvent(event)) return null;

      const name = (frontmatter.name as string) ?? filename.replace(/\.md$/, '');
      const description = frontmatter.description as string | undefined;
      const applyTo = frontmatter.applyTo as string | undefined;

      return {
        name,
        event,
        applyTo,
        description,
        body: body.trim(),
        sourcePath: filePath,
      };
    } catch {
      return null;
    }
  }

  private isValidEvent(event: string): event is HookEvent {
    const valid: HookEvent[] = [
      'onFileChange',
      'onFileSave',
      'onChatStart',
      'onChatEnd',
      'onToolCallBefore',
      'onToolCallAfter',
      'onModeSwitch',
      'onPlanCreated',
      'onError',
    ];
    return valid.includes(event as HookEvent);
  }

  private parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
  } {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return { frontmatter: {}, body: content };

    const fmBlock = fmMatch[1];
    const body = fmMatch[2];
    const frontmatter: Record<string, unknown> = {};

    for (const line of fmBlock.split('\n')) {
      const kvMatch = line.match(/^(\w+):\s*(.+)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        frontmatter[key] = value.replace(/^['"]|['"]$/g, '');
      }
    }

    return { frontmatter, body };
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*');
    try {
      return new RegExp(`^${regexStr}$`).test(filePath);
    } catch {
      return false;
    }
  }
}
