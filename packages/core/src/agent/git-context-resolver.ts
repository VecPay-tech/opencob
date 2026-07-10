import { execSync } from 'node:child_process';

export class GitContextResolver {
  looksLikeBranch(input: string): boolean {
    if (input.includes(' ') || input.startsWith('@') || input.startsWith('/')) return false;
    if (/\.(ts|js|py|java|go|rs|c|h|cbl|cob|rpg|pli|md|yaml|json|xml|html|css)$/i.test(input))
      return false;
    return /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(input);
  }

  resolveGitBranchDiff(branch: string, workspaceRoot: string): string {
    try {
      if (branch === 'HEAD') {
        return execSync('git diff HEAD', {
          cwd: workspaceRoot,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
      }
      const mergeBase = execSync(`git merge-base ${branch} HEAD`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
      }).trim();
      const diff = execSync(`git diff ${mergeBase}..HEAD`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return diff || `(no diff between ${branch} and HEAD)`;
    } catch (err) {
      return `(git diff failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  resolveGitPrContext(baseBranch: string, workspaceRoot: string): string {
    try {
      const log = execSync(`git log ${baseBranch}..HEAD --oneline`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
      });
      const diff = this.resolveGitBranchDiff(baseBranch, workspaceRoot);
      return `## Commits\n\n${log}\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``;
    } catch (err) {
      return `(git log failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }
}
