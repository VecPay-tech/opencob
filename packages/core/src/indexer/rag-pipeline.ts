import type { CodeChunk } from '../indexer/workspace-indexer.js';

/** A retrieved context item with relevance score */
export interface RetrievedContext {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  source: 'semantic' | 'keyword' | 'mention' | 'dependency' | 'recent';
}

export interface RetrievalOptions {
  topK?: number;
  minScore?: number;
  includeImports?: boolean;
  sources?: RetrievedContext['source'][];
}

/** Simple TF-IDF style scoring for keyword search */
function tokenize(text: string): string[] {
  return text
    // Split camelCase/PascalCase before lowercasing
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * In-memory vector store using cosine similarity on simple token embeddings.
 * This is a lightweight embedded alternative to LanceDB/Qdrant
 * that works with zero external dependencies for the CE edition.
 */
export class VectorStore {
  private documents: Map<string, { chunk: CodeChunk; vector: Map<string, number> }> = new Map();
  private idf: Map<string, number> = new Map();
  private dirty = false;

  /** Add or update a code chunk */
  upsert(chunk: CodeChunk): void {
    const tokens = tokenize(chunk.content);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    // Normalize TF
    const maxTf = Math.max(...tf.values(), 1);
    const normalized = new Map<string, number>();
    for (const [term, count] of tf) {
      normalized.set(term, count / maxTf);
    }
    this.documents.set(chunk.id, { chunk, vector: normalized });
    this.dirty = true;
  }

  /** Remove all chunks for a file */
  removeFile(filePath: string): void {
    for (const [id, doc] of this.documents) {
      if (doc.chunk.filePath === filePath) {
        this.documents.delete(id);
      }
    }
    this.dirty = true;
  }

  /** Rebuild IDF after bulk operations */
  rebuildIndex(): void {
    this.idf.clear();
    const N = this.documents.size;
    if (N === 0) return;

    const docFreq = new Map<string, number>();
    for (const doc of this.documents.values()) {
      for (const term of doc.vector.keys()) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log(1 + N / df));
    }
    this.dirty = false;
  }

  /** Search for chunks relevant to a query */
  search(query: string, topK: number = 10): RetrievedContext[] {
    if (this.dirty) {
      this.rebuildIndex();
    }

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // Build query vector (TF-IDF)
    const queryTf = new Map<string, number>();
    for (const token of queryTokens) {
      queryTf.set(token, (queryTf.get(token) ?? 0) + 1);
    }
    const maxQTf = Math.max(...queryTf.values(), 1);
    const queryVector = new Map<string, number>();
    for (const [term, count] of queryTf) {
      const idf = this.idf.get(term) ?? 0;
      queryVector.set(term, (count / maxQTf) * idf);
    }

    // Score each document via cosine similarity
    const scores: Array<{ id: string; score: number }> = [];
    for (const [id, doc] of this.documents) {
      let dotProduct = 0;
      let docMag = 0;
      for (const [term, weight] of doc.vector) {
        const tfidf = weight * (this.idf.get(term) ?? 0);
        docMag += tfidf * tfidf;
        const qWeight = queryVector.get(term);
        if (qWeight) {
          dotProduct += tfidf * qWeight;
        }
      }
      docMag = Math.sqrt(docMag);
      let queryMag = 0;
      for (const w of queryVector.values()) {
        queryMag += w * w;
      }
      queryMag = Math.sqrt(queryMag);

      const denom = docMag * queryMag;
      const score = denom > 0 ? dotProduct / denom : 0;
      if (score > 0) {
        scores.push({ id, score });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    const topResults = scores.slice(0, topK);

    return topResults.map((s) => {
      const doc = this.documents.get(s.id)!;
      return {
        filePath: doc.chunk.filePath,
        startLine: doc.chunk.startLine,
        endLine: doc.chunk.endLine,
        content: doc.chunk.content,
        score: s.score,
        source: 'semantic' as const,
      };
    });
  }

  /** Get total document count */
  size(): number {
    return this.documents.size;
  }
}

/**
 * RAG Pipeline — retrieves relevant code context for LLM prompts.
 * Combines semantic search (vector store) + keyword search + dependency context.
 */
export class RAGPipeline {
  private vectorStore: VectorStore;
  private allChunks: CodeChunk[] = [];
  private recentFiles: string[] = [];
  private maxRecentFiles = 10;

  constructor() {
    this.vectorStore = new VectorStore();
  }

  /** Index code chunks for semantic search */
  indexChunks(chunks: CodeChunk[]): void {
    this.allChunks = [...chunks];
    for (const chunk of chunks) {
      this.vectorStore.upsert(chunk);
    }
    this.vectorStore.rebuildIndex();
  }

  /** Re-index a single file's chunks */
  reindexFile(filePath: string, chunks: CodeChunk[]): void {
    this.allChunks = this.allChunks.filter((c) => c.filePath !== filePath);
    this.allChunks.push(...chunks);
    this.vectorStore.removeFile(filePath);
    for (const chunk of chunks) {
      this.vectorStore.upsert(chunk);
    }
    this.vectorStore.rebuildIndex();
  }

  /** Remove a file from the index */
  removeFile(filePath: string): void {
    this.vectorStore.removeFile(filePath);
  }

  /** Track a recently edited file */
  trackRecentEdit(filePath: string): void {
    this.recentFiles = [filePath, ...this.recentFiles.filter((f) => f !== filePath)].slice(
      0,
      this.maxRecentFiles,
    );
  }

  /** Retrieve relevant context for a query */
  retrieve(query: string, options?: RetrievalOptions): RetrievedContext[] {
    const topK = options?.topK ?? 10;
    const minScore = options?.minScore ?? 0.01;

    // 1. Semantic search (TF-IDF vector similarity)
    const semanticResults = this.vectorStore.search(query, topK * 2);

    // 2. Keyword search fallback (F8.2) — regex/substring match
    const keywordResults = this.keywordSearch(query, topK);

    // 3. Recent file context
    const recentResults = this.getRecentContext(topK);

    // Merge all sources, deduplicate
    const all = [...semanticResults, ...keywordResults, ...recentResults];
    const filtered = all.filter((r) => r.score >= minScore);

    // Deduplicate by file+range
    const seen = new Set<string>();
    const deduped: RetrievedContext[] = [];
    for (const result of filtered) {
      const key = `${result.filePath}:${result.startLine}-${result.endLine}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(result);
      }
    }

    // Sort by score descending, limit to topK
    deduped.sort((a, b) => b.score - a.score);
    return deduped.slice(0, topK);
  }

  /** Keyword/regex search across indexed chunks */
  private keywordSearch(query: string, topK: number): RetrievedContext[] {
    const results: RetrievedContext[] = [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

    for (const chunk of this.allChunks) {
      const contentLower = chunk.content.toLowerCase();
      let matchCount = 0;
      for (const word of queryWords) {
        if (contentLower.includes(word)) matchCount++;
      }
      if (matchCount > 0) {
        const score = matchCount / queryWords.length * 0.5; // keyword scores are 0–0.5
        results.push({
          filePath: chunk.filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          score,
          source: 'keyword',
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /** Get context from recently edited files */
  private getRecentContext(topK: number): RetrievedContext[] {
    const results: RetrievedContext[] = [];
    for (const filePath of this.recentFiles.slice(0, 3)) {
      const fileChunks = this.allChunks.filter((c) => c.filePath === filePath);
      for (const chunk of fileChunks.slice(0, 2)) {
        results.push({
          filePath: chunk.filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          score: 0.3, // Fixed moderate score for recency
          source: 'recent',
        });
      }
    }
    return results.slice(0, topK);
  }

  /** Get recently edited files list */
  getRecentFiles(): string[] {
    return [...this.recentFiles];
  }

  /** Get vector store size */
  getIndexSize(): number {
    return this.vectorStore.size();
  }
}
