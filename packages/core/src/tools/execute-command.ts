import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from './types.js';

const MAX_OUTPUT = 50_000; // 50KB output limit

export function createExecuteCommandTool(workspaceRoot: string): Tool {
  return {
    name: 'execute_command',
    group: 'command',
    description:
      'Execute a CLI command in the workspace directory. ' +
      'The command runs in a child process and returns stdout/stderr. ' +
      'Long-running commands are killed after a timeout.',
    parameters: [
      { name: 'command', type: 'string', description: 'The command to execute', required: true },
      { name: 'timeout', type: 'number', description: 'Timeout in milliseconds (default: 30000)', required: false },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const command = params.command as string;
      if (!command) {
        return { success: false, content: 'Error: command parameter is required' };
      }

      const timeout = (params.timeout as number) || 30_000;

      return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'cmd.exe' : '/bin/sh';
        const shellArg = isWindows ? '/c' : '-c';

        const child = spawn(shell, [shellArg, command], {
          cwd: workspaceRoot,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let killed = false;

        const timer = setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
        }, timeout);

        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
          if (stdout.length > MAX_OUTPUT) {
            stdout = stdout.slice(0, MAX_OUTPUT) + '\n... (output truncated)';
            killed = true;
            child.kill('SIGTERM');
          }
        });

        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > MAX_OUTPUT) {
            stderr = stderr.slice(0, MAX_OUTPUT) + '\n... (output truncated)';
          }
        });

        child.on('close', (code: number | null) => {
          clearTimeout(timer);

          const output = [
            stdout ? `STDOUT:\n${stdout}` : '',
            stderr ? `STDERR:\n${stderr}` : '',
            killed ? '(command timed out or output was truncated)' : '',
          ]
            .filter(Boolean)
            .join('\n\n');

          resolve({
            success: code === 0,
            content: output || '(no output)',
            metadata: { exitCode: code, command, timedOut: killed },
          });
        });

        child.on('error', (err: Error) => {
          clearTimeout(timer);
          resolve({
            success: false,
            content: `Error executing command: ${err.message}`,
            metadata: { command },
          });
        });
      });
    },
  };
}
