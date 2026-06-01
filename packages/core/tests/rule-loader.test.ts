/**
 * Rule Loader Tests — config file loading, presets, EE integration, overrides
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadRulesSync,
  loadRules,
  getAvailablePresets,
  convertEeRules,
  type RuleConfigFile,
  type EeRemoteRule,
} from '../src/metrics/rule-loader.js';
import { DEFAULT_RULES } from '../src/metrics/quality-rules.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencob-rules-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('Rule Loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  describe('loadRulesSync', () => {
    it('returns default rules when no config file exists', () => {
      const result = loadRulesSync(tmpDir);
      expect(result.rules).toEqual(DEFAULT_RULES);
      expect(result.sources).toContain('opencob:recommended (default)');
      expect(result.errors).toHaveLength(0);
    });

    it('loads .opencob-rules.json and applies extends', () => {
      const config: RuleConfigFile = { extends: ['opencob:minimal'] };
      fs.writeFileSync(path.join(tmpDir, '.opencob-rules.json'), JSON.stringify(config));

      const result = loadRulesSync(tmpDir);
      const enabled = result.rules.filter((r) => r.enabled);
      // minimal only enables NEST001, ID001, MOVE001
      expect(enabled.length).toBe(3);
      expect(enabled.map((r) => r.code).sort()).toEqual(['ID001', 'MOVE001', 'NEST001']);
    });

    it('applies per-rule overrides', () => {
      const config: RuleConfigFile = {
        extends: ['opencob:recommended'],
        rules: {
          NEST001: { severity: 'critical', params: { max_depth: 2 } },
          STRUC001: { enabled: false },
        },
      };
      fs.writeFileSync(path.join(tmpDir, '.opencob-rules.json'), JSON.stringify(config));

      const result = loadRulesSync(tmpDir);
      const nest = result.rules.find((r) => r.code === 'NEST001')!;
      expect(nest.severity).toBe('critical');
      expect(nest.checkerParams.max_depth).toBe(2);

      const struc = result.rules.find((r) => r.code === 'STRUC001')!;
      expect(struc.enabled).toBe(false);
    });

    it('reports error for unknown rule override codes', () => {
      const config: RuleConfigFile = {
        extends: ['opencob:recommended'],
        rules: { UNKNOWN99: { enabled: false } },
      };
      fs.writeFileSync(path.join(tmpDir, '.opencob-rules.json'), JSON.stringify(config));

      const result = loadRulesSync(tmpDir);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('UNKNOWN99');
    });

    it('handles JSONC with comments', () => {
      const jsonc = `{
  // This is a comment
  "extends": ["opencob:minimal"],
  "rules": {
    // Override nesting
    "NEST001": { "severity": "critical" }
  }
}`;
      fs.writeFileSync(path.join(tmpDir, '.opencob-rules.json'), jsonc);

      const result = loadRulesSync(tmpDir);
      expect(result.errors).toHaveLength(0);
      const nest = result.rules.find((r) => r.code === 'NEST001')!;
      expect(nest.severity).toBe('critical');
    });

    it('reports parse errors gracefully', () => {
      fs.writeFileSync(path.join(tmpDir, '.opencob-rules.json'), '{ invalid json }}}');
      const result = loadRulesSync(tmpDir);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('Failed to parse');
      // Falls back to defaults
      expect(result.rules).toEqual(DEFAULT_RULES);
    });

    it('searches alternative config paths (.opencob/rules.json)', () => {
      const dir = path.join(tmpDir, '.opencob');
      fs.mkdirSync(dir);
      const config: RuleConfigFile = { extends: ['opencob:strict'] };
      fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(config));

      const result = loadRulesSync(tmpDir);
      // strict enables all rules
      const enabled = result.rules.filter((r) => r.enabled);
      expect(enabled.length).toBe(DEFAULT_RULES.length);
    });

    it('skips ee: presets in sync mode with error', () => {
      const config: RuleConfigFile = { extends: ['opencob:recommended', 'ee:production'] };
      fs.writeFileSync(path.join(tmpDir, '.opencob-rules.json'), JSON.stringify(config));

      const result = loadRulesSync(tmpDir);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('async loadRules()');
    });
  });

  describe('loadRules (async)', () => {
    it('returns defaults when no config', async () => {
      const result = await loadRules(tmpDir);
      expect(result.rules).toEqual(DEFAULT_RULES);
    });

    it('reports missing eeServer URL', async () => {
      const config: RuleConfigFile = { extends: ['ee'] };
      fs.writeFileSync(path.join(tmpDir, '.opencob-rules.json'), JSON.stringify(config));

      // Clear env var if set
      const prev = process.env.OPENCOB_EE_URL;
      delete process.env.OPENCOB_EE_URL;

      const result = await loadRules(tmpDir);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('no eeServer URL');

      if (prev) process.env.OPENCOB_EE_URL = prev;
    });
  });

  describe('getAvailablePresets', () => {
    it('returns built-in preset names', () => {
      const presets = getAvailablePresets();
      expect(presets).toContain('opencob:recommended');
      expect(presets).toContain('opencob:strict');
      expect(presets).toContain('opencob:minimal');
      expect(presets.length).toBe(3);
    });
  });

  describe('convertEeRules', () => {
    it('converts valid EE rules to local format', () => {
      const remote: EeRemoteRule[] = [
        {
          id: 'EE-NEST01',
          name: 'EE Nesting Check',
          severity: 'high',
          category: 'complexity',
          checkerId: 'nesting_depth',
          checkerParams: { max_depth: 3 },
          debtMinutes: 20,
        },
        {
          id: 'EE-SIZE01',
          name: 'EE Block Size',
          severity: 'medium',
          category: 'maintainability',
          checkerId: 'block_size',
          checkerParams: { block_type: 'paragraph', max_lines: 50 },
        },
      ];

      const converted = convertEeRules(remote);
      expect(converted.length).toBe(2);
      expect(converted[0].code).toBe('EE-NEST01');
      expect(converted[0].checkerId).toBe('nesting_depth');
      expect(converted[0].checkerParams.max_depth).toBe(3);
      expect(converted[0].debtMinutes).toBe(20);
      expect(converted[1].debtMinutes).toBe(15); // default
    });

    it('skips rules with unknown checkerIds', () => {
      const remote: EeRemoteRule[] = [
        {
          id: 'X1',
          name: 'Unknown',
          severity: 'low',
          category: 'x',
          checkerId: 'nonexistent_checker',
        },
        { id: 'X2', name: 'No Checker', severity: 'low', category: 'x' },
      ];
      const converted = convertEeRules(remote);
      expect(converted.length).toBe(0);
    });
  });

  describe('presets content', () => {
    it('opencob:strict enables NAME001 and DOC001', () => {
      const config: RuleConfigFile = { extends: ['opencob:strict'] };
      fs.writeFileSync(path.join(tmpDir, '.opencob-rules.json'), JSON.stringify(config));

      const result = loadRulesSync(tmpDir);
      const name = result.rules.find((r) => r.code === 'NAME001')!;
      const doc = result.rules.find((r) => r.code === 'DOC001')!;
      expect(name.enabled).toBe(true);
      expect(doc.enabled).toBe(true);
    });

    it('opencob:strict tightens thresholds', () => {
      const config: RuleConfigFile = { extends: ['opencob:strict'] };
      fs.writeFileSync(path.join(tmpDir, '.opencob-rules.json'), JSON.stringify(config));

      const result = loadRulesSync(tmpDir);
      const nest = result.rules.find((r) => r.code === 'NEST001')!;
      const size = result.rules.find((r) => r.code === 'SIZE001')!;
      expect(nest.checkerParams.max_depth).toBe(3);
      expect(size.checkerParams.max_lines).toBe(40);
    });
  });
});
