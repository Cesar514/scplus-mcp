# Phase 17 ExecPlan

Goal: remove the unified-ranking `match.title === "file"` heuristic and replace it with explicit typed ranking metadata so real symbols named `file` cannot be misclassified as file hits.

1. Add explicit `entityType` metadata to hybrid retrieval documents and query matches.
2. Make unified ranking consume `match.entityType` instead of inferring from `match.title`.
3. Bump the persisted artifact version so stale hybrid artifacts fail validation instead of being silently reused.
4. Add regressions for a real symbol literally named `file` at both the hybrid-retrieval and unified-ranking layers.
5. Re-run focused and broader verification, then move Phase 17 from `TODO.md` to `TODO_COMPLETED.md` and commit.
