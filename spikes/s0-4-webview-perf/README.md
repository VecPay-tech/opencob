# S0-4: React WebView Cold-Start Measurement

**Duration**: 1 day  
**Validates**: ADR-006 (React custom WebView)  
**Status**: NOT STARTED

## Objective

Measure extension activation → chat panel interactive time. Test Preact as a lighter alternative if React is too slow.

## Metrics

| Metric | React | Preact |
|---|---|---|
| Extension activation time | | |
| WebView first paint | | |
| WebView interactive (input responds) | | |
| Bundle size (gzipped) | | |

## Target

- Extension activation → chat interactive: **< 500ms**
- Bundle size: **< 200KB gzipped**

## Deliverables

- [ ] `src/` — minimal React + Preact WebView builds
- [ ] `results/perf.md` — timing measurements
- [ ] `README.md` — React vs Preact recommendation
