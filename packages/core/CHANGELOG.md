# @opencob/core

## 0.1.1

### Patch Changes

- 3f422f5: Fix orchestrator integration reliability by preserving subtask failure reasons and correcting change-summary line aggregation based on actual tool execution results.

  This improves error visibility in orchestrator mode and makes file-change summaries accurate for repeated edits and diff-based tool calls.

- 4116e12: Fix core and extension defects found during local testing:
  - core: send `max_completion_tokens` (and omit unsupported `temperature`) for Azure/OpenAI GPT-5 and o-series models so requests no longer fail with a 400 "Unsupported parameter" error.
  - core: process one tool call per round so parallel tool calls from the model no longer leave orphaned "running…" tool cards.
  - extension: repair the chat webview inline script (a template-literal escape produced invalid JS), restore the welcome screen for empty conversations, and finalize lingering tool cards on response end.
  - extension: harden activation secret migration to avoid a re-entrant config-change/testConnection cascade that slowed startup.
  - extension: render "Generate Diagram" in an interactive webview with mermaid bundled locally (offline-safe), a proper Content-Security-Policy, and auto-fit on first render.
