import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export interface OpenCobConfig {
  model: {
    provider: 'ollama' | 'openai-compatible';
    chat: string;
    completion: string;
    baseUrl: string;
  };
  autoApprove: {
    read: boolean;
    edit: boolean;
    command: boolean;
    mcp: boolean;
  };
  contextWindow: {
    maxTokens: number;
  };
  customModes: CustomModeConfig[];
  modeRules: Record<string, string[]>;
}

export interface CustomModeConfig {
  slug: string;
  name: string;
  roleDefinition: string;
  whenToUse?: string;
  groups: Array<string | [string, { fileRegex?: string; description?: string }]>;
  customInstructions?: string;
}

const DEFAULT_CONFIG: OpenCobConfig = {
  model: {
    provider: 'ollama',
    chat: 'qwen2.5-coder:7b',
    completion: 'qwen2.5-coder:1.5b',
    baseUrl: 'http://127.0.0.1:11434',
  },
  autoApprove: {
    read: false,
    edit: false,
    command: false,
    mcp: false,
  },
  contextWindow: {
    maxTokens: 8192,
  },
  customModes: [],
  modeRules: {},
};

/**
 * Loads OpenCob configuration from multiple sources with precedence:
 * 1. Project-level: .OpenCob/config.json or .OpenCob/config.yaml (highest)
 * 2. Global: ~/.OpenCob/config.json or ~/.OpenCob/config.yaml
 * 3. Defaults (lowest)
 */
export class ConfigLoader {
  private config: OpenCobConfig = structuredClone(DEFAULT_CONFIG);

  constructor(private readonly workspaceRoot: string) {}

  /** Load configuration from all sources */
  async load(): Promise<OpenCobConfig> {
    // Start with defaults
    this.config = structuredClone(DEFAULT_CONFIG);

    // Load global config
    const globalDirs = this.uniqueDirs([
      path.join(os.homedir(), '.OpenCob'),
      path.join(os.homedir(), '.opencob'),
    ]);
    for (const globalDir of globalDirs) {
      await this.mergeConfigFile(path.join(globalDir, 'config.json'));
      await this.mergeConfigFile(path.join(globalDir, 'config.yaml'));
      await this.mergeConfigFile(path.join(globalDir, 'config.yml'));
    }

    // Load project config (overrides global)
    const projectDirs = this.uniqueDirs([
      path.join(this.workspaceRoot, '.OpenCob'),
      path.join(this.workspaceRoot, '.opencob'),
    ]);
    for (const projectDir of projectDirs) {
      await this.mergeConfigFile(path.join(projectDir, 'config.json'));
      await this.mergeConfigFile(path.join(projectDir, 'config.yaml'));
      await this.mergeConfigFile(path.join(projectDir, 'config.yml'));
    }

    // Load custom modes from .OpenCob/custom_modes.json or .yaml
    for (const projectDir of projectDirs) {
      await this.loadCustomModes(projectDir);
    }
    for (const globalDir of globalDirs) {
      await this.loadCustomModes(globalDir);
    }

    // Load mode-specific rules from rules-<slug>/ directories
    for (const projectDir of projectDirs) {
      await this.loadModeRules(projectDir);
    }
    for (const globalDir of globalDirs) {
      await this.loadModeRules(globalDir);
    }

    // Load general rules from .OpenCob/rules/ (F16)
    for (const projectDir of projectDirs) {
      await this.loadGeneralRules(projectDir);
    }
    for (const globalDir of globalDirs) {
      await this.loadGeneralRules(globalDir);
    }

    // Load .OpenCobrules from project root (F16)
    await this.loadSingleRuleFile(path.join(this.workspaceRoot, '.OpenCobrules'));

    // Load AGENTS.md from project root (F16)
    await this.loadSingleRuleFile(path.join(this.workspaceRoot, 'AGENTS.md'));

    return this.config;
  }

  /** Get the loaded config (call load() first) */
  getConfig(): OpenCobConfig {
    return this.config;
  }

  private async mergeConfigFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      let parsed: unknown;
      if (filePath.endsWith('.json')) {
        parsed = JSON.parse(content);
      } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        parsed = this.parseSimpleYaml(content);
      }
      if (parsed && typeof parsed === 'object') {
        this.deepMerge(this.config as unknown as Record<string, unknown>, parsed as Record<string, unknown>);
      }
    } catch {
      // File not found or invalid — skip silently
    }
  }

  private async loadCustomModes(dir: string): Promise<void> {
    const files = ['custom_modes.json', 'custom_modes.yaml', 'custom_modes.yml'];
    for (const file of files) {
      try {
        const modesFile = path.join(dir, file);
        const content = await fs.readFile(modesFile, 'utf-8');
        let parsed: unknown;
        if (file.endsWith('.json')) {
          parsed = JSON.parse(content);
        } else {
          parsed = this.parseSimpleYaml(content);
        }
        if (parsed && typeof parsed === 'object' && 'customModes' in (parsed as Record<string, unknown>)) {
          const modes = (parsed as Record<string, unknown>).customModes;
          if (Array.isArray(modes)) {
            for (const mode of modes) {
              const existingIdx = this.config.customModes.findIndex(
                (m) => m.slug === (mode as CustomModeConfig).slug,
              );
              if (existingIdx >= 0) {
                this.config.customModes[existingIdx] = mode as CustomModeConfig;
              } else {
                this.config.customModes.push(mode as CustomModeConfig);
              }
            }
          }
        }
      } catch {
        // No custom modes file — skip
      }
    }
  }

  private async loadModeRules(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('rules-')) {
          const slug = entry.name.slice('rules-'.length);
          const rulesDir = path.join(dir, entry.name);
          const rules = await this.readRuleFiles(rulesDir);
          if (rules.length > 0) {
            this.config.modeRules[slug] = [
              ...(this.config.modeRules[slug] ?? []),
              ...rules,
            ];
          }
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  private async readRuleFiles(dir: string): Promise<string[]> {
    const rules: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = await fs.readFile(
            path.join(dir, entry.name),
            'utf-8',
          );
          rules.push(content.trim());
        }
      }
    } catch {
      // skip
    }
    return rules;
  }

  private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const key of Object.keys(source)) {
      const targetVal = target[key];
      const sourceVal = source[key];

      if (
        targetVal &&
        sourceVal &&
        typeof targetVal === 'object' &&
        typeof sourceVal === 'object' &&
        !Array.isArray(targetVal) &&
        !Array.isArray(sourceVal)
      ) {
        this.deepMerge(
          targetVal as Record<string, unknown>,
          sourceVal as Record<string, unknown>,
        );
      } else {
        target[key] = sourceVal;
      }
    }
  }

  /** Load general rules from .OpenCob/rules/ directory */
  private async loadGeneralRules(dir: string): Promise<void> {
    const rulesDir = path.join(dir, 'rules');
    const rules = await this.readRuleFiles(rulesDir);
    if (rules.length > 0) {
      // Store under '_general' key
      this.config.modeRules['_general'] = [
        ...(this.config.modeRules['_general'] ?? []),
        ...rules,
      ];
    }
  }

  /** Load a single rule file (.OpenCobrules or AGENTS.md) */
  private async loadSingleRuleFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.trim()) {
        this.config.modeRules['_general'] = [
          ...(this.config.modeRules['_general'] ?? []),
          content.trim(),
        ];
      }
    } catch {
      // File doesn't exist — skip
    }
  }

  /**
   * Lightweight YAML parser for simple key-value configs.
   * Handles: scalars, nested objects, simple arrays.
   * Does NOT handle: multi-line strings, anchors, tags, complex types.
   * For full YAML support, use js-yaml package.
   */
  private parseSimpleYaml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = content.split('\n');
    const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
      { indent: -1, obj: result },
    ];
    let currentArray: unknown[] | null = null;
    let currentArrayKey = '';

    for (const rawLine of lines) {
      // Skip empty lines and comments
      if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue;

      const indent = rawLine.search(/\S/);
      const line = rawLine.trim();

      // Array item
      if (line.startsWith('- ')) {
        const value = this.parseYamlValue(line.slice(2).trim());
        if (currentArray) {
          currentArray.push(value);
          // Replace the nested object with the array on the parent
          if (currentArrayKey && stack.length > 1) {
            const parent = stack[stack.length - 2]?.obj ?? stack[0].obj;
            parent[currentArrayKey] = currentArray;
          }
        }
        continue;
      }

      // Key-value pair
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const valueStr = line.slice(colonIdx + 1).trim();

        // Pop stack to correct nesting level
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
          stack.pop();
        }
        const parent = stack[stack.length - 1].obj;

        if (valueStr === '' || valueStr === '|' || valueStr === '>') {
          // Nested object or array — will be filled by subsequent lines
          const nested: Record<string, unknown> = {};
          parent[key] = nested;
          stack.push({ indent, obj: nested });
          // Prepare for potential array items under this key
          const arr: unknown[] = [];
          currentArray = arr;
          currentArrayKey = key;
        } else {
          parent[key] = this.parseYamlValue(valueStr);
          currentArray = null;
        }
      }
    }

    return result;
  }

  private uniqueDirs(dirs: string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const dir of dirs) {
      const key = path.resolve(dir).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(dir);
      }
    }
    return unique;
  }

  private parseYamlValue(value: string): unknown {
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    // Booleans
    if (value === 'true' || value === 'True' || value === 'TRUE') return true;
    if (value === 'false' || value === 'False' || value === 'FALSE') return false;
    // Null
    if (value === 'null' || value === '~') return null;
    // Numbers
    const num = Number(value);
    if (!isNaN(num) && value !== '') return num;
    // String
    return value;
  }
}
