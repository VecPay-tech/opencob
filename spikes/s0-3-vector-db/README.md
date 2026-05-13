# S0-3: Vector DB Benchmark — LanceDB vs sqlite-vec

**Duration**: 2 days  
**Validates**: ADR-004 (LanceDB for CE, Qdrant for EE)  
**Status**: NOT STARTED

## Objective

Performance comparison of LanceDB embedded vs sqlite-vec on a realistic workspace of 50K code chunks.

## Test Parameters

- **Dataset**: 50,000 code chunks (avg 200 tokens each) from a real COBOL + TypeScript codebase
- **Embedding model**: Ollama `nomic-embed-text` (768 dims)
- **Operations**: Insert, query (top-10), incremental update, cold start

## Metrics to Capture

| Metric | LanceDB | sqlite-vec |
|---|---|---|
| Bulk insert (50K chunks) | | |
| Single query (top-10, 768d) | | |
| 100 queries p50/p99 | | |
| Cold start (first query after process restart) | | |
| Incremental update (1K chunks) | | |
| Disk size (50K chunks) | | |
| Memory usage (RSS) | | |

## Success Criteria

- [ ] LanceDB single-query latency < 50ms for 50K chunks
- [ ] LanceDB bulk insert < 60s for 50K chunks
- [ ] Disk usage < 500MB for 50K chunks
- [ ] No NPM native module issues on Windows/macOS/Linux

## Deliverables

- [ ] `src/benchmark.ts` — benchmark harness
- [ ] `results/` — raw benchmark data
- [ ] `README.md` — updated with findings, recommendation, and charts
