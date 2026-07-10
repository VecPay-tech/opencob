export interface RexxProgram {
  labels: string[];
  calls: RexxCall[];
  signals: string[];
  hasDynamicExec: boolean;
}

export interface RexxCall {
  target: string;
  type: 'internal' | 'external';
}

export function parse(content: string): RexxProgram {
  const lines = content.split('\n');

  // First pass: collect all labels (lines ending with ':' after a valid identifier)
  const labels: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('/*') || trimmed.startsWith('--')) continue;
    const labelMatch = trimmed.match(/^([A-Za-z_]\w*):\s*$/);
    if (labelMatch) labels.push(labelMatch[1].toUpperCase());
  }

  const calls: RexxCall[] = [];
  const signals: string[] = [];
  let hasDynamicExec = false;

  // Second pass: collect calls, signals, dynamic exec
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('/*') || trimmed.startsWith('--')) continue;

    const callMatch = trimmed.match(/^CALL\s+(\S+)/i);
    if (callMatch) {
      const target = callMatch[1].toUpperCase();
      calls.push({ target, type: labels.includes(target) ? 'internal' : 'external' });
      continue;
    }

    const signalMatch = trimmed.match(/^SIGNAL\s+(\S+)/i);
    if (signalMatch) {
      signals.push(signalMatch[1].toUpperCase());
      continue;
    }

    if (/\bINTERPRET\b/i.test(trimmed)) {
      hasDynamicExec = true;
    }
  }

  return { labels, calls, signals, hasDynamicExec };
}
