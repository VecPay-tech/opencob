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
