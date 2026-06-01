/**
 * IBM i Source Physical File Name Inference
 *
 * Maps IBM i object browser member paths and source physical file names
 * to standard file extensions. Handles:
 * - IFS paths: /home/user/myfile.rpgle → rpgle
 * - Object browser: MYPGM — MYLIB/QRPGLESRC → rpgle
 * - Standard source PFs: QRPGLESRC, QCBLSRC, QCLSRC, etc.
 * - Custom source PFs via fuzzy matching: CBLSRC → cbl, RPGLESRC → rpgle
 *
 * Ported from DriverX ibmi_name_to_extension() / _IBMI_SRCPF_TO_EXT.
 */

/**
 * Mapping of well-known IBM i source physical file names to extensions.
 * Q-prefixed names are standard IBM naming convention.
 */
const IBMI_SRCPF_TO_EXT: Record<string, string> = {
  // COBOL
  QCBLSRC: 'cbl',
  QCBLLESRC: 'cbl',
  QCBLCPY: 'cpy',
  QLBLSRC: 'cbl',
  QCBLESRC: 'cbl',
  QCBLMQSRC: 'cbl',
  QSQLCBLSRC: 'sqb',
  // RPG
  QRPGSRC: 'rpg',
  QRPGLESRC: 'rpgle',
  QSQLRPGSRC: 'sqlrpg',
  QSQLRPGLES: 'sqlrpgle',
  QSQLRPGLE: 'sqlrpgle',
  // CL
  QCLSRC: 'clp',
  QCLLESRC: 'clle',
  QCMDSRC: 'cmd',
  QMNUSRC: 'mnu',
  // DDS
  QDDSSRC: 'dds',
  QDDSPSRC: 'dspf',
  QDDSPFSRC: 'dspf',
  QPFDSRC: 'pf',
  QLFSRC: 'lf',
  QPRTFSRC: 'prtf',
  QDDS: 'dds',
  // PL/I
  QPLISRC: 'pli',
  QPL1SRC: 'pl1',
  // Misc
  QSRCSRC: 'cbl',
  QCSRC: 'clle',
  QTXTSRC: 'cbl',
};

/**
 * Fuzzy extension inference from non-standard source PF names.
 * Strips optional Q prefix, then matches against known patterns.
 */
const FUZZY_PATTERNS: Array<[RegExp, string]> = [
  [/^Q?RPGLESRC/i, 'rpgle'],
  [/^Q?SQLRPGLE/i, 'sqlrpgle'],
  [/^Q?SQLRPG/i, 'sqlrpg'],
  [/^Q?RPGSRC/i, 'rpg'],
  [/^Q?CBLSRC/i, 'cbl'],
  [/^Q?CBLLESRC/i, 'cbl'],
  [/^Q?CBLCPY/i, 'cpy'],
  [/^Q?SQLCBL/i, 'sqb'],
  [/^Q?CLSRC/i, 'clp'],
  [/^Q?CLLESRC/i, 'clle'],
  [/^Q?CMDSRC/i, 'cmd'],
  [/^Q?MNUSRC/i, 'mnu'],
  [/^Q?DDSSRC/i, 'dds'],
  [/^Q?DSPF/i, 'dspf'],
  [/^Q?PFSRC/i, 'pf'],
  [/^Q?LFSRC/i, 'lf'],
  [/^Q?PRTF/i, 'prtf'],
  [/^Q?PLISRC/i, 'pli'],
  [/^Q?PL1/i, 'pl1'],
  [/RPGLE/i, 'rpgle'],
  [/RPGSRC/i, 'rpg'],
  [/CBLSRC/i, 'cbl'],
  [/COBOL/i, 'cbl'],
  [/CLSRC/i, 'clp'],
  [/DSPF/i, 'dspf'],
  [/DDS/i, 'dds'],
];

/**
 * Infer the file extension for an IBM i source member.
 *
 * Handles multiple input formats:
 * - IFS path: `/home/user/myfile.rpgle` → `rpgle`
 * - File with extension: `MYPGM.cbl` → `cbl`
 * - Object browser format: `MYPGM — MYLIB/QRPGLESRC` → `rpgle`
 * - Source PF name only: `QRPGLESRC` → `rpgle`
 *
 * @returns Extension string without dot, or null if unrecognizable.
 */
export function ibmiNameToExtension(name: string): string | null {
  if (!name || !name.trim()) return null;

  const trimmed = name.trim();

  // Case 1: Already has a file extension (IFS path or dotted name)
  const dotMatch = trimmed.match(/\.(\w+)$/);
  if (dotMatch) {
    return dotMatch[1].toLowerCase();
  }

  // Case 2: Object browser format "MEMBER — LIB/SRCPF"
  const objBrowserMatch = trimmed.match(/\w+\s*[—–-]\s*(?:\w+[*/])?\s*(\w+)\s*$/);
  if (objBrowserMatch) {
    const srcpf = objBrowserMatch[1].toUpperCase();
    const ext = lookupSrcPf(srcpf);
    if (ext) return ext;
  }

  // Case 3: "LIB/SRCPF(MEMBER)" format
  const libPfMatch = trimmed.match(/(?:\w+\/)?(\w+)\(\w+\)/i);
  if (libPfMatch) {
    const srcpf = libPfMatch[1].toUpperCase();
    const ext = lookupSrcPf(srcpf);
    if (ext) return ext;
  }

  // Case 4: Plain source PF name
  const ext = lookupSrcPf(trimmed.toUpperCase());
  if (ext) return ext;

  return null;
}

/**
 * Look up a source physical file name to get the extension.
 * First tries exact match, then fuzzy patterns.
 */
function lookupSrcPf(srcpf: string): string | null {
  // Exact match
  if (IBMI_SRCPF_TO_EXT[srcpf]) {
    return IBMI_SRCPF_TO_EXT[srcpf];
  }

  // Fuzzy match
  for (const [pattern, ext] of FUZZY_PATTERNS) {
    if (pattern.test(srcpf)) {
      return ext;
    }
  }

  return null;
}

/**
 * Extract the member name from various IBM i path formats.
 * Returns the clean member name without library/srcpf decoration.
 */
export function ibmiExtractMemberName(path: string): string {
  const trimmed = path.trim();

  // "LIB/SRCPF(MEMBER)" → MEMBER
  const parenMatch = trimmed.match(/\w+\/\w+\((\w+)\)/i);
  if (parenMatch) return parenMatch[1];

  // "MEMBER — LIB/SRCPF" → MEMBER
  const dashMatch = trimmed.match(/^(\w+)\s*[—–-]\s*/);
  if (dashMatch) return dashMatch[1];

  // IFS: /path/to/file.ext → file (without extension)
  const ifsMatch = trimmed.match(/[/\\]([^/\\]+?)(?:\.\w+)?$/);
  if (ifsMatch) return ifsMatch[1];

  // Just the name
  return trimmed.replace(/\.\w+$/, '');
}
