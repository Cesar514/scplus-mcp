# Phase 18 ExecPlan

Goal: make missing hybrid vectors a loud integrity failure instead of a silent `semanticScore = 0` downgrade, while surfacing explicit vector-coverage diagnostics through query output and doctor surfaces.

1. Add cheap vector-presence inspection helpers at the sqlite/embedding layer.
2. Introduce explicit hybrid vector coverage diagnostics and a `HybridVectorIntegrityError`.
3. Make hybrid search fail loudly on missing vectors for semantic or mixed retrieval.
4. Keep keyword-only retrieval explicit by reporting `lexical-only-explicit` mode in diagnostics.
5. Surface hybrid vector coverage through related-search text, bridge payloads, and doctor reports.
6. Add regressions for keyword-only reporting, missing-vector failure, related-search diagnostics, and doctor coverage output.
