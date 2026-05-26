/**
 * BMS Map Parser — Parses 3270 BMS screen definition files (.map).
 *
 * Ported from DriverX parsers/bms_parser.py.
 * Extracts DFHMSD (mapset), DFHMDI (map), DFHMDF (field) definitions.
 */

export interface BmsMapField {
  mapName: string;
  mapsetName: string;
  fieldName: string;
  row: number | null;
  col: number | null;
  length: number | null;
  attrb: string;
  initialVal: string;
  startLine: number;
}

export interface BmsParseResult {
  mapsetName: string;
  maps: Array<{ name: string; startLine: number }>;
  fields: BmsMapField[];
}

const RE_DFHMSD = /(\w+)\s+DFHMSD\s+TYPE=/i;
const RE_DFHMDI = /(\w+)\s+DFHMDI\s+/i;
const RE_DFHMDF = /(\w+)\s+DFHMDF\s+/i;
const RE_POS = /POS=\((\d+),(\d+)\)/i;
const RE_LENGTH = /LENGTH=(\d+)/i;
const RE_ATTRB = /ATTRB=\(([^)]+)\)/i;
const RE_INITIAL = /INITIAL=['"]([^'"]*)['"]/i;

/**
 * Parse a BMS map file and extract screen field layout data.
 */
export function parseBmsMap(content: string): BmsParseResult {
  const lines = content.split('\n');
  const joined = joinContinuationLines(lines);

  let currentMapset = '';
  let currentMap = '';
  const maps: Array<{ name: string; startLine: number }> = [];
  const fields: BmsMapField[] = [];

  for (const [lineNo, text] of joined) {
    const stripped = text.trim();
    if (!stripped || stripped.startsWith('*')) continue;

    // DFHMSD — mapset definition
    let m = RE_DFHMSD.exec(text);
    if (m) {
      currentMapset = m[1].trim();
      continue;
    }

    // DFHMDI — map definition
    m = RE_DFHMDI.exec(text);
    if (m) {
      currentMap = m[1].trim();
      maps.push({ name: currentMap, startLine: lineNo });
      continue;
    }

    // DFHMDF — field definition
    m = RE_DFHMDF.exec(text);
    if (m) {
      const fieldName = m[1].trim();
      const mf: BmsMapField = {
        mapName: currentMap || currentMapset,
        mapsetName: currentMapset,
        fieldName,
        row: null,
        col: null,
        length: null,
        attrb: '',
        initialVal: '',
        startLine: lineNo,
      };

      // Position
      const pm = RE_POS.exec(text);
      if (pm) {
        mf.row = parseInt(pm[1], 10);
        mf.col = parseInt(pm[2], 10);
      }

      // Length
      const lm = RE_LENGTH.exec(text);
      if (lm) {
        mf.length = parseInt(lm[1], 10);
      }

      // Attributes
      const am = RE_ATTRB.exec(text);
      if (am) {
        mf.attrb = am[1].trim();
      }

      // Initial value
      const im = RE_INITIAL.exec(text);
      if (im) {
        mf.initialVal = im[1];
      }

      fields.push(mf);
    }
  }

  return { mapsetName: currentMapset, maps, fields };
}

/**
 * Join BMS continuation lines (ending with X in column 72).
 */
function joinContinuationLines(lines: string[]): Array<[number, string]> {
  const result: Array<[number, string]> = [];
  let current = '';
  let currentLineNo = 1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    // BMS continuation: 'X' in column 72 (0-indexed: 71)
    if (raw.length >= 72 && raw[71] === 'X') {
      if (!current) currentLineNo = i + 1;
      current += raw.slice(0, 71).trimEnd();
    } else {
      if (current) {
        current += raw;
        result.push([currentLineNo, current]);
        current = '';
      } else {
        result.push([i + 1, raw]);
      }
    }
  }

  if (current) {
    result.push([currentLineNo, current]);
  }

  return result;
}
