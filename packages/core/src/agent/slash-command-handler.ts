import type { AgentEvent } from './agent-types.js';
import type { ModeEngine } from '../modes/mode-engine.js';
import type { SnapshotManager } from '../checkpoints/snapshot-manager.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

export type SlashResult =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'rewrite'; message: string }
  | { kind: 'passthrough' };

export interface SlashCommandHandlerOpts {
  modeEngine: ModeEngine;
  snapshotManager: SnapshotManager | null;
  toolRegistry: ToolRegistry;
  customCommands: Map<string, { description: string; prompt: string }>;
}

const PROMPT_PREFIXES: Record<string, string> = {
  '/explain':
    'Explain the following code in detail. What does it do, how does it work, and what are the key patterns used?\n\n',
  '/fix':
    'Analyze the following code for bugs, errors, and issues. Fix all problems you find and explain each fix.\n\n',
  '/test':
    'Generate comprehensive unit tests for the following code. Cover edge cases, error paths, and typical usage.\n\n',
  '/diagram':
    'Generate the most relevant diagram for the following code/context. Prefer Mermaid output and include a short explanation.\n\n',
  '/review':
    'Review the following code for quality, security, performance, and maintainability issues. Suggest improvements.\n\n',
};

const MODE_COMMANDS: Record<string, string> = {
  '/code': 'code',
  '/ask': 'ask',
  '/plan': 'orchestrator',
  '/advanced': 'advanced',
  '/orchestrator': 'orchestrator',
};

export class SlashCommandHandler {
  private modeEngine: ModeEngine;
  private snapshotManager: SnapshotManager | null;
  private toolRegistry: ToolRegistry;
  private customCommands: Map<string, { description: string; prompt: string }>;

  constructor(opts: SlashCommandHandlerOpts) {
    this.modeEngine = opts.modeEngine;
    this.snapshotManager = opts.snapshotManager;
    this.toolRegistry = opts.toolRegistry;
    this.customCommands = opts.customCommands;
  }

  handle(input: string): SlashResult {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return { kind: 'passthrough' };

    const [command] = trimmed.split(/\s+/);
    const remainder = trimmed.slice(command.length).trim();

    if (command in MODE_COMMANDS) {
      this.modeEngine.setActive(MODE_COMMANDS[command]);
      const mode = this.modeEngine.getActive();
      if (remainder) return { kind: 'passthrough' }; // mode set; processMessage handles message
      return {
        kind: 'event',
        event: { type: 'mode_switch', mode: mode.name, text: `Switched to ${mode.name} mode` },
      };
    }

    if (command === '/new' || command === '/clear') {
      return { kind: 'event', event: { type: 'done', text: 'Conversation cleared.' } };
    }

    if (command === '/undo') {
      if (!this.snapshotManager)
        return {
          kind: 'event',
          event: { type: 'done', text: 'Undo not available — no snapshot manager configured.' },
        };
      const result = this.snapshotManager.undoLastTurn();
      if (!result) return { kind: 'event', event: { type: 'done', text: 'Nothing to undo.' } };
      const fileList = result.restoredFiles.join('\n  ');
      return {
        kind: 'event',
        event: {
          type: 'done',
          text: `Undid turn ${result.turnId}. Restored ${result.restoredFiles.length} file(s):\n  ${fileList}`,
        },
      };
    }

    if (command === '/help') {
      const available = this.toolRegistry.listAvailable();
      const toolList = available.map((t) => `  ${t.name} — ${t.description}`).join('\n');
      const customList =
        this.customCommands.size > 0
          ? Array.from(this.customCommands.entries())
              .map(([n, c]) => `  /${n} — ${c.description}`)
              .join('\n')
          : '';
      const text = [
        'Available commands:',
        '  /code /ask /plan /advanced /orchestrator — switch mode',
        '  /new /clear — start new conversation',
        '  /undo — undo last turn file changes',
        '  /explain /fix /test /diagram /review /create-pr — prompt shortcuts',
        '  /help — show this help',
        customList ? `\nCustom commands:\n${customList}` : '',
        `\nAvailable tools (${this.modeEngine.getActive().name} mode):\n${toolList || '  (none)'}`,
      ]
        .filter(Boolean)
        .join('\n');
      return { kind: 'event', event: { type: 'done', text } };
    }

    if (command in PROMPT_PREFIXES) {
      if (!remainder && command !== '/review' && command !== '/diagram') {
        return {
          kind: 'event',
          event: { type: 'done', text: `Usage: ${command} <code or file reference>` },
        };
      }
      return { kind: 'rewrite', message: PROMPT_PREFIXES[command] + remainder };
    }

    const cmdName = command.slice(1);
    const customCmd = this.customCommands.get(cmdName);
    if (customCmd) return { kind: 'rewrite', message: customCmd.prompt + '\n\n' + remainder };

    return { kind: 'passthrough' };
  }
}
