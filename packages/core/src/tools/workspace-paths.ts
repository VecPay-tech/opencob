import { resolve, relative, isAbsolute, basename } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Resolves a user-provided path against multiple workspace roots.
 * Supports:
 *   - Relative paths (resolved against primaryRoot first, then other roots)
 *   - Absolute paths (must be inside any allowed root)
 *   - Paths starting with a workspace folder name
 *   - Leading-slash paths on Windows (treated as relative)
 *   - Bare folder names matched as subfolder of any root
 *
 * Returns { absPath, relDisplay } or { error }.
 */
export interface ResolvedPath {
  absPath: string;
  /** Display-friendly relative path */
  relDisplay: string;
  /** Which root this path belongs to */
  root: string;
}

export interface PathError {
  error: string;
}

export type PathResolution = ResolvedPath | PathError;

export function isPathError(r: PathResolution): r is PathError {
  return 'error' in r;
}

export function resolveWorkspacePath(
  inputPath: string,
  primaryRoot: string,
  allRoots: string[],
): PathResolution {
  const roots = allRoots.length > 0 ? allRoots : [primaryRoot];
  const normalizedRoots = roots.map((r) => resolve(r));

  // On Windows, strip leading / that isn't a real absolute path
  // e.g. "/source" should be treated as relative "source"
  let cleaned = inputPath;
  if (process.platform === 'win32' && /^\/[^/]/.test(cleaned) && !cleaned.includes(':')) {
    cleaned = cleaned.slice(1);
  }

  let absPath: string;

  if (isAbsolute(cleaned)) {
    absPath = resolve(cleaned);
  } else {
    // Try primary root first
    absPath = resolve(primaryRoot, cleaned);

    // If it doesn't exist or resolves outside all roots, try each root
    if (!isInsideAnyRoot(absPath, normalizedRoots) || !existsSync(absPath)) {
      let found = false;
      for (const root of normalizedRoots) {
        const candidate = resolve(root, cleaned);
        if (isInsideAnyRoot(candidate, normalizedRoots) && existsSync(candidate)) {
          absPath = candidate;
          found = true;
          break;
        }
      }
      // If still not found with existence check, try without (for write operations)
      if (!found) {
        for (const root of normalizedRoots) {
          const candidate = resolve(root, cleaned);
          if (isInsideAnyRoot(candidate, normalizedRoots)) {
            absPath = candidate;
            found = true;
            break;
          }
        }
      }
    }
  }

  // Final security check
  const matchedRoot = findMatchingRoot(absPath, normalizedRoots);
  if (!matchedRoot) {
    return { error: 'Error: path is outside the workspace' };
  }

  const relDisplay = relative(matchedRoot, absPath) || '.';
  return { absPath, relDisplay, root: matchedRoot };
}

function isInsideAnyRoot(absPath: string, roots: string[]): boolean {
  const p = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  return roots.some((root) => {
    const r = process.platform === 'win32' ? root.toLowerCase() : root;
    return p === r || p.startsWith(r + '\\') || p.startsWith(r + '/');
  });
}

function findMatchingRoot(absPath: string, roots: string[]): string | undefined {
  const p = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  return roots.find((root) => {
    const r = process.platform === 'win32' ? root.toLowerCase() : root;
    return p === r || p.startsWith(r + '\\') || p.startsWith(r + '/');
  });
}
