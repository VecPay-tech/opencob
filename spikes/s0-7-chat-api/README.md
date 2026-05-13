# S0-7: VS Code Chat Participant API Evaluation

**Duration**: 1 day  
**Validates**: ADR-006 (Confirm custom WebView needed over native chat API)  
**Status**: NOT STARTED

## Objective

Test VS Code's Chat Participant API to confirm it cannot deliver our mode/tool/approval UX. Document exactly why a custom WebView is required.

## Test Cases

1. Can we show a mode selector in the native chat?
2. Can we render tool approval buttons (Approve/Reject) inline?
3. Can we show file diffs inline in chat responses?
4. Can we render Mermaid diagrams inline?
5. Can we implement `@file` mentions with autocomplete?
6. Can we show a progress indicator for multi-step tasks?
7. Can we customize the chat input area (enhance prompt button, `/` commands)?

## Deliverables

- [ ] `results/api-evaluation.md` — pass/fail per test case with screenshots
- [ ] `README.md` — updated with recommendation
