export type ModeSlug = 'code' | 'ask' | 'plan' | 'advanced' | 'orchestrator' | string;

export type ToolGroup = 'read' | 'edit' | 'command' | 'mcp' | 'browser';

export interface Mode {
  slug: ModeSlug;
  name: string;
  roleDefinition: string;
  whenToUse?: string;
  groups: ToolGroupConfig[];
  customInstructions?: string;
}

export type ToolGroupConfig =
  | ToolGroup
  | [ToolGroup, { fileRegex?: string; description?: string }];

export const BUILT_IN_MODES: Mode[] = [
  {
    slug: 'code',
    name: '💻 Code',
    roleDefinition:
      'You are OpenCob, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.',
    whenToUse: 'Use for writing, modifying, and refactoring code.',
    groups: ['read', 'edit', 'command'],
  },
  {
    slug: 'ask',
    name: '❓ Ask',
    roleDefinition:
      'You are OpenCob, a knowledgeable technical assistant focused on answering questions and providing information about software development.',
    whenToUse: 'Use for getting answers and explanations without modifying files.',
    groups: ['read', 'mcp'],
  },
  {
    slug: 'plan',
    name: '📝 Plan',
    roleDefinition:
      'You are OpenCob, an experienced technical leader who is inquisitive and an excellent planner. Your goal is to gather information and create a detailed plan.',
    whenToUse: 'Use for high-level planning and technical design before implementation.',
    groups: ['read', ['edit', { fileRegex: '\\.md$', description: 'Markdown files only' }], 'mcp'],
  },
  {
    slug: 'advanced',
    name: '🛠️ Advanced',
    roleDefinition:
      'You are OpenCob, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.',
    whenToUse: 'Use for complex tasks requiring access to all tools.',
    groups: ['read', 'edit', 'command', 'mcp'],
  },
  {
    slug: 'orchestrator',
    name: '🔀 Orchestrator',
    roleDefinition:
      'You are OpenCob, a strategic workflow orchestrator who coordinates complex tasks by delegating them to appropriate specialized modes.',
    whenToUse:
      'Use for complex projects requiring coordination across different specialties.',
    groups: [],
  },
];

export class ModeEngine {
  private modes: Map<ModeSlug, Mode> = new Map();
  private activeMode: ModeSlug = 'code';

  constructor(customModes: Mode[] = []) {
    for (const mode of BUILT_IN_MODES) {
      this.modes.set(mode.slug, mode);
    }
    // Custom modes override built-in with same slug
    for (const mode of customModes) {
      this.modes.set(mode.slug, mode);
    }
  }

  getActive(): Mode {
    return this.modes.get(this.activeMode) ?? BUILT_IN_MODES[0];
  }

  setActive(slug: ModeSlug): Mode {
    const mode = this.modes.get(slug);
    if (!mode) {
      throw new Error(`Unknown mode: ${slug}`);
    }
    this.activeMode = slug;
    return mode;
  }

  listModes(): Mode[] {
    return Array.from(this.modes.values());
  }

  isToolGroupAllowed(group: ToolGroup): boolean {
    const mode = this.getActive();
    return mode.groups.some((g) => {
      if (typeof g === 'string') return g === group;
      return g[0] === group;
    });
  }

  getEditRestriction(): string | undefined {
    const mode = this.getActive();
    for (const g of mode.groups) {
      if (Array.isArray(g) && g[0] === 'edit' && g[1]?.fileRegex) {
        return g[1].fileRegex;
      }
    }
    return undefined;
  }

  /** Register a custom mode dynamically (adds or overrides) */
  registerMode(mode: Mode): void {
    this.modes.set(mode.slug, mode);
  }
}
