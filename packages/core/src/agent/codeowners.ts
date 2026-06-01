import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CodeOwnerRule {
  /** Glob pattern for files */
  pattern: string;
  /** Owner identifiers (teams or usernames) */
  owners: string[];
}

/**
 * Parses CODEOWNERS files and resolves ownership for file paths.
 * Supports GitHub CODEOWNERS format.
 *
 * Lookup order:
 * 1. .opencob/CODEOWNERS
 * 2. .github/CODEOWNERS
 * 3. CODEOWNERS (root)
 */
export class CodeOwnersResolver {
  private rules: CodeOwnerRule[] = [];

  constructor(private readonly workspaceRoot: string) {
    this.load();
  }

  /** Load CODEOWNERS from the workspace */
  private load(): void {
    const candidates = [
      path.join(this.workspaceRoot, '.opencob', 'CODEOWNERS'),
      path.join(this.workspaceRoot, '.OpenCob', 'CODEOWNERS'),
      path.join(this.workspaceRoot, '.github', 'CODEOWNERS'),
      path.join(this.workspaceRoot, 'CODEOWNERS'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const content = fs.readFileSync(candidate, 'utf-8');
          this.rules = this.parse(content);
          return;
        } catch {
          continue;
        }
      }
    }
  }

  /** Parse CODEOWNERS file content into rules */
  private parse(content: string): CodeOwnerRule[] {
    const rules: CodeOwnerRule[] = [];
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      // Skip empty lines and comments
      if (!line || line.startsWith('#')) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;

      const pattern = parts[0];
      const owners = parts.slice(1).map((o) => o.replace(/^@/, ''));
      rules.push({ pattern, owners });
    }
    return rules;
  }

  /** Get owners for a given file path (last matching rule wins, per GitHub convention) */
  getOwners(filePath: string): string[] {
    const relativePath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
    let matchedOwners: string[] = [];

    for (const rule of this.rules) {
      if (this.matchPattern(relativePath, rule.pattern)) {
        matchedOwners = rule.owners;
      }
    }
    return matchedOwners;
  }

  /** Check if a file path is owned by a specific owner/team */
  isOwnedBy(filePath: string, owner: string): boolean {
    const owners = this.getOwners(filePath);
    return owners.includes(owner.replace(/^@/, ''));
  }

  /** Get all files patterns owned by a specific owner */
  getPatternsForOwner(owner: string): string[] {
    const normalized = owner.replace(/^@/, '');
    return this.rules.filter((r) => r.owners.includes(normalized)).map((r) => r.pattern);
  }

  /** Get all unique owners defined in CODEOWNERS */
  getAllOwners(): string[] {
    const owners = new Set<string>();
    for (const rule of this.rules) {
      for (const owner of rule.owners) {
        owners.add(owner);
      }
    }
    return [...owners];
  }

  /** Check if CODEOWNERS file exists */
  hasCodeOwners(): boolean {
    return this.rules.length > 0;
  }

  /** Match a file path against a CODEOWNERS pattern */
  private matchPattern(filePath: string, pattern: string): boolean {
    // Handle leading / (anchored to root)
    let pat = pattern;
    if (pat.startsWith('/')) {
      pat = pat.slice(1);
    }

    // Handle trailing / (directory match — match anything under it)
    if (pat.endsWith('/')) {
      return filePath.startsWith(pat) || filePath.startsWith(pat.slice(0, -1));
    }

    // Convert CODEOWNERS glob to regex
    const regexStr = pat
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*')
      .replace(/\?/g, '[^/]');

    // If pattern doesn't contain a slash, it matches in any directory
    if (!pattern.includes('/')) {
      try {
        return new RegExp(`(^|/)${regexStr}$`).test(filePath);
      } catch {
        return false;
      }
    }

    try {
      return new RegExp(`^${regexStr}$`).test(filePath);
    } catch {
      return false;
    }
  }
}
