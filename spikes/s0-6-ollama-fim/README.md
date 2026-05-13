# S0-6: Ollama FIM Inline Completion Prototype

**Duration**: 2 days  
**Validates**: ADR-005 (Ollama-first), ADR-011 (Dual-model FIM)  
**Status**: NOT STARTED

## Objective

Build a working inline completion prototype using Ollama's `/api/generate` endpoint with FIM (Fill-in-the-Middle) tokens. Measure latency and quality.

## Implementation

```typescript
// FIM prompt format for Qwen2.5-Coder
const fimPrompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
```

### VS Code Integration

- Register `vscode.InlineCompletionItemProvider`
- Debounce at 300ms
- Cancel in-flight requests on new keystrokes
- Show ghost text with Tab to accept

## Models to Test

| Model | Size | Expected Latency |
|---|---|---|
| `qwen2.5-coder:0.5b` | 0.5B | <200ms |
| `qwen2.5-coder:1.5b` | 1.5B | <500ms |
| `qwen2.5-coder:3b` | 3B | <1000ms |
| `deepseek-coder:1.3b` | 1.3B | <500ms |

## Metrics

| Metric | Target |
|---|---|
| Time-to-first-token | <200ms (1.5B model) |
| Full completion time | <500ms |
| Cancel rate | Measure how often user types before completion arrives |
| Accept rate | Measure Tab acceptance vs. continued typing |

## Deliverables

- [ ] `src/inline-completion-provider.ts` — working VS Code provider
- [ ] `results/latency.md` — per-model latency measurements
- [ ] `README.md` — updated with model recommendation
