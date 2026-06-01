/**
 * Dependency Engine — Whole-repo dependency management for IBM i source.
 *
 * Feature-compatible with IBM Source Orbit and DriverX dependency_engine.py.
 * Provides:
 *   1. Dependency tree (upstream/downstream)
 *   2. Impact analysis (what is affected by a change)
 *   3. Build order (topological sort) — full or incremental
 *   4. Build script generation (CL / JSON)
 *   5. Repo summary / stats
 *   6. Unresolved references detection
 *   7. Object type inference
 *   8. Impact markdown report generation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ═══════════════════════════════════════════════════════════════
//  Data Model
// ═══════════════════════════════════════════════════════════════

/** IBM i object type classification */
export type ObjectType =
  | 'PGM'
  | 'SRVPGM'
  | 'MODULE'
  | 'FILE'
  | 'DSPF'
  | 'PRTF'
  | 'BNDDIR'
  | 'MNU'
  | 'CMD'
  | 'DTAARA'
  | 'COPY'
  | 'OBJ';

/** Cross-object reference types */
export type CrossRefType =
  | 'COPY'
  | 'CALL'
  | 'CICS LINK'
  | 'CICS XCTL'
  | 'file_select'
  | 'file_ref'
  | 'DCLF'
  | 'REF'
  | 'REFFLD'
  | 'SBMJOB'
  | 'CALLPRC';

const CROSS_REF_TYPES = new Set<string>([
  'COPY',
  'CALL',
  'CICS LINK',
  'CICS XCTL',
  'file_select',
  'file_ref',
  'DCLF',
  'REF',
  'REFFLD',
  'SBMJOB',
  'CALLPRC',
]);

/** Recognised source file extensions */
const FILE_TYPES = new Set([
  'cbl',
  'cob',
  'cpy',
  'sqb',
  'pco',
  'sbc',
  'ccp',
  'ccc',
  'cbe',
  'rmc',
  'obs',
  'clle',
  'clp',
  'cmd',
  'mnu',
  'rpg',
  'rpgle',
  'sqlrpgle',
  'sqlrpg',
  'pf',
  'lf',
  'dspf',
  'prtf',
  'dds',
  'pli',
  'pl1',
  'inc',
  'map',
  'asm',
  'rma',
]);

/** CL compile command mapping */
const COMPILE_CMD_MAP: Record<string, string> = {
  PGM: 'CRTBNDCBL',
  FILE: 'CRTPF',
  DSPF: 'CRTDSPF',
  PRTF: 'CRTPRTF',
  CMD: 'CRTCMD',
  MNU: 'CRTMNU',
};

/** Represents one compilable source member in the repo */
export interface SourceObject {
  name: string; // stem (lowercase)
  filename: string; // full filename with extension
  extension: string;
  category: string; // program | copybook | dds | screen
  objectType: ObjectType;
  library: string;
  sourceType: string; // e.g. "cblsrc", "cpysrc"
  absPath: string;
  relPath: string; // relative to repo root
  lineCount: number;
  reference: boolean; // true if from .objrefs (not real source)
  dependsOn: Set<string>; // names this object needs
  dependedBy: Set<string>; // names that need this object
  references: Array<{ target: string; refType: string; line: number }>;
}

/** File message / warning */
export interface FileMessage {
  relPath: string;
  message: string;
  msgType: 'info' | 'warning';
  line?: number;
}

/** Impact analysis result */
export interface ImpactResult {
  changed: string[];
  totalAffected: number;
  byDepth: Record<
    number,
    Array<{
      name: string;
      objectType: string;
      library: string;
      relPath: string;
      isChanged: boolean;
    }>
  >;
  directlyAffected: string[];
  transitivelyAffected: string[];
  affectedPrograms: string[];
  buildOrder: string[];
}

/** Build order result */
export interface BuildOrderResult {
  totalObjects: number;
  total: number;
  order: string[];
  levels: Record<string, number>;
  buildSteps: Array<{
    step: number;
    name: string;
    objectType: string;
    library: string;
    relPath: string;
  }>;
  cycles: string[];
}

/** Build script result */
export interface BuildScriptResult {
  format: 'cl' | 'json';
  totalSteps: number;
  script?: string;
  steps?: Array<{
    step: number;
    command: string;
    object: string;
    library: string;
    sourceFile: string;
    sourceMember: string;
    objectType: string;
    relPath: string;
  }>;
  cycles: string[];
}

/** Repo summary result */
export interface RepoSummary {
  totalObjects: number;
  totalEdges: number;
  byObjectType: Record<string, number>;
  byLibrary: Record<string, number>;
  byCategory: Record<string, number>;
  orphansCount: number;
  orphansSample: string[];
  mostDependedOn: Array<{
    name: string;
    library: string;
    objectType: string;
    dependedByCount: number;
  }>;
}

/** Unresolved reference entry */
export interface UnresolvedRef {
  name: string;
  referencedByCount: number;
  referencedBy: string[];
}

// ═══════════════════════════════════════════════════════════════
//  Object Type Inference
// ═══════════════════════════════════════════════════════════════

/**
 * Infer the IBM i object type from source member type and extension.
 */
export function inferObjectType(sourceType: string, ext: string, category: string): ObjectType {
  const stLower = sourceType.toLowerCase();
  const extLower = ext.toLowerCase();

  if (stLower === 'cpysrc' || category === 'copybook') return 'COPY';
  if (extLower === 'pf' || extLower === 'dds') return 'FILE';
  if (extLower === 'lf') return 'FILE';
  if (extLower === 'dspf') return 'DSPF';
  if (extLower === 'prtf') return 'PRTF';
  if (extLower === 'clle' || extLower === 'clp') return 'PGM';
  if (extLower === 'cmd') return 'CMD';
  if (extLower === 'mnu') return 'MNU';
  if (['cbl', 'cob', 'sqb', 'pco', 'sbc', 'ccp', 'ccc', 'cbe', 'obs'].includes(extLower))
    return 'PGM';
  if (['rpg', 'rpgle', 'sqlrpgle', 'sqlrpg'].includes(extLower)) return 'PGM';
  return 'OBJ';
}

/**
 * Infer category from extension.
 */
function inferCategory(ext: string): string {
  const e = ext.toLowerCase();
  if (['cpy', 'inc'].includes(e)) return 'copybook';
  if (['pf', 'lf', 'dds'].includes(e)) return 'dds';
  if (['dspf', 'prtf', 'map', 'asm', 'rma'].includes(e)) return 'screen';
  return 'program';
}

// ═══════════════════════════════════════════════════════════════
//  Repo Scanner
// ═══════════════════════════════════════════════════════════════

/** Reference extracted from source parsing */
interface ParsedRef {
  target: string;
  refType: string;
  line: number;
}

/** Light-weight regex-based reference extraction (no full AST parse needed) */
function extractReferences(content: string, ext: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  const lines = content.split('\n');
  const extLower = ext.toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    // Strip sequence area for COBOL
    const text = line.length > 6 ? line.substring(6) : line;
    if (!text.trim()) continue;
    // Skip comments
    if (text.length > 0 && (text[0] === '*' || text[0] === '/')) continue;

    const upper = text.toUpperCase();

    // COPY statement
    const copyMatch = upper.match(/\bCOPY\s+([\w-]+)/);
    if (copyMatch) {
      refs.push({ target: copyMatch[1].toLowerCase(), refType: 'COPY', line: lineNum });
    }

    // CALL statement
    const callMatch = upper.match(/\bCALL\s+['"]?([\w-]+)['"]?/);
    if (callMatch) {
      refs.push({ target: callMatch[1].toLowerCase(), refType: 'CALL', line: lineNum });
    }

    // EXEC CICS LINK / XCTL
    const cicsLinkMatch = upper.match(/EXEC\s+CICS\s+LINK\s+.*PROGRAM\s*\(\s*['"]?([\w-]+)/);
    if (cicsLinkMatch) {
      refs.push({ target: cicsLinkMatch[1].toLowerCase(), refType: 'CICS LINK', line: lineNum });
    }
    const cicsXctlMatch = upper.match(/EXEC\s+CICS\s+XCTL\s+.*PROGRAM\s*\(\s*['"]?([\w-]+)/);
    if (cicsXctlMatch) {
      refs.push({ target: cicsXctlMatch[1].toLowerCase(), refType: 'CICS XCTL', line: lineNum });
    }

    // DDS REFFLD
    const reffldMatch = upper.match(/REFFLD\(\s*([\w/]+)\s+([\w*/]+)/);
    if (reffldMatch) {
      const target = reffldMatch[2].split('/').pop()?.replace(/\*/g, '').toLowerCase() ?? '';
      if (target) refs.push({ target, refType: 'REFFLD', line: lineNum });
    }

    // DDS REF
    const refMatch = upper.match(/\bREF\(\s*([\w]+)\s*\)/);
    if (refMatch) {
      refs.push({ target: refMatch[1].toLowerCase(), refType: 'REF', line: lineNum });
    }

    // CL: DCLF
    if (extLower === 'clle' || extLower === 'clp') {
      const dclfMatch = upper.match(/\bDCLF\s+.*FILE\(\s*(?:\w+\/)?([\w]+)/);
      if (dclfMatch) {
        refs.push({ target: dclfMatch[1].toLowerCase(), refType: 'DCLF', line: lineNum });
      }
      // SBMJOB
      const sbmjobMatch = upper.match(/\bSBMJOB\s+.*CMD\(\s*CALL\s+.*PGM\(\s*([\w]+)/);
      if (sbmjobMatch) {
        refs.push({ target: sbmjobMatch[1].toLowerCase(), refType: 'SBMJOB', line: lineNum });
      }
    }

    // SELECT ... ASSIGN (file I/O)
    const selectMatch = upper.match(/\bSELECT\s+([\w-]+)\s+ASSIGN\s+TO\s+([\w-]+)/);
    if (selectMatch) {
      refs.push({ target: selectMatch[2].toLowerCase(), refType: 'file_select', line: lineNum });
    }
  }

  return refs;
}

/**
 * Scan a repository directory and build the dependency graph.
 */
export function scanRepo(
  repoRoot: string,
  progressCb?: (scanned: number, total: number, filename: string) => void,
): Map<string, SourceObject> {
  const objects = new Map<string, SourceObject>();
  const rawRefs = new Map<string, ParsedRef[]>();
  const sourceDir = fs.existsSync(path.join(repoRoot, 'source'))
    ? path.join(repoRoot, 'source')
    : repoRoot;

  // Load .objrefs
  const objrefsPath = path.join(repoRoot, '.objrefs');
  if (fs.existsSync(objrefsPath)) {
    const content = fs.readFileSync(objrefsPath, 'utf-8');
    for (const line of content.split('\n')) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith('#') || line[0] === ' ' || line[0] === '\t') continue;
      const parts = stripped.split('.');
      const name = parts[0].toLowerCase();
      const objType = (parts[1]?.toUpperCase() ?? 'OBJ') as ObjectType;
      if (!objects.has(name)) {
        objects.set(name, {
          name,
          filename: stripped,
          extension: '',
          category: 'reference',
          objectType: objType,
          library: '*LIBL',
          sourceType: '',
          absPath: '',
          relPath: `.objrefs:${stripped}`,
          lineCount: 0,
          reference: true,
          dependsOn: new Set(),
          dependedBy: new Set(),
          references: [],
        });
      }
    }
  }

  // Discover eligible files
  const eligible: string[] = [];
  function discover(dir: string, depth: number): void {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        discover(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (FILE_TYPES.has(ext)) eligible.push(full);
      }
    }
  }
  discover(sourceDir, 0);

  // Parse each file
  for (let i = 0; i < eligible.length; i++) {
    const fpath = eligible[i];
    const ext = path.extname(fpath).slice(1).toLowerCase();
    const stem = path.basename(fpath, path.extname(fpath)).toLowerCase();
    const relPath = path.relative(repoRoot, fpath).replace(/\\/g, '/');
    const parts = path.relative(sourceDir, fpath).replace(/\\/g, '/').split('/');
    const library = parts.length >= 2 ? parts[0] : '';
    const sourceType = parts.length >= 3 ? parts[1] : '';
    const category = inferCategory(ext);

    let content: string;
    try {
      content = fs.readFileSync(fpath, 'utf-8');
    } catch {
      continue;
    }

    const lineCount = content.split('\n').length;
    const refs = extractReferences(content, ext);

    const obj: SourceObject = {
      name: stem,
      filename: path.basename(fpath).toLowerCase(),
      extension: ext,
      category,
      objectType: inferObjectType(sourceType, ext, category),
      library,
      sourceType,
      absPath: fpath,
      relPath,
      lineCount,
      reference: false,
      dependsOn: new Set(),
      dependedBy: new Set(),
      references: refs,
    };

    // Source takes precedence over .objrefs
    objects.set(stem, obj);
    rawRefs.set(stem, refs);

    if (progressCb) progressCb(i + 1, eligible.length, path.basename(fpath));
  }

  // Resolve edges
  const allNames = new Set(objects.keys());
  for (const [stem, refs] of rawRefs) {
    for (const r of refs) {
      if (allNames.has(r.target) && r.target !== stem) {
        objects.get(stem)!.dependsOn.add(r.target);
        objects.get(r.target)!.dependedBy.add(stem);
      }
    }
  }

  return objects;
}

// ═══════════════════════════════════════════════════════════════
//  1. Dependency Tree
// ═══════════════════════════════════════════════════════════════

export interface DependencyTreeNode {
  name: string;
  objectType?: string;
  library?: string;
  relPath?: string;
  truncated?: boolean;
  external?: boolean;
  children: DependencyTreeNode[];
}

/**
 * Build a dependency tree rooted at target.
 * direction="down": what does target depend on
 * direction="up": what depends on target
 */
export function dependencyTree(
  objects: Map<string, SourceObject>,
  target: string,
  direction: 'down' | 'up' = 'down',
  maxDepth: number = 10,
): {
  root: string;
  direction: string;
  totalNodes: number;
  tree: DependencyTreeNode | null;
  error?: string;
} {
  const key = target.toLowerCase();
  if (!objects.has(key)) {
    return {
      root: key,
      direction,
      totalNodes: 0,
      tree: null,
      error: `Object '${target}' not found`,
    };
  }

  function walk(name: string, depth: number, visited: Set<string>): DependencyTreeNode {
    if (depth > maxDepth || visited.has(name)) {
      return { name, truncated: true, children: [] };
    }
    visited.add(name);
    const obj = objects.get(name);
    if (!obj) return { name, external: true, children: [] };
    const neighbours = direction === 'down' ? obj.dependsOn : obj.dependedBy;
    const children = [...neighbours].sort().map((n) => walk(n, depth + 1, new Set(visited)));
    return {
      name,
      objectType: obj.objectType,
      library: obj.library,
      relPath: obj.relPath,
      children,
    };
  }

  function countNodes(node: DependencyTreeNode): number {
    return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
  }

  const tree = walk(key, 0, new Set());
  return { root: key, direction, totalNodes: countNodes(tree), tree };
}

// ═══════════════════════════════════════════════════════════════
//  2. Impact Analysis
// ═══════════════════════════════════════════════════════════════

/**
 * Given changed files, find all transitively affected objects (upstream — who depends on them).
 */
export function impactAnalysis(
  objects: Map<string, SourceObject>,
  changedFiles: string[],
): ImpactResult {
  const changed = new Set<string>();
  for (const f of changedFiles) {
    const stem = f.toLowerCase().split('.')[0];
    if (objects.has(stem)) changed.add(stem);
  }

  const affected = new Map<string, number>(); // name → depth
  const queue: Array<[string, number]> = [...changed].sort().map((n) => [n, 0]);
  const visited = new Set<string>(changed);

  while (queue.length > 0) {
    const [name, depth] = queue.shift()!;
    const obj = objects.get(name);
    if (!obj) continue;
    affected.set(name, depth);
    for (const parent of obj.dependedBy) {
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push([parent, depth + 1]);
      }
    }
  }

  // Group by depth
  const byDepth: ImpactResult['byDepth'] = {};
  for (const [name, depth] of affected) {
    if (!byDepth[depth]) byDepth[depth] = [];
    const obj = objects.get(name)!;
    byDepth[depth].push({
      name,
      objectType: obj.objectType,
      library: obj.library,
      relPath: obj.relPath,
      isChanged: changed.has(name),
    });
  }

  const directlyAffected = [...affected.entries()]
    .filter(([, d]) => d === 1)
    .map(([n]) => n)
    .sort();
  const transitivelyAffected = [...affected.entries()]
    .filter(([, d]) => d > 1)
    .map(([n]) => n)
    .sort();
  const affectedPrograms = [...affected.entries()]
    .filter(([n, d]) => d > 0 && objects.get(n)?.category === 'program')
    .map(([n]) => n)
    .sort();

  // Build order for affected items
  let bo: string[] = [];
  try {
    const fullBo = buildOrder(objects);
    const boSet = new Set([...affected.keys()].filter((n) => !changed.has(n)));
    bo = fullBo.order.filter((n) => boSet.has(n));
  } catch {
    /* empty */
  }

  return {
    changed: [...changed].sort(),
    totalAffected: affected.size,
    byDepth,
    directlyAffected,
    transitivelyAffected,
    affectedPrograms,
    buildOrder: bo,
  };
}

// ═══════════════════════════════════════════════════════════════
//  3. Topological Build Order (Kahn's Algorithm)
// ═══════════════════════════════════════════════════════════════

/**
 * Compute a topological build order.
 * If scope is given, only include those objects and their transitive dependencies.
 * Copybooks (COPY) are excluded since they're included, not compiled.
 */
export function buildOrder(objects: Map<string, SourceObject>, scope?: string[]): BuildOrderResult {
  // Determine included objects
  let included: Set<string>;
  if (scope) {
    included = new Set<string>();
    const queue = scope.map((s) => s.toLowerCase()).filter((s) => objects.has(s));
    const q: string[] = [...queue];
    while (q.length > 0) {
      const name = q.shift()!;
      if (included.has(name)) continue;
      included.add(name);
      const obj = objects.get(name);
      if (obj) {
        for (const dep of obj.dependsOn) {
          if (!included.has(dep)) q.push(dep);
        }
      }
    }
  } else {
    included = new Set(objects.keys());
  }

  // Filter to compilable (skip COPY)
  const compilable = new Set([...included].filter((n) => objects.get(n)?.objectType !== 'COPY'));

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const name of compilable) {
    inDegree.set(name, 0);
    adj.set(name, []);
  }
  for (const name of compilable) {
    const obj = objects.get(name)!;
    for (const dep of obj.dependsOn) {
      if (compilable.has(dep)) {
        adj.get(dep)!.push(name);
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }
  }

  const queue = [...compilable].filter((n) => inDegree.get(n) === 0).sort();
  const order: string[] = [];
  const buildSteps: BuildOrderResult['buildSteps'] = [];
  const levels: Record<string, number> = {};
  const nodeLevel = new Map<string, number>();
  for (const n of compilable) nodeLevel.set(n, 0);

  let step = 1;
  while (queue.length > 0) {
    const name = queue.shift()!;
    const obj = objects.get(name)!;
    order.push(name);
    buildSteps.push({
      step,
      name,
      objectType: obj.objectType,
      library: obj.library,
      relPath: obj.relPath,
    });
    levels[name] = nodeLevel.get(name) ?? 0;
    step++;
    for (const child of (adj.get(name) ?? []).sort()) {
      const deg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, deg);
      nodeLevel.set(child, Math.max(nodeLevel.get(child) ?? 0, (nodeLevel.get(name) ?? 0) + 1));
      if (deg === 0) queue.push(child);
    }
  }

  const cycles = [...compilable].filter((n) => (inDegree.get(n) ?? 0) > 0).sort();

  return { totalObjects: compilable.size, total: order.length, order, levels, buildSteps, cycles };
}

// ═══════════════════════════════════════════════════════════════
//  4. Build Script Generation
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a build script (CL commands or JSON) from the topological build order.
 */
export function generateBuildScript(
  objects: Map<string, SourceObject>,
  format: 'cl' | 'json' = 'cl',
  scope?: string[],
): BuildScriptResult {
  const orderResult = buildOrder(objects, scope);
  const steps = orderResult.buildSteps;

  if (format === 'json') {
    const jsonSteps = steps.map((s) => {
      const obj = objects.get(s.name)!;
      const srcMember = obj.name.toUpperCase();
      const srcFile = obj.sourceType.toUpperCase() || 'QSRC';
      const lib = obj.library.toUpperCase() || '*CURLIB';
      let cmd = COMPILE_CMD_MAP[obj.objectType] ?? 'CRTOBJ';
      if (obj.objectType === 'PGM' && ['clle', 'clp'].includes(obj.extension)) cmd = 'CRTBNDCL';
      return {
        step: s.step,
        command: cmd,
        object: srcMember,
        library: lib,
        sourceFile: srcFile,
        sourceMember: srcMember,
        objectType: obj.objectType,
        relPath: obj.relPath,
      };
    });
    return {
      format: 'json',
      totalSteps: jsonSteps.length,
      steps: jsonSteps,
      cycles: orderResult.cycles,
    };
  }

  // CL format
  const clLines: string[] = [
    '/* ============================================= */',
    '/* OpenCob Auto-Generated Build Script           */',
    '/* ============================================= */',
    '',
  ];
  for (const s of steps) {
    const obj = objects.get(s.name)!;
    const srcMember = obj.name.toUpperCase();
    const srcFile = obj.sourceType.toUpperCase() || 'QSRC';
    const lib = obj.library.toUpperCase() || '*CURLIB';
    let cmd = COMPILE_CMD_MAP[obj.objectType] ?? 'CRTOBJ';
    if (obj.objectType === 'PGM' && ['clle', 'clp'].includes(obj.extension)) cmd = 'CRTBNDCL';

    if (obj.objectType === 'FILE') {
      const fileCmd = obj.extension === 'lf' ? 'CRTLF' : 'CRTPF';
      clLines.push(
        `${fileCmd} FILE(${lib}/${srcMember}) SRCFILE(${lib}/${srcFile}) SRCMBR(${srcMember})`,
      );
    } else if (obj.objectType === 'DSPF' || obj.objectType === 'PRTF') {
      clLines.push(
        `${cmd} FILE(${lib}/${srcMember}) SRCFILE(${lib}/${srcFile}) SRCMBR(${srcMember})`,
      );
    } else if (obj.objectType === 'PGM') {
      clLines.push(
        `${cmd} PGM(${lib}/${srcMember}) SRCFILE(${lib}/${srcFile}) SRCMBR(${srcMember})`,
      );
    } else if (obj.objectType === 'CMD') {
      clLines.push(
        `CRTCMD CMD(${lib}/${srcMember}) PGM(${lib}/${srcMember}) SRCFILE(${lib}/${srcFile})`,
      );
    } else {
      clLines.push(`/* ${cmd} ${lib}/${srcMember} — manual review needed */`);
    }
  }

  return {
    format: 'cl',
    totalSteps: steps.length,
    script: clLines.join('\n'),
    cycles: orderResult.cycles,
  };
}

// ═══════════════════════════════════════════════════════════════
//  5. Repo Summary / Stats
// ═══════════════════════════════════════════════════════════════

/**
 * High-level stats about the repo's dependency graph.
 */
export function repoSummary(objects: Map<string, SourceObject>): RepoSummary {
  const byObjectType: Record<string, number> = {};
  const byLibrary: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let totalEdges = 0;
  const orphans: string[] = [];

  for (const obj of objects.values()) {
    byObjectType[obj.objectType] = (byObjectType[obj.objectType] ?? 0) + 1;
    if (obj.library) byLibrary[obj.library] = (byLibrary[obj.library] ?? 0) + 1;
    byCategory[obj.category] = (byCategory[obj.category] ?? 0) + 1;
    totalEdges += obj.dependsOn.size;
    if (obj.dependsOn.size === 0 && obj.dependedBy.size === 0) {
      orphans.push(obj.name);
    }
  }

  // Top 20 most depended-upon
  const ranked = [...objects.values()]
    .filter((o) => o.dependedBy.size > 0)
    .sort((a, b) => b.dependedBy.size - a.dependedBy.size)
    .slice(0, 20);

  return {
    totalObjects: objects.size,
    totalEdges,
    byObjectType,
    byLibrary,
    byCategory,
    orphansCount: orphans.length,
    orphansSample: orphans.sort().slice(0, 50),
    mostDependedOn: ranked.map((o) => ({
      name: o.name,
      library: o.library,
      objectType: o.objectType,
      dependedByCount: o.dependedBy.size,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════
//  6. Unresolved References
// ═══════════════════════════════════════════════════════════════

/**
 * Find all references pointing to objects NOT in the scanned repo.
 */
export function unresolvedReferences(objects: Map<string, SourceObject>): UnresolvedRef[] {
  const allNames = new Set(objects.keys());
  const unresolved = new Map<string, string[]>();

  for (const obj of objects.values()) {
    for (const ref of obj.references) {
      if (!CROSS_REF_TYPES.has(ref.refType)) continue;
      if (!allNames.has(ref.target)) {
        if (!unresolved.has(ref.target)) unresolved.set(ref.target, []);
        unresolved.get(ref.target)!.push(obj.name);
      }
    }
  }

  return [...unresolved.entries()]
    .map(([name, refs]) => ({
      name,
      referencedByCount: refs.length,
      referencedBy: [...new Set(refs)].sort().slice(0, 20),
    }))
    .sort((a, b) => b.referencedByCount - a.referencedByCount);
}

// ═══════════════════════════════════════════════════════════════
//  7. Impact Markdown Report
// ═══════════════════════════════════════════════════════════════

/**
 * Generate an impact.md markdown report for a set of changed files.
 * Compatible with Source Orbit's IMD format.
 */
export function impactMarkdown(objects: Map<string, SourceObject>, changedFiles: string[]): string {
  const changedStems = changedFiles.map((f) => f.toLowerCase().split('.')[0]);
  const touched = changedStems.filter((s) => objects.has(s)).map((s) => objects.get(s)!);
  const lines: string[] = [];

  if (touched.length > 0) {
    lines.push('## Impact Analysis', '', 'Touched objects:', '');
    for (const obj of touched) {
      lines.push(`* \`${obj.name.toUpperCase()}.${obj.objectType}\`: \`${obj.relPath}\``);
    }
    lines.push('', '---', '');

    for (const obj of touched) {
      lines.push(`### \`${obj.name.toUpperCase()}.${obj.objectType}\``, '');
      const impacted = renderImpactTree(objects, obj);
      if (impacted.length <= 1) {
        lines.push('Changes to this object have no impact.', '');
      } else {
        lines.push(...impacted, '');
      }
    }
  }

  return lines.join('\n');
}

function renderImpactTree(objects: Map<string, SourceObject>, root: SourceObject): string[] {
  const result: string[] = [];
  const visited: string[] = [];

  function walk(obj: SourceObject, depth: number): void {
    const indent = '  '.repeat(depth);
    result.push(`${indent}* \`${obj.name.toUpperCase()}.${obj.objectType}\` (\`${obj.relPath}\`)`);
    visited.push(obj.name);
    for (const parentName of [...obj.dependedBy].sort()) {
      if (!visited.includes(parentName)) {
        const parent = objects.get(parentName);
        if (parent) walk(parent, depth + 1);
      }
    }
    visited.pop();
  }

  walk(root, 0);
  return result;
}
