/**
 * Quality Rule Loader — Configurable rules via `.opencob-rules.json` with EE download support.
 *
 * Supports:
 *   - Local `.opencob-rules.json` config files
 *   - Built-in presets (`opencob:recommended`, `opencob:strict`, `opencob:minimal`)
 *   - Remote rule packs from OpenCob EE (`ee:<profile-name>`)
 *   - Rule overrides (enable/disable, severity, params)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_RULES, type QualityRule, type Severity } from './quality-rules.js';

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

/** User-facing rule config file schema */
export interface RuleConfigFile {
  /** Presets to extend. Evaluated left-to-right, later wins. */
  extends?: string[];
  /** EE server URL for remote rule downloads */
  eeServer?: string;
  /** API key or token for EE auth (or set OPENCOB_EE_TOKEN env var) */
  eeToken?: string;
  /** Per-rule overrides keyed by rule code */
  rules?: Record<string, RuleOverride>;
}

/** Override for a single rule */
export interface RuleOverride {
  enabled?: boolean;
  severity?: Severity;
  params?: Record<string, string | number>;
  maxPerFile?: number;
  debtMinutes?: number;
}

/** Remote rule from EE server */
export interface EeRemoteRule {
  id: string;
  name: string;
  description?: string;
  severity: string;
  language?: string;
  category: string;
  debtMinutes?: number;
  checkerId?: string;
  checkerParams?: Record<string, string | number>;
}

/** Result of loading rules */
export interface RuleLoadResult {
  rules: QualityRule[];
  sources: string[];
  errors: string[];
}

// ═══════════════════════════════════════════════════════════════
//  Built-in Presets
// ═══════════════════════════════════════════════════════════════

const PRESET_RECOMMENDED = DEFAULT_RULES;

const PRESET_STRICT: QualityRule[] = DEFAULT_RULES.map((r) => ({
  ...r,
  enabled: true,
  ...(r.code === 'NAME001' ? { enabled: true } : {}),
  ...(r.code === 'DOC001' ? { enabled: true } : {}),
  ...(r.code === 'NEST001' ? { checkerParams: { ...r.checkerParams, max_depth: 3 } } : {}),
  ...(r.code === 'SIZE001' ? { checkerParams: { ...r.checkerParams, max_lines: 40 } } : {}),
}));

const PRESET_MINIMAL: QualityRule[] = DEFAULT_RULES.map((r) => ({
  ...r,
  enabled: ['NEST001', 'ID001', 'MOVE001'].includes(r.code),
}));

const PRESETS: Record<string, QualityRule[]> = {
  'opencob:recommended': PRESET_RECOMMENDED,
  'opencob:strict': PRESET_STRICT,
  'opencob:minimal': PRESET_MINIMAL,
};

/** Get list of available built-in presets */
export function getAvailablePresets(): string[] {
  return Object.keys(PRESETS);
}

// ═══════════════════════════════════════════════════════════════
//  EE Rule Fetcher
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch rules from an OpenCob EE server.
 * Uses `GET /api/v1/quality/rules` endpoint.
 */
export async function fetchEeRules(
  serverUrl: string,
  token?: string,
): Promise<{ rules: EeRemoteRule[]; error?: string }> {
  const url = `${serverUrl.replace(/\/$/, '')}/api/v1/quality/rules`;
  const authToken = token || process.env.OPENCOB_EE_TOKEN || '';

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return { rules: [], error: `EE server responded ${response.status}: ${response.statusText}` };
    }

    const data = (await response.json()) as { rules?: EeRemoteRule[] } | EeRemoteRule[];
    const rules = Array.isArray(data) ? data : (data.rules ?? []);
    return { rules };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rules: [], error: `Failed to fetch EE rules: ${msg}` };
  }
}

/**
 * Convert EE remote rules to local QualityRule format.
 * Only rules with a recognized checkerId are usable locally.
 */
export function convertEeRules(remote: EeRemoteRule[]): QualityRule[] {
  const VALID_CHECKERS = new Set([
    'structure_count',
    'block_size',
    'nesting_depth',
    'unused_detection',
    'naming_convention',
    'documentation_check',
    'program_id_filename',
    'duplicate_detection',
    'move_analysis',
  ]);

  return remote
    .filter((r) => r.checkerId && VALID_CHECKERS.has(r.checkerId))
    .map((r) => ({
      code: r.id,
      name: r.name,
      severity: (r.severity as Severity) ?? 'medium',
      category: r.category ?? 'general',
      checkerId: r.checkerId!,
      checkerParams: r.checkerParams ?? {},
      enabled: true,
      maxPerFile: 10,
      debtMinutes: r.debtMinutes ?? 15,
    }));
}

// ═══════════════════════════════════════════════════════════════
//  Rule Loader
// ═══════════════════════════════════════════════════════════════

/**
 * Load quality rules from a `.opencob-rules.json` file.
 * Falls back to `opencob:recommended` if no config file exists.
 */
export async function loadRules(workspaceRoot: string): Promise<RuleLoadResult> {
  const configPaths = [
    path.join(workspaceRoot, '.opencob-rules.json'),
    path.join(workspaceRoot, '.opencob-rules.jsonc'),
    path.join(workspaceRoot, '.opencob', 'rules.json'),
  ];

  let configFile: RuleConfigFile | null = null;
  let configSource = '';

  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        // Strip single-line comments for JSONC support
        const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
        configFile = JSON.parse(stripped) as RuleConfigFile;
        configSource = p;
        break;
      } catch (err: unknown) {
        return {
          rules: DEFAULT_RULES,
          sources: ['opencob:recommended (fallback)'],
          errors: [`Failed to parse ${p}: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    }
  }

  // No config → use defaults
  if (!configFile) {
    return { rules: DEFAULT_RULES, sources: ['opencob:recommended (default)'], errors: [] };
  }

  const sources: string[] = [configSource];
  const errors: string[] = [];
  let mergedRules = new Map<string, QualityRule>();

  // Process extends
  const extends_ = configFile.extends ?? ['opencob:recommended'];
  for (const preset of extends_) {
    if (PRESETS[preset]) {
      for (const rule of PRESETS[preset]) {
        mergedRules.set(rule.code, { ...rule });
      }
      sources.push(preset);
    } else if (preset.startsWith('ee:') || preset === 'ee') {
      // Fetch from EE server
      const serverUrl = configFile.eeServer || process.env.OPENCOB_EE_URL || '';
      if (!serverUrl) {
        errors.push(
          `Cannot resolve '${preset}': no eeServer URL configured (set eeServer in config or OPENCOB_EE_URL env var)`,
        );
        continue;
      }
      const { rules: remote, error } = await fetchEeRules(serverUrl, configFile.eeToken);
      if (error) {
        errors.push(error);
      } else {
        const converted = convertEeRules(remote);
        for (const rule of converted) {
          mergedRules.set(rule.code, rule);
        }
        sources.push(`ee:${serverUrl} (${converted.length} rules)`);
      }
    } else {
      errors.push(`Unknown preset: '${preset}'`);
    }
  }

  // Apply per-rule overrides
  if (configFile.rules) {
    for (const [code, override] of Object.entries(configFile.rules)) {
      const existing = mergedRules.get(code);
      if (existing) {
        if (override.enabled !== undefined) existing.enabled = override.enabled;
        if (override.severity) existing.severity = override.severity;
        if (override.maxPerFile !== undefined) existing.maxPerFile = override.maxPerFile;
        if (override.debtMinutes !== undefined) existing.debtMinutes = override.debtMinutes;
        if (override.params)
          existing.checkerParams = { ...existing.checkerParams, ...override.params };
        mergedRules.set(code, existing);
      } else {
        errors.push(`Rule override for unknown code '${code}' — skipped`);
      }
    }
  }

  return { rules: [...mergedRules.values()], sources, errors };
}

/**
 * Synchronous rule loader (no EE fetch). Use when network calls aren't needed.
 */
export function loadRulesSync(workspaceRoot: string): RuleLoadResult {
  const configPaths = [
    path.join(workspaceRoot, '.opencob-rules.json'),
    path.join(workspaceRoot, '.opencob-rules.jsonc'),
    path.join(workspaceRoot, '.opencob', 'rules.json'),
  ];

  let configFile: RuleConfigFile | null = null;
  let configSource = '';

  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
        configFile = JSON.parse(stripped) as RuleConfigFile;
        configSource = p;
        break;
      } catch (err: unknown) {
        return {
          rules: DEFAULT_RULES,
          sources: ['opencob:recommended (fallback)'],
          errors: [`Failed to parse ${p}: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    }
  }

  if (!configFile) {
    return { rules: DEFAULT_RULES, sources: ['opencob:recommended (default)'], errors: [] };
  }

  const sources: string[] = [configSource];
  const errors: string[] = [];
  let mergedRules = new Map<string, QualityRule>();

  const extends_ = configFile.extends ?? ['opencob:recommended'];
  for (const preset of extends_) {
    if (PRESETS[preset]) {
      for (const rule of PRESETS[preset]) {
        mergedRules.set(rule.code, { ...rule });
      }
      sources.push(preset);
    } else if (preset.startsWith('ee:') || preset === 'ee') {
      errors.push(`EE presets require async loadRules() — skipped '${preset}'`);
    } else {
      errors.push(`Unknown preset: '${preset}'`);
    }
  }

  if (configFile.rules) {
    for (const [code, override] of Object.entries(configFile.rules)) {
      const existing = mergedRules.get(code);
      if (existing) {
        if (override.enabled !== undefined) existing.enabled = override.enabled;
        if (override.severity) existing.severity = override.severity;
        if (override.maxPerFile !== undefined) existing.maxPerFile = override.maxPerFile;
        if (override.debtMinutes !== undefined) existing.debtMinutes = override.debtMinutes;
        if (override.params)
          existing.checkerParams = { ...existing.checkerParams, ...override.params };
        mergedRules.set(code, existing);
      } else {
        errors.push(`Rule override for unknown code '${code}' — skipped`);
      }
    }
  }

  return { rules: [...mergedRules.values()], sources, errors };
}
