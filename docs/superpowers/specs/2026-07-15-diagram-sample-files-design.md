# Design: Sample Files for Diagram Generation Testing

**Date:** 2026-07-15  
**Status:** Approved

---

## Goal

Bundle a set of realistic, payment-domain source code samples into the OpenCob VS Code extension VSIX so that any user who installs the extension can immediately test the diagram generation feature — no repo cloning required.

---

## Location

`packages/extension/resources/samples/`

Shipped inside the VSIX. Not excluded from `.vscodeignore`.

---

## File Inventory

| File                    | Language          | Program represents                  | Primary diagram types                            |
| ----------------------- | ----------------- | ----------------------------------- | ------------------------------------------------ |
| `PAYTRANS.cbl`          | COBOL (AS/400)    | Batch payment transaction processor | call_graph, control_flow, file_io, copybook_tree |
| `PAYAUTH.rpgle`         | RPG ILE           | Real-time card authorization        | call_graph, control_flow, structure_chart        |
| `SETTLMNT.pli`          | PL/I              | End-of-day settlement calculation   | call_graph, control_flow, field_hierarchy        |
| `RUNPAY.clle`           | CL ILE            | Job control for payment batch run   | dependency_map, control_flow                     |
| `TRANSACT.pf`           | DDS Physical File | Transaction master file definition  | record_layout, field_hierarchy                   |
| `PAYINQ.dspf`           | DDS Display File  | Payment inquiry screen              | screen_layout                                    |
| `PAYMAP.map`            | BMS               | CICS payment inquiry map            | screen_layout, dependency_map                    |
| `SETTLJOB.jcl`          | JCL               | Mainframe settlement batch job      | dependency_map, usage_map                        |
| `PAYRPT.rexx`           | REXX              | Payment exception report utility    | control_flow                                     |
| `PAYBATCH.nsp`          | NATURAL           | Natural payment batch program       | call_graph, control_flow                         |
| `PAYENC.hlasm`          | HLASM             | PIN encryption routine              | control_flow                                     |
| `payment-service.ts`    | TypeScript        | Payment API service class           | class, call-graph, dependency                    |
| `reconcile.py`          | Python            | Daily reconciliation script         | call-graph, dependency                           |
| `PaymentProcessor.java` | Java              | Card payment processor class        | class, call-graph                                |
| `gateway.go`            | Go                | Payment gateway microservice        | call-graph, dependency                           |

---

## Richness Criteria

Each file is short enough to read in a few minutes but structurally rich enough to produce meaningful diagrams:

- **COBOL** — 3–4 paragraphs, 2 file reads, 1 CALL to sub-program, COPY reference
- **RPG ILE** — 3 procedures, database read, conditional logic
- **PL/I** — nested procedures, structures, ON-conditions
- **CL ILE** — CALL chain, IF/MONMSG, SBMJOB
- **DDS PF** — 8–10 fields with key, field types
- **DDS DSPF** — 2 record formats, input/output fields
- **BMS** — 2 maps, labeled fields, DFHMDF
- **JCL** — 3 steps, EXEC PGM, DD statements, PROC call
- **REXX** — conditional branches, CALL, INTERPRET
- **NATURAL** — CALLNAT, IF/ELSE, DEFINE DATA
- **HLASM** — CSECT, branching, CALL macro
- **TypeScript** — class with injected dependencies, async methods
- **Python** — dataclasses, function calls, imports
- **Java** — class hierarchy, interface, method calls
- **Go** — structs, interfaces, goroutine

---

## Extension Changes

### 1. Bundle samples in VSIX

Ensure `resources/samples/**` is not listed in `.vscodeignore`. No other packaging change needed — `resources/` is already a standard extension resource folder.

### 2. Command: `opencob.openSamples`

- Registered in `package.json` under `contributes.commands`
- Implementation: `src/commands/open-samples.ts`
- Uses `vscode.workspace.updateWorkspaceFolders()` to add the samples folder to the current workspace
- Wired up in `src/extension.ts` alongside existing command registrations

### 3. VS Code Walkthrough

- New `contributes.walkthroughs` entry in `package.json`
- Title: "Get Started with OpenCob"
- One step: "Try Diagram Generation"
  - Description: instructs user to open a sample file and right-click → Generate Diagram
  - Command: `opencob.openSamples`
  - Activates on first install via `"when": "onStartupFinished"`

---

## Out of Scope

- One sample per diagram type (too many files to maintain)
- Copybook/include companion files (kept simple for v1)
- Interactive walkthrough with embedded webview previews
