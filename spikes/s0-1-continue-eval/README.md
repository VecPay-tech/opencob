# S0-1: Continue Codebase Evaluation

**Duration**: 1 week  
**Validates**: ADR-001 (Build from scratch vs. fork Continue)  
**Status**: NOT STARTED

## Objective

Deep evaluation of the Continue (continue.dev) codebase to confirm our "build from scratch" decision is correct. Document reuse opportunities vs. technical debt risk.

## Evaluation Areas

1. **Extension architecture** — How is it structured? Can we reuse the activation/webview pattern?
2. **Chat UI** — React webview implementation quality
3. **Inline completion** — FIM provider implementation
4. **Tool system** — Is it mode-based? Can we lift the tool abstraction?
5. **MCP integration** — How mature is their MCP client?
6. **Model adapters** — Provider abstraction pattern
7. **Legacy language support** — Any COBOL/RPG support?

## Deliverables

- [ ] `results/evaluation.md` — detailed assessment per area
- [ ] `results/reuse-candidates.md` — specific code patterns worth adopting (not copying)
- [ ] `README.md` — updated with final recommendation
