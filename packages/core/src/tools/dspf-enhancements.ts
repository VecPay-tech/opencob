/**
 * DSPF Screen Enhancement Utilities
 *
 * Provides production-quality DSPF screen rendering features:
 * - Field label humanization (prefix stripping, word splitting, known-name lookup)
 * - Function key label assignment
 * - MSGCON message constant resolution
 * - CL driver title extraction
 * - Header/framework value resolution
 * - Field legend table generation
 *
 * Ported from DriverX _dspf_field_label() and Codex _screen_layout_to_ascii().
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ══════════════════════════════════════════════════════════════
//  Field Label Humanization
// ══════════════════════════════════════════════════════════════

/**
 * Known field name → human-readable label mapping.
 * Covers common mainframe/AS400 field naming conventions.
 */
const KNOWN_LABEL_MAP: Record<string, string> = {
  // Framework / header
  ERRMSG: 'Error Message',
  ERRORMSG: 'Error Message',
  MSGLINE: 'Message Line',
  MSGFLD: 'Message',
  SYSDATE: 'System Date',
  SYSTIME: 'System Time',
  SYSID: 'System ID',
  USERID: 'User ID',
  USRID: 'User ID',
  USERNAME: 'User Name',
  PGMNAM: 'Program Name',
  PGMNAME: 'Program Name',
  PRGNAM: 'Program Name',
  TRANID: 'Transaction ID',
  MENUID: 'Menu ID',
  MENUOPT: 'Menu Option',
  // Date/time
  DATE: 'Date',
  TIME: 'Time',
  CURDATE: 'Current Date',
  CURTIME: 'Current Time',
  RUNDATE: 'Run Date',
  RUNTIME: 'Run Time',
  // Common business
  ACCTNO: 'Account Number',
  ACCTNUM: 'Account Number',
  ACCOUNT: 'Account',
  CUSTNO: 'Customer Number',
  CUSTNUM: 'Customer Number',
  CUSTNAME: 'Customer Name',
  CUSTID: 'Customer ID',
  CARDNO: 'Card Number',
  CARDNUM: 'Card Number',
  AMOUNT: 'Amount',
  BALANCE: 'Balance',
  STATUS: 'Status',
  DESCRIPTION: 'Description',
  DESC: 'Description',
  DESCR: 'Description',
  TITLE: 'Title',
  HEADING: 'Heading',
  NAME: 'Name',
  ADDRESS: 'Address',
  ADDR: 'Address',
  PHONE: 'Phone',
  EMAIL: 'Email',
};

/**
 * Prefixes to strip from field names (common DDS naming conventions).
 */
const STRIP_PREFIXES = [
  /^SCRN_?/i,
  /^SCR_?/i,
  /^DSP_?/i,
  /^FLD_?/i,
  /^WRK_?/i,
  /^W_/i,
  /^S_/i,
  /^F_/i,
  /^H_/i,
  /^O_/i,
  /^I_/i,
];

/**
 * Known sub-word parts for word-boundary splitting in uppercase blobs.
 * Sorted longest first to prevent partial matches.
 */
const KNOWN_SUBWORDS = [
  'ACCOUNT',
  'ACCT',
  'ADDRESS',
  'AMOUNT',
  'BALANCE',
  'BRANCH',
  'CARD',
  'CHANGE',
  'CHECK',
  'CODE',
  'COMMENT',
  'COUNT',
  'CREDIT',
  'CURRENCY',
  'CUSTOMER',
  'DATE',
  'DEBIT',
  'DESC',
  'DESCRIPTION',
  'DETAIL',
  'EMAIL',
  'ERROR',
  'FIELD',
  'FILE',
  'FLAG',
  'FROM',
  'FUNC',
  'GROUP',
  'HEADING',
  'INDEX',
  'INFO',
  'INTEREST',
  'ITEM',
  'KEY',
  'LABEL',
  'LENGTH',
  'LIMIT',
  'LINE',
  'LIST',
  'LOAN',
  'MESSAGE',
  'MODE',
  'MSG',
  'NAME',
  'NOTE',
  'NUMBER',
  'NUM',
  'OPTION',
  'PAGE',
  'PAYMENT',
  'PHONE',
  'PRINT',
  'RATE',
  'RECORD',
  'REF',
  'REFERENCE',
  'REPORT',
  'RESULT',
  'SCREEN',
  'SELECT',
  'SEQUENCE',
  'SEQ',
  'STATUS',
  'STMT',
  'SYSTEM',
  'TABLE',
  'TERM',
  'TEXT',
  'TIME',
  'TITLE',
  'TOTAL',
  'TRAN',
  'TRANSACTION',
  'TYPE',
  'UPDATE',
  'USER',
  'VALUE',
  'VAL',
].sort((a, b) => b.length - a.length);

/**
 * Regex patterns for numbered fields (FUNKEY1, MSGFLD2, CARD3, etc.)
 */
const NUMBERED_FIELD_RE = /^(\w+?)(\d+)$/;

/**
 * Humanize a DDS field name into a readable display label.
 *
 * Priority:
 * 1. TEXT keyword value (from DDS source)
 * 2. Cleaned ALIAS value
 * 3. Known-name lookup
 * 4. Prefix-stripped + word-split field name
 *
 * @param fieldName The raw DDS field name
 * @param alias Optional ALIAS keyword value
 * @param textDesc Optional TEXT keyword value
 * @returns Human-readable label
 */
export function humanizeFieldLabel(fieldName: string, alias?: string, textDesc?: string): string {
  // Priority 1: TEXT keyword (already human-readable — preserve original casing)
  if (textDesc && textDesc.trim().length > 1) {
    return textDesc.trim();
  }

  // Priority 2: ALIAS (strip prefixes, then clean)
  if (alias && alias.trim().length > 1) {
    const cleaned = cleanFieldName(alias.trim());
    if (cleaned.length > 1) return cleaned;
  }

  // Priority 3: Known-name exact lookup
  const upper = fieldName.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (KNOWN_LABEL_MAP[upper]) {
    return KNOWN_LABEL_MAP[upper];
  }

  // Priority 4: Numbered field pattern (e.g., FUNKEY1 → "Fn Key 1")
  const numMatch = NUMBERED_FIELD_RE.exec(upper);
  if (numMatch) {
    const baseName = numMatch[1];
    const num = numMatch[2];
    if (/^FUNKEY|^FKEY|^FK/.test(baseName)) return `Fn Key ${num}`;
    if (/^MSGFLD|^MSG/.test(baseName)) return `Message ${num}`;
    if (/^CARD/.test(baseName)) return `Card ${num}`;
    if (/^OPT/.test(baseName)) return `Option ${num}`;
    if (/^LINE/.test(baseName)) return `Line ${num}`;
    // Try cleaning the base
    const cleanedBase = cleanFieldName(baseName);
    return `${cleanedBase} ${num}`;
  }

  // Priority 5: Strip prefixes + word-boundary split
  return cleanFieldName(fieldName);
}

/**
 * Clean a raw field name by stripping prefixes and splitting into words.
 */
function cleanFieldName(name: string): string {
  let cleaned = name.toUpperCase();

  // Strip known prefixes
  for (const prefix of STRIP_PREFIXES) {
    cleaned = cleaned.replace(prefix, '');
  }

  // Strip leading/trailing underscores
  cleaned = cleaned.replace(/^_+|_+$/g, '');

  // If it has underscores, split on them
  if (cleaned.includes('_')) {
    return cleaned
      .split('_')
      .filter((w) => w.length > 0)
      .map((w) => titleCase(w))
      .join(' ');
  }

  // Try known sub-word splitting for UPPERCASE blobs
  const words = splitByKnownWords(cleaned);
  if (words.length > 1) {
    return words.map((w) => titleCase(w)).join(' ');
  }

  // Fallback: title case as-is
  return titleCase(cleaned);
}

/**
 * Split an uppercase string by matching known sub-words.
 */
function splitByKnownWords(text: string): string[] {
  const words: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let matched = false;
    for (const word of KNOWN_SUBWORDS) {
      if (remaining.startsWith(word)) {
        words.push(word);
        remaining = remaining.slice(word.length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Take one character and continue
      if (words.length > 0) {
        words[words.length - 1] += remaining[0];
      } else {
        words.push(remaining[0]);
      }
      remaining = remaining.slice(1);
    }
  }

  return words;
}

function titleCase(word: string): string {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// ══════════════════════════════════════════════════════════════
//  Function Key Label Assignment
// ══════════════════════════════════════════════════════════════

/**
 * Regex patterns for identifying function key fields.
 */
const RE_FKEY_ALIAS = /^(?:F|FK|FN|FKEY|FUNKEY|CMD)(\d+)/i;
const RE_FKEY_NAME = /^(?:FUNKEY|FKEY|FK|F)(\d+)/i;

export interface FuncKeyField {
  fieldName: string;
  fKeyNumber: number;
  label: string;
  row: number;
  col: number;
}

/**
 * Identify and assign function key labels from DSPF screen fields.
 * Sorts by column position (left-to-right) and assigns F-key numbers.
 *
 * @param fields Array of screen fields with row, col, and display info
 * @returns Sorted array of function key assignments
 */
export function assignFunctionKeyLabels(
  fields: Array<{
    fieldName: string;
    alias?: string;
    displayLabel?: string;
    row: number;
    col: number;
    type: string;
  }>,
): FuncKeyField[] {
  const fKeyFields: FuncKeyField[] = [];

  for (const field of fields) {
    let fKeyNum: number | null = null;

    // Check alias first
    if (field.alias) {
      const am = RE_FKEY_ALIAS.exec(field.alias);
      if (am) fKeyNum = parseInt(am[1], 10);
    }

    // Check field name
    if (fKeyNum === null) {
      const nm = RE_FKEY_NAME.exec(field.fieldName);
      if (nm) fKeyNum = parseInt(nm[1], 10);
    }

    if (fKeyNum !== null) {
      const label = field.displayLabel || field.fieldName;
      fKeyFields.push({
        fieldName: field.fieldName,
        fKeyNumber: fKeyNum,
        label: `F${fKeyNum}=${label}`,
        row: field.row,
        col: field.col,
      });
    }
  }

  // Sort by column (left-to-right display order)
  fKeyFields.sort((a, b) => a.col - b.col);
  return fKeyFields;
}

// ══════════════════════════════════════════════════════════════
//  MSGCON Message Constant Resolution
// ══════════════════════════════════════════════════════════════

/**
 * Well-known IBM i message IDs and their text.
 * Used as static fallback when message file is unavailable.
 */
const KNOWN_MESSAGES: Record<string, string> = {
  CPF0001: 'Error found on command',
  CPF0006: 'Errors occurred in command',
  CPF9801: 'Object not found',
  CPF9802: 'Not authorized to object',
  CPF9810: 'Library not found',
  CPF9830: 'Cannot assign library',
  USR0001: 'Record not found',
  USR0002: 'Record already exists',
  USR0003: 'Invalid input',
  USR0004: 'Operation successful',
  USR0005: 'Please confirm action',
};

export interface MsgconResolution {
  msgId: string;
  msgFile: string;
  length: number;
  resolvedText: string | null;
}

/**
 * Resolve a MSGCON keyword to actual message text.
 *
 * Format: MSGCON(length msgid msgfile)
 * Example: MSGCON(20 USR0001 USRMSGF)
 *
 * Resolution priority:
 * 1. Static known message lookup
 * 2. JSON message file in workspace (if provided)
 * 3. Returns null if unresolvable
 *
 * @param msgconValue The raw MSGCON keyword value (e.g., "20 USR0001 USRMSGF")
 * @param workspaceRoot Optional workspace root for JSON message file lookup
 * @returns Resolution result with text or null
 */
export function resolveMsgcon(msgconValue: string, workspaceRoot?: string): MsgconResolution {
  const parts = msgconValue.trim().split(/\s+/);
  const length = parseInt(parts[0], 10) || 0;
  const msgId = (parts[1] || '').toUpperCase();
  const msgFile = (parts[2] || '').toUpperCase();

  // Priority 1: Static known messages
  if (KNOWN_MESSAGES[msgId]) {
    return {
      msgId,
      msgFile,
      length,
      resolvedText: KNOWN_MESSAGES[msgId].slice(0, length || undefined),
    };
  }

  // Priority 2: JSON message file in workspace
  if (workspaceRoot) {
    const jsonPath = path.join(
      workspaceRoot,
      '.opencob',
      'messages',
      `${msgFile.toLowerCase()}.json`,
    );
    try {
      if (fs.existsSync(jsonPath)) {
        const msgs = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Record<string, string>;
        if (msgs[msgId]) {
          return {
            msgId,
            msgFile,
            length,
            resolvedText: msgs[msgId].slice(0, length || undefined),
          };
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { msgId, msgFile, length, resolvedText: null };
}

// ══════════════════════════════════════════════════════════════
//  CL Driver Title Extraction
// ══════════════════════════════════════════════════════════════

export interface ClDriverTitle {
  screenDesc: string;
  screenTran: string;
  source: string;
}

/**
 * Find and extract the screen title from a companion CL driver program.
 *
 * Naming convention: `<base>d.dspf` paired with `<base>x.clle` or `<base>r.clle`.
 *
 * Extracts:
 * - *TITLE. comments
 * - CHGVAR VAR(&TITLE) VALUE('literal')
 * - &MENUID assignment for transaction ID
 *
 * @param dspfPath Full path to the DSPF file
 * @returns Extracted title info or null if no driver found
 */
export function extractClDriverTitle(dspfPath: string): ClDriverTitle | null {
  const dir = path.dirname(dspfPath);
  const stem = path.basename(dspfPath, path.extname(dspfPath));

  // Naming convention: remove trailing 'd' or 'D' and try suffixes
  const base = stem.replace(/[dD]$/, '');
  const driverSuffixes = ['x', 'r', 'c', ''];
  const driverExts = ['.clle', '.clp', '.CL', '.cl'];

  let driverContent: string | null = null;
  let driverSource = '';

  for (const suffix of driverSuffixes) {
    for (const ext of driverExts) {
      const candidate = path.join(dir, `${base}${suffix}${ext}`);
      try {
        if (fs.existsSync(candidate)) {
          driverContent = fs.readFileSync(candidate, 'utf-8');
          driverSource = path.basename(candidate);
          break;
        }
      } catch {
        continue;
      }
    }
    if (driverContent) break;
  }

  // Also try uppercase variants
  if (!driverContent) {
    for (const suffix of driverSuffixes.map((s) => s.toUpperCase())) {
      for (const ext of driverExts) {
        const candidate = path.join(dir, `${base.toUpperCase()}${suffix}${ext}`);
        try {
          if (fs.existsSync(candidate)) {
            driverContent = fs.readFileSync(candidate, 'utf-8');
            driverSource = path.basename(candidate);
            break;
          }
        } catch {
          continue;
        }
      }
      if (driverContent) break;
    }
  }

  if (!driverContent) return null;

  let screenDesc = '';
  let screenTran = '';

  // Extract from *TITLE. comments
  const titleComment = driverContent.match(/\*\s*TITLE\.?\s*:?\s*(.+)/i);
  if (titleComment) {
    screenDesc = titleComment[1].trim().replace(/\*$/, '').trim();
  }

  // Extract from CHGVAR VAR(&TITLE) VALUE('literal')
  if (!screenDesc) {
    const chgvarMatch = driverContent.match(/CHGVAR\s+VAR\(\s*&TITLE\s*\)\s+VALUE\(\s*'([^']+)'/i);
    if (chgvarMatch) {
      screenDesc = chgvarMatch[1].trim();
    }
  }

  // Extract from CHGVAR VAR(&HEADING) VALUE('literal')
  if (!screenDesc) {
    const headingMatch = driverContent.match(
      /CHGVAR\s+VAR\(\s*&HEADING\s*\)\s+VALUE\(\s*'([^']+)'/i,
    );
    if (headingMatch) {
      screenDesc = headingMatch[1].trim();
    }
  }

  // Extract transaction ID from &MENUID or &TRANID
  const tranMatch = driverContent.match(
    /CHGVAR\s+VAR\(\s*&(?:MENUID|TRANID|TRAN)\s*\)\s+VALUE\(\s*'([^']+)'/i,
  );
  if (tranMatch) {
    screenTran = tranMatch[1].trim();
  }

  if (!screenDesc && !screenTran) return null;

  return { screenDesc, screenTran, source: driverSource };
}

// ══════════════════════════════════════════════════════════════
//  Header / Framework Value Resolution
// ══════════════════════════════════════════════════════════════

/**
 * Well-known header field patterns and their design-time display values.
 */
const HEADER_PATTERNS: Array<[RegExp, (ctx: HeaderContext) => string]> = [
  [/^(?:SYS.*HEAD|SYSTEM.*HEAD|TITLE|HEADING)/i, (ctx) => ctx.screenTitle || 'Screen Title'],
  [/^(?:TRAN.*NAME|TRANSACTION)/i, (ctx) => ctx.screenTran || 'Transaction'],
  [/^(?:TRANID|MENUID|TRAN_?ID)/i, (ctx) => ctx.screenTran || 'TRAN'],
  [/^(?:SYS.*DATE|CURDATE|DATE)/i, () => '99/99/9999'],
  [/^(?:SYS.*TIME|CURTIME|TIME)/i, () => '99:99:99'],
  [/^(?:ERRMSG|ERROR.*MSG|MSGLINE)/i, () => ''],
  [/^(?:USER.*ID|USRID|USERID)/i, () => 'USER'],
  [/^(?:PGM.*NAM|PROGRAM)/i, (ctx) => ctx.programName || 'PROGRAM'],
  [/^(?:PAGE.*NO|PAGENO|PAGE)/i, () => '999'],
];

export interface HeaderContext {
  screenTitle: string;
  screenTran: string;
  programName: string;
}

/**
 * Resolve a framework/header field to its design-time display value.
 *
 * @param fieldName The field name or alias to check
 * @param ctx Context containing screen title, transaction ID, program name
 * @returns Resolved display value or null if not a header field
 */
export function resolveHeaderValue(fieldName: string, ctx: HeaderContext): string | null {
  const upper = fieldName.toUpperCase().replace(/[^A-Z0-9]/g, '');

  for (const [pattern, resolver] of HEADER_PATTERNS) {
    if (pattern.test(upper)) {
      return resolver(ctx);
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
//  ASCII Field Legend Table
// ══════════════════════════════════════════════════════════════

export interface FieldLegendEntry {
  type: 'INPUT' | 'OUTPUT' | 'BOTH' | 'HIDDEN' | 'CONSTANT';
  row: number;
  col: number;
  length: number;
  fieldName: string;
  displayName: string;
}

/**
 * Generate a field legend table for append after ASCII screen art.
 * Lists all fields with their type, position, length, and display name.
 *
 * @param fields Array of screen fields
 * @returns Formatted legend string
 */
export function generateFieldLegend(
  fields: Array<{
    fieldName: string;
    displayLabel?: string;
    type: string;
    row: number;
    col: number;
    length: number;
    usage?: string;
    alias?: string;
  }>,
): string {
  if (fields.length === 0) return '';

  const entries: FieldLegendEntry[] = [];

  for (const f of fields) {
    if (!f.fieldName && f.type === 'constant') continue; // Skip unnamed constants

    let fieldType: FieldLegendEntry['type'];
    const usage = (f.usage || '').toUpperCase();
    if (f.type === 'constant') fieldType = 'CONSTANT';
    else if (usage === 'B') fieldType = 'BOTH';
    else if (usage === 'I') fieldType = 'INPUT';
    else if (usage === 'H') fieldType = 'HIDDEN';
    else if (f.type === 'input') fieldType = 'INPUT';
    else fieldType = 'OUTPUT';

    const displayName = f.displayLabel || f.fieldName;
    const aliasPart = f.alias && f.alias !== f.fieldName ? ` (${f.alias})` : '';

    entries.push({
      type: fieldType,
      row: f.row,
      col: f.col,
      length: f.length,
      fieldName: f.fieldName + aliasPart,
      displayName,
    });
  }

  if (entries.length === 0) return '';

  // Sort: by row, then col
  entries.sort((a, b) => a.row - b.row || a.col - b.col);

  const lines: string[] = ['', '  Fields:'];
  for (const e of entries) {
    const typeStr = `[${e.type}]`.padEnd(10);
    const posStr = `Row ${String(e.row).padStart(2)}, Col ${String(e.col).padStart(3)}, Len ${String(e.length).padStart(3)}`;
    lines.push(`    ${typeStr} ${posStr}  ${e.fieldName}`);
  }

  return lines.join('\n');
}
