# Phase 3b: Legacy Language Parsers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add regex-based parsers for JCL, REXX, NATURAL, and Assembler to `packages/core/src/legacy/`, each exporting a typed AST and a `parse()` function, with inline-fixture tests, barrel registration, and findings scanner rules.

**Architecture:** Four independent parser modules following the pattern of `cobol-parser.ts`: line-by-line regex matching, typed output interfaces, no Tree-sitter dependency for the initial pass. A barrel file registers all seven parsers; existing extension detection and findings scanner are extended with new language entries.

**Tech Stack:** TypeScript (strict, ESM), Vitest globals, Node 22.

## Global Constraints

- Node 22, pnpm >= 10
- TypeScript strict mode — no `any`, all interfaces explicitly typed
- No new npm dependencies — pure regex parsing only
- Each parser must export exactly: `parse(content: string): <ResultType>` and all result types
- Test fixture snippets must be inline strings (no external fixture files)
- Commit after each parser is green

---

### Task 1: JCL Parser

**Files:**

- Create: `packages/core/src/legacy/jcl-parser.ts`
- Create: `packages/core/tests/jcl-parser.test.ts`

**Interfaces:**

- Produces:

  ```typescript
  export interface JclJob {
    jobName: string;
    steps: JclStep[];
    symbols: Map<string, string>;
  }
  export interface JclStep {
    name: string;
    pgm?: string;
    proc?: string;
    dd: JclDd[];
  }
  export interface JclDd {
    name: string;
    dsname?: string;
    disp?: string;
  }
  export function parse(content: string): JclJob;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/jcl-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parse } from '../src/legacy/jcl-parser.js';

const JCL_FIXTURE = `
//MYJOB01  JOB (ACCT),'MY JOB',CLASS=A,MSGCLASS=X
//* Comment line — should be ignored
//STEP01   EXEC PGM=IEFBR14
//DD01     DD DSN=MY.INPUT.DATA,DISP=SHR
//DD02     DD DSN=MY.OUTPUT.DATA,DISP=(NEW,CATLG)
//STEP02   EXEC PROC=MYPROC
//         SET SYSPARM=VALUE1
`.trim();

describe('jcl-parser', () => {
  it('parses job name', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.jobName).toBe('MYJOB01');
  });

  it('parses EXEC PGM steps', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.steps[0].name).toBe('STEP01');
    expect(result.steps[0].pgm).toBe('IEFBR14');
  });

  it('parses EXEC PROC steps', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.steps[1].name).toBe('STEP02');
    expect(result.steps[1].proc).toBe('MYPROC');
  });

  it('parses DD statements within steps', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.steps[0].dd).toHaveLength(2);
    expect(result.steps[0].dd[0].name).toBe('DD01');
    expect(result.steps[0].dd[0].dsname).toBe('MY.INPUT.DATA');
    expect(result.steps[0].dd[0].disp).toBe('SHR');
  });

  it('parses SET symbols', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.symbols.get('SYSPARM')).toBe('VALUE1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @opencob/core test -- tests/jcl-parser.test.ts
```

Expected: `Error: Cannot find module '../src/legacy/jcl-parser.js'`

- [ ] **Step 3: Implement the parser**

Create `packages/core/src/legacy/jcl-parser.ts`:

```typescript
export interface JclJob {
  jobName: string;
  steps: JclStep[];
  symbols: Map<string, string>;
}

export interface JclStep {
  name: string;
  pgm?: string;
  proc?: string;
  dd: JclDd[];
}

export interface JclDd {
  name: string;
  dsname?: string;
  disp?: string;
}

export function parse(content: string): JclJob {
  const lines = content.split('\n');
  const job: JclJob = { jobName: '', steps: [], symbols: new Map() };
  let currentStep: JclStep | null = null;

  for (const line of lines) {
    if (!line.startsWith('//') || line.startsWith('//*')) continue;

    const jobMatch = line.match(/^\/\/(\S+)\s+JOB\s+/);
    if (jobMatch) {
      job.jobName = jobMatch[1];
      continue;
    }

    const setMatch = line.match(/^\/\/\s+SET\s+(\w+)=(.+)/);
    if (setMatch) {
      job.symbols.set(setMatch[1], setMatch[2].trim());
      continue;
    }

    const execMatch = line.match(/^\/\/(\S+)\s+EXEC\s+(?:PGM=(\S+)|(\S+))/);
    if (execMatch) {
      currentStep = { name: execMatch[1], dd: [] };
      if (execMatch[2]) currentStep.pgm = execMatch[2].replace(/,.*$/, '');
      else if (execMatch[3]) currentStep.proc = execMatch[3].replace(/,.*$/, '');
      job.steps.push(currentStep);
      continue;
    }

    const ddMatch = line.match(/^\/\/(\S+)\s+DD\s+(.*)/);
    if (ddMatch && currentStep) {
      const dd: JclDd = { name: ddMatch[1] };
      const dsnMatch = ddMatch[2].match(/DSN=([^,\s]+)/);
      if (dsnMatch) dd.dsname = dsnMatch[1];
      const dispMatch = ddMatch[2].match(/DISP=\(?([^,)\s]+)/);
      if (dispMatch) dd.disp = dispMatch[1];
      currentStep.dd.push(dd);
    }
  }

  return job;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @opencob/core test -- tests/jcl-parser.test.ts
```

Expected: `5 tests passed`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/legacy/jcl-parser.ts packages/core/tests/jcl-parser.test.ts
git commit -m "feat(legacy): add JCL parser"
```

---

### Task 2: REXX Parser

**Files:**

- Create: `packages/core/src/legacy/rexx-parser.ts`
- Create: `packages/core/tests/rexx-parser.test.ts`

**Interfaces:**

- Produces:

  ```typescript
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
  export function parse(content: string): RexxProgram;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/rexx-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parse } from '../src/legacy/rexx-parser.js';

const REXX_FIXTURE = `
/* REXX exec: main routine */
CALL INITIALIZE
CALL EXTERNAL_ROUTINE
SIGNAL DONE

INITIALIZE:
  SAY 'Starting up'
RETURN

DONE:
  EXIT 0
`.trim();

const REXX_DYNAMIC = `
/* REXX with INTERPRET */
INTERPRET 'SAY hello'
`.trim();

describe('rexx-parser', () => {
  it('detects procedure labels', () => {
    const result = parse(REXX_FIXTURE);
    expect(result.labels).toContain('INITIALIZE');
    expect(result.labels).toContain('DONE');
  });

  it('classifies internal calls', () => {
    const result = parse(REXX_FIXTURE);
    const initCall = result.calls.find((c) => c.target === 'INITIALIZE');
    expect(initCall?.type).toBe('internal');
  });

  it('classifies external calls', () => {
    const result = parse(REXX_FIXTURE);
    const extCall = result.calls.find((c) => c.target === 'EXTERNAL_ROUTINE');
    expect(extCall?.type).toBe('external');
  });

  it('parses SIGNAL targets', () => {
    const result = parse(REXX_FIXTURE);
    expect(result.signals).toContain('DONE');
  });

  it('detects dynamic execution', () => {
    expect(parse(REXX_FIXTURE).hasDynamicExec).toBe(false);
    expect(parse(REXX_DYNAMIC).hasDynamicExec).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @opencob/core test -- tests/rexx-parser.test.ts
```

Expected: `Error: Cannot find module '../src/legacy/rexx-parser.js'`

- [ ] **Step 3: Implement the parser**

Create `packages/core/src/legacy/rexx-parser.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @opencob/core test -- tests/rexx-parser.test.ts
```

Expected: `5 tests passed`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/legacy/rexx-parser.ts packages/core/tests/rexx-parser.test.ts
git commit -m "feat(legacy): add REXX parser"
```

---

### Task 3: NATURAL Parser

**Files:**

- Create: `packages/core/src/legacy/natural-parser.ts`
- Create: `packages/core/tests/natural-parser.test.ts`

**Interfaces:**

- Produces:

  ```typescript
  export type NaturalModuleType =
    | 'PROGRAM'
    | 'SUBPROGRAM'
    | 'FUNCTION'
    | 'SUBROUTINE'
    | 'COPYCODE'
    | 'UNKNOWN';
  export interface NaturalProgram {
    type: NaturalModuleType;
    name: string;
    dataArea: NaturalVariable[];
    externalCalls: string[];
    dbAccess: NaturalDbAccess[];
  }
  export interface NaturalVariable {
    level: number;
    name: string;
    type: string;
    scope: 'LOCAL' | 'GLOBAL' | 'PARAMETER';
  }
  export interface NaturalDbAccess {
    statement: 'READ' | 'FIND' | 'HISTOGRAM';
    ddm: string;
  }
  export function parse(content: string): NaturalProgram;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/natural-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parse } from '../src/legacy/natural-parser.js';

const NAT_FIXTURE = `
* Main program
PROGRAM CUSTMAINT
DEFINE DATA
LOCAL
1 #CUSTNO (A8)
1 #NAME   (A30)
PARAMETER
1 #ACTION (A1)
END-DEFINE
CALLNAT 'CUSTVAL'
FETCH 'CUSTMENU'
READ CUSTOMERS WITH CUSTNO = #CUSTNO
FIND ORDERS WITH ORDERNO = '12345'
END
`.trim();

describe('natural-parser', () => {
  it('parses module type and name', () => {
    const result = parse(NAT_FIXTURE);
    expect(result.type).toBe('PROGRAM');
    expect(result.name).toBe('CUSTMAINT');
  });

  it('parses LOCAL variables', () => {
    const result = parse(NAT_FIXTURE);
    const local = result.dataArea.filter((v) => v.scope === 'LOCAL');
    expect(local).toHaveLength(2);
    expect(local[0]).toMatchObject({ level: 1, name: '#CUSTNO', type: 'A8', scope: 'LOCAL' });
  });

  it('parses PARAMETER variables', () => {
    const result = parse(NAT_FIXTURE);
    const params = result.dataArea.filter((v) => v.scope === 'PARAMETER');
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('#ACTION');
  });

  it('parses external calls', () => {
    const result = parse(NAT_FIXTURE);
    expect(result.externalCalls).toContain('CUSTVAL');
    expect(result.externalCalls).toContain('CUSTMENU');
  });

  it('parses database access statements', () => {
    const result = parse(NAT_FIXTURE);
    expect(result.dbAccess).toHaveLength(2);
    expect(result.dbAccess[0]).toMatchObject({ statement: 'READ', ddm: 'CUSTOMERS' });
    expect(result.dbAccess[1]).toMatchObject({ statement: 'FIND', ddm: 'ORDERS' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @opencob/core test -- tests/natural-parser.test.ts
```

Expected: `Error: Cannot find module '../src/legacy/natural-parser.js'`

- [ ] **Step 3: Implement the parser**

Create `packages/core/src/legacy/natural-parser.ts`:

```typescript
export type NaturalModuleType =
  | 'PROGRAM'
  | 'SUBPROGRAM'
  | 'FUNCTION'
  | 'SUBROUTINE'
  | 'COPYCODE'
  | 'UNKNOWN';

export interface NaturalProgram {
  type: NaturalModuleType;
  name: string;
  dataArea: NaturalVariable[];
  externalCalls: string[];
  dbAccess: NaturalDbAccess[];
}

export interface NaturalVariable {
  level: number;
  name: string;
  type: string;
  scope: 'LOCAL' | 'GLOBAL' | 'PARAMETER';
}

export interface NaturalDbAccess {
  statement: 'READ' | 'FIND' | 'HISTOGRAM';
  ddm: string;
}

export function parse(content: string): NaturalProgram {
  const lines = content.split('\n');
  const program: NaturalProgram = {
    type: 'UNKNOWN',
    name: '',
    dataArea: [],
    externalCalls: [],
    dbAccess: [],
  };

  let inDefineData = false;
  let currentScope: NaturalVariable['scope'] = 'LOCAL';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed === '') continue;
    const upper = trimmed.toUpperCase();

    const headerMatch = upper.match(/^(PROGRAM|SUBPROGRAM|FUNCTION|SUBROUTINE|COPYCODE)\s+(\S+)/);
    if (headerMatch) {
      program.type = headerMatch[1] as NaturalModuleType;
      program.name = headerMatch[2];
      continue;
    }

    if (upper === 'DEFINE DATA') {
      inDefineData = true;
      continue;
    }
    if (upper === 'END-DEFINE') {
      inDefineData = false;
      continue;
    }

    if (inDefineData) {
      if (upper === 'LOCAL') {
        currentScope = 'LOCAL';
        continue;
      }
      if (upper === 'GLOBAL') {
        currentScope = 'GLOBAL';
        continue;
      }
      if (upper === 'PARAMETER') {
        currentScope = 'PARAMETER';
        continue;
      }

      const varMatch = trimmed.match(/^(\d+)\s+([#\w]+)\s+\(([^)]+)\)/);
      if (varMatch) {
        program.dataArea.push({
          level: parseInt(varMatch[1], 10),
          name: varMatch[2].toUpperCase(),
          type: varMatch[3],
          scope: currentScope,
        });
      }
      continue;
    }

    const callMatch = upper.match(/^(?:CALLNAT|FETCH|INCLUDE)\s+'?([^'\s]+)'?/);
    if (callMatch) {
      program.externalCalls.push(callMatch[1]);
      continue;
    }

    const dbMatch = upper.match(/^(READ|FIND|HISTOGRAM)\s+(\S+)/);
    if (dbMatch) {
      program.dbAccess.push({
        statement: dbMatch[1] as NaturalDbAccess['statement'],
        ddm: dbMatch[2],
      });
    }
  }

  return program;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @opencob/core test -- tests/natural-parser.test.ts
```

Expected: `5 tests passed`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/legacy/natural-parser.ts packages/core/tests/natural-parser.test.ts
git commit -m "feat(legacy): add NATURAL parser"
```

---

### Task 4: Assembler Parser

**Files:**

- Create: `packages/core/src/legacy/assembler-parser.ts`
- Create: `packages/core/tests/assembler-parser.test.ts`

**Interfaces:**

- Produces:

  ```typescript
  export interface AssemblerProgram {
    sections: AsmSection[];
    macros: string[];
    copies: string[];
    entryPoint?: string;
  }
  export interface AsmSection {
    name: string;
    type: 'CSECT' | 'DSECT' | 'RSECT';
  }
  export function parse(content: string): AssemblerProgram;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/assembler-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parse } from '../src/legacy/assembler-parser.js';

const ASM_FIXTURE = `
MYPGM    CSECT
         USING *,15
         COPY  COMMON
         BR    14
*
MYDATA   DSECT
LEN      DS    F
NAME     DS    CL8
*
         MACRO
MYMACRO  &PARM
         MEND
*
         END   MYPGM
`.trim();

describe('assembler-parser', () => {
  it('parses CSECT sections', () => {
    const result = parse(ASM_FIXTURE);
    const csect = result.sections.find((s) => s.type === 'CSECT');
    expect(csect?.name).toBe('MYPGM');
  });

  it('parses DSECT sections', () => {
    const result = parse(ASM_FIXTURE);
    const dsect = result.sections.find((s) => s.type === 'DSECT');
    expect(dsect?.name).toBe('MYDATA');
  });

  it('parses COPY members', () => {
    const result = parse(ASM_FIXTURE);
    expect(result.copies).toContain('COMMON');
  });

  it('parses MACRO names from prototype line', () => {
    const result = parse(ASM_FIXTURE);
    expect(result.macros).toContain('MYMACRO');
  });

  it('parses entry point from END statement', () => {
    const result = parse(ASM_FIXTURE);
    expect(result.entryPoint).toBe('MYPGM');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @opencob/core test -- tests/assembler-parser.test.ts
```

Expected: `Error: Cannot find module '../src/legacy/assembler-parser.js'`

- [ ] **Step 3: Implement the parser**

Create `packages/core/src/legacy/assembler-parser.ts`:

```typescript
export interface AssemblerProgram {
  sections: AsmSection[];
  macros: string[];
  copies: string[];
  entryPoint?: string;
}

export interface AsmSection {
  name: string;
  type: 'CSECT' | 'DSECT' | 'RSECT';
}

export function parse(content: string): AssemblerProgram {
  const lines = content.split('\n');
  const program: AssemblerProgram = { sections: [], macros: [], copies: [] };

  let inMacro = false;
  let sawMacroDirective = false;

  for (const line of lines) {
    if (line.startsWith('*') || line.trim() === '') continue;

    // HLASM columns: label in 1-8, opcode follows whitespace
    const parts = line.match(/^(\S*)\s+(\S+)\s*(.*)/);
    if (!parts) continue;

    const [, label, opcode, operands] = parts;
    const op = opcode.toUpperCase();

    if (op === 'MACRO') {
      inMacro = true;
      sawMacroDirective = true;
      continue;
    }

    if (inMacro) {
      // The first labelled line after MACRO is the prototype; label is macro name
      if (sawMacroDirective && label) {
        program.macros.push(label.toUpperCase());
        sawMacroDirective = false;
      }
      if (op === 'MEND') inMacro = false;
      continue;
    }

    if (op === 'CSECT' || op === 'DSECT' || op === 'RSECT') {
      program.sections.push({ name: label, type: op });
      continue;
    }

    if (op === 'COPY') {
      const member = operands.trim().split(/[\s,]/)[0];
      if (member) program.copies.push(member);
      continue;
    }

    if (op === 'END') {
      const ep = operands.trim().split(/[\s,]/)[0];
      if (ep) program.entryPoint = ep;
    }
  }

  return program;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @opencob/core test -- tests/assembler-parser.test.ts
```

Expected: `5 tests passed`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/legacy/assembler-parser.ts packages/core/tests/assembler-parser.test.ts
git commit -m "feat(legacy): add Assembler (HLASM) parser"
```

---

### Task 5: Barrel, Extension Detection, and Findings Rules

**Files:**

- Create: `packages/core/src/legacy/index.ts`
- Modify: `packages/core/src/tools/diagram-types.ts`
- Modify: `packages/core/src/findings/findings-scanner.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: all four parsers from Tasks 1–4; existing COBOL/RPG/PL/I parsers already in `src/legacy/`
- Produces: `packages/core/src/legacy/index.ts` barrel; new extension sets in `diagram-types.ts`; new findings rules in `findings-scanner.ts`

- [ ] **Step 1: Discover existing legacy parsers and barrel state**

```bash
ls packages/core/src/legacy/
```

Note which parser files already exist (cobol, rpg, pli, bms, dds). The barrel must re-export all of them.

- [ ] **Step 2: Create the legacy barrel file**

Create `packages/core/src/legacy/index.ts` with exports for all parsers present. At minimum include the four new ones; add the existing ones as they appear in the `ls` output from Step 1:

```typescript
export * from './jcl-parser.js';
export * from './rexx-parser.js';
export * from './natural-parser.js';
export * from './assembler-parser.js';
// Add existing parsers found in Step 1, e.g.:
// export * from './cobol-parser.js'
// export * from './rpg-parser.js'
// export * from './pli-parser.js'
```

- [ ] **Step 3: Read diagram-types.ts to find where to add extension sets**

```bash
cat packages/core/src/tools/diagram-types.ts
```

Find the existing extension-set constants (e.g., `COBOL_EXTS`, `RPG_EXTS`). Add the four new sets in the same style after the last existing set:

```typescript
export const JCL_EXTS = new Set(['.jcl', '.job', '.proc']);
export const REXX_EXTS = new Set(['.rexx', '.rex', '.exec']);
export const NATURAL_EXTS = new Set(['.nsp', '.nsa', '.nsg', '.nsl', '.nsh', '.nat']);
export const ASM_EXTS = new Set(['.asm', '.hlasm', '.s', '.mac']);
```

- [ ] **Step 4: Read findings-scanner.ts to find where to add rules**

```bash
cat packages/core/src/findings/findings-scanner.ts | head -80
```

Locate the rules array or object (look for existing COBOL or RPG rule entries). Add the new language rules in the same pattern:

```typescript
// JCL rules
{ id: 'JCL001', severity: 'warning' as const, language: 'jcl',
  pattern: /DISP=\(NEW,DELETE\)/i,
  message: 'DD statement deletes dataset on normal termination — verify intent' },
{ id: 'JCL002', severity: 'info' as const, language: 'jcl',
  pattern: /EXEC\s+PGM=IEFBR14/i,
  message: 'IEFBR14 step — typically used for DD allocation/deletion only' },

// REXX rules
{ id: 'REXX001', severity: 'warning' as const, language: 'rexx',
  pattern: /\bINTERPRET\b/i,
  message: 'INTERPRET executes dynamic code — review for injection risk' },
{ id: 'REXX002', severity: 'info' as const, language: 'rexx',
  pattern: /\bPARSE\s+EXTERNAL\b/i,
  message: 'PARSE EXTERNAL reads from stdin — ensure caller provides input' },

// NATURAL rules
{ id: 'NAT001', severity: 'warning' as const, language: 'natural',
  pattern: /\bDYNAMIC\b/i,
  message: 'DYNAMIC attribute — runtime-sized variable, watch memory allocation' },
{ id: 'NAT002', severity: 'info' as const, language: 'natural',
  pattern: /\bHISTOGRAM\b/i,
  message: 'HISTOGRAM performs an index scan — verify the DDM index exists' },

// Assembler rules
{ id: 'ASM001', severity: 'warning' as const, language: 'assembler',
  pattern: /\bMVC\s+\d+\([^,]+\),\s*\d+\(/i,
  message: 'MVC with explicit lengths — verify source and target lengths match' },
{ id: 'ASM002', severity: 'info' as const, language: 'assembler',
  pattern: /\bBALR\s+14,0\b/i,
  message: 'BALR 14,0 loads current PSW without branching — typically for base-register setup' },
```

Note: adjust `severity` cast and rule shape to match the existing rule entries exactly (e.g., if they use string literals without `as const`, drop the cast).

- [ ] **Step 5: Export the legacy barrel from the core index**

Open `packages/core/src/index.ts`. Find where other sub-packages are exported. Add:

```typescript
export * from './legacy/index.js';
```

If a `legacy` export already exists, replace it with this barrel re-export rather than listing parsers individually.

- [ ] **Step 6: Run typecheck**

```bash
pnpm --filter @opencob/core typecheck
```

Fix any type errors before proceeding. Common issues:

- `severity` type mismatch in findings rules — adjust the `as const` cast to match the existing type
- Duplicate exports if a legacy barrel already existed — remove the old export from `src/index.ts`

- [ ] **Step 7: Run full test suite**

```bash
pnpm --filter @opencob/core test
```

Expected: All existing tests pass plus all four new parser test files pass. No regressions.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/legacy/index.ts \
        packages/core/src/tools/diagram-types.ts \
        packages/core/src/findings/findings-scanner.ts \
        packages/core/src/index.ts
git commit -m "feat(legacy): register JCL/REXX/NATURAL/ASM parsers and add findings rules"
```

---

## Self-Review Checklist

- [x] All four parsers export `parse(content: string)` with typed return — spec requirement met
- [x] Test fixtures are inline strings — no external fixture files
- [x] Each parser committed independently before Task 5 — frequent commits maintained
- [x] `legacy/index.ts` barrel re-exports all new parsers
- [x] Four new extension sets defined (`JCL_EXTS`, `REXX_EXTS`, `NATURAL_EXTS`, `ASM_EXTS`)
- [x] At least two findings rules per language — spec requirement met
- [x] No new npm dependencies introduced
- [x] TypeScript strict — no `any` in any parser implementation
- [x] Task 5 Step 1 reads existing files before modifying — avoids clobbering existing exports
