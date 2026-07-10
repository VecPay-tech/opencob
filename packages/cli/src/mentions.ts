import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

export function expandMentions(input: string, cwd: string): string {
  return input.replace(/#([\w./\\-]+)/g, (_match, token: string) => {
    const fullPath = resolve(cwd, token);
    if (!existsSync(fullPath)) return _match;
    const content = readFileSync(fullPath, 'utf8');
    const rel = relative(cwd, fullPath);
    return `\n--- file: ${rel} ---\n${content}\n---\n`;
  });
}
