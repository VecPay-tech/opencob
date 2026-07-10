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
