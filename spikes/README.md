# Sprint 0 — Validation Spikes

This directory contains time-boxed validation tasks that de-risk our architecture decisions before Sprint 1 begins.

## Tasks

| Dir | Task | Duration | Validates |
|---|---|---|---|
| `s0-1-continue-eval/` | Continue codebase evaluation | 1 week | ADR-001 |
| `s0-2-state-machine/` | Custom state machine prototype | 3 days | ADR-003 |
| `s0-3-vector-db/` | LanceDB vs sqlite-vec benchmark | 2 days | ADR-004 |
| `s0-4-webview-perf/` | React WebView cold-start measurement | 1 day | ADR-006 |
| `s0-5-treesitter-cobol/` | Tree-sitter COBOL grammar eval | 3 days | ADR-008 |
| `s0-6-ollama-fim/` | Ollama FIM inline completion prototype | 2 days | ADR-005/011 |
| `s0-7-chat-api/` | VS Code Chat Participant API eval | 1 day | ADR-006 |
| `s0-8-codex-driverx/` | Codex/DriverX integration spike | 3 days | EE value |

## Deliverable Format

Each spike directory should contain:
- `README.md` — findings, decision, and recommendation
- `src/` — prototype code (if applicable)
- `results/` — benchmarks, screenshots, measurements

## Timeline

All tasks can be parallelized across 2-3 engineers in ~1.5 weeks.
