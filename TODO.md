# TODO List

## v1.5 Goal

- [ ] Make Context+ serve only a last-known-good validated index generation through one persistent backend shared by MCP and the human CLI, with no silent degradation, no hidden fallback behavior, and a real operator console over the full engine.

## v1.5 Non-Negotiable Rules

- [ ] Enforce the greenfield rule across v1.5 work: prefer loud fatal errors over silent fallback, degraded empty states, or success-shaped default behavior.
- [ ] Remove silent parser, retrieval, indexing, and UI fallback paths unless a framework-forced default must remain with an explicit `// FALLBACK` marker immediately before that line.
- [ ] Treat the active serving generation as the product contract: partial rebuild state must never leak into live search or operator views.
- [ ] Keep MCP and the human CLI on one backend truth source so they cannot drift in cache state, watcher ownership, job queue state, or generation freshness.

## v1.5 Execution Order

- [ ] Finish the serving contract and post-write freshness work before major UI expansion so the new console surfaces stable truth instead of unstable intermediate state.
- [ ] Finish backend unification and bridge parity before building advanced TUI actions so the UI does not hard-code another thin subprocess shell.
- [ ] Finish no-fallback correctness fixes before claiming large-repo or production-grade trustworthiness.
- [ ] Finish real benchmark and observability work before claiming the engine is fast on large repos.

## Phase 4: Bridge Parity Between CLI And MCP

- [ ] Expand [src/cli/commands.ts](/home/cesar514/Documents/agent_programming/contextplus/src/cli/commands.ts) until the CLI bridge can access the same high-value engine surfaces that MCP already exposes.
- [ ] Add bridge commands for `search` with exact and related intent, including explicit retrieval mode controls and structured result payloads.
- [ ] Add bridge commands for `symbol`, `word`, `outline`, and `deps` so the human operator can inspect the same exact-query substrate the agent uses.
- [ ] Add bridge commands for `lint`, `blast_radius`, `research`, `checkpoint`, and `restore` so the CLI is not limited to a thin dashboard.
- [ ] Add bridge commands for `status` and `changes` with typed payloads suitable for tables and detail panes, not just plain text.
- [ ] Update [README.md](/home/cesar514/Documents/agent_programming/contextplus/README.md) after bridge expansion so the documented human CLI matches the actual backend bridge surface.

## Phase 5: Vector Persistence Hot Path

- [ ] Rewrite the embedding save path in [src/core/embeddings.ts](/home/cesar514/Documents/agent_programming/contextplus/src/core/embeddings.ts) so `saveEmbeddingCache()` stops mapping the whole cache back into entries and stops calling full-namespace replacement for every save.
- [ ] Use the existing delta-write APIs in [src/core/index-database.ts](/home/cesar514/Documents/agent_programming/contextplus/src/core/index-database.ts), specifically `upsertVectorEntries()` and `deleteVectorEntries()`, from the embedding save path instead of `replaceVectorCollection()`.
- [ ] Remove the current full-namespace rewrite behavior where `replaceVectorCollection()` deletes the namespace and reinserts every vector and metadata entry, because this is the current highest-ROI performance issue.
- [ ] Preserve namespace integrity and deletion semantics while switching to delta writes so removed vectors are actually deleted and changed vectors are updated in place.
- [ ] Verify that incremental embedding updates on a small file set do not rewrite the full vector namespace in sqlite.

## Phase 6: Embedding Cache Load Strategy

- [ ] Rewrite `loadEmbeddingCache()` in [src/core/embeddings.ts](/home/cesar514/Documents/agent_programming/contextplus/src/core/embeddings.ts) so it no longer loads entire vector collections into a giant JS object on every search path.
- [ ] Add a process-level cache keyed by namespace and generation so repeated searches can reuse already-loaded vectors when the generation is unchanged.
- [ ] Add generation-aware invalidation so process cache entries are dropped immediately when the active generation changes.
- [ ] Introduce candidate-first vector fetches so lexical prefiltering or exact-query narrowing reduces the set of vectors pulled into memory.
- [ ] Remove the current pattern in [src/tools/hybrid-retrieval.ts](/home/cesar514/Documents/agent_programming/contextplus/src/tools/hybrid-retrieval.ts) where `searchHybridChunkIndex()` and `searchHybridIdentifierIndex()` load the entire cache before ranking.
- [ ] Evaluate longer-term ANN or sqlite-native vector support, but do not defer the immediate process-cache and candidate-first improvements behind that future work.

## Phase 7: Real Lexical Candidate Generation

- [ ] Replace the current lexical scoring model that scans all documents with a real candidate-generation substrate such as FTS5 or an explicit inverted index.
- [ ] Rework hybrid retrieval so lexical retrieval returns a small candidate set first, then semantic reranking runs only on those candidates.
- [ ] Keep exact deterministic lookup separate from broad related retrieval so the lexical candidate generator does not weaken the exact substrate.
- [ ] Add explicit query-stage reporting so operators can see lexical candidate counts, rerank candidate counts, and final result counts for a query.

## Phase 8: Refresh Cost And Invalidation Gates

- [ ] Rewrite `refreshPersistedFileSearchState()` in [src/tools/semantic-search.ts](/home/cesar514/Documents/agent_programming/contextplus/src/tools/semantic-search.ts) to use `(mtimeMs, size)` as the first invalidation gate instead of computing content hashes for every file on every refresh.
- [ ] Only compute a content hash when metadata changed, so no-op refreshes stop paying a full-file hashing pass across the repo.
- [ ] Persist enough file metadata to support this stat-based prefilter cleanly and deterministically.
- [ ] Ensure stat-based prefiltering still escalates to content-hash verification when metadata indicates change.
- [ ] Verify refresh latency on unchanged repos before and after this rewrite so the no-op path becomes materially cheaper.

## Phase 9: Tree-Sitter Performance And Strictness

- [ ] Remove the redundant `await readFile(wasmPath)` in `loadGrammar()` inside [src/core/tree-sitter.ts](/home/cesar514/Documents/agent_programming/contextplus/src/core/tree-sitter.ts) before `Parser.Language.load(wasmPath)`.
- [ ] Stop creating a fresh parser instance per file in `parseWithTreeSitter()` and instead pool parser instances per grammar, per worker, or per backend session.
- [ ] Keep parser lifecycle deterministic so parser reuse does not leak language state across files.
- [ ] Expose grammar-load failures and parse failures as explicit operator-visible errors rather than returning `null`.
- [ ] Track parse-failure counts by language for observability and benchmark reporting.

## Phase 10: Query Embedding Duplication

- [ ] Audit unified search flow so the query embedding is computed exactly once per top-level query, not once in file search and again in hybrid search.
- [ ] Pass a shared query vector through lexical-semantic ranking stages, hybrid retrieval, and any other semantic reranking stage that currently recomputes it.
- [ ] Add a test or benchmark that asserts only one embedding request is issued per unified query in the expected path.

## Phase 11: Index Status Persistence Noise

- [ ] Audit `indexCodebase()` progress callbacks and index-status writes so stage-state persistence is not triggered on every progress event.
- [ ] Debounce stage and status persistence to coarse intervals, stage boundaries, or explicit milestone checkpoints.
- [ ] Preserve crash recovery value while reducing sqlite churn and noisy UI updates from over-frequent status writes.

## Phase 12: Binary Vector Storage

- [ ] Replace JSON text storage for vectors in sqlite with a binary representation such as `Float32Array` bytes.
- [ ] Remove repeated JSON stringify and parse overhead from vector load and save code paths.
- [ ] Migrate existing vector read and write helpers to the new binary layout without reintroducing whole-namespace rewrites.
- [ ] Add migration or rebuild logic so old vector collections can be upgraded safely and explicitly.

## Phase 13: Clustering Scalability

- [ ] Audit [src/core/clustering.ts](/home/cesar514/Documents/agent_programming/contextplus/src/core/clustering.ts) and the full-index cluster artifact path to remove the current full affinity matrix, normalized Laplacian, eigen decomposition, and k-means pipeline as the default large-repo strategy.
- [ ] Choose and implement a clustering strategy with a cost shape suitable for very large repos instead of only moderate `n`.
- [ ] Preserve useful cluster labels, related-file neighborhoods, and subsystem summaries while replacing the current algorithmic bottleneck.
- [ ] Add benchmark coverage for medium and large repos so clustering cost is measured directly.

## Phase 14: No-Fallback Parser And Index Correctness

- [ ] Remove the silent fallback from `analyzeFile()` in [src/core/parser.ts](/home/cesar514/Documents/agent_programming/contextplus/src/core/parser.ts), where tree-sitter failures currently fall through to regex parsing without surfacing an explicit error.
- [ ] Remove the `null`-return fallback contract from `loadGrammar()` and `parseWithTreeSitter()` in [src/core/tree-sitter.ts](/home/cesar514/Documents/agent_programming/contextplus/src/core/tree-sitter.ts); failures must propagate as explicit failures or blocked states.
- [ ] Decide the strict unsupported-language behavior explicitly: either unsupported files are excluded by contract before parsing begins, or they fail loudly as unsupported, but they must not silently degrade into approximate parsing.
- [ ] If regex parsing remains anywhere for framework-required reasons, mark it explicitly as a fallback path and surface it in diagnostics.

## Phase 15: Silent File Omission Bug

- [ ] Fix the file omission bug in `refreshPersistedFileSearchState()` in [src/tools/semantic-search.ts](/home/cesar514/Documents/agent_programming/contextplus/src/tools/semantic-search.ts), where changed files are re-added only when `doc` is truthy and are otherwise silently absent from `nextFiles`.
- [ ] Replace silent omission with a loud failure or blocked refresh result so the operator knows the file could not be indexed.
- [ ] Add explicit refresh diagnostics listing files that failed document construction, along with the reason.
- [ ] Add regression coverage that proves a file cannot disappear from the live index without an explicit surfaced error.

## Phase 16: Regex Range Corruption

- [ ] Replace or retire `findBraceBlockEnd()` in [src/core/parser.ts](/home/cesar514/Documents/agent_programming/contextplus/src/core/parser.ts), because it scans raw characters and counts braces without understanding strings or comments.
- [ ] Ensure symbol `endLine` computation cannot be shifted by braces that appear inside string literals or comments.
- [ ] Add regression fixtures that include braces inside strings, comments, templates, or nested language literals.

## Phase 17: Ranking Misclassification Bug

- [ ] Remove the brittle unified-ranking heuristic that treats chunk matches as files when `match.title === "file"`.
- [ ] Replace that heuristic with explicit typed metadata on ranking entities so real symbols named `file` are handled correctly.
- [ ] Add regression coverage for a real symbol literally named `file` and verify it is not classified as a file hit.

## Phase 18: Missing Vector Integrity Bug

- [ ] Change `searchHybridState()` in [src/tools/hybrid-retrieval.ts](/home/cesar514/Documents/agent_programming/contextplus/src/tools/hybrid-retrieval.ts) so missing vectors are not silently assigned `semanticScore = 0`.
- [ ] Treat missing vectors as an explicit stale-state, corruption, or refresh-incomplete condition and report that condition loudly.
- [ ] Ensure lexical-only continuation is an explicit reported mode, never a silent one.
- [ ] Include vector-coverage diagnostics in query output and observability panels so stale namespaces are obvious.

## Phase 19: Query Engine Stack

- [ ] Formalize a three-layer query architecture for v1.5 and wire the code to match it.
- [ ] Layer A: keep the exact deterministic substrate for `symbol`, `word`, `outline`, `deps`, `status`, and `changes` as the first and cheapest path.
- [ ] Layer B: build the real candidate-generation substrate for lexical retrieval, semantic retrieval, structural neighborhood retrieval, and hub or cluster priors.
- [ ] Layer C: precompute agent-ready explanation artifacts such as per-file purpose summaries, public API cards, per-module summaries, dependency neighborhood summaries, hot-path summaries, ownership summaries, hub candidate rationale, and change-risk notes.
- [ ] Make `research` and rich operator views consume the explanation substrate instead of reconstructing high-level summaries on demand.

## Phase 20: Real Benchmark Harness

- [ ] Replace the current synthetic-only benchmark in [src/tools/evaluation.ts](/home/cesar514/Documents/agent_programming/contextplus/src/tools/evaluation.ts), where `writeFixtureRepo()` creates only a small toy repo under `src/auth`, `src/ui`, `src/api`, and `docs`.
- [ ] Keep the synthetic fixture only as a smoke test, not as the main performance or retrieval-quality gate.
- [ ] Add benchmark targets for a small repo, medium repo, large monorepo, polyglot repo, intentionally broken repo, and a repo with generated files and ignored trees.
- [ ] Add benchmark targets that exercise rename-heavy or change-heavy histories where stale-after-write behavior matters.
- [ ] Define a golden operator-question set with expected files, symbols, dependencies, and hub results.
- [ ] Measure exact lookup accuracy, related-search relevance, symbol resolution accuracy, dependency graph accuracy, hub suggestion quality, stale-after-write failure rate, restore correctness, and index validation false-positive and false-negative rates.
- [ ] Measure p50, p95, and p99 query latency for exact lookup, related search, and broad research.

## Phase 21: Observability As A Product Feature

- [ ] Add stage timing metrics for indexing, including files per second, chunks per second, embeds per second, and time per durable stage.
- [ ] Add cache observability for process-cache hits, vector-cache hits, parser-pool reuse, and lexical candidate counts before rerank.
- [ ] Add integrity observability for vector coverage, parse failures by language, fallback counts, stale-generation age, and refresh failures.
- [ ] Add scheduler observability for watcher queue depth, deduped batches, canceled jobs, superseded jobs, and reasons a full rebuild was required.
- [ ] Surface these metrics through `doctor`, machine-readable debug JSON, backend logs, and the human CLI status area.

## Phase 22: TUI Architecture Reset

- [ ] Rebuild the TUI around three layers: command layer, navigation layer, and job layer, so `contextplus-ui` becomes an operator console instead of a dashboard with text panes.
- [ ] Use a left sidebar for navigation and actions, a center pane for lists or tables, a right pane for preview or detail, and a bottom pane for logs and job state when terminal width allows.
- [ ] Add a vertical or stacked fallback layout for narrow terminals instead of relying on fragile horizontal card formulas.
- [ ] Keep the backend-facing UI model typed around domain objects, not monolithic text payloads.

## Phase 23: Overview Screen And Layout Fixes

- [ ] Make the Overview screen scrollable instead of a static string render in `renderOverview()` inside [cli/internal/ui/model.go](/home/cesar514/Documents/agent_programming/contextplus/cli/internal/ui/model.go).
- [ ] Stop using only horizontal cards with width formulas based on terminal width in `renderOverview()`, because this is fragile and cramped on smaller terminals.
- [ ] Add a real bottom status line showing watcher on or off, current index stage, backend connectivity, active repo, and active generation.
- [ ] Preserve the header and mascot if desired, but stop letting the overview be a static card wall with no navigation.

## Phase 24: Raw Text View Replacement

- [ ] Replace the `syncViewport()` pattern in [cli/internal/ui/model.go](/home/cesar514/Documents/agent_programming/contextplus/cli/internal/ui/model.go), which currently pushes raw `treeText`, `hubsText`, restore text, and `clusterText` into `viewport.SetContent()`.
- [ ] Replace monolithic text dumps with proper Bubble components: lists for hubs, restore points, clusters, files, and actions; tables for status, changes, and lint findings; a viewport only for previews or detail text.
- [ ] Add selection state so a chosen row in the center pane updates a detail preview in another pane.
- [ ] Add typed renderers for tree, hubs, restore points, clusters, status, changes, and search results instead of plain text blocks.

## Phase 25: Logs, Jobs, And Progress Model

- [ ] Replace the current `appendLog()` behavior in [cli/internal/ui/model.go](/home/cesar514/Documents/agent_programming/contextplus/cli/internal/ui/model.go), which keeps only 12 log lines, with a real scrollable log panel.
- [ ] Add structured job rows for indexing, refresh, restore, lint, and query tasks instead of burying state only in log lines.
- [ ] Add stage name, percent complete where available, current file, elapsed time, and queue depth to the indexing model instead of a boolean `indexing` flag.
- [ ] Add cancel, supersede, and retry controls for long-running or stale jobs.
- [ ] Stream job and log updates from the persistent backend instead of synthesizing them only in the UI.

## Phase 26: Navigation, Search, And Command Surface

- [ ] Add a real navigation model with focused pane, selected row, open detail, and back or forward history instead of only tab switching.
- [ ] Add a command palette that exposes every backend action the operator needs, including search, exact lookup, lint, blast radius, checkpoint, restore, changes, and status.
- [ ] Add in-UI search and filter boxes, plus “go to file” and “go to symbol” workflows.
- [ ] Add a help overlay bound to `?` that shows scrolling keys, command keys, filtering keys, and action keys.
- [ ] Add copy or export actions for logs, query results, and selected detail views.
- [ ] Add mouse support once the typed list and pane model exists.

## Phase 27: Expose The Full Engine In The TUI

- [ ] Stop limiting the human CLI backend to `doctor`, `tree`, `hubs`, `cluster`, `restore-points`, and `index`, because this keeps the UI strategically thin relative to the engine.
- [ ] Add dedicated TUI actions and views for `symbol`, `word`, `search`, `research`, `lint`, `blast_radius`, `status`, `changes`, `checkpoint`, `restore`, and `find_hub`.
- [ ] Add result ranking inspection so operators can understand why a search result ranked where it did.
- [ ] Add dependency graph browsing, cluster drill-down, hub suggestion triage, diff viewing, and restore execution from inside the UI.

## Phase 28: Watcher And Scheduler Rework

- [ ] Replace the current blunt watcher behavior in [cli/internal/watcher/watcher.go](/home/cesar514/Documents/agent_programming/contextplus/cli/internal/watcher/watcher.go) and [cli/internal/ui/model.go](/home/cesar514/Documents/agent_programming/contextplus/cli/internal/ui/model.go), where change bursts trigger loud full reindex behavior.
- [ ] Collapse bursty filesystem events into one queued refresh job and cancel superseded jobs before they start.
- [ ] Separate delta refresh from full rebuild and surface why a full rebuild was needed when it happens.
- [ ] Show “changes detected” and pending-job badges in the UI instead of immediately forcing visible heavy work for each burst.
- [ ] Add optional background incremental refresh that can run without blowing away current operator context.
- [ ] Ensure duplicate events are collapsed and stale jobs are canceled when a newer job covers the same affected files.

## Phase 29: Watcher Double-Close Bug

- [ ] Fix the likely double-close panic around the watcher: pressing `q` in [cli/internal/ui/model.go](/home/cesar514/Documents/agent_programming/contextplus/cli/internal/ui/model.go) closes the watcher, and [cli/cmd/contextplus-ui/main.go](/home/cesar514/Documents/agent_programming/contextplus/cli/cmd/contextplus-ui/main.go) closes the final model again after `program.Run()`.
- [ ] Make [cli/internal/watcher/watcher.go](/home/cesar514/Documents/agent_programming/contextplus/cli/internal/watcher/watcher.go) `Close()` idempotent so a second close cannot panic on `close(s.stop)`.
- [ ] Add regression coverage for quitting through the UI while the watcher is active.

## Phase 30: Documentation And Rollout Truthfulness

- [ ] Update [README.md](/home/cesar514/Documents/agent_programming/contextplus/README.md) so it stops overselling the current human CLI once bridge parity and operator-console work land.
- [ ] Keep docs explicit about which surfaces are human CLI only, MCP only, or shared through the persistent backend.
- [ ] Document active-generation serving semantics, dirty-state semantics after writes, and explicit degraded-state reporting rules.
- [ ] Document the watcher and scheduler behavior so operators know when auto-refresh, queued jobs, or blocked states are expected.

## Later Backlog

- [ ] Rename the product and commands to `context++` only after v1.5 serving correctness, no-fallback enforcement, backend unification, and operator-console work are all stable.
- [ ] Audit tool and parameter sprawl after v1.5 and remove overengineered surfaces that do not materially improve agent context quality.
- [ ] Remove remaining embedding-provider spam and make background embedding maintenance an explicit observable service responsibility instead of an ad hoc hot-path cost.
- [ ] Add any net-new `researchplus` features only after the v1.5 performance, correctness, and operator-console gaps above are closed.
