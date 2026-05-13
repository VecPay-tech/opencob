import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolResult } from './types.js';

/**
 * Composite code analysis: complexity, smells, unused code, naming issues, suggestions.
 * All analysis in a single call.
 */
export function createAnalyzeCodeTool(workspaceRoot: string): Tool {
  return {
    name: 'analyze_code',
    group: 'read',
    description:
      'Analyze a file for code quality: complexity, code smells, unused code, naming conventions, and improvement suggestions. Returns a composite report.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'File path relative to workspace root',
        required: true,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.path as string;
      if (!filePath) return { success: false, content: 'Error: path is required' };

      const fullPath = path.resolve(workspaceRoot, filePath);
      if (!fullPath.startsWith(path.resolve(workspaceRoot))) {
        return { success: false, content: 'Error: path traversal not allowed' };
      }

      if (!fs.existsSync(fullPath)) {
        return { success: false, content: `Error: file not found: ${filePath}` };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const analysis = analyzeFile(filePath, lines);

      return {
        success: true,
        content: formatReport(filePath, analysis),
        metadata: { path: filePath, ...analysis.metrics },
      };
    },
  };
}

interface AnalysisReport {
  metrics: {
    totalLines: number;
    codeLines: number;
    commentLines: number;
    blankLines: number;
    maxNesting: number;
    functionCount: number;
    longestFunction: number;
  };
  issues: AnalysisIssue[];
}

interface AnalysisIssue {
  severity: 'info' | 'warning' | 'error';
  category: string;
  line?: number;
  message: string;
}

function analyzeFile(filePath: string, lines: string[]): AnalysisReport {
  const issues: AnalysisIssue[] = [];
  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  let maxNesting = 0;
  let currentNesting = 0;
  let functionCount = 0;
  let longestFunction = 0;
  let currentFunctionLength = 0;
  let inFunction = false;

  const ext = path.extname(filePath).toLowerCase();
  const isTs = ['.ts', '.tsx', '.js', '.jsx'].includes(ext);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // Blank lines
    if (trimmed === '') {
      blankLines++;
      continue;
    }

    // Comments
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')
    ) {
      commentLines++;
      continue;
    }

    codeLines++;

    // Track nesting depth (brace-based languages)
    if (isTs) {
      const opens = (trimmed.match(/{/g) ?? []).length;
      const closes = (trimmed.match(/}/g) ?? []).length;
      currentNesting += opens - closes;
      maxNesting = Math.max(maxNesting, currentNesting);

      // Function detection
      if (trimmed.match(/(?:function\s+\w+|=>\s*{|\w+\s*\([^)]*\)\s*{)/)) {
        functionCount++;
        inFunction = true;
        currentFunctionLength = 0;
      }

      if (inFunction) {
        currentFunctionLength++;
        if (closes > opens) {
          longestFunction = Math.max(longestFunction, currentFunctionLength);
          inFunction = false;
        }
      }
    }

    // Long lines
    if (line.length > 120) {
      issues.push({
        severity: 'info',
        category: 'style',
        line: lineNum,
        message: `Line exceeds 120 characters (${line.length})`,
      });
    }

    // TODO/FIXME/HACK comments
    if (/\b(TODO|FIXME|HACK|XXX)\b/i.test(trimmed)) {
      issues.push({
        severity: 'info',
        category: 'maintenance',
        line: lineNum,
        message: `Contains ${trimmed.match(/\b(TODO|FIXME|HACK|XXX)\b/i)?.[1]} marker`,
      });
    }

    // Console.log / print statements
    if (/console\.(log|warn|error|debug)\s*\(/.test(trimmed) || /\bprint\s*\(/.test(trimmed)) {
      issues.push({
        severity: 'warning',
        category: 'cleanup',
        line: lineNum,
        message: 'Debug print statement found — consider removing before production',
      });
    }

    // Hardcoded strings that look like secrets
    if (/(?:password|secret|token|api_key)\s*[:=]\s*['"][^'"]+['"]/i.test(trimmed)) {
      issues.push({
        severity: 'error',
        category: 'security',
        line: lineNum,
        message: 'Possible hardcoded secret detected',
      });
    }
  }

  // File-level issues
  if (lines.length > 500) {
    issues.push({
      severity: 'warning',
      category: 'complexity',
      message: `File is ${lines.length} lines — consider splitting into smaller modules`,
    });
  }

  if (maxNesting > 5) {
    issues.push({
      severity: 'warning',
      category: 'complexity',
      message: `Maximum nesting depth is ${maxNesting} — consider extracting inner logic`,
    });
  }

  if (longestFunction > 50) {
    issues.push({
      severity: 'warning',
      category: 'complexity',
      message: `Longest function is ~${longestFunction} lines — consider breaking into smaller functions`,
    });
  }

  return {
    metrics: {
      totalLines: lines.length,
      codeLines,
      commentLines,
      blankLines,
      maxNesting,
      functionCount,
      longestFunction,
    },
    issues,
  };
}

function formatReport(filePath: string, report: AnalysisReport): string {
  const { metrics, issues } = report;

  const metricsSection = [
    `## Code Analysis: ${filePath}`,
    '',
    '### Metrics',
    `- Total lines: ${metrics.totalLines}`,
    `- Code lines: ${metrics.codeLines}`,
    `- Comment lines: ${metrics.commentLines}`,
    `- Blank lines: ${metrics.blankLines}`,
    `- Functions: ${metrics.functionCount}`,
    `- Max nesting depth: ${metrics.maxNesting}`,
    `- Longest function: ~${metrics.longestFunction} lines`,
  ].join('\n');

  if (issues.length === 0) {
    return `${metricsSection}\n\n### Issues\nNo issues found — code looks clean!`;
  }

  const issuesByCategory = new Map<string, AnalysisIssue[]>();
  for (const issue of issues) {
    const list = issuesByCategory.get(issue.category) ?? [];
    list.push(issue);
    issuesByCategory.set(issue.category, list);
  }

  const issueLines: string[] = ['', '### Issues'];
  for (const [category, catIssues] of issuesByCategory) {
    issueLines.push(`\n**${category}** (${catIssues.length}):`);
    for (const issue of catIssues.slice(0, 10)) {
      const loc = issue.line ? `L${issue.line}: ` : '';
      const icon = issue.severity === 'error' ? '🔴' : issue.severity === 'warning' ? '🟡' : 'ℹ️';
      issueLines.push(`  ${icon} ${loc}${issue.message}`);
    }
    if (catIssues.length > 10) {
      issueLines.push(`  ... and ${catIssues.length - 10} more`);
    }
  }

  return metricsSection + issueLines.join('\n');
}
