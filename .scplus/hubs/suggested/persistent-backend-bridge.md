# persistent backend bridge

The Go backend client maintains a persistent bridge to the shared Node backend session with typed status and change payloads. The Go backend client uses RepoStatusSummary and ChangeRange to track repository state, unique to its role. 18 files around docs/architecture.md

Suggested hub generated from persisted full-index artifacts.

- Rationale: The Go backend client maintains a persistent bridge to the shared Node backend session with typed status and change payloads. The Go backend client uses RepoStatusSummary and ChangeRange to track repository state, unique to its role. 18 files around docs/architecture.md Touches modules src/core, src/tools, test/main. Tagged with Aggregated code, cluster, and hub research coverage, Benchmark coverage for retrieval, validation, freshness, and latency distributions, Codebase indexing entrypoint for .scplus project initialization.. Backed by semantic clusters cluster-root, cluster-1-2.
- Modules: src/core, src/tools, test/main
- Feature tags: Aggregated code, cluster, and hub research coverage, Benchmark coverage for retrieval, validation, freshness, and latency distributions, Codebase indexing entrypoint for .scplus project initialization.

@linked-to [[Hierarchical context management via feature hub graph.]]
@linked-to [[architecture documentation]]
@linked-to [[embedding and indexing]]
@linked-to [[operator console launcher]]

- [[src/core/index-database.ts|Suggested because it anchors persistent backend bridge]]
- [[src/tools/evaluation.ts|Suggested because it anchors persistent backend bridge]]
- [[src/tools/index-codebase.ts|Suggested because it anchors persistent backend bridge]]
- [[src/tools/index-contract.ts|Suggested because it anchors persistent backend bridge]]
- [[src/tools/index-reliability.ts|Suggested because it anchors persistent backend bridge]]
- [[src/tools/index-stages.ts|Suggested because it anchors persistent backend bridge]]
- [[src/tools/invalidation.ts|Suggested because it anchors persistent backend bridge]]
- [[src/tools/write-freshness.ts|Suggested because it anchors persistent backend bridge]]
- [[test/main/evaluation.test.mjs|Suggested because it anchors persistent backend bridge]]
- [[test/main/exact-query.test.mjs|Suggested because it anchors persistent backend bridge]]
- [[test/main/index-codebase.test.mjs|Suggested because it anchors persistent backend bridge]]
- [[test/main/index-reliability.test.mjs|Suggested because it anchors persistent backend bridge]]
- [[test/main/invalidation.test.mjs|Suggested because it anchors persistent backend bridge]]
- [[test/main/query-engine.test.mjs|Suggested because it anchors persistent backend bridge]]
- [[test/main/research.test.mjs|Suggested because it anchors persistent backend bridge]]
- [[test/main/unified-ranking.test.mjs|Suggested because it anchors persistent backend bridge]]
