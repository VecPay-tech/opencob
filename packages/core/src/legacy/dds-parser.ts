/**
 * DDS Parser — Parses AS/400 Data Description Specification files.
 *
 * Ported from DriverX parsers/dds_parser.py.
 * Handles: .pf (Physical File), .lf (Logical File), .dspf (Display File), .prtf (Print File)
 *
 * Extracts record formats, field definitions, keys, screen positions (DSPF),
 * and relationships (REFFLD, REF).
 */

export interface DdsField {
  recordName: string;
  fieldName: string;
  fieldType: string;
  fieldLength: number | null;
  decimalPos: number | null;
  refField: string;
  alias: string;
  colHeading: string;
  textDesc: string;
  startLine: number;
  // DSPF screen position fields
  row: number | null;
  col: number | null;
  usage: string; // B=both, I=input, O=output, H=hidden
  isConstant: boolean;
  constantKeyword: string;
  constantLength: number | null;
}

export interface DdsRecord {
  name: string;
  startLine: number;
  fields: DdsField[];
  keys: string[];
}

export interface DdsScreenMeta {
  rows: number;
  cols: number;
  funcKeys: string[];
  screenDesc: string;
  screenTran: string;
}

export interface DdsParseResult {
  programId: string;
  fileType: 'pf' | 'lf' | 'dspf' | 'prtf' | 'dds';
  records: DdsRecord[];
  allFields: DdsField[];
  screenMeta: DdsScreenMeta | null;
  references: Array<{ target: string; type: string; line: number }>;
}

const RE_RECORD = /^\s*A?\s+R\s+(\w+)/i;
const RE_KEY = /^\s*A?\s+K\s+(\w+)/i;
const RE_SEQ_NUM = /^\d{5,6}/;
const RE_REF = /REF\(\s*(\w+)\s*\)/i;
const RE_REFFLD = /REFFLD\(\s*([\w/]+)\s+([\w*/]+)\s*\)/i;
const RE_ALIAS = /ALIAS\(\s*(\w+)\s*\)/i;
const RE_COLHDG = /COLHDG\(\s*(.+?)\s*\)/i;
const RE_TEXT = /TEXT\(\s*['"](.+?)['"]\s*\)/i;
const RE_DSPSIZ = /DSPSIZ\(\s*(\d+)\s+(\d+)/i;
const RE_CF_KEY = /CF(\d+)\((\d+)\s+'([^']*)'\)/gi;

/**
 * Parse a DDS source file.
 */
export function parseDds(content: string, filePath: string): DdsParseResult {
  const ext =
    (filePath.split('.').pop()?.toLowerCase() as 'pf' | 'lf' | 'dspf' | 'prtf' | 'dds') ?? 'dds';
  let isDspf = ext === 'dspf';

  // Content-based DSPF detection: if .dds file contains DSPSIZ, WORKSTN, or CF keys,
  // it's a display file regardless of extension
  if (!isDspf && ext === 'dds') {
    const upper = content.toUpperCase();
    if (upper.includes('DSPSIZ') || upper.includes('WORKSTN') || /CF\d+\(/.test(upper)) {
      isDspf = true;
    }
  }

  const lines = content.split('\n');
  const stem =
    filePath
      .split('/')
      .pop()
      ?.replace(/\.\w+$/, '') ?? '';

  const result: DdsParseResult = {
    programId: stem,
    fileType: isDspf && ext === 'dds' ? 'dspf' : ext,
    records: [],
    allFields: [],
    screenMeta: null,
    references: [],
  };

  // Screen metadata for DSPF
  let screenRows = 24;
  let screenCols = 80;
  const funcKeys: string[] = [];
  let screenDesc = '';
  let screenTran = '';

  // Pre-scan for file-level keywords
  for (let i = 0; i < lines.length; i++) {
    const raw = stripSeq(lines[i].replace(/\r$/, ''));

    const refMatch = RE_REF.exec(raw);
    if (refMatch) {
      result.references.push({ target: refMatch[1], type: 'include', line: i + 1 });
    }

    if (isDspf) {
      const sizeMatch = RE_DSPSIZ.exec(raw);
      if (sizeMatch) {
        screenRows = parseInt(sizeMatch[1], 10);
        screenCols = parseInt(sizeMatch[2], 10);
      }

      // Extract CF keys
      RE_CF_KEY.lastIndex = 0;
      let cfm: RegExpExecArray | null;
      while ((cfm = RE_CF_KEY.exec(raw)) !== null) {
        const fkNum = cfm[1];
        const fkDesc = cfm[3].trim();
        if (fkDesc) funcKeys.push(`F${fkNum}=${fkDesc}`);
      }

      // Extract screen description from comments
      if (!screenDesc) {
        let dm = raw.match(/\*\s*DESCRIPTION\s*:\s*(.+)/i);
        if (dm) {
          const descText = dm[1].trim().replace(/\*$/, '').trim();
          const pm = descText.match(/(.+?)\s*\(([A-Z0-9]+)\)\s*$/);
          if (pm) {
            screenDesc = pm[1].trim();
            screenTran = pm[2].trim();
          } else {
            screenDesc = descText;
          }
        }
        if (!screenDesc) {
          dm = raw.match(/\*\s*Function\s*:\s*(.+)/i);
          if (dm) {
            const fval = dm[1].trim().replace(/\*$/, '').trim();
            if (fval && !fval.includes('----')) screenDesc = fval;
          }
        }
        if (!screenDesc) {
          dm = raw.match(/\*\s*TITI?LE\s*[.:]\s*(.+)/i);
          if (dm) {
            const tval = dm[1].trim().replace(/\*$/, '').replace(/\.$/, '').trim();
            if (tval && !tval.includes('----')) screenDesc = tval;
          }
        }
      }
    }
  }

  if (isDspf) {
    result.screenMeta = { rows: screenRows, cols: screenCols, funcKeys, screenDesc, screenTran };
  }

  // Main parse loop
  let currentRecord: DdsRecord | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = stripSeq(lines[i].replace(/\r$/, ''));
    if (/^\s*\*/.test(text)) continue; // Comment

    // Record format
    const recMatch = RE_RECORD.exec(text);
    if (recMatch) {
      currentRecord = { name: recMatch[1].trim(), startLine: i + 1, fields: [], keys: [] };
      result.records.push(currentRecord);
      continue;
    }

    // Key field
    const keyMatch = RE_KEY.exec(text);
    if (keyMatch && currentRecord) {
      currentRecord.keys.push(keyMatch[1].trim());
      continue;
    }

    // Field definitions
    if (!currentRecord) continue;

    if (isDspf) {
      // DSPF: position-based parsing
      const field = parseDspfField(text, currentRecord.name, i + 1);
      if (field) {
        currentRecord.fields.push(field);
        result.allFields.push(field);

        // REFFLD references
        const reffldMatch = RE_REFFLD.exec(text);
        if (reffldMatch) {
          field.refField = `${reffldMatch[1]} ${reffldMatch[2]}`;
          result.references.push({ target: reffldMatch[2], type: 'reffld', line: i + 1 });
        }
      }
    } else {
      // PF/LF/PRTF: standard field parsing
      const field = parseStandardField(text, currentRecord.name, i + 1);
      if (field) {
        currentRecord.fields.push(field);
        result.allFields.push(field);

        // REFFLD references
        const reffldMatch = RE_REFFLD.exec(text);
        if (reffldMatch) {
          field.refField = `${reffldMatch[1]} ${reffldMatch[2]}`;
          result.references.push({ target: reffldMatch[2], type: 'reffld', line: i + 1 });
        }
      }
    }
  }

  return result;
}

function stripSeq(line: string): string {
  return RE_SEQ_NUM.test(line) ? line.slice(6) : line;
}

function parseDspfField(text: string, recordName: string, line: number): DdsField | null {
  // DSPF fields have screen position (row col) before keywords
  // Format: [spaces]A[indicators][name][R|length][type][dec][usage][row][col][keywords]
  // Also handles constant text: A                                  3 10'text here'

  // Try regex-based approach for flexibility
  // Match named field with usage+position: A  FIELDNAME  LEN TYPE DEC USAGE ROW COL
  const namedMatch = text.match(
    /^\s*A?\s{2,}(\w+)\s+(\d+|R)([APSB]?)\s*(\d*)\s*([BIOH]?)\s+(\d+)\s+(\d+)/i,
  );
  if (namedMatch) {
    const fname = namedMatch[1].trim();
    if (['R', 'K'].includes(fname.toUpperCase())) return null;

    const isRef = namedMatch[2] === 'R';
    const length = isRef ? null : parseInt(namedMatch[2], 10) || null;
    const fieldType = namedMatch[3]?.toUpperCase() || '';
    const decimalPos = namedMatch[4] ? parseInt(namedMatch[4], 10) : null;
    const usage = namedMatch[5]?.toUpperCase() || '';
    const row = parseInt(namedMatch[6], 10);
    const col = parseInt(namedMatch[7], 10);
    const kwStart = text.indexOf(namedMatch[7]) + namedMatch[7].length;
    const kw = text.slice(kwStart).trim();

    const aliasMatch = RE_ALIAS.exec(kw);
    const colhdgMatch = RE_COLHDG.exec(kw);
    const textMatch = RE_TEXT.exec(kw);
    const reffldMatch = RE_REFFLD.exec(kw);

    return {
      recordName,
      fieldName: fname,
      fieldType,
      fieldLength: length,
      decimalPos,
      refField: reffldMatch ? `${reffldMatch[1]} ${reffldMatch[2]}` : '',
      alias: aliasMatch ? aliasMatch[1] : '',
      colHeading: colhdgMatch ? colhdgMatch[1] : '',
      textDesc: textMatch ? textMatch[1] : '',
      startLine: line,
      row,
      col,
      usage,
      isConstant: false,
      constantKeyword: '',
      constantLength: null,
    };
  }

  // Match reference field (name + R + keywords, no row/col):
  // A            FIELDNAME    R           REFFLD(...)
  const refFieldMatch = text.match(/^\s*A?\s{2,}(\w+)\s+R\b(.*)/i);
  if (refFieldMatch) {
    const fname = refFieldMatch[1].trim();
    if (!['R', 'K'].includes(fname.toUpperCase())) {
      const kw = refFieldMatch[2].trim();
      const reffldMatch = RE_REFFLD.exec(kw);
      const aliasMatch = RE_ALIAS.exec(kw);
      const textMatch = RE_TEXT.exec(kw);

      return {
        recordName,
        fieldName: fname,
        fieldType: '',
        fieldLength: null,
        decimalPos: null,
        refField: reffldMatch ? `${reffldMatch[1]} ${reffldMatch[2]}` : '',
        alias: aliasMatch ? aliasMatch[1] : '',
        colHeading: '',
        textDesc: textMatch ? textMatch[1] : '',
        startLine: line,
        row: null,
        col: null,
        usage: '',
        isConstant: false,
        constantKeyword: '',
        constantLength: null,
      };
    }
  }

  // Match constant text (no field name, just row col and text):
  // A                                  3 10'text'
  const constMatch = text.match(/^\s*A?\s+(\d+)\s+(\d+)(.*)$/);
  if (constMatch) {
    const row = parseInt(constMatch[1], 10);
    const col = parseInt(constMatch[2], 10);
    const constText = constMatch[3].trim().replace(/^'|'$/g, '');

    return {
      recordName,
      fieldName: '',
      fieldType: '',
      fieldLength: constText.length || null,
      decimalPos: null,
      refField: '',
      alias: '',
      colHeading: '',
      textDesc: constText,
      startLine: line,
      row,
      col,
      usage: '',
      isConstant: true,
      constantKeyword: constText,
      constantLength: constText.length || null,
    };
  }

  return null;
}

function parseStandardField(text: string, recordName: string, line: number): DdsField | null {
  // DDS field line: after form type (A) and optional indicators, has field name + length + type
  // Format: [spaces]A[indicators][name][length][type][dec][usage][row][col][keywords]
  // Use regex to be flexible with column alignment
  const fieldMatch = text.match(/^\s*A?\s{2,}(\w+)\s+(\d+)([APSB]?)\s*(\d*)/i);
  if (!fieldMatch) {
    // Check for reference-field (R indicator after name)
    const refMatch = text.match(/^\s*A?\s{2,}(\w+)\s+R\b/i);
    if (!refMatch) return null;

    const fname = refMatch[1].trim();
    if (['R', 'K'].includes(fname.toUpperCase())) return null;

    const kw = text.slice(text.indexOf(fname) + fname.length + 2).trim();
    const aliasMatch = RE_ALIAS.exec(kw);
    const colhdgMatch = RE_COLHDG.exec(kw);
    const textMatch = RE_TEXT.exec(kw);

    return {
      recordName,
      fieldName: fname,
      fieldType: '',
      fieldLength: null,
      decimalPos: null,
      refField: '',
      alias: aliasMatch ? aliasMatch[1] : '',
      colHeading: colhdgMatch ? colhdgMatch[1] : '',
      textDesc: textMatch ? textMatch[1] : '',
      startLine: line,
      row: null,
      col: null,
      usage: '',
      isConstant: false,
      constantKeyword: '',
      constantLength: null,
    };
  }

  const fname = fieldMatch[1].trim();
  // Skip if it looks like a record or key definition caught by accident
  if (['R', 'K'].includes(fname.toUpperCase())) return null;

  const length = parseInt(fieldMatch[2], 10) || null;
  const fieldType = fieldMatch[3]?.toUpperCase() || '';
  const decimalPos = fieldMatch[4] ? parseInt(fieldMatch[4], 10) : null;

  const kw = text.slice(text.indexOf(fieldMatch[0]) + fieldMatch[0].length).trim();
  const aliasMatch = RE_ALIAS.exec(kw);
  const colhdgMatch = RE_COLHDG.exec(kw);
  const textMatch = RE_TEXT.exec(kw);

  return {
    recordName,
    fieldName: fname,
    fieldType,
    fieldLength: length,
    decimalPos,
    refField: '',
    alias: aliasMatch ? aliasMatch[1] : '',
    colHeading: colhdgMatch ? colhdgMatch[1] : '',
    textDesc: textMatch ? textMatch[1] : '',
    startLine: line,
    row: null,
    col: null,
    usage: '',
    isConstant: false,
    constantKeyword: '',
    constantLength: null,
  };
}
