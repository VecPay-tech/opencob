# S0-8: Codex/DriverX Integration Spike

**Duration**: 3 days  
**Validates**: EE commercial value  
**Status**: NOT STARTED

## Objective

Evaluate the feasibility of porting key Codex and DriverX features to TypeScript for EE integration, or wrapping them as MCP servers.

## Features to Evaluate

### From Codex (c:\Paytech\worldline\rag\codex\)
- Quality rules engine (12+ COBOL checkers) → Port to TS or MCP wrap?
- Security vulnerability propagation (BFS through call graph) → TS port feasible?
- CycloneDX SBOM export → TS port (small scope)

### From DriverX (c:\Paytech\worldline\rag\driverx\)
- Dependency engine (Source Orbit compatible) → TS port or MCP wrap?
- Smart model routing (3-tier) → TS port (pattern adoption)
- Agentic loop (16 tools) → Pattern adoption for CE agent

## Integration Options to Assess

| Option | Effort | Latency | Deployment |
|---|---|---|---|
| Port to TypeScript | High | Low | Same process |
| Wrap as MCP server (Python sidecar) | Low | Medium | Separate process |
| Run as EE microservice | Medium | Medium | Docker container |

## Deliverables

- [ ] `results/port-assessment.md` — per-feature port feasibility and effort estimate
- [ ] `results/mcp-wrapper-poc.md` — proof-of-concept MCP wrapper for one Codex tool
- [ ] `README.md` — updated with recommended integration strategy
