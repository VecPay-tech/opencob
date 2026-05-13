import { describe, it, expect, beforeEach } from 'vitest';
import { RAGPipeline, VectorStore } from '../src/indexer/rag-pipeline.js';
import type { CodeChunk } from '../src/indexer/workspace-indexer.js';

describe('VectorStore', () => {
  let store: VectorStore;

  beforeEach(() => {
    store = new VectorStore();
  });

  it('indexes and searches documents', () => {
    store.upsert({
      id: 'file1:1-50',
      filePath: 'user-service.ts',
      startLine: 1,
      endLine: 50,
      content: 'export class UserService { async getUser(id) { return database.find(id); } }',
      language: 'typescript',
    });
    store.upsert({
      id: 'file2:1-30',
      filePath: 'order-service.ts',
      startLine: 1,
      endLine: 30,
      content: 'export class OrderService { async createOrder(data) { return database.insert(data); } }',
      language: 'typescript',
    });
    store.rebuildIndex();

    const results = store.search('user service get user', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe('user-service.ts');
  });

  it('returns empty for no matching query', () => {
    store.upsert({
      id: 'f:1-10',
      filePath: 'hello.ts',
      startLine: 1,
      endLine: 10,
      content: 'hello world greeting message',
      language: 'typescript',
    });
    store.rebuildIndex();

    const results = store.search('xyz123 nothing matches');
    expect(results.length).toBe(0);
  });

  it('removes file from index', () => {
    store.upsert({
      id: 'f:1-10',
      filePath: 'temp.ts',
      startLine: 1,
      endLine: 10,
      content: 'temporary file content',
      language: 'typescript',
    });
    expect(store.size()).toBe(1);

    store.removeFile('temp.ts');
    expect(store.size()).toBe(0);
  });
});

describe('RAGPipeline', () => {
  let rag: RAGPipeline;

  beforeEach(() => {
    rag = new RAGPipeline();
  });

  it('indexes chunks and retrieves relevant context', () => {
    const chunks: CodeChunk[] = [
      {
        id: 'auth:1-50',
        filePath: 'auth.ts',
        startLine: 1,
        endLine: 50,
        content: 'export class AuthService { async login(username, password) { validate credentials return token } }',
        language: 'typescript',
      },
      {
        id: 'db:1-50',
        filePath: 'database.ts',
        startLine: 1,
        endLine: 50,
        content: 'export class DatabasePool { connect() { open connection } query(sql) { execute query } }',
        language: 'typescript',
      },
    ];

    rag.indexChunks(chunks);
    const results = rag.retrieve('authentication login credentials');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe('auth.ts');
  });

  it('tracks recently edited files', () => {
    rag.trackRecentEdit('file1.ts');
    rag.trackRecentEdit('file2.ts');
    rag.trackRecentEdit('file1.ts'); // should deduplicate

    const recent = rag.getRecentFiles();
    expect(recent.length).toBe(2);
    expect(recent[0]).toBe('file1.ts'); // most recent first
  });

  it('re-indexes a single file', () => {
    rag.indexChunks([
      { id: 'a:1-10', filePath: 'a.ts', startLine: 1, endLine: 10, content: 'old content foo', language: 'ts' },
    ]);

    rag.reindexFile('a.ts', [
      { id: 'a:1-10', filePath: 'a.ts', startLine: 1, endLine: 10, content: 'new content bar baz', language: 'ts' },
    ]);

    expect(rag.getIndexSize()).toBe(1);
  });

  it('deduplicates results', () => {
    const chunks: CodeChunk[] = [
      { id: 'f:1-50', filePath: 'service.ts', startLine: 1, endLine: 50, content: 'user service management', language: 'ts' },
    ];
    rag.indexChunks(chunks);

    const results = rag.retrieve('user service', { topK: 5 });
    // Should not have duplicate entries for same file+range
    const keys = results.map((r) => `${r.filePath}:${r.startLine}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
