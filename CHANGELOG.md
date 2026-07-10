# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Diagram Engine** — direction override parameter (`LR`, `RL`, `TD`, `BT`) for all Mermaid diagram types
- **Diagram Engine** — collapsed procedure_flow for programs with >100 paragraphs (groups into section-level nodes)
- **Diagram Engine** — `fileId` property on `DiagramNode` for cross-reference linking
- **Diagram Engine** — `cachedTypes` field in availability response showing which types are pre-cached
- **Diagram Engine** — reverse `usage_map` enrichment (scans workspace for files that CALL/COPY the current file)
- **Diagram Engine** — expanded inbound reference scan (3 directory levels, 500 files max)
- **IBM i** — source physical file name resolver (`ibmi-name-resolver.ts`) mapping SRCPF names to extensions
- **DSPF Enhancements** — `humanizeFieldLabel()` with TEXT > ALIAS > known-name > prefix-strip priority
- **DSPF Enhancements** — `assignFunctionKeyLabels()` for FK field detection and sorting
- **DSPF Enhancements** — `resolveMsgcon()` for MSGCON keyword resolution to message text
- **DSPF Enhancements** — `extractClDriverTitle()` for companion CL driver title/transaction extraction
- **DSPF Enhancements** — `resolveHeaderValue()` for framework header field resolution
- **DSPF Enhancements** — `generateFieldLegend()` for INPUT/OUTPUT field table in ASCII art
- **Tests** — 40-test `diagram-parity-v2.test.ts` covering all gap closures
- **Metrics** — cyclomatic complexity calculator (`computeCyclomaticComplexity`) following McCabe's method
- **Metrics** — max nesting depth tracker for IF/EVALUATE/PERFORM blocks
- **Metrics** — full `ComplexityScore` analysis: code lines, comment ratio, keyword counts, risk score
- **Metrics** — risk classification (`low`/`medium`/`high`/`critical`) with configurable thresholds
- **Metrics** — `aggregateScores()` for bulk scan summaries across multiple files
- **Dependency Graph** — weighted `DependencyGraph` class with CALL=1.0, COPY=0.8, FILE_IO=0.6 coupling
- **Dependency Graph** — BFS transitive traversal (forward/reverse) with weight accumulation
- **Dependency Graph** — Tarjan's SCC algorithm for cycle detection
- **Security** — `propagateVulnerabilities()` via reverse dependency graph with severity degradation per hop
- **Security** — `degradeSeverity()` with ordered severity levels (critical→high→medium→low→info)
- **REFFLD** — cross-file field length resolver (`resolveReffldLengths`) parsing sibling PF files
- **REFFLD** — `RFDUMMY(NNN)` pattern extraction for hardcoded length hints
- **MSGCON** — bulk pre-scan (`prefetchMsgconCache`) scanning CL files for MSGCON/SNDPGMMSG/CHGMSGD
- **MSGCON** — `lookupMsgcon()` with fallback to 17 known IBM system messages
- **Flow Parser** — string literal preservation preventing false keyword matches inside quotes
- **Diagram Engine** — enhanced error messages with per-type requirement hints
- **Tests** — 32-test `diagram-parity-v3.test.ts` covering metrics, graph, propagation, REFFLD, MSGCON
- **Dependency Engine** — full repo scanner with regex-based reference extraction (COPY, CALL, CICS, DCLF, REFFLD, SBMJOB)
- **Dependency Engine** — dependency tree builder (upstream/downstream) with configurable max depth
- **Dependency Engine** — impact analysis (BFS propagation with depth grouping, affected programs, build order)
- **Dependency Engine** — topological build order via Kahn's algorithm (full or scoped, cycle detection)
- **Dependency Engine** — CL/JSON build script generation with IBM i compile command mapping
- **Dependency Engine** — repo summary/stats (object type distribution, orphan detection, top-depended ranking)
- **Dependency Engine** — unresolved reference detection (missing COPY/CALL/DCLF targets)
- **Dependency Engine** — Source Orbit compatible impact markdown report generation
- **Dependency Engine** — `.objrefs` file support for external object declarations
- **Quality Rules** — 9-checker engine ported from Codex: structure_count, block_size, nesting_depth, unused_detection, naming_convention, documentation_check, program_id_filename, duplicate_detection, move_analysis
- **Quality Rules** — 13 default rules with configurable severity, debt minutes, and max-per-file limits
- **Quality Rules** — multi-file scanner with aggregate issue counts and technical debt calculation
- **Quality Rules** — dead code detection (unused paragraphs, data items, 88-level conditions)
- **Quality Rules** — PROGRAM-ID vs filename mismatch detection
- **Quality Rules** — self-assignment MOVE detection (bug-risk category)
- **Quality Rules** — duplicate string literal detection (maintainability category)
- **Tests** — 37-test `diagram-parity-v4.test.ts` covering dependency engine + quality rules

- **Diagram Engine** — `usage_map` diagram type showing outgoing calls, copies, and file I/O from any legacy file
- **Diagram Engine** — inbound reference enrichment for `dependency_map`/`copybook_tree` (scans sibling files for COPY refs)
- **Diagram Engine** — evidence-based availability detection via `getAvailableDiagramsFromContent()` for both legacy and modern files
- **Diagram Engine** — section picker support via `getSectionsFromContent()` for control_flow diagrams
- **Diagram Engine** — SHA-256 content-keyed diagram cache (`diagram-cache.ts`) with 5-min TTL
- **Diagram Engine** — stable external API contract (`diagram-api.ts`) with `listAvailableTypes`, `generateDiagram`, `listSections`, cache invalidation
- **Diagram Engine** — 37 parity tests in `diagram-parity.test.ts` covering extension coverage, type coverage, availability rules, API shape
- **Extension** — QuickPick now shows "(recommended: type)" based on content analysis
- **Extension** — menu regex aligned with full core extension registry (34 legacy + 9 modern extensions)
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

### Fixed

- **Extension UI alignment** — refreshed OpenCob sidebar/view wiring to better match DESIGN.md interaction flow while keeping manifest-compatible contribution points.
- **Settings Surface** — restored Settings webview contribution and provider registration in extension activation flow.
- **Findings Workflow** — run initial findings scan after workspace indexing and keep Findings tree synchronized on workspace scan/save.
- **Findings Commands** — normalized command registration so `OpenCob.showFindings` is registered once (avoids repeated registration on each file save).
