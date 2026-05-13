import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface ContextMention {
  type: 'file' | 'folder' | 'problems' | 'terminal' | 'git-changes' | 'git-commit' | 'url';
  value: string;
  resolvedContent?: string;
  startIndex: number;
  endIndex: number;
}

export interface MentionParseResult {
  cleanText: string;
  mentions: ContextMention[];
  contextBlock: string;
}

// Match @file{path} or @file(path) or @problems or @terminal or @git-changes or @<commit-hash> or @path/to/file.ext
const MENTION_REGEX =
  /@(file|folder|problems|terminal|git-changes|git-commit|url)\{([^}]+)\}|@(file|folder)\(([^)]+)\)|@([0-9a-f]{7,40})\b|@([\w./\\-]+\.\w+)/g;

/**
 * Parse @mentions in user messages and resolve file contents.
 */
export class MentionParser {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Parse a user message for @mentions, resolve file contents,
   * and return a clean message + context block.
   */
  async parse(text: string): Promise<MentionParseResult> {
    const mentions: ContextMention[] = [];
    let match: RegExpExecArray | null;
    const regex = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);

    while ((match = regex.exec(text)) !== null) {
      let type: ContextMention['type'];
      let value: string;

      if (match[1] && match[2]) {
        // @file{path} or @folder{path} or @problems{} etc.
        type = match[1] as ContextMention['type'];
        value = match[2];
      } else if (match[3] && match[4]) {
        // @file(path) or @folder(path)
        type = match[3] as ContextMention['type'];
        value = match[4];
      } else if (match[5]) {
        // @<commit-hash> — auto-detect as git-commit
        type = 'git-commit';
        value = match[5];
      } else if (match[6]) {
        // @path/to/file.ext — auto-detect as file
        type = 'file';
        value = match[6];
      } else {
        continue;
      }

      mentions.push({
        type,
        value,
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }

    // Resolve file/folder/special mention contents
    for (const mention of mentions) {
      if (mention.type === 'file') {
        mention.resolvedContent = await this.resolveFile(mention.value);
      } else if (mention.type === 'folder') {
        mention.resolvedContent = await this.resolveFolder(mention.value);
      } else if (mention.type === 'git-changes') {
        mention.resolvedContent = this.resolveGitChanges();
      } else if (mention.type === 'git-commit') {
        mention.resolvedContent = this.resolveGitCommit(mention.value);
      } else if (mention.type === 'terminal') {
        mention.resolvedContent = this.resolveTerminal();
      } else if (mention.type === 'problems') {
        mention.resolvedContent = this.resolveProblems();
      } else if (mention.type === 'url') {
        mention.resolvedContent = await this.resolveUrl(mention.value);
      }
    }

    // Build clean text (remove mention syntax) and context block
    let cleanText = text;
    // Replace in reverse order to preserve indices
    for (let i = mentions.length - 1; i >= 0; i--) {
      const m = mentions[i];
      cleanText =
        cleanText.slice(0, m.startIndex) + `[${m.type}: ${m.value}]` + cleanText.slice(m.endIndex);
    }

    const contextBlock = this.buildContextBlock(mentions);

    return { cleanText, mentions, contextBlock };
  }

  private async resolveFile(filePath: string): Promise<string | undefined> {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspaceRoot, filePath);

    // Security: prevent path traversal
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(this.workspaceRoot))) {
      return `[Error: path ${filePath} is outside workspace]`;
    }

    try {
      const content = await fs.readFile(resolved, 'utf-8');
      // Truncate large files
      const MAX_FILE_CHARS = 20_000;
      if (content.length > MAX_FILE_CHARS) {
        return content.slice(0, MAX_FILE_CHARS) + `\n... [truncated at ${MAX_FILE_CHARS} chars]`;
      }
      return content;
    } catch {
      return `[Error: could not read file ${filePath}]`;
    }
  }

  private async resolveFolder(folderPath: string): Promise<string | undefined> {
    const fullPath = path.isAbsolute(folderPath)
      ? folderPath
      : path.resolve(this.workspaceRoot, folderPath);

    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(this.workspaceRoot))) {
      return `[Error: path ${folderPath} is outside workspace]`;
    }

    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const listing = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
      return listing;
    } catch {
      return `[Error: could not list folder ${folderPath}]`;
    }
  }

  private buildContextBlock(mentions: ContextMention[]): string {
    const blocks: string[] = [];

    for (const m of mentions) {
      if (!m.resolvedContent) continue;

      switch (m.type) {
        case 'file':
          blocks.push(`<file path="${m.value}">\n${m.resolvedContent}\n</file>`);
          break;
        case 'folder':
          blocks.push(`<folder path="${m.value}">\n${m.resolvedContent}\n</folder>`);
          break;
        case 'git-changes':
          blocks.push(`<git-changes>\n${m.resolvedContent}\n</git-changes>`);
          break;
        case 'git-commit':
          blocks.push(`<git-commit hash="${m.value}">\n${m.resolvedContent}\n</git-commit>`);
          break;
        case 'terminal':
          blocks.push(`<terminal>\n${m.resolvedContent}\n</terminal>`);
          break;
        case 'problems':
          blocks.push(`<problems>\n${m.resolvedContent}\n</problems>`);
          break;
        case 'url':
          blocks.push(`<url value="${m.value}">\n${m.resolvedContent}\n</url>`);
          break;
      }
    }

    return blocks.length > 0 ? `\n\n## Referenced Context\n\n${blocks.join('\n\n')}` : '';
  }

  /** Resolve @git-changes — git status + diff of uncommitted changes */
  private resolveGitChanges(): string {
    try {
      const status = execSync('git status --short', {
        cwd: this.workspaceRoot,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (!status) return 'No uncommitted changes.';

      const diff = execSync('git diff --stat', {
        cwd: this.workspaceRoot,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      const fullDiff = execSync('git diff', {
        cwd: this.workspaceRoot,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();

      // Truncate large diffs
      const maxChars = 15_000;
      const truncatedDiff =
        fullDiff.length > maxChars
          ? fullDiff.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`
          : fullDiff;

      return `## Status\n${status}\n\n## Diff Summary\n${diff}\n\n## Full Diff\n${truncatedDiff}`;
    } catch {
      return '[Error: could not read git changes — is this a git repository?]';
    }
  }

  /** Resolve @<commit-hash> — commit details + diff */
  private resolveGitCommit(hash: string): string {
    // Validate hash format to prevent command injection
    if (!/^[0-9a-f]{7,40}$/.test(hash)) {
      return `[Error: invalid commit hash format: ${hash}]`;
    }

    try {
      const info = execSync(`git log -1 --format="%H%n%an%n%ae%n%ai%n%s%n%b" ${hash}`, {
        cwd: this.workspaceRoot,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      const diff = execSync(`git show --stat ${hash}`, {
        cwd: this.workspaceRoot,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();

      // Truncate
      const maxChars = 15_000;
      const truncated =
        diff.length > maxChars ? diff.slice(0, maxChars) + `\n... [truncated]` : diff;

      return `## Commit Info\n${info}\n\n## Changes\n${truncated}`;
    } catch {
      return `[Error: could not find commit ${hash}]`;
    }
  }

  /** Resolve @terminal — placeholder for last terminal output (extension fills this) */
  private resolveTerminal(): string {
    // In the core package, we can't access VS Code terminals directly.
    // The extension layer should override this or provide terminal content.
    // Return a placeholder that the extension can replace.
    return '[Terminal context is available in the VS Code extension — use the chat panel to reference @terminal]';
  }

  /** Resolve @problems — placeholder for VS Code diagnostics (extension fills this) */
  private resolveProblems(): string {
    // Similar to @terminal — VS Code API needed for real diagnostics.
    return '[Problems context is available in the VS Code extension — use the chat panel to reference @problems]';
  }

  private async resolveUrl(urlValue: string): Promise<string> {
    const trimmed = urlValue.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return `[Error: unsupported URL scheme in ${urlValue}]`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(trimmed, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        return `[Error: failed to fetch ${trimmed} (${response.status})]`;
      }

      const text = await response.text();
      const MAX_URL_CHARS = 20_000;
      if (text.length > MAX_URL_CHARS) {
        return text.slice(0, MAX_URL_CHARS) + `\n... [truncated at ${MAX_URL_CHARS} chars]`;
      }

      return text;
    } catch {
      return `[Error: could not fetch URL ${trimmed}]`;
    } finally {
      clearTimeout(timeout);
    }
  }
}
