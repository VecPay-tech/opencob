# S0-2: Custom State Machine Prototype

**Duration**: 3 days  
**Validates**: ADR-003 (Custom state machine over LangGraph)  
**Status**: NOT STARTED

## Objective

Build a minimal agent orchestration state machine that handles our 5 core workflows in ~1000 lines of TypeScript. Prove we don't need LangGraph.

## Workflows to Validate

1. **Simple chat** — user message → LLM → response (no tools)
2. **Single tool call** — user message → LLM → tool call → tool result → LLM → response
3. **Multi-step agent** — user message → LLM → tool → LLM → tool → ... → response
4. **Self-correction** — execute_command fails → LLM reads error → generates fix → retries (max 3)
5. **Orchestrator delegation** — break task → delegate to Code mode → collect result → delegate to Ask mode → final response

## Success Criteria

- [ ] All 5 workflows pass with mock LLM responses
- [ ] Total implementation < 1500 LOC (excluding tests)
- [ ] State transitions are explicit and debuggable (log every transition)
- [ ] Approval gates work (pause state machine, wait for user approve/reject)
- [ ] Can serialize/deserialize state for persistence

## Implementation Plan

```typescript
// Core state machine types
type AgentState = 'idle' | 'thinking' | 'tool_call' | 'awaiting_approval' | 'executing' | 'self_correcting' | 'done' | 'error';

interface AgentContext {
  state: AgentState;
  messages: ChatMessage[];
  pendingToolCall?: ToolCall;
  retryCount: number;
  maxRetries: number;
}
```

## Deliverables

- [ ] `src/agent-state-machine.ts` — core implementation
- [ ] `src/agent-state-machine.test.ts` — tests for all 5 workflows
- [ ] `README.md` — updated with findings and recommendation
