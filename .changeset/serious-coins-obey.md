---
'@opencob/core': patch
---

Fix orchestrator integration reliability by preserving subtask failure reasons and correcting change-summary line aggregation based on actual tool execution results.

This improves error visibility in orchestrator mode and makes file-change summaries accurate for repeated edits and diff-based tool calls.
