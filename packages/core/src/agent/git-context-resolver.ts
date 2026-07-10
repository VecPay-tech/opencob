import { execSync } from 'node:child_process';

export class GitContextResolver {
  looksLikeBranch(input: string): boolean {
    if (input.includes(' ') || input.startsWith('@') || input.startsWith('/')) return false;
    if (/\.(ts|js|py|java|go|rs|c|h|cbl|cob|rpg|pli|md|yaml|json|xml|html|css)$/i.test(input))
      return false;
    return /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(input);
  }

  resolveGitBranchDiff(branch: string, workspaceRoot: string): string {
    if (branch !== 'HEAD' && !this.looksLikeBranch(branch)) return '(invalid branch name)';
    try {
      if (branch === 'HEAD') {
        return execSync('git diff HEAD', {
          cwd: workspaceRoot,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          timeout: 15000,
        });
      }
      const mergeBase = execSync(`git merge-base ${branch} HEAD`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        timeout: 15000,
      }).trim();
      // Validate mergeBase before using it in a shell command
      if (!this.looksLikeBranch(mergeBase) && !/^[0-9a-f]{7,40}$/i.test(mergeBase)) {
        throw new Error('git merge-base returned an unexpected value');
      }
      const diff = execSync(`git diff ${mergeBase}..HEAD`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: 15000,
      });
      return diff || `(no diff between ${branch} and HEAD)`;
    } catch (err) {
      return `(git diff failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  resolveGitPrContext(baseBranch: string, workspaceRoot: string): string {
    if (!this.looksLikeBranch(baseBranch)) return '(invalid branch name)';
    try {
      const log = execSync(`git log ${baseBranch}..HEAD --oneline`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        timeout: 15000,
      });
      const diff = this.resolveGitBranchDiff(baseBranch, workspaceRoot);
      return `## Commits\n\n${log}\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``;
    } catch (err) {
      return `(git log failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  /**
   * Rewrites a /review or /create-pr slash command into a full LLM prompt
   * with embedded git context. Returns null if the command is not handled here.
   */
  resolveSlashCommand(
    cmd: string,
    remainder: string,
    workspaceRoot: string,
  ): { message: string } | { error: string } | null {
    if (cmd === '/review') {
      if (remainder && this.looksLikeBranch(remainder)) {
        const diff = this.resolveGitBranchDiff(remainder, workspaceRoot);
        return {
          message:
            `Review the following branch diff (comparing "${remainder}" against HEAD) for quality, security, performance, and maintainability issues. Provide a comprehensive analysis with specific improvement suggestions.\n\n` +
            diff,
        };
      }
      if (!remainder) {
        const diff = this.resolveGitBranchDiff('HEAD', workspaceRoot);
        return {
          message:
            'Review the following uncommitted changes for quality, security, performance, and maintainability issues. Suggest improvements.\n\n' +
            diff,
        };
      }
      return null; // not a branch — let SlashCommandHandler's rewrite stand
    }
    if (cmd === '/create-pr') {
      const baseBranch = remainder || 'main';
      if (!this.looksLikeBranch(baseBranch)) {
        return { error: 'Invalid branch name: must contain only letters, digits, _, ., /, -' };
      }
      const prContext = this.resolveGitPrContext(baseBranch, workspaceRoot);
      return {
        message:
          `Generate a pull request title and description for the following changes (comparing current branch against "${baseBranch}"). ` +
          `Use Conventional Commit style for the title. Structure the description with: ## Summary, ## Changes, ## Testing.\n\n` +
          prContext,
      };
    }
    return null;
  }
}
