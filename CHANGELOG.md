# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Agent Loop** — Plan→Execute→Verify with self-correction and orchestrator delegation
- **Mode System** — 5 built-in modes (Code, Ask, Plan, Advanced, Orchestrator) + custom YAML
- **Tool System** — 20 tools: read/write/search/execute/analyze/MCP/mode/undo/todo
- **Two-stage command approval** — Risk detection (10 patterns), AST validation, allowlist enforcement
- **MCP Client** — Stdio + SSE transports, server lifecycle, tool discovery
- **Inline Completion** — FIM via Ollama, debounce, Tab accept, cross-file context, partial accept
- **Chat Panel** — WebView sidebar with streaming, code blocks, diff preview, auto-approve toolbar, enhance prompt button
- **Conversation Manager** — CRUD, disk persistence, context trimming, auto-titling, Markdown export
- **Conversation Compactor** — LLM-based summarization for context window management
- **Workspace Indexer + RAG** — TF-IDF vector store, code definition extraction, dependency graph
- **Findings Scanner** — Background scanning: secrets, SQL injection, nesting depth, TODOs, dead code
- **Privacy & Redaction** — 7+ redaction rules, .opencobignore, air-gapped mode
- **Context Mentions** — @file, @folder, @git-changes, @git-commit, @terminal, @problems, @url
- **Prompt Enhancement** — LLM-powered prompt refinement before sending
- **Legacy Parsers** — COBOL (divisions, copybooks, CICS, SQL), RPG (free/fixed), PL/I (procedures, %INCLUDE)
- **Modernization Assistant** — COBOL→Java entity generation, copybook→DTO, test stubs
- **Configuration System** — Project + global `.OpenCob/` config with precedence
- **Slash Commands** — /code, /ask, /plan, /advanced, /orchestrator, /undo, /help, /explain, /fix, /test, /review + custom
- **Literate Coding** — `// @OpenCob:` marker detection, in-place code generation
- **Skills System** — `.OpenCob/skills/` loader with YAML frontmatter
- **Checkpoints** — Shadow Git snapshots, turn-level rollback
- **BYOM** — Ollama adapter, model routing per task type (chat/completion/planning)
- **CLI** — Interactive REPL + `--task` non-interactive mode
- **Post-Edit Verifier** — Syntax validation (JSON, JS/TS, Python, YAML, XML) after writes
- **Task Complexity** — Request complexity scoring, LLM parameter adjustment
- **CE↔EE Client** — Server discovery, token auth, health monitoring, capabilities
- Governance files: LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY
- CI workflows: ci.yaml, codeql.yaml, dependency-review.yaml, release.yaml
- Community templates: CODEOWNERS, issue templates, PR template
- Renovate config for automated dependency updates
