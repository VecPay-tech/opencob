/**
 * Control Flow Parser — Recursive descent flow-graph builder.
 *
 * Ported from DriverX parsers/flow_parser.py
 *
 * Generates flowchart-style control flow graphs from:
 * 1. COBOL PROCEDURE DIVISION (IF/ELSE/EVALUATE/PERFORM/GO TO)
 * 2. CL programs (IF COND/DO/ENDDO/GOTO/CALL PGM)
 *
 * Output: { nodes: [...], edges: [...] }
 * Node types: terminal, process, decision, call, loop, goto, merge, io
 * Edge types: seq, true, false, when, goto, loop_back
 */

import type { DiagramNode, DiagramEdge } from './diagram-types.js';

export interface FlowGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

// ── COBOL verbs that mark the START of a new statement ──────

const VERBS = new Set([
  'IF',
  'ELSE',
  'END-IF',
  'EVALUATE',
  'WHEN',
  'END-EVALUATE',
  'PERFORM',
  'END-PERFORM',
  'GO',
  'CALL',
  'EXEC',
  'MOVE',
  'COMPUTE',
  'ADD',
  'SUBTRACT',
  'MULTIPLY',
  'DIVIDE',
  'READ',
  'WRITE',
  'REWRITE',
  'DELETE',
  'START',
  'OPEN',
  'CLOSE',
  'STOP',
  'GOBACK',
  'EXIT',
  'DISPLAY',
  'ACCEPT',
  'STRING',
  'UNSTRING',
  'INSPECT',
  'INITIALIZE',
  'SET',
  'SEARCH',
  'SORT',
  'MERGE',
  'RELEASE',
  'RETURN',
  'CONTINUE',
  'NEXT',
  'END-READ',
  'END-WRITE',
  'END-CALL',
  'END-STRING',
  'END-UNSTRING',
  'END-COMPUTE',
  'END-SEARCH',
  'END-START',
  'END-RETURN',
  'END-ACCEPT',
  'END-ADD',
  'END-SUBTRACT',
  'END-MULTIPLY',
  'END-DIVIDE',
  'END-DELETE',
  'END-REWRITE',
  'END-EXEC',
]);

function firstWord(line: string): string {
  const cleaned = stripStringLiterals(line);
  const m = cleaned.trim().match(/^([A-Z][\w-]*)/i);
  return m ? m[1].toUpperCase() : '';
}

function isVerb(word: string): boolean {
  return VERBS.has(word) || word.startsWith('END-');
}

/**
 * Strip string literals from a line to prevent false keyword matches.
 * Replaces content inside quotes with spaces (preserves positions).
 * Handles both single ('...') and double ("...") quoted strings.
 */
function stripStringLiterals(line: string): string {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      result += ' ';
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      result += ' ';
    } else if (inSingle || inDouble) {
      result += ' ';
    } else {
      result += ch;
    }
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
//  COBOL Control Flow Builder (recursive descent)
// ══════════════════════════════════════════════════════════════

/**
 * Parse stripped COBOL source lines into a control flow graph.
 */
export function parseControlFlow(
  codeLines: string[],
  baseLine: number = 1,
  paragraphName: string = '',
): FlowGraph {
  const builder = new CobolFlowBuilder(paragraphName);
  return builder.build(codeLines, baseLine);
}

class CobolFlowBuilder {
  private nodes: DiagramNode[] = [];
  private edges: DiagramEdge[] = [];
  private idCounter = 0;
  private paraName: string;

  constructor(paragraphName: string = '') {
    this.paraName = paragraphName;
  }

  private nid(): string {
    this.idCounter++;
    return `cf${this.idCounter}`;
  }

  private node(label: string, ntype: string, line: number = 0): string {
    const id = this.nid();
    this.nodes.push({ id, label, type: ntype, startLine: line });
    return id;
  }

  private edge(src: string, tgt: string, label: string = '', etype: string = 'seq'): void {
    this.edges.push({ source: src, target: tgt, label, edgeType: etype });
  }

  private flush(prev: string, buf: string[], line: number): string {
    if (buf.length === 0) return prev;
    const label = this.summarize(buf);
    const nid = this.node(label, 'process', line);
    this.edge(prev, nid);
    buf.length = 0;
    return nid;
  }

  private summarize(stmts: string[]): string {
    if (stmts.length === 0) return '';
    const first = stmts[0].trim().slice(0, 55);
    if (stmts.length === 1) return first;
    return `${first}\n  +${stmts.length - 1} more`;
  }

  // ── Boundary finders ────────────────────────────────────────

  private findIfBounds(lines: string[], start: number, end: number): [number | null, number] {
    let depth = 1;
    let elseI: number | null = null;
    for (let i = start; i < end; i++) {
      const fw = firstWord(lines[i]);
      if (fw === 'IF') depth++;
      else if (fw === 'ELSE' && depth === 1) elseI = i;
      else if (fw === 'END-IF') {
        depth--;
        if (depth === 0) return [elseI, i];
      }
    }
    return [elseI, end];
  }

  private findEvalBounds(lines: string[], start: number, end: number): [number[], number] {
    let depth = 1;
    const whens: number[] = [];
    for (let i = start; i < end; i++) {
      const fw = firstWord(lines[i]);
      if (fw === 'EVALUATE') depth++;
      else if (fw === 'WHEN' && depth === 1) whens.push(i);
      else if (fw === 'END-EVALUATE') {
        depth--;
        if (depth === 0) return [whens, i];
      }
    }
    return [whens, end];
  }

  private findEndPerform(lines: string[], start: number, end: number): number {
    let depth = 1;
    for (let i = start; i < end; i++) {
      const fw = firstWord(lines[i]);
      if (fw === 'PERFORM') depth++;
      else if (fw === 'END-PERFORM') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return end;
  }

  // ── Main entry ─────────────────────────────────────────────

  build(lines: string[], base: number): FlowGraph {
    const startLabel = this.paraName || 'START';
    const start = this.node(startLabel, 'terminal', base);
    const tail = this.parseBlock(lines, 0, lines.length, base, start);
    const endId = this.node('END', 'terminal', base + Math.max(0, lines.length - 1));
    if (tail) this.edge(tail, endId);
    return { nodes: this.nodes, edges: this.edges };
  }

  // ── Recursive block parser ─────────────────────────────────

  private parseBlock(lines: string[], lo: number, hi: number, base: number, prev: string): string {
    const buf: string[] = [];
    let bufLine = 0;
    let i = lo;

    while (i < hi) {
      const raw = lines[i].trim();
      if (!raw) {
        i++;
        continue;
      }

      const up = raw.toUpperCase();
      const fw = firstWord(raw);
      const lno = base + i;

      // ── IF ─────────────────────────────────────────────
      if (fw === 'IF') {
        prev = this.flush(prev, buf, bufLine);
        let condText = raw
          .slice(up.indexOf('IF') + 2)
          .trim()
          .replace(/\.$/, '');
        let j = i + 1;
        while (j < hi) {
          const nw = firstWord(lines[j]);
          if (isVerb(nw)) break;
          const part = lines[j].trim();
          if (part) condText += ' ' + part.replace(/\.$/, '');
          j++;
        }

        const [elseI, endifI] = this.findIfBounds(lines, j, hi);
        const dec = this.node(condText.slice(0, 80), 'decision', lno);
        this.edge(prev, dec);
        const merge = this.node('', 'merge', base + (endifI < hi ? endifI : i));

        // TRUE branch
        const trueEnd = elseI !== null ? elseI : endifI;
        const eb = this.edges.length;
        if (j < trueEnd) {
          const trueTail = this.parseBlock(lines, j, trueEnd, base, dec);
          this.edge(trueTail, merge);
          if (eb < this.edges.length) {
            this.edges[eb].label = 'Y';
            this.edges[eb].edgeType = 'true';
          }
        } else {
          this.edge(dec, merge, 'Y', 'true');
        }

        // FALSE branch
        if (elseI !== null) {
          const falseStart = elseI + 1;
          const eb2 = this.edges.length;
          if (falseStart < endifI) {
            const falseTail = this.parseBlock(lines, falseStart, endifI, base, dec);
            this.edge(falseTail, merge);
            if (eb2 < this.edges.length) {
              this.edges[eb2].label = 'N';
              this.edges[eb2].edgeType = 'false';
            }
          } else {
            this.edge(dec, merge, 'N', 'false');
          }
        } else {
          this.edge(dec, merge, 'N', 'false');
        }

        prev = merge;
        i = endifI < hi ? endifI + 1 : hi;
        continue;
      }

      // ── EVALUATE ───────────────────────────────────────
      if (fw === 'EVALUATE') {
        prev = this.flush(prev, buf, bufLine);
        const subject = raw
          .slice(up.indexOf('EVALUATE') + 8)
          .trim()
          .replace(/\.$/, '');
        const [whens, endEvalI] = this.findEvalBounds(lines, i + 1, hi);

        const dec = this.node(`EVALUATE\n${subject.slice(0, 60)}`, 'decision', lno);
        this.edge(prev, dec);
        const merge = this.node('', 'merge', base + (endEvalI < hi ? endEvalI : i));

        for (let wi = 0; wi < whens.length; wi++) {
          const whenIdx = whens[wi];
          const whenLine = lines[whenIdx].trim();
          const whenUp = whenLine.toUpperCase();
          const whenValIdx = whenUp.indexOf('WHEN') + 4;
          const whenVal = whenLine.slice(whenValIdx).trim().replace(/\.$/, '');
          const whenEnd = wi + 1 < whens.length ? whens[wi + 1] : endEvalI;
          const whenStart = whenIdx + 1;

          const eb = this.edges.length;
          if (whenStart < whenEnd) {
            const whenTail = this.parseBlock(lines, whenStart, whenEnd, base, dec);
            this.edge(whenTail, merge);
            if (eb < this.edges.length) {
              this.edges[eb].label = whenVal.slice(0, 30);
              this.edges[eb].edgeType = 'when';
            }
          } else {
            this.edge(dec, merge, whenVal.slice(0, 30), 'when');
          }
        }

        prev = merge;
        i = endEvalI < hi ? endEvalI + 1 : hi;
        continue;
      }

      // ── PERFORM (external paragraph call or inline loop) ──
      if (fw === 'PERFORM') {
        prev = this.flush(prev, buf, bufLine);
        const m = up.match(/^PERFORM\s+([A-Z0-9][\w-]+)/);
        if (m) {
          const target = m[1];
          let nid: string;
          if (up.includes('UNTIL')) {
            const um = up.match(/UNTIL\s+(.+?)(?:\s*$|\.)/);
            const cond = um ? um[1].trim().slice(0, 40) : '...';
            nid = this.node(`PERFORM ${target}\nUNTIL ${cond}`, 'loop', lno);
          } else if (up.includes('VARYING')) {
            nid = this.node(`PERFORM ${target}\n(VARYING)`, 'loop', lno);
          } else {
            nid = this.node(`PERFORM\n${target}`, 'call', lno);
          }
          this.edge(prev, nid);
          prev = nid;
        } else {
          // Inline PERFORM … END-PERFORM (loop body)
          if (up.includes('UNTIL')) {
            const um = up.match(/UNTIL\s+(.+?)(?:\s*$|\.)/);
            const cond = um ? um[1].trim().slice(0, 40) : '...';
            const epI = this.findEndPerform(lines, i + 1, hi);

            const loopId = this.node(`LOOP UNTIL\n${cond}`, 'loop', lno);
            this.edge(prev, loopId);
            const merge = this.node('', 'merge', base + (epI < hi ? epI : i));

            if (i + 1 < epI) {
              const bodyTail = this.parseBlock(lines, i + 1, epI, base, loopId);
              this.edge(bodyTail, loopId, '', 'loop_back');
            }
            this.edge(loopId, merge, 'done', 'false');
            prev = merge;
            i = epI < hi ? epI + 1 : hi;
            continue;
          } else {
            const nid = this.node('PERFORM (inline)', 'call', lno);
            this.edge(prev, nid);
            prev = nid;
          }
        }
        i++;
        continue;
      }

      // ── GO TO ──────────────────────────────────────────
      if (fw === 'GO') {
        prev = this.flush(prev, buf, bufLine);
        const m = up.match(/GO\s+TO\s+([A-Z0-9][\w-]+)/);
        const target = m ? m[1] : '???';
        const nid = this.node(`GO TO\n${target}`, 'goto', lno);
        this.edge(prev, nid, '', 'goto');
        prev = nid;
        i++;
        continue;
      }

      // ── CALL ───────────────────────────────────────────
      if (fw === 'CALL') {
        prev = this.flush(prev, buf, bufLine);
        const m = up.match(/CALL\s+['"]?(\S+?)['"]?\s/);
        const target = m ? m[1].replace(/['"]/g, '') : '...';
        const nid = this.node(`CALL\n${target}`, 'call', lno);
        this.edge(prev, nid);
        prev = nid;
        i++;
        continue;
      }

      // ── READ / WRITE (I/O) ─────────────────────────────
      if (fw === 'READ' || fw === 'WRITE' || fw === 'REWRITE') {
        prev = this.flush(prev, buf, bufLine);
        const nid = this.node(raw.trim().slice(0, 60), 'io', lno);
        this.edge(prev, nid);
        prev = nid;
        i++;
        continue;
      }

      // ── STOP RUN / GOBACK / EXIT ───────────────────────
      if (fw === 'STOP' || fw === 'GOBACK') {
        prev = this.flush(prev, buf, bufLine);
        const nid = this.node(fw, 'terminal', lno);
        this.edge(prev, nid);
        prev = nid;
        i++;
        continue;
      }

      // ── Structural keywords handled by parent scope ────
      if (
        fw === 'ELSE' ||
        fw === 'END-IF' ||
        fw === 'WHEN' ||
        fw === 'END-EVALUATE' ||
        fw === 'END-PERFORM'
      ) {
        i++;
        continue;
      }

      // ── Regular statement → accumulate ─────────────────
      if (buf.length === 0) bufLine = lno;
      buf.push(raw);
      i++;
    }

    prev = this.flush(prev, buf, bufLine);
    return prev;
  }
}

// ══════════════════════════════════════════════════════════════
//  CL (AS/400) Control Flow Builder
// ══════════════════════════════════════════════════════════════

const RE_CL_COMMENT = /^\s*\/\*/;
const RE_CL_PGM = /^\s*PGM\b/i;
const RE_CL_ENDPGM = /^\s*ENDPGM\b/i;
const RE_CL_IF = /IF\s+COND\((.+?)\)/i;
const RE_CL_THEN_DO = /THEN\(\s*DO\s*\)/i;
const RE_CL_THEN_CMD = /THEN\((.+)\)\s*$/i;
const RE_CL_ELSE = /^\s*ELSE\b/i;
const RE_CL_ENDDO = /^\s*ENDDO\b/i;
const RE_CL_DO_LOOP = /^\s*(?:DOWHILE|DOUNTIL|DOFOR)\b/i;
const RE_CL_GOTO = /GOTO\s+(?:CMDLBL\(\s*)?(\w+)/i;
const RE_CL_CALL = /CALL\s+PGM\(\s*(?:[\w*/]+\/)?\s*(\w+)/i;
const RE_CL_CALLPRC = /CALLPRC\s+PRC\(\s*(\w+)/i;
const RE_CL_SBMJOB = /SBMJOB\s+.*CMD\(\s*CALL\s+PGM\(\s*(?:[\w*/]+\/)?\s*(\w+)/i;
const RE_CL_MONMSG = /^\s*MONMSG\b/i;
const RE_CL_MONEXEC = /EXEC\((.+)\)/i;
const RE_CL_LABEL = /^(\s*)(\w+):\s*(.*)/;
const RE_CL_SUBR = /^\s*SUBR\s+SUBR\(\s*(\w+)\s*\)/i;
const RE_CL_ENDSUBR = /^\s*ENDSUBR\b/i;
const RE_CL_RETURN = /^\s*RETURN\b/i;

/**
 * Parse AS/400 CL program source lines into a control flow graph.
 */
export function parseClControlFlow(
  codeLines: string[],
  baseLine: number = 1,
  sectionName: string = '',
): FlowGraph {
  const builder = new ClFlowBuilder(sectionName);
  return builder.build(codeLines, baseLine);
}

class ClFlowBuilder {
  private nodes: DiagramNode[] = [];
  private edges: DiagramEdge[] = [];
  private idCounter = 0;
  private name: string;

  constructor(name: string = '') {
    this.name = name;
  }

  private nid(): string {
    this.idCounter++;
    return `cl${this.idCounter}`;
  }

  private node(label: string, ntype: string, line: number = 0): string {
    const id = this.nid();
    this.nodes.push({ id, label, type: ntype, startLine: line });
    return id;
  }

  private edge(src: string, tgt: string, label: string = '', etype: string = 'seq'): void {
    this.edges.push({ source: src, target: tgt, label, edgeType: etype });
  }

  private flush(prev: string, buf: string[], line: number): string {
    if (buf.length === 0) return prev;
    const first = buf[0].trim().slice(0, 55);
    const label = buf.length === 1 ? first : `${first}\n  +${buf.length - 1} more`;
    const nid = this.node(label, 'process', line);
    this.edge(prev, nid);
    buf.length = 0;
    return nid;
  }

  // ── Boundary finders ────────────────────────────────────────

  private findIfEnddo(lines: string[], start: number, end: number): [number | null, number] {
    let depth = 1;
    let elseI: number | null = null;
    for (let i = start; i < end; i++) {
      const text = lines[i].trim();
      const up = text.toUpperCase();
      if (!text || RE_CL_COMMENT.test(text)) continue;
      if (RE_CL_THEN_DO.test(up) || RE_CL_DO_LOOP.test(up)) {
        depth++;
      } else if (RE_CL_ELSE.test(text) && depth === 1) {
        elseI = i;
        if (up.includes('CMD(DO)') || up.includes('THEN(DO)') || up.trim() === 'ELSE DO') {
          depth++;
        }
      } else if (RE_CL_ELSE.test(text)) {
        if (up.includes('CMD(DO)') || up.includes('THEN(DO)')) depth++;
      } else if (RE_CL_ENDDO.test(text)) {
        depth--;
        if (depth === 0) return [elseI, i];
      }
    }
    return [elseI, end];
  }

  private findEnddo(lines: string[], start: number, end: number): number {
    let depth = 1;
    for (let i = start; i < end; i++) {
      const text = lines[i].trim().toUpperCase();
      if (!text || text.startsWith('/*')) continue;
      if (RE_CL_THEN_DO.test(text) || RE_CL_DO_LOOP.test(text)) depth++;
      else if (text.startsWith('ENDDO')) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return end;
  }

  // ── Main entry ─────────────────────────────────────────────

  build(lines: string[], base: number): FlowGraph {
    const startLabel = this.name || 'START';
    const start = this.node(startLabel, 'terminal', base);
    const tail = this.parseBlock(lines, 0, lines.length, base, start);
    const endId = this.node('END', 'terminal', base + Math.max(0, lines.length - 1));
    if (tail) this.edge(tail, endId);
    return { nodes: this.nodes, edges: this.edges };
  }

  // ── Recursive block parser ─────────────────────────────────

  private parseBlock(lines: string[], lo: number, hi: number, base: number, prev: string): string {
    const buf: string[] = [];
    let bufLine = 0;
    let i = lo;

    while (i < hi) {
      let raw = lines[i].trim();
      if (!raw || RE_CL_COMMENT.test(raw)) {
        i++;
        continue;
      }

      const lno = base + i;

      // ── Label (NAME: ...) ──────────────────────────────
      const labelMatch = RE_CL_LABEL.exec(lines[i]);
      if (labelMatch) {
        prev = this.flush(prev, buf, bufLine);
        const labelName = labelMatch[2];
        const nid = this.node(`${labelName}:`, 'merge', lno);
        this.edge(prev, nid);
        prev = nid;
        const rest = labelMatch[3].trim();
        if (rest && !RE_CL_COMMENT.test(rest)) {
          raw = rest;
        } else {
          i++;
          continue;
        }
      }

      // ── PGM / ENDPGM ──────────────────────────────────
      if (RE_CL_PGM.test(raw)) {
        i++;
        continue;
      }
      if (RE_CL_ENDPGM.test(raw)) {
        prev = this.flush(prev, buf, bufLine);
        const nid = this.node('ENDPGM', 'terminal', lno);
        this.edge(prev, nid);
        prev = nid;
        i++;
        continue;
      }

      // ── RETURN ─────────────────────────────────────────
      if (RE_CL_RETURN.test(raw)) {
        prev = this.flush(prev, buf, bufLine);
        const nid = this.node('RETURN', 'terminal', lno);
        this.edge(prev, nid);
        prev = nid;
        i++;
        continue;
      }

      // ── IF COND(...) ───────────────────────────────────
      const mIf = RE_CL_IF.exec(raw);
      if (mIf) {
        prev = this.flush(prev, buf, bufLine);
        const condText = mIf[1].trim().slice(0, 60);
        const dec = this.node(`IF ${condText}`, 'decision', lno);
        this.edge(prev, dec);

        if (RE_CL_THEN_DO.test(raw)) {
          // Block IF: IF COND(...) THEN(DO) ... ENDDO
          const [elseI, enddoI] = this.findIfEnddo(lines, i + 1, hi);
          const merge = this.node('', 'merge', base + (enddoI < hi ? enddoI : i));

          // TRUE branch
          const trueEnd = elseI !== null ? elseI : enddoI;
          const eb = this.edges.length;
          if (i + 1 < trueEnd) {
            const trueTail = this.parseBlock(lines, i + 1, trueEnd, base, dec);
            this.edge(trueTail, merge);
            if (eb < this.edges.length) {
              this.edges[eb].label = 'Y';
              this.edges[eb].edgeType = 'true';
            }
          } else {
            this.edge(dec, merge, 'Y', 'true');
          }

          // FALSE branch
          if (elseI !== null) {
            const falseStart = elseI + 1;
            const eb2 = this.edges.length;
            if (falseStart < enddoI) {
              const falseTail = this.parseBlock(lines, falseStart, enddoI, base, dec);
              this.edge(falseTail, merge);
              if (eb2 < this.edges.length) {
                this.edges[eb2].label = 'N';
                this.edges[eb2].edgeType = 'false';
              }
            } else {
              this.edge(dec, merge, 'N', 'false');
            }
          } else {
            this.edge(dec, merge, 'N', 'false');
          }

          prev = merge;
          i = enddoI < hi ? enddoI + 1 : hi;
        } else {
          // Simple IF: IF COND(...) THEN(command)
          const merge = this.node('', 'merge', lno);
          const mThen = RE_CL_THEN_CMD.exec(raw);
          if (mThen) {
            const cmd = mThen[1].trim().slice(0, 55);
            const nid = this.node(cmd, 'process', lno);
            this.edge(dec, nid, 'Y', 'true');
            this.edge(nid, merge);
          } else {
            this.edge(dec, merge, 'Y', 'true');
          }
          this.edge(dec, merge, 'N', 'false');
          prev = merge;
          i++;
        }
        continue;
      }

      // ── DOWHILE / DOUNTIL / DOFOR ──────────────────────
      if (RE_CL_DO_LOOP.test(raw)) {
        prev = this.flush(prev, buf, bufLine);
        const mLoop = raw.match(/(?:DOWHILE|DOUNTIL|DOFOR)\s+COND\((.+?)\)/i);
        let label: string;
        if (mLoop) {
          const loopType = raw.match(/(DOWHILE|DOUNTIL|DOFOR)/i)![1].toUpperCase();
          const cond = mLoop[1].trim().slice(0, 40);
          label = `${loopType}\n${cond}`;
        } else {
          label = raw.trim().slice(0, 50);
        }
        const loopId = this.node(label, 'loop', lno);
        this.edge(prev, loopId);

        const enddoI = this.findEnddo(lines, i + 1, hi);
        const merge = this.node('', 'merge', base + (enddoI < hi ? enddoI : i));
        if (i + 1 < enddoI) {
          const bodyTail = this.parseBlock(lines, i + 1, enddoI, base, loopId);
          this.edge(bodyTail, loopId, '', 'loop_back');
          // Label first edge from loopId
          for (const e of this.edges) {
            if (e.source === loopId && e.edgeType === 'seq') {
              e.label = 'Y';
              e.edgeType = 'true';
              break;
            }
          }
        }
        this.edge(loopId, merge, 'done', 'false');
        prev = merge;
        i = enddoI < hi ? enddoI + 1 : hi;
        continue;
      }

      // ── GOTO ───────────────────────────────────────────
      const up = raw.toUpperCase().trimStart();
      if (up.startsWith('GOTO')) {
        const m = RE_CL_GOTO.exec(raw);
        if (m) {
          prev = this.flush(prev, buf, bufLine);
          const target = m[1];
          const nid = this.node(`GOTO ${target}`, 'goto', lno);
          this.edge(prev, nid, '', 'goto');
          prev = nid;
          i++;
          continue;
        }
      }

      // ── CALL PGM(...) ──────────────────────────────────
      if (up.startsWith('CALL ')) {
        const m = RE_CL_CALL.exec(raw);
        if (m) {
          prev = this.flush(prev, buf, bufLine);
          const target = m[1];
          const nid = this.node(`CALL ${target}`, 'call', lno);
          this.edge(prev, nid);
          prev = nid;
          i++;
          continue;
        }
      }

      // ── CALLPRC ────────────────────────────────────────
      if (up.startsWith('CALLPRC')) {
        const m = RE_CL_CALLPRC.exec(raw);
        if (m) {
          prev = this.flush(prev, buf, bufLine);
          const target = m[1];
          const nid = this.node(`CALLPRC ${target}`, 'call', lno);
          this.edge(prev, nid);
          prev = nid;
          i++;
          continue;
        }
      }

      // ── SBMJOB CMD(CALL PGM(...)) ─────────────────────
      const mSbm = RE_CL_SBMJOB.exec(raw);
      if (mSbm) {
        prev = this.flush(prev, buf, bufLine);
        const target = mSbm[1];
        const nid = this.node(`SBMJOB\nCALL ${target}`, 'call', lno);
        this.edge(prev, nid);
        prev = nid;
        i++;
        continue;
      }

      // ── MONMSG ─────────────────────────────────────────
      if (RE_CL_MONMSG.test(raw)) {
        prev = this.flush(prev, buf, bufLine);
        const mExec = RE_CL_MONEXEC.exec(raw);
        let nid: string;
        if (mExec) {
          const handlerCmd = mExec[1].trim().slice(0, 45);
          const mGoto = RE_CL_GOTO.exec(handlerCmd);
          const labelTxt = mGoto ? `MONMSG\n→ GOTO ${mGoto[1]}` : `MONMSG\n→ ${handlerCmd}`;
          nid = this.node(labelTxt, 'decision', lno);
        } else {
          nid = this.node('MONMSG', 'process', lno);
        }
        this.edge(prev, nid);
        prev = nid;
        i++;
        continue;
      }

      // ── SUBR / ENDSUBR ─────────────────────────────────
      const mSubr = RE_CL_SUBR.exec(raw);
      if (mSubr) {
        prev = this.flush(prev, buf, bufLine);
        const subrName = mSubr[1];
        const nid = this.node(`SUBR ${subrName}`, 'call', lno);
        this.edge(prev, nid);
        prev = nid;
        i++;
        continue;
      }
      if (RE_CL_ENDSUBR.test(raw)) {
        prev = this.flush(prev, buf, bufLine);
        const nid = this.node('ENDSUBR', 'terminal', lno);
        this.edge(prev, nid);
        prev = nid;
        i++;
        continue;
      }

      // ── Regular statement → accumulate ─────────────────
      if (buf.length === 0) bufLine = lno;
      buf.push(raw);
      i++;
    }

    prev = this.flush(prev, buf, bufLine);
    return prev;
  }
}
