import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { ModeEngine } from '../modes/mode-engine.js';
import type { CustomizationLoader } from './customization-loader.js';
import type { SkillsLoader } from '../skills/skills-loader.js';

export interface SystemPromptBuilderOpts {
  modeEngine: ModeEngine;
  customizationLoader: CustomizationLoader | null;
  skillsLoader: SkillsLoader | null;
  workspaceRoot?: string;
}

export class SystemPromptBuilder {
  private modeEngine: ModeEngine;
  private customizationLoader: CustomizationLoader | null;
  private skillsLoader: SkillsLoader | null;
  private workspaceRoot: string | undefined;

  constructor(opts: SystemPromptBuilderOpts) {
    this.modeEngine = opts.modeEngine;
    this.customizationLoader = opts.customizationLoader;
    this.skillsLoader = opts.skillsLoader;
    this.workspaceRoot = opts.workspaceRoot;
  }

  build(): string {
    const mode = this.modeEngine.getActive();
    const repoTree = this.buildCompactRepoTree();

    const parts = [
      mode.roleDefinition,
      '',
      mode.customInstructions || '',
      '',
      '## Guidelines',
      '',
      '- Be concise and direct in your responses.',
      '- Use the available tools to accomplish tasks. Call tools rather than describing what you would do.',
      '- When users ask about architecture, flow, dependencies, or structure, prefer calling generate_diagram and briefly explain the result.',
      '- When modifying files, use apply_diff for targeted changes and write_to_file for new files.',
      '- Always read a file before modifying it.',
      '- Explain what you are doing and why before making changes.',
      '- If a tool call fails, diagnose the error and try a different approach.',
      repoTree ? `\n## Workspace Structure\n\n\`\`\`\n${repoTree}\n\`\`\`` : '',
    ];

    if (this.customizationLoader) {
      const resolved = this.customizationLoader.resolve([]);
      if (resolved.systemPromptAdditions.length > 0) {
        parts.push('\n## Project Instructions\n');
        parts.push(...resolved.systemPromptAdditions);
      }
      const hookResult = this.customizationLoader.fireHook({ event: 'onChatStart' });
      if (hookResult.instructions.length > 0) {
        parts.push('\n## Active Hooks\n');
        parts.push(...hookResult.instructions);
      }
    }

    if (this.workspaceRoot) {
      const docsPath = nodePath.join(this.workspaceRoot, 'docs', 'pages');
      if (fs.existsSync(docsPath)) {
        parts.push('\n## Self-Help Documentation\n');
        parts.push(
          'When users ask how to use OpenCob, read the relevant MDX file from docs/pages/.\n' +
            'Key files: installation.mdx, getting-started.mdx, customization.mdx, hooks.mdx, modes.mdx, tools.mdx, commands.mdx, mcp.mdx, troubleshooting.mdx',
        );
      }
    }

    return parts.filter(Boolean).join('\n');
  }

  private buildCompactRepoTree(): string {
    if (!this.workspaceRoot) return '';
    try {
      const root = this.workspaceRoot;
      const lines: string[] = [];
      const maxLines = 60;
      const skip = new Set([
        'node_modules',
        '.git',
        'dist',
        'build',
        '.next',
        '.turbo',
        'coverage',
        '.nyc_output',
        '__pycache__',
        '.venv',
        'target',
      ]);

      const walk = (dir: string, prefix: string, depth: number): void => {
        if (depth > 3 || lines.length >= maxLines) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries = entries
          .filter((e) => !skip.has(e.name) && !e.name.startsWith('.'))
          .sort((a, b) =>
            a.isDirectory() === b.isDirectory()
              ? a.name.localeCompare(b.name)
              : a.isDirectory()
                ? -1
                : 1,
          );
        for (let i = 0; i < entries.length && lines.length < maxLines; i++) {
          const entry = entries[i];
          const isLast = i === entries.length - 1;
          lines.push(
            `${prefix}${isLast ? '└── ' : '├── '}${entry.name}${entry.isDirectory() ? '/' : ''}`,
          );
          if (entry.isDirectory())
            walk(nodePath.join(dir, entry.name), prefix + (isLast ? '    ' : '│   '), depth + 1);
        }
      };

      lines.push(`${nodePath.basename(root)}/`);
      walk(root, '', 0);
      if (lines.length >= maxLines) lines.push('... (truncated)');
      return lines.join('\n');
    } catch {
      return '';
    }
  }
}
