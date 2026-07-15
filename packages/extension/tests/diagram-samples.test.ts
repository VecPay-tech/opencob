import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { generateDiagramFromContent } from '@opencob/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(__dirname, '..', 'resources', 'samples');

const EXPECTED_SAMPLES: Array<{ file: string; ext: string; diagramType: string }> = [
  { file: 'PAYTRANS.cbl', ext: 'cbl', diagramType: 'call_graph' },
  { file: 'PAYAUTH.rpgle', ext: 'rpgle', diagramType: 'call_graph' },
  { file: 'SETTLMNT.pli', ext: 'pli', diagramType: 'call_graph' },
  { file: 'RUNPAY.clle', ext: 'clle', diagramType: 'dependency_map' },
  { file: 'TRANSACT.pf', ext: 'pf', diagramType: 'record_layout' },
  { file: 'PAYINQ.dspf', ext: 'dspf', diagramType: 'screen_layout' },
  { file: 'PAYMAP.map', ext: 'map', diagramType: 'screen_layout' },
  { file: 'SETTLJOB.jcl', ext: 'jcl', diagramType: 'dependency_map' },
  { file: 'PAYRPT.rexx', ext: 'rexx', diagramType: 'control_flow' },
  { file: 'PAYBATCH.nsp', ext: 'nsp', diagramType: 'call_graph' },
  { file: 'PAYENC.hlasm', ext: 'hlasm', diagramType: 'control_flow' },
  { file: 'payment-service.ts', ext: 'ts', diagramType: 'class' },
  { file: 'reconcile.py', ext: 'py', diagramType: 'call-graph' },
  { file: 'PaymentProcessor.java', ext: 'java', diagramType: 'class' },
  { file: 'gateway.go', ext: 'go', diagramType: 'call-graph' },
];

describe('diagram sample files', () => {
  for (const { file, ext, diagramType } of EXPECTED_SAMPLES) {
    it(`${file} exists and renders ${diagramType} without error`, () => {
      const filePath = join(samplesDir, file);
      expect(existsSync(filePath), `${file} missing from resources/samples/`).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      expect(content.length, `${file} is empty`).toBeGreaterThan(50);

      const result = generateDiagramFromContent(content, ext, diagramType as any);
      expect(result.success, `${file} diagram failed: ${result.content}`).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    });
  }
});
