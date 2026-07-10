/**
 * MSGCON Bulk Scanner — Background pre-scan for message constant resolution.
 *
 * Ported from Codex api.py `_startup_msgcon_scan()` background thread.
 * Scans CL menu drivers in the workspace to extract MSGCON→message mappings.
 * Populates an in-memory cache used by resolveMsgcon() in dspf-enhancements.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Resolved MSGCON entry */
export interface MsgconEntry {
  msgId: string;
  msgFile: string;
  msgLib: string;
  resolvedText: string;
  sourceFile: string; // CL file where the MSGCON was found
}

/** MSGCON cache: msgId → MsgconEntry */
const MSGCON_CACHE = new Map<string, MsgconEntry>();

/** CL file extensions to scan */
const CL_EXTENSIONS = new Set(['.clle', '.clp', '.cmd', '.mnu', '.cl']);

/** Known IBM messages (base set from QCPFMSG, QUSRMSG) */
const KNOWN_MESSAGES: Record<string, string> = {
  CPF0001: 'Error found on command',
  CPF0002: 'Not valid',
  CPF9801: 'Object not found',
  CPF9802: 'Not authorized to object',
  CPF9810: 'Library not found',
  CPF9811: 'Program not found',
  CPF9812: 'File not found',
  CPF9820: 'Not authorized to use library',
  CPF9830: 'Cannot assign library',
  CPF9871: 'Error occurred while processing',
  CPF9872: 'Program or service program error',
  CPD0006: 'Errors on command',
  CPD0030: 'Character value for parameter not valid',
  CPD0074: 'Not enough characters',
  CPD0078: 'Value for parameter not valid',
  USR0001: 'User message 1',
  USR0002: 'User message 2',
};

/**
 * Pre-scan workspace for CL files and extract MSGCON references.
 * Non-blocking: returns a Promise that resolves when scan is complete.
 *
 * @param sourceDir Root directory to scan
 * @param maxFiles Maximum number of CL files to process
 * @param maxDepth Maximum directory recursion depth
 * @returns Number of MSGCON entries resolved
 */
export async function prefetchMsgconCache(
  sourceDir: string,
  maxFiles: number = 200,
  maxDepth: number = 4,
): Promise<number> {
  const clFiles = findClFiles(sourceDir, maxFiles, maxDepth);
  let resolved = 0;

  for (const clFile of clFiles) {
    try {
      const content = fs.readFileSync(clFile, 'utf-8');
      const entries = extractMsgconEntries(content, clFile);
      for (const entry of entries) {
        if (!MSGCON_CACHE.has(entry.msgId)) {
          MSGCON_CACHE.set(entry.msgId, entry);
          resolved++;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return resolved;
}

/**
 * Look up a message ID in the cache.
 * Falls back to KNOWN_MESSAGES if not found in scanned cache.
 */
export function lookupMsgcon(msgId: string): MsgconEntry | null {
  const upper = msgId.toUpperCase();
  const cached = MSGCON_CACHE.get(upper);
  if (cached) return cached;

  // Fallback to known messages
  const knownText = KNOWN_MESSAGES[upper];
  if (knownText) {
    return {
      msgId: upper,
      msgFile: 'QCPFMSG',
      msgLib: '*LIBL',
      resolvedText: knownText,
      sourceFile: '',
    };
  }

  return null;
}

/**
 * Get current cache contents (for diagnostics/export).
 */
export function getMsgconCache(): Map<string, MsgconEntry> {
  return new Map(MSGCON_CACHE);
}

/**
 * Get cache size.
 */
export function getMsgconCacheSize(): number {
  return MSGCON_CACHE.size;
}

/**
 * Clear the cache (useful for testing).
 */
export function clearMsgconCache(): void {
  MSGCON_CACHE.clear();
}

/**
 * Manually add entries to the cache (useful for testing or external sources).
 */
export function addMsgconEntry(entry: MsgconEntry): void {
  MSGCON_CACHE.set(entry.msgId.toUpperCase(), entry);
}

// ── Internal Helpers ────────────────────────────────────────

/**
 * Extract MSGCON entries from a CL file's content.
 */
function extractMsgconEntries(content: string, sourceFile: string): MsgconEntry[] {
  const entries: MsgconEntry[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const upper = line.toUpperCase();

    // Match MSGCON(length msgid msgfile [msglib])
    let match: RegExpExecArray | null;
    const re1 = /MSGCON\(\s*(\d+)\s+(\w+)\s+(\w+)(?:\s+(\w+))?\s*\)/gi;
    while ((match = re1.exec(upper)) !== null) {
      const msgId = match[2];
      const msgFile = match[3];
      const msgLib = match[4] ?? '*LIBL';
      const resolvedText = KNOWN_MESSAGES[msgId] ?? `[${msgId}]`;
      entries.push({ msgId, msgFile, msgLib, resolvedText, sourceFile });
    }

    // Match SNDPGMMSG with MSGID and MSGF
    const re2 = /SNDPGMMSG\s+.*MSGID\(\s*(\w+)\s*\).*MSGF\(\s*(?:(\w+)\/)?(\w+)\s*\)/gi;
    while ((match = re2.exec(upper)) !== null) {
      const msgId = match[1];
      const msgLib = match[2] ?? '*LIBL';
      const msgFile = match[3];
      const resolvedText = KNOWN_MESSAGES[msgId] ?? `[${msgId}]`;
      entries.push({ msgId, msgFile, msgLib, resolvedText, sourceFile });
    }

    // Match CHGMSGD with MSG text (actual message definitions)
    const re3 = /CHGMSGD\s+.*MSGID\(\s*(\w+)\s*\).*MSG\(\s*'([^']*)'\s*\)/gi;
    while ((match = re3.exec(line)) !== null) {
      const msgId = match[1].toUpperCase();
      const text = match[2];
      entries.push({
        msgId,
        msgFile: '',
        msgLib: '',
        resolvedText: text,
        sourceFile,
      });
    }
  }

  return entries;
}

/**
 * Find CL files in a directory tree.
 */
function findClFiles(dir: string, maxFiles: number, maxDepth: number): string[] {
  const results: string[] = [];
  scanDir(dir, results, maxFiles, maxDepth, 0);
  return results;
}

function scanDir(
  dir: string,
  results: string[],
  maxFiles: number,
  maxDepth: number,
  currentDepth: number,
): void {
  if (results.length >= maxFiles || currentDepth > maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;

    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CL_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    } else if (entry.isDirectory() && currentDepth < maxDepth) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      scanDir(fullPath, results, maxFiles, maxDepth, currentDepth + 1);
    }
  }
}
