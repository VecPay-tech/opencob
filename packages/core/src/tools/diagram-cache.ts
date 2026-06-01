/**
 * Diagram Cache — In-memory caching of diagram generation results.
 *
 * Keyed by hash(content) + diagramType + sectionId.
 * Invalidated on content change (different hash).
 * TTL-based eviction after 5 minutes of inactivity.
 */

import { createHash } from 'node:crypto';

export interface DiagramCacheEntry {
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  accessedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 100;

export class DiagramCache {
  private cache = new Map<string, DiagramCacheEntry>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private makeKey(
    contentHash: string,
    diagramType: string,
    sectionId?: number,
    direction?: string,
  ): string {
    return `${contentHash}::${diagramType}::${sectionId ?? ''}::${direction ?? ''}`;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Get a cached diagram result, or undefined if not cached / expired.
   */
  get(
    content: string,
    diagramType: string,
    sectionId?: number,
    direction?: string,
  ): DiagramCacheEntry | undefined {
    const hash = this.hashContent(content);
    const key = this.makeKey(hash, diagramType, sectionId, direction);
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    const now = Date.now();
    if (now - entry.accessedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    entry.accessedAt = now;
    return entry;
  }

  /**
   * Store a diagram result in the cache.
   */
  set(
    content: string,
    diagramType: string,
    result: string,
    metadata?: Record<string, unknown>,
    sectionId?: number,
    direction?: string,
  ): void {
    // Evict expired entries if nearing capacity
    if (this.cache.size >= MAX_ENTRIES) {
      this.evictExpired();
    }
    // If still full, evict oldest
    if (this.cache.size >= MAX_ENTRIES) {
      this.evictOldest();
    }

    const hash = this.hashContent(content);
    const key = this.makeKey(hash, diagramType, sectionId, direction);
    const now = Date.now();
    this.cache.set(key, {
      content: result,
      metadata,
      createdAt: now,
      accessedAt: now,
    });
  }

  /**
   * Invalidate all cache entries for a given content hash.
   */
  invalidate(content: string): void {
    const hash = this.hashContent(content);
    const prefix = `${hash}::`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Number of entries currently in cache.
   */
  get size(): number {
    return this.cache.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.accessedAt > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}

/** Singleton diagram cache instance */
export const diagramCache = new DiagramCache();
