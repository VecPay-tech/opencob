# OpenCob Community Edition

<p align="center">
  <strong>Open-Source Agentic AI Coding Assistant for Legacy & Modern Development</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://github.com/mountek/opencob/actions/workflows/ci.yaml"><img src="https://img.shields.io/github/actions/workflow/status/mountek/opencob/ci.yaml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/mountek/opencob/actions/workflows/codeql.yaml"><img src="https://img.shields.io/github/actions/workflow/status/mountek/opencob/codeql.yaml?branch=main&label=CodeQL" alt="CodeQL"></a>
  <a href="https://github.com/mountek/opencob/actions/workflows/secret-scan.yaml"><img src="https://img.shields.io/github/actions/workflow/status/mountek/opencob/secret-scan.yaml?branch=main&label=Secret%20Scan" alt="Secret Scan"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=opencob.opencob"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-007ACC" alt="VS Code Marketplace"></a>
</p>

---

## What is OpenCob?

OpenCob is a **free, open-source AI coding assistant** that runs entirely on your local machine. It provides agentic workflows, inline code completion, and first-class support for legacy languages (COBOL, RPG, PL/I, JCL) — all without sending a single line of code to the cloud.

### Key Features

- **Local-first AI** — Ollama / vLLM inference. Zero telemetry, zero cloud dependency.
- **Agentic workflows** — Plan → Execute → Verify with self-correction loops.
- **Mode system** — Code, Ask, Plan, Advanced, Orchestrator + custom YAML modes.
- **Legacy languages** — COBOL, RPG, PL/I, JCL, NATURAL, REXX, Assembler via Tree-sitter.
- **MCP integration** — Connect to databases, terminals, and APIs via Model Context Protocol.
- **Secret redaction** — Automatic masking of API keys, passwords, and PII before LLM calls.
- **Bring Your Own Model** — Use any GGUF, ONNX, or API-compatible LLM.
- **VS Code extension + CLI** — Chat panel, inline completion, and headless terminal mode.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22.0.0
- [pnpm](https://pnpm.io/) >= 10.0.0
- [Ollama](https://ollama.ai/) (for local model serving)

### Install & Build

```bash
git clone https://github.com/mountek/opencob.git
cd opencob
pnpm install
pnpm build
```

### Run Tests

```bash
pnpm test
```

### Development

```bash
# Build all packages
pnpm build

# Validate formatting, lint, tests, and type safety
pnpm format:check
pnpm lint
pnpm test
pnpm typecheck

# Validate shared .opencob configuration
pnpm validate:opencob

# Run the CLI
cd packages/cli && node dist/index.js

# Launch the VS Code extension
# Open packages/extension in VS Code → F5 to debug
```

### Local VSIX Cycle

For fast local extension testing (build + package + install into local VS Code):

```bash
bash ./scripts/dev/local-vsix-cycle.sh
```

## Project Structure

```
opencob/
├── packages/
│   ├── core/           # Agent engine, tools, modes, MCP, LLM adapters
│   ├── cli/            # Interactive + headless terminal CLI
│   └── extension/      # VS Code extension (chat, completion, modes)
├── spikes/             # Technical spikes and research
├── .github/            # CI/CD workflows, issue/PR templates
└── docs/               # Nextra documentation site content
```

## Packages

| Package                                    | Description                                                                 | Build   |
| ------------------------------------------ | --------------------------------------------------------------------------- | ------- |
| [`@opencob/core`](packages/core)           | Agent loop, tool system, mode engine, MCP client, LLM adapters, RAG indexer | tsc     |
| [`@opencob/cli`](packages/cli)             | Terminal REPL with interactive and headless modes                           | esbuild |
| [`@opencob/extension`](packages/extension) | VS Code extension: chat panel, inline completion, mode selector             | esbuild |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, coding standards, and PR guidelines.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Release Notes

- CI, CodeQL, dependency review, and secret scanning run on pull requests and/or main.
- VSIX packaging runs on main, version tags, and published GitHub releases via `.github/workflows/package-extension.yaml`.
- Automated npm release flow is gated behind the `ENABLE_RELEASE=true` repository variable.

## License

[Apache License 2.0](LICENSE) © 2026 OpenCob Contributors

---

> **OpenCob** — _Free, private, and open. AI-assisted coding that never phones home._
