import type { Tool, ToolResult, ToolGroup } from './types.js';
import type { ModeEngine } from '../modes/mode-engine.js';

export interface ToolExecutionRequest {
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface ToolExecutionResult extends ToolResult {
  toolName: string;
  approved: boolean;
  /** If the tool was blocked, the reason why */
  blockedReason?: string;
}

export type ApprovalCallback = (tool: Tool, params: Record<string, unknown>) => Promise<boolean>;

export interface AutoApproveConfig {
  read: boolean;
  edit: boolean;
  command: boolean;
  mcp: boolean;
  browser: boolean;
}

/** Command allowlist pattern for two-stage approval (F4.7 Should) */
export interface CommandAllowlistEntry {
  pattern: string;
  description?: string;
}

/** Risk assessment result from LLM or heuristic (F4.7 Should) */
export interface CommandRiskAssessment {
  level: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
}

const DEFAULT_AUTO_APPROVE: AutoApproveConfig = {
  read: false,
  edit: false,
  command: false,
  mcp: false,
  browser: false,
};

/** Dangerous shell operators that could indicate command injection (F4.7 Should) */
const DANGEROUS_OPERATORS =
  /[;&|`$]|\$\(|>\s*\/|rm\s+-rf|sudo|chmod\s+777|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh/i;

/** High-risk command patterns */
const HIGH_RISK_PATTERNS = [
  /\brm\s+(-[a-z]*r|-[a-z]*f)/i, // rm -rf, rm -r, rm -f
  /\bsudo\b/i, // sudo
  /\bchmod\s+[0-7]*7[0-7]*/i, // chmod world-writable
  /\bdrop\s+(table|database)/i, // DROP TABLE/DATABASE
  /\btruncate\s+table/i, // TRUNCATE TABLE
  /\bgit\s+push\s+.*--force/i, // git push --force
  /\bgit\s+reset\s+--hard/i, // git reset --hard
  /\bformat\b/i, // format commands
  /\bmkfs\b/i, // filesystem creation
  />\s*\/dev\//i, // redirect to device files
];

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private modeEngine: ModeEngine;
  private approvalCallback: ApprovalCallback | undefined;
  private autoApprove: AutoApproveConfig;
  private fileFilter: ((path: string) => boolean) | undefined;
  private commandAllowlist: CommandAllowlistEntry[];
  private enableCommandValidation: boolean;

  constructor(
    modeEngine: ModeEngine,
    options?: {
      approvalCallback?: ApprovalCallback;
      autoApprove?: Partial<AutoApproveConfig>;
      fileFilter?: (path: string) => boolean;
      commandAllowlist?: CommandAllowlistEntry[];
      enableCommandValidation?: boolean;
    },
  ) {
    this.modeEngine = modeEngine;
    this.approvalCallback = options?.approvalCallback;
    this.autoApprove = { ...DEFAULT_AUTO_APPROVE, ...options?.autoApprove };
    this.fileFilter = options?.fileFilter;
    this.commandAllowlist = options?.commandAllowlist ?? [];
    this.enableCommandValidation = options?.enableCommandValidation ?? true;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** List tools available in the current mode */
  listAvailable(): Tool[] {
    return Array.from(this.tools.values()).filter((tool) =>
      this.modeEngine.isToolGroupAllowed(tool.group),
    );
  }

  /** List all registered tools regardless of mode */
  listAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Get tool definitions formatted for LLM function calling */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return this.listAvailable().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          tool.parameters.map((p) => [p.name, { type: p.type, description: p.description }]),
        ),
        required: tool.parameters.filter((p) => p.required).map((p) => p.name),
      },
    }));
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const tool = this.tools.get(request.toolName);
    if (!tool) {
      return {
        toolName: request.toolName,
        approved: false,
        success: false,
        content: `Error: unknown tool "${request.toolName}"`,
        blockedReason: 'unknown_tool',
      };
    }

    // Check mode permission
    if (!this.modeEngine.isToolGroupAllowed(tool.group)) {
      const mode = this.modeEngine.getActive();
      return {
        toolName: request.toolName,
        approved: false,
        success: false,
        content: `Error: tool "${tool.name}" (group: ${tool.group}) is not allowed in ${mode.name} mode`,
        blockedReason: 'mode_restriction',
      };
    }

    // Check file restrictions for edit tools
    if (tool.group === 'edit') {
      const restriction = this.modeEngine.getEditRestriction();
      const filePath = request.parameters.path as string;
      if (restriction && filePath) {
        const regex = new RegExp(restriction);
        if (!regex.test(filePath)) {
          return {
            toolName: request.toolName,
            approved: false,
            success: false,
            content: `Error: file "${filePath}" does not match edit restriction pattern "${restriction}" in current mode`,
            blockedReason: 'file_restriction',
          };
        }
      }
    }

    // Check .OpenCobignore filter
    if (this.fileFilter && (tool.group === 'read' || tool.group === 'edit')) {
      const filePath = request.parameters.path as string;
      if (filePath && !this.fileFilter(filePath)) {
        return {
          toolName: request.toolName,
          approved: false,
          success: false,
          content: `Error: file "${filePath}" is excluded by .OpenCobignore`,
          blockedReason: 'ignored_file',
        };
      }
    }

    // Check approval
    const needsApproval = !this.autoApprove[tool.group as keyof AutoApproveConfig];
    if (needsApproval) {
      if (!this.approvalCallback) {
        return {
          toolName: request.toolName,
          approved: false,
          success: false,
          content: `Error: tool "${tool.name}" requires user approval, but no approval handler is configured.`,
          blockedReason: 'approval_unavailable',
        };
      }

      // Two-stage command approval (F4.7 Should): validate + risk assess before user prompt
      if (tool.group === 'command' && this.enableCommandValidation) {
        const command = request.parameters.command as string;
        if (command) {
          // Stage 1: AST-based command validation — detect chaining/injection
          const validation = this.validateCommand(command);
          if (validation) {
            // Inject risk warning into parameters so the approval callback can display it
            request.parameters._riskWarning = validation;
          }

          // Stage 2: Check against allowlist — if command matches an allowed pattern, skip extra approval
          if (this.commandAllowlist.length > 0) {
            const allowed = this.commandAllowlist.some((entry) => {
              try {
                return new RegExp(entry.pattern).test(command);
              } catch {
                return false;
              }
            });
            if (!allowed) {
              request.parameters._riskWarning =
                (request.parameters._riskWarning ?? '') +
                '\n⚠️ Command does not match any allowlisted pattern.';
            }
          }
        }
      }

      const approved = await this.approvalCallback(tool, request.parameters);
      if (!approved) {
        return {
          toolName: request.toolName,
          approved: false,
          success: false,
          content: 'Tool execution rejected by user',
          blockedReason: 'user_rejected',
        };
      }
    }

    // Execute
    try {
      const result = await tool.execute(request.parameters);
      return { ...result, toolName: request.toolName, approved: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        toolName: request.toolName,
        approved: true,
        success: false,
        content: `Error executing tool: ${msg}`,
      };
    }
  }

  setAutoApprove(config: Partial<AutoApproveConfig>): void {
    Object.assign(this.autoApprove, config);
  }

  setApprovalCallback(cb: ApprovalCallback): void {
    this.approvalCallback = cb;
  }

  /**
   * AST-based command validation (F4.7 Should).
   * Parses commands for chaining operators (&&, ||, ;, |), redirections,
   * and other injection indicators. Returns a warning string or null if safe.
   */
  validateCommand(command: string): string | null {
    const warnings: string[] = [];

    // Detect dangerous operators
    if (DANGEROUS_OPERATORS.test(command)) {
      warnings.push('⚠️ Command contains potentially dangerous operators or patterns.');
    }

    // Detect command chaining
    const chainOps = command.match(/[;&|]{1,2}/g);
    if (chainOps && chainOps.length > 0) {
      const unique = [...new Set(chainOps)];
      warnings.push(`⚠️ Command uses chaining operators: ${unique.join(', ')}`);
    }

    // Detect subshell / command substitution
    if (/\$\(/.test(command) || /`[^`]+`/.test(command)) {
      warnings.push('⚠️ Command contains subshell/command substitution.');
    }

    // Detect output redirection to sensitive paths
    if (/>\s*\/(etc|usr|bin|sbin|var|dev|proc|sys)\b/.test(command)) {
      warnings.push('⚠️ Command redirects output to a system directory.');
    }

    return warnings.length > 0 ? warnings.join('\n') : null;
  }

  /**
   * Heuristic risk assessment for commands (F4.7 Should).
   * Returns a risk level and reason.
   */
  assessCommandRisk(command: string): CommandRiskAssessment {
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(command)) {
        return { level: 'high', reason: `Matches high-risk pattern: ${pattern.source}` };
      }
    }

    if (DANGEROUS_OPERATORS.test(command)) {
      return { level: 'medium', reason: 'Contains potentially dangerous operators' };
    }

    // Read-only commands are low risk
    const readOnlyPrefixes = [
      'ls',
      'cat',
      'head',
      'tail',
      'grep',
      'find',
      'echo',
      'pwd',
      'whoami',
      'date',
      'uname',
      'which',
      'type',
      'file',
      'wc',
      'du',
      'df',
      'env',
      'printenv',
      'git status',
      'git log',
      'git diff',
      'git branch',
    ];
    const trimmed = command.trim().toLowerCase();
    if (readOnlyPrefixes.some((p) => trimmed.startsWith(p))) {
      return { level: 'low', reason: 'Read-only or informational command' };
    }

    return { level: 'medium', reason: 'Unknown command — manual review recommended' };
  }
}
