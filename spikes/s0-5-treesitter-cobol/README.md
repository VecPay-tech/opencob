# S0-5: Tree-sitter COBOL Grammar Evaluation

**Duration**: 3 days  
**Validates**: ADR-008 (Fork existing COBOL grammar, build RPG from scratch)  
**Status**: NOT STARTED

## Objective

Test the `tree-sitter-cobol` grammar against 10 real Enterprise COBOL programs from the Codex corpus. Catalog gaps and estimate effort to fix.

## Test Programs (from Codex)

Select 10 programs covering:
1. Basic IDENTIFICATION/ENVIRONMENT/DATA/PROCEDURE divisions
2. COPY statements (with REPLACING)
3. Embedded SQL (EXEC SQL ... END-EXEC)
4. EVALUATE/WHEN blocks
5. Nested IF with complex conditions
6. PERFORM THRU with paragraphs
7. FILE SECTION with FDs and record layouts
8. CALL with BY REFERENCE/BY CONTENT
9. STRING/UNSTRING operations
10. Large program (>5000 LOC)

## Evaluation Criteria

| Criteria | Weight | Pass |
|---|---|---|
| Parse without errors | 30% | All 10 programs parse |
| Division/section extraction | 20% | Correct node types |
| Paragraph names | 15% | All paragraphs identified |
| COPY/CALL references | 15% | Extracted correctly |
| Data item definitions | 10% | Level numbers + PIC clauses |
| Embedded SQL blocks | 10% | Boundaries detected |

## Deliverables

- [ ] `results/parse-results.md` — per-program parse results
- [ ] `results/gap-analysis.md` — list of gaps with effort estimates
- [ ] `README.md` — updated with recommendation (fork as-is / fork+fix / build new)
