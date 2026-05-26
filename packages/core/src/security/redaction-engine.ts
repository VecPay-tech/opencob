export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export interface RedactionResult {
  redacted: string;
  redactionCount: number;
  redactions: Array<{ rule: string; count: number }>;
}

/** Built-in redaction patterns for common secret types */
const BUILT_IN_RULES: RedactionRule[] = [
  {
    name: 'AWS_ACCESS_KEY',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  {
    name: 'AWS_SECRET_KEY',
    pattern: /\b[A-Za-z0-9/+=]{40}\b(?=\s|$|"|')/g,
    replacement: '[REDACTED_AWS_SECRET]',
  },
  {
    name: 'GENERIC_API_KEY',
    pattern: /(?:api[_-]?key|apikey|api[_-]?token)\s*[:=]\s*['"]?([A-Za-z0-9_-]{20,})['"]?/gi,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    name: 'BEARER_TOKEN',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  {
    name: 'JWT',
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    name: 'PRIVATE_KEY',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    name: 'PASSWORD_ASSIGNMENT',
    pattern: /(?:password|passwd|pwd|secret)\s*[:=]\s*['"]([^'"]{4,})['"]?/gi,
    replacement: '[REDACTED_PASSWORD]',
  },
  {
    name: 'CONNECTION_STRING',
    pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s'"]+/gi,
    replacement: '[REDACTED_CONNECTION_STRING]',
  },
  {
    name: 'GITHUB_TOKEN',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    name: 'SLACK_TOKEN',
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacement: '[REDACTED_SLACK_TOKEN]',
  },
];

export class RedactionEngine {
  private rules: RedactionRule[];

  constructor(customRules: RedactionRule[] = []) {
    this.rules = [...BUILT_IN_RULES, ...customRules];
  }

  /** Redact sensitive content from text */
  redact(text: string): RedactionResult {
    let redacted = text;
    let totalCount = 0;
    const redactions: Array<{ rule: string; count: number }> = [];

    for (const rule of this.rules) {
      // Clone regex to reset lastIndex
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      const matches = redacted.match(regex);
      if (matches && matches.length > 0) {
        redacted = redacted.replace(regex, rule.replacement);
        totalCount += matches.length;
        redactions.push({ rule: rule.name, count: matches.length });
      }
    }

    return { redacted, redactionCount: totalCount, redactions };
  }

  /** Redact an array of chat messages */
  redactMessages<T extends { content: string }>(messages: T[]): T[] {
    return messages.map((msg) => ({
      ...msg,
      content: this.redact(msg.content).redacted,
    }));
  }

  /** Add a custom redaction rule */
  addRule(rule: RedactionRule): void {
    this.rules.push(rule);
  }

  /** Get the current list of rule names */
  listRules(): string[] {
    return this.rules.map((r) => r.name);
  }
}
