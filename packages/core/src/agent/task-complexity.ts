/**
 * F6.4 Task Complexity Classifier — Score request complexity
 * and adjust reasoning effort + max tokens accordingly.
 */
export interface ComplexityScore {
  level: 'low' | 'medium' | 'high';
  score: number; // 0–100
  adjustedMaxTokens: number;
  adjustedTemperature: number;
  /** Whether to delegate to orchestrator for complex tasks */
  shouldDelegate: boolean;
  reason: string;
}

const COMPLEX_KEYWORDS = [
  'refactor',
  'redesign',
  'migrate',
  'modernize',
  'architect',
  'across files',
  'multiple files',
  'entire',
  'whole project',
  'build system',
  'deploy',
  'infrastructure',
  'database schema',
  'performance',
  'optimize',
  'security audit',
  'review all',
];

const SIMPLE_KEYWORDS = [
  'explain',
  'what is',
  'how to',
  'fix this',
  'typo',
  'rename',
  'add comment',
  'format',
  'lint',
];

export class TaskComplexityClassifier {
  /**
   * Score the complexity of a user request.
   */
  classify(message: string, contextFileCount: number = 0, turnDepth: number = 0): ComplexityScore {
    let score = 30; // baseline
    const reasons: string[] = [];

    // Message length
    if (message.length > 500) {
      score += 15;
      reasons.push('long request');
    } else if (message.length > 200) {
      score += 8;
    }

    // Keyword analysis
    const lower = message.toLowerCase();
    for (const kw of COMPLEX_KEYWORDS) {
      if (lower.includes(kw)) {
        score += 12;
        reasons.push(kw);
        break; // only count once
      }
    }
    for (const kw of SIMPLE_KEYWORDS) {
      if (lower.includes(kw)) {
        score -= 10;
        break;
      }
    }

    // Context size
    if (contextFileCount > 10) {
      score += 15;
      reasons.push(`${contextFileCount} context files`);
    } else if (contextFileCount > 5) {
      score += 8;
    }

    // Turn depth (deeper conversations are more complex)
    if (turnDepth > 10) {
      score += 10;
      reasons.push(`turn depth ${turnDepth}`);
    } else if (turnDepth > 5) {
      score += 5;
    }

    // Multi-file mentions
    const mentionCount = (message.match(/@[\w./\\-]+/g) || []).length;
    if (mentionCount > 3) {
      score += 10;
      reasons.push(`${mentionCount} @mentions`);
    }

    // Question marks suggest simpler queries
    if (message.includes('?') && message.length < 100) {
      score -= 8;
    }

    // Clamp
    score = Math.max(0, Math.min(100, score));

    // Determine level and adjust parameters
    if (score >= 65) {
      return {
        level: 'high',
        score,
        adjustedMaxTokens: 8192,
        adjustedTemperature: 0.7,
        shouldDelegate: score >= 80,
        reason: reasons.length > 0 ? reasons.join(', ') : 'complex request',
      };
    }
    if (score >= 35) {
      return {
        level: 'medium',
        score,
        adjustedMaxTokens: 4096,
        adjustedTemperature: 0.5,
        shouldDelegate: false,
        reason: reasons.length > 0 ? reasons.join(', ') : 'moderate request',
      };
    }
    return {
      level: 'low',
      score,
      adjustedMaxTokens: 2048,
      adjustedTemperature: 0.3,
      shouldDelegate: false,
      reason: reasons.length > 0 ? reasons.join(', ') : 'simple request',
    };
  }
}
