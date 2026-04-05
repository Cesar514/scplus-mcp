# TODO Completed

## Current Goal History

- [x] Allow same-repo scplus runtimes to take over watcher and mutation locks by terminating verified competing scplus processes for that repository, while preserving independent operation across different repositories, and add regression tests for same-repo takeover behavior.
- [x] Make `scplus-cli index` fail with actionable corruption context when persisted JSON state is malformed, including the exact legacy file path or sqlite artifact key, and add regression tests for both malformed legacy JSON and malformed persisted artifact JSON.
- [x] Fix `scplus-cli doctor` so repositories containing directory symlinks do not fail with `EISDIR` during fallback-marker inspection, and add a regression test that proves the doctor command succeeds against a repo fixture with a symlinked directory.
- [x] Run an exhaustive local verification pass across the current scplus setup, including full automated suites, live doctor/status checks, and direct command smoke tests for the main shipped CLI and backend surfaces.
- [x] Verify the real built `scplus-cli` and `node build/index.js` command surfaces on this repository and on a fixture repository, then capture any remaining failing commands instead of assuming setup health from partial tests.
- [x] Reproduce the live `cluster` JSON failure against this repository, inspect the real chat-model response contract, and stop relying on mock-only verification for semantic cluster refresh.
- [x] Harden structured chat generation with schema-backed Ollama JSON output plus retry-on-invalid-JSON behavior, and verify that both `node build/index.js cluster` and `./build/scplus-cli cluster` now succeed on this repository.
- [x] Add a real chat-generation backend so semantic clustering and broad research invoke the configured chat model instead of relying only on embeddings and heuristic strings.
- [x] Use the chat model to generate semantic cluster labels and summaries during cluster artifact refresh, then verify the persisted cluster state reflects those generated semantics.
- [x] Use the chat model to synthesize research answers from ranked evidence, then verify the research surface includes a model-generated semantic summary instead of only templated artifact dumps.
- [x] Correct the human CLI runtime-model indicator so `cluster` reports the embedding model instead of implying chat-model work.
- [x] Trim the human CLI command surface so internal navigation-only actions do not appear as operator-facing commands.
- [x] Remove the `view trail` status text from the human CLI so internal navigation bookkeeping is no longer shown to operators.
- [x] Split the human CLI cluster surface so `cluster` runs semantic clustering work with visible job/log activity while `view-clusters` remains the read-only persisted cluster browser.
- [x] Verify the split cluster behavior directly through focused CLI/backend tests plus built command runs that show `cluster` mutates and `view-clusters` only renders.
- [x] Remove the CLI mascot entirely so the activity shell, detail windows, and overlays render without any mascot block or mascot-themed status text.
- [x] Make `Ctrl+X` quit the human CLI and terminate live local scplus runtime processes discovered by the launcher sweep, then verify the shutdown path with launcher-side process tests plus a live CLI snapshot.
- [x] Remove the legacy all-caps env prefix from active source, tests, and docs so that exact stale prefix no longer appears anywhere in the repository.
- [x] Replace the abandoned dense sprite pipeline with a fixed 8-line ASCII wizard hat and wand animation, verify it in focused UI coverage, and confirm the shipped `scplus-cli snapshot` activity shell now renders that simpler mascot.
- [x] Align repo-facing config and metadata with the standalone `scplus-mcp` repository by renaming the landing Cloudflare worker/service away from stale `contextplus`, syncing MCP server version metadata to `package.json`, and updating the README naming contract so configurable published identifiers now point to `scplus-mcp`.
- [x] Fix the activity window header so it drops `Activity |`, shows `SCPLUS-CLI` as the brand title, separates the magician runtime line, redraws the ASCII magician so the hat and body stay aligned, clears stale `cluster failed` state after a successful post-index refresh, avoids leaving a fake queued index state when the backend rejects a duplicate run, and verifies the shipped semantic clustering command surface.
- [x] Finish the single-window CLI cleanup by removing slash-only command invocation, fixing the ASCII magician proportions and placement, keeping the status/help rails fully inside a complete bordered window at all terminal sizes, adding explicit scroll visibility indicators plus mouse-wheel scrolling for truncated detail views, enforcing ESC hierarchy so the root activity view does nothing on ESC, auditing and deleting stale unused UI paths surfaced by blast-radius plus lint analysis, and renaming the repo-local state root from `.contextplus` to `.scplus` so new indexes are created only under the new directory.
- [x] Expand the human CLI single-window layout to use about 95% of the terminal, move all status and operator guidance inside that one blue window, make command discovery letter-driven without requiring `/`, add dynamic hidden-item disclosure with explicit `{command}` labels, and redesign the animated ASCII magician so he reads clearly as a magician with proportional hat/robe and a wand while keeping all content strictly within terminal bounds.
- [x] Redesign the human CLI so it uses no mouse controls, renders exactly one bounded in-terminal window whose content swaps for `/log`, `/issue`, and related commands, keeps the magician centered and always visible, and never allows any border or content path to exceed the current terminal bounds during resize or command-entry states.
- [x] Prevent MCP and the human CLI from corrupting shared repo state when both run at the same time by enforcing one cross-process watcher owner per repo and one cross-process mutating index/refresh lane per repo, then verify that concurrent MCP-plus-CLI sessions fail loudly instead of racing.
- [x] fix the remaining confusing CLI operator surfaces by replacing unclear status jargon such as `history` and `generation` with user-facing wording, and make manual `index` bootstrap a full prepared index only when none exists while using incremental refresh on subsequent runs
- [x] diagnose the CLI with real screenshots and remove the remaining visual defects in the activity slash-command view, including border overflow and irrelevant activity previews while `/` is active
- [x] keep the full-screen activity shell height visually stable when slash commands appear by moving the inline slash-command list into a fixed-size tray
- [x] fix the full-screen activity window so it respects terminal height budgets, and redesign the ASCII magician so it renders cleanly inside the bounded pane
- [x] fix the operator console top-level layout budget so opening `/issue` and supplemental modal windows no longer renders more total lines than the current terminal height
- [x] run Context+ lint for the repository and capture the active warning set
- [x] migrate every flagged source file to the structured `summary:` / `FEATURE:` / `inputs:` / `outputs:` header format
- [x] rerun Context+ lint and native checks until the repository reports zero lint issues for this goal
- [x] audit the Context+ skill, bundled manual, repo instructions, and landing instruction mirrors for drift against the current codebase
- [x] update those instruction surfaces to the current Context+ runtime contract, tool names, storage model, freshness model, and edit rules
- [x] verify the repo still passes Context+ lint and native checks after the instruction sync
- [x] fix the operator CLI activity pane so issue and latest-log previews stay within the terminal pane, clamp to three rendered lines, and expose `/issue` plus `/log` full-detail views
- [x] keep slash-command suggestions scrollable and bounded while typing `/` so the activity shell does not hand most of the pane to the command list
- [x] migrate the public executable, package, init-template, docs, landing, Codex config, and external skill naming to `scplus-mcp` and `scplus-cli` while preserving the stable `.contextplus/` state contract
- [x] verify the CLI and naming migration with `npm run build`, `npm test`, focused Go CLI package tests, Context+ lint, and stale-name grep checks
- [x] commit the verified scplus CLI and MCP migration
- [x] identify the lingering global `contextplus` and `contextplusplus` npm aliases that still exposed legacy commands after the scplus migration
- [x] remove the old global aliases and broken legacy bin symlinks so only `scplus-mcp` and `scplus-cli` remain on the live PATH
- [x] verify the old commands no longer resolve, confirm the remaining Codex skill/config surfaces no longer advertise the old names, and sync the package lockfile with the renamed package metadata
- [x] inspect the live GitHub repo metadata, tracked landing links, and fresh-shell command state to identify the remaining stale Context+ public surface
- [x] update the tracked repo links to `Cesar514/scplus-cli`, update the live GitHub About description to the scplus product contract, and sync the local `origin` remote to the renamed repository URL
- [x] verify the updated metadata and command cleanup, document the current GitHub fork-network constraint, and move this goal out of `TODO.md`
- [x] capture a safe local mirror backup plus the current GitHub metadata and ref state before publishing the standalone `Cesar514/scplus-mcp` repository
- [x] replace the dead hosted-app instruction source and tracked repo links with the standalone `scplus-mcp` repository metadata and clear the obsolete homepage field
- [x] publish `Cesar514/scplus-mcp` with the current local commit history intact, repoint `origin` to the new standalone repository, preserve `fork-origin` and `upstream` for reference and syncing, and verify the new standalone state
- [x] remove `upstream` and `fork-origin` so this checkout is connected only to the standalone `scplus-mcp` repository
- [x] add explicit bottom-of-README references for the original `contextplus` and `claude-context` projects that informed this codebase
- [x] verify the final remote state and README footer, then move this goal out of `TODO.md`

## v1.5

- [x] extend the lint and checkpoint header contract to require structured `summary:`, `inputs:`, and `outputs:` fields in addition to `FEATURE:`
- [x] verify the new header-field rules directly in both static-analysis and checkpoint coverage, including negative cases for missing structured header metadata

- [x] add one short authoritative architecture document that describes the current serving model, generation model, exact-vs-related escalation model, and CLI/MCP transport model
- [x] add [docs/architecture.md](/home/cesar514/Documents/agent_programming/contextplus/docs/architecture.md) and link it from [README.md](/home/cesar514/Documents/agent_programming/contextplus/README.md) so the runtime contract has one short canonical reference
- [x] verify the architecture document against the shipped code paths for active-generation serving, exact-vs-related escalation, and the shared CLI/MCP backend transport

- [x] finish v1.5 phase 30 by making the rollout and operator documentation match the shipped serving and backend truth
- [x] update [README.md](/home/cesar514/Documents/agent_programming/contextplus/README.md) so it stops overselling the human CLI and clearly separates MCP-only, shared-backend, and human-CLI-only surfaces
- [x] document the active-generation serving contract, dirty and blocked freshness semantics after writes, and the no-fallback degraded-state reporting rules
- [x] document watcher and scheduler behavior so operators can see when auto-refresh, queued watch plans, full rebuild escalation, and blocked states are expected
- [x] verify v1.5 phase 30 directly by inspecting the shipped README sections and asserting the required surface-boundary, serving-contract, and watcher-scheduler text is present
- [x] commit the verified v1.5 phase 30 work

- [x] finish v1.5 phase 29 by hardening the remaining watcher close path against repeated shutdowns
- [x] verify that the old TODO suspicion about `contextplus-ui` double-closing a final model after `program.Run()` is stale on the current tree, then fix the real remaining risk in the Go watcher service instead
- [x] make [cli/internal/watcher/watcher.go](/home/cesar514/Documents/agent_programming/contextplus/cli/internal/watcher/watcher.go) `Close()` idempotent so repeated closes cannot panic on `close(s.stop)`
- [x] add regression coverage for repeated watcher close after live watch activity and for quitting the UI while watch state is active
- [x] verify v1.5 phase 29 directly with focused Go watcher/UI coverage plus the full Go CLI suite
- [x] commit the verified v1.5 phase 29 work

- [x] finish v1.5 phase 28 by replacing the blunt watcher-triggered full rebuild path with a real queued watch scheduler and background refresh flow
- [x] collapse bursty filesystem edits into one pending watch plan and cancel superseded queued watch jobs before they start
- [x] separate watch-driven incremental refresh from full rebuild so normal code edits stay in the `refresh` lane while dependency or tooling config edits escalate to `index` with an explicit rebuild reason
- [x] surface pending changes, pending job kind, pending paths, and full rebuild reasons through backend events, doctor output, bridge payloads, and the human CLI overview/sidebar/status/jobs surfaces
- [x] keep operator context stable while watcher-driven background refresh work runs and while newer watch batches replace stale queued work
- [x] verify v1.5 phase 28 directly with focused persistent-bridge coverage, focused Go UI coverage, live built backend event flow, and touched-file build checks
- [x] commit the verified v1.5 phase 28 work

- [x] finish v1.5 phase 27 by exposing the full engine through dedicated human-CLI views instead of routing most operator actions into one generic results pane
- [x] stop limiting the human CLI backend model to the original dashboard subset by wiring dedicated TUI sections for ranked `find-hub`, dependencies, search, symbol, word, outline, research, lint, blast-radius, checkpoint, status, changes, restore, tree, hubs, and cluster output
- [x] add explicit ranking inspection for search results so operators can see rank order and score context directly in the Search section detail pane
- [x] add dependency graph browsing, ranked hub suggestion triage, diff patch viewing, and direct restore execution from inside the UI
- [x] verify v1.5 phase 27 directly with focused Go UI coverage, focused bridge and exact-query coverage, the built `contextplus-ui` binary on this repository, direct snapshot inspection, and touched-file lint/build checks
- [x] commit the verified v1.5 phase 27 work

- [x] finish v1.5 phase 26 by adding a real navigation, search, and command surface to `contextplus-ui`
- [x] add back and forward navigation history over active view, focused pane, and selected section row state instead of relying only on direct tab or pane switching
- [x] add a command palette bound to `:` and `Ctrl+P` that exposes exact lookup, related search, research, go-to file, go-to symbol, lint, blast-radius, checkpoint-detail, restore-point, status, and changes workflows
- [x] add in-UI filter boxes plus palette-driven go-to file and go-to symbol flows that land in a typed Results section
- [x] add a help overlay bound to `?` that documents navigation, command, filtering, export, and mouse controls
- [x] add export actions for logs, query results, and selected detail views under `.contextplus/exports/`
- [x] add mouse focus and wheel-scrolling support once the typed pane model exists
- [x] verify v1.5 phase 26 directly with focused Go UI coverage for palette, filters, history, exports, and mouse handling, the full Go CLI test suite, the built `contextplus-ui` binary, direct snapshot inspection on this repository, and touched-file Context+ lint checks
- [x] commit the verified v1.5 phase 26 work

- [x] finish v1.5 phase 25 by replacing the bottom-pane string summary with a real jobs-and-logs operator surface in `contextplus-ui`
- [x] replace the fixed 12-line `appendLog()` buffer with a scrollable log viewport fed by the persistent backend session
- [x] add structured job rows for index, refresh, restore, lint, and query task slots instead of relying on ad hoc log-only state
- [x] add index progress metadata for stage, percent complete, current file, elapsed time, queue depth, pending state, and rebuild reason across the backend event bridge and TUI model
- [x] add explicit cancel-pending, supersede-pending, and retry-last index controls through the persistent backend bridge and human CLI sidebar
- [x] verify v1.5 phase 25 directly with focused Go UI coverage, persistent `bridge-serve` integration coverage, the Go CLI build, direct `contextplus-ui snapshot` inspection on this repository, direct `contextplus-ui doctor`, and touched-file lint/build checks
- [x] commit the verified v1.5 phase 25 work

- [x] finish v1.5 phase 24 by replacing the remaining raw text view path in `contextplus-ui` with typed Bubble list and table state
- [x] stop feeding tree, hubs, restore points, and cluster views through generic raw text splitting by adding typed list renderers for each section
- [x] add typed Bubble table sections for git status and repo changes, backed by structured bridge payloads in the Go backend client
- [x] keep the detail viewport only for previews while making list and table selection drive the right-hand detail pane
- [x] add typed search-result renderer state so exact and related search payloads no longer depend on plain text blocks inside the UI model layer
- [x] verify v1.5 phase 24 directly with focused Go UI renderer coverage, the full Go CLI test suite, direct `contextplus-ui snapshot` inspection on this repository, and touched-file Context+ lint checks
- [x] commit the verified v1.5 phase 24 work

- [x] finish v1.5 phase 23 by making the operator overview a real navigable list with a shipped bottom status line instead of leaving the old static-overview TODO open
- [x] keep the animated header while making the overview pane show typed rows, selection state, and a visible scroll window rather than a static card wall with no navigation
- [x] expand the overview section into enough typed operator rows to exercise selection and scrolling inside the center content pane
- [x] add a real bottom status line showing watcher state, current index stage, backend connectivity, active repo, and active generation in `contextplus-ui`
- [x] update the human CLI docs so the README describes the status line and overview navigation truthfully
- [x] verify v1.5 phase 23 directly with focused Go UI tests, the full Go CLI test suite, direct `contextplus-ui snapshot` inspection on this repository, and direct `contextplus-ui doctor`
- [x] commit the verified v1.5 phase 23 work

- [x] finish v1.5 phase 22 by rebuilding `contextplus-ui` around a real operator-console layout with distinct command, navigation, and job layers
- [x] replace the tab-only overview wall with a left navigation-and-actions sidebar, a center content pane, a right detail pane, and a bottom jobs/logs pane on wide terminals
- [x] add a stacked vertical fallback layout for narrow terminals instead of relying on fragile horizontal card formulas
- [x] keep the backend-facing UI model typed around section state and content items rather than monolithic raw text payload fields
- [x] verify v1.5 phase 22 directly with the Go CLI test suite, direct `contextplus-ui snapshot` inspection on this repository, direct `contextplus-ui doctor`, and narrow-layout rendering coverage
- [x] commit the verified v1.5 phase 22 work

- [x] finish v1.5 phase 21 by exposing stage timing, cache, integrity, and scheduler observability as first-class operator signals instead of scattered internal counters
- [x] add stage timing metrics with per-stage duration plus files-per-second, chunks-per-second, and embeds-per-second observability in the persisted index status and doctor surfaces
- [x] expose cache observability for process-cache hits, vector-cache hits, parser-pool reuse, and lexical candidate counts through doctor text, machine-readable doctor JSON, and the human CLI views
- [x] expose integrity observability for vector coverage, parse failures by language, fallback marker counts, stale-generation age, and refresh failures through doctor text, machine-readable doctor JSON, backend logs, and the human CLI status area
- [x] expose scheduler observability for watcher queue depth, batch counts, deduped path events, canceled jobs, superseded jobs, and full rebuild reasons through doctor text, machine-readable doctor JSON, backend logs, and the human CLI status area
- [x] increment scheduler canceled-job tracking when a queued watcher rebuild is superseded by a newer change batch
- [x] verify v1.5 phase 21 directly with focused bridge/index observability coverage, the Go CLI test suite, the full main suite, direct `doctor --json`, direct `contextplus-ui doctor`, and a live snapshot render on this repository
- [x] commit the verified v1.5 phase 21 work

- [x] replace the current synthetic-only benchmark in `src/tools/evaluation.ts` with a real scenario-based benchmark harness instead of relying on one toy repo under `src/auth`, `src/ui`, `src/api`, and `docs`
- [x] keep the old tiny synthetic repo only as the small/smoke scenario, not as the main retrieval, freshness, or performance gate
- [x] add benchmark targets for a small repo, medium repo, large monorepo, polyglot repo, intentionally broken prepared state, and a repo with generated files plus ignored trees
- [x] add rename-heavy and change-heavy freshness coverage that exercises stale-after-write behavior and restore correctness
- [x] define a golden operator-question set with expected files, symbols, dependencies, and hub results across the benchmark scenarios
- [x] measure exact lookup accuracy, related-search relevance, symbol resolution accuracy, dependency graph accuracy, hub suggestion quality, stale-after-write failure rate, restore correctness, and index validation false-positive and false-negative rates
- [x] measure p50, p95, and p99 query latency for exact lookup, related search, and broad research in the built evaluation report
- [x] update the public `evaluate` descriptions in `README.md` and `src/index.ts` so they describe the real benchmark harness truthfully
- [x] formalize a three-layer query architecture for v1.5 with an explicit Layer A exact substrate, Layer B candidate substrate, and Layer C explanation substrate
- [x] keep `symbol`, `word`, `outline`, `deps`, `status`, and `changes` as the exact deterministic first path while exposing that layer explicitly in the persisted query-engine contract
- [x] keep lexical, semantic, structural, cluster, and hub-prior candidate generation in the prepared retrieval stack and make the layered contract point at those persisted artifacts
- [x] add a persisted `query-explanation-index` artifact with per-file purpose summaries, public API cards, dependency-neighborhood summaries, hot-path summaries, ownership summaries, module cards, subsystem cards, hub rationale, and change-risk notes
- [x] make `research` and bridge-facing rich operator views consume the explanation substrate instead of reconstructing subsystem and hub summaries on demand
- [x] change `searchHybridState()` in `src/tools/hybrid-retrieval.ts` so missing rerank vectors are no longer silently converted into `semanticScore = 0`
- [x] add an explicit `HybridVectorIntegrityError` and fail loudly when hybrid semantic or mixed retrieval encounters stale, corrupt, or refresh-incomplete vector state
- [x] make keyword-only continuation explicit by reporting `explicit-lexical-only` vector coverage instead of silently treating missing vectors as acceptable
- [x] surface hybrid vector-coverage diagnostics through related-search output, bridge payloads, `doctor`, and the human CLI doctor overview so stale namespaces are obvious to operators
- [x] remove the brittle unified-ranking heuristic in `src/tools/unified-ranking.ts` that treated chunk matches as files when `match.title === "file"`
- [x] replace that heuristic with explicit typed metadata on hybrid ranking entities and matches in `src/tools/hybrid-retrieval.ts` so real symbols named `file` are handled correctly
- [x] bump the persisted full-index artifact version so stale hybrid artifacts without explicit entity typing fail validation instead of being silently reused
- [x] add direct regressions proving a real symbol literally named `file` stays typed as a symbol in both hybrid retrieval and unified ranking
- [x] retire the old `findBraceBlockEnd()`-style regex range path by removing the remaining regex parser implementation from `src/core/parser.ts`
- [x] ensure symbol range computation no longer depends on raw brace counting, so braces inside strings and comments cannot shift `endLine`
- [x] verify with built tree-sitter parsing that function ranges stay correct when source text contains `}` inside strings and comments
- [x] fix the file omission bug in `refreshPersistedFileSearchState()` in `src/tools/semantic-search.ts` so changed files cannot silently disappear from `nextFiles`
- [x] replace silent omission with an explicit `FileSearchRefreshError` that blocks refresh and reports per-file reasons instead of returning a partially missing search state
- [x] add explicit refresh diagnostics listing files that failed document construction or would silently disappear from the persisted file-search index
- [x] add regression coverage proving a previously indexed file cannot disappear from the live file-search index without an explicit surfaced error
- [x] audit `src/core/clustering.ts` and the semantic cluster artifact path to remove the current full affinity matrix, normalized Laplacian, eigen decomposition, and k-means pipeline as the default strategy
- [x] replace spectral clustering with deterministic farthest-seed cosine k-means so semantic cluster building has a cost shape suitable for much larger repositories
- [x] preserve semantic cluster artifact consumers by keeping cluster labels, related-file neighborhoods, subsystem summaries, and persisted cluster structure stable while swapping the algorithm underneath
- [x] add explicit medium and large clustering benchmark coverage in `src/tools/evaluation.ts` and direct clustering tests so clustering cost is measured directly
- [x] finish removing the remaining `null`-return contract from `parseWithTreeSitter()` in `src/core/tree-sitter.ts` so unsupported-language handling becomes an explicit `TreeSitterUnsupportedLanguageError` instead of a silent `null` path
- [x] make unsupported-language handling fail loudly by contract so unsupported files no longer silently degrade into approximate parsing
- [x] remove the remaining regex parser path from `src/core/parser.ts`, including the old brace-counting range heuristics, instead of keeping a hidden fallback implementation
- [x] verify direct built artifacts now throw `TreeSitterUnsupportedLanguageError` for unsupported files through both `parseWithTreeSitter()` and `analyzeFile()`
- [x] tighten file-search invalidation metadata to include `ctimeMs` alongside `mtimeMs` and `size` so same-size rewrites with reset mtimes cannot evade refresh detection
- [x] replace JSON text vector storage in sqlite with binary `Float32Array` blob storage in `src/core/index-database.ts`
- [x] remove repeated vector JSON stringify and parse overhead from vector load and save paths by switching `vector_entries` to `vector_blob`
- [x] migrate existing vector read and write helpers to the binary layout without reintroducing whole-namespace rewrites
- [x] add explicit legacy vector-schema migration so existing `vector_json` rows upgrade to schema version `4` on open and the temporary legacy table is removed afterward
- [x] add direct regression coverage proving vectors are stored as sqlite blobs and legacy JSON vector rows migrate to blob storage on first open
- [x] serialize same-root checkpoint and restore write refreshes so prepared-index regeneration cannot race itself under concurrent repo mutations
- [x] audit `indexCodebase()` progress callbacks and index-status writes so stage-state persistence is no longer triggered on every progress event
- [x] keep stage-boundary and failure persistence in `executeIndexStage()` but debounce progress-driven status writes in `src/tools/index-codebase.ts`
- [x] add a direct regression proving repeated same-phase progress bursts are coalesced while phase changes still persist immediately
- [x] audit the unified search flow so the query embedding is computed exactly once per top-level query instead of separately in file search and hybrid retrieval
- [x] compute the unified query embedding once in `src/tools/unified-ranking.ts` and pass the shared query vector through file ranking and hybrid retrieval reranking stages
- [x] extend `SearchIndex.search()` and hybrid retrieval query options so semantic reranking can consume a caller-supplied query vector instead of re-embedding internally
- [x] add direct regression coverage proving one top-level unified query issues exactly one embedding request in the expected path
- [x] remove the redundant `await readFile(wasmPath)` work from `loadGrammar()` in `src/core/tree-sitter.ts` and load WASM grammars directly through `Parser.Language.load(wasmPath)`
- [x] stop creating a fresh parser instance per file in `parseWithTreeSitter()` by pooling parser instances per grammar within the backend session
- [x] keep tree-sitter parser reuse deterministic and observable, including explicit pooled-parser reuse counters
- [x] expose tree-sitter grammar-load failures and parse failures as explicit errors instead of returning silent `null` failures for supported grammars
- [x] track parse-failure counts by language and surface tree-sitter runtime stats through `doctor` and the evaluation benchmark report
- [x] remove the silent fallback from `analyzeFile()` in `src/core/parser.ts` so supported parser failures stop degrading into regex parsing
- [x] rewrite `refreshPersistedFileSearchState()` in `src/tools/semantic-search.ts` to use `(mtimeMs, size)` as the first invalidation gate instead of computing content hashes for every file on every refresh
- [x] compute a content hash only when metadata changed, so no-op file-search refreshes stop paying a full-file hashing pass across the repo
- [x] persist file metadata in the file-search index state so the stat-based prefilter is deterministic and reusable across refreshes
- [x] keep stat-based prefiltering strict by escalating to content-hash verification when metadata indicates change, including metadata-only touches where content stays identical
- [x] verify the unchanged-repo refresh path is materially cheaper with regression tests and a direct benchmark over a no-op second refresh
- [x] replace the hybrid lexical scoring path that scanned all documents with a persisted lexical candidate-generation substrate in the hybrid retrieval artifacts
- [x] rework hybrid retrieval so lexical retrieval returns a bounded candidate set first and semantic reranking runs only on those candidates
- [x] keep the exact deterministic substrate separate from broad related retrieval while upgrading hybrid lexical candidate generation
- [x] add explicit hybrid query-stage diagnostics so callers can inspect lexical candidate counts, rerank candidate counts, and final result counts
- [x] rewrite `loadEmbeddingCache()` in `src/core/embeddings.ts` so query hot paths stop loading whole vector namespaces into a giant JS object on every search
- [x] add a process-level cache keyed by namespace and generation so repeated vector reads can reuse already-loaded entries while the serving generation is unchanged
- [x] add generation-aware invalidation so process-cache entries from the previous active generation are dropped as soon as serving switches
- [x] introduce candidate-first vector fetches so lexical prefiltering or exact-query narrowing reduces the set of vectors loaded for ranking
- [x] remove the full-cache query pattern from `src/tools/hybrid-retrieval.ts` by routing `searchHybridChunkIndex()` and `searchHybridIdentifierIndex()` through by-id vector loads
- [x] replace the semantic identifier callsite query path’s full-cache load with by-id vector reads plus partial cache upserts for newly embedded callsites
- [x] rewrite the embedding save path in `src/core/embeddings.ts` so `saveEmbeddingCache()` stops replacing full vector namespaces for every save
- [x] switch the embedding save path to the sqlite delta-write APIs in `src/core/index-database.ts`, specifically `upsertVectorEntries()` and `deleteVectorEntries()`, instead of `replaceVectorCollection()`
- [x] remove the full-namespace delete-and-reinsert behavior from the hot embedding persistence path so unchanged vectors keep their existing sqlite rows
- [x] preserve namespace integrity and deletion semantics while switching to delta writes, including zero-entry namespace materialization for split identifier caches
- [x] verify directly that incremental embedding updates on a small file set do not rewrite the full vector namespace in sqlite
- [x] expand `src/cli/commands.ts` so the CLI bridge exposes the same high-value engine surfaces as MCP instead of stopping at the dashboard subset
- [x] add bridge commands for `search` with exact and related intent, explicit retrieval-mode controls, and structured result payloads
- [x] add bridge commands for `symbol`, `word`, `outline`, and `deps` so the human operator can inspect the same exact-query substrate the agent uses
- [x] add bridge commands for `lint`, `blast_radius`, `research`, `checkpoint`, and `restore` so the CLI is not limited to a thin dashboard
- [x] expose typed `status` and `changes` data through the persistent bridge so the future TUI can render tables and detail panes without scraping text
- [x] update `README.md` so the documented CLI bridge surface matches the expanded shared backend command set and persistent `bridge-serve` protocol
- [x] replace the repeated shell-out backend model in `cli/internal/backend/client.go` with a persistent local bridge session that survives across UI actions
- [x] define a long-lived backend core that owns watcher state, index job state, active-generation service calls, and the persistent-process cache surface shared by the CLI bridge
- [x] expose that backend core through two transports by routing MCP `index` through it and adding a local CLI stdio bridge transport for the human UI
- [x] implement and document the local persistent CLI transport as a line-delimited JSON protocol with request, response, and event frames
- [x] remove per-action cold starts from `contextplus-ui` by keeping one backend Node process alive for the lifetime of the Go client
- [x] stream backend log lines, index progress events, watch batches, and job-state changes into the TUI over the persistent bridge instead of polling subprocess commands
- [x] move watcher ownership and the file-change queue into the backend service so the human CLI no longer owns a separate watcher path
- [x] add explicit index generations to the durable sqlite contract so a new index build writes into an inactive generation instead of mutating the live one
- [x] add an active-generation pointer in sqlite and make query-time artifact and vector reads resolve through that serving pointer unless an explicit generation is requested
- [x] make `indexCodebase()` reserve a pending generation, write stage artifacts into that generation, validate that generation fully, and switch the active pointer only after validation succeeds
- [x] prevent partially completed stage output from becoming query-visible if indexing, validation, or artifact persistence fails mid-run
- [x] materialize reused and empty vector namespaces into the pending generation so validation and serving semantics remain correct even when a reindex reuses existing embeddings or indexes zero documents
- [x] add generation metadata, validation timestamp, and freshness metadata to validation reports, CLI bridge payloads, and operator status views
- [x] add explicit serving-status output to `doctor` and overview surfaces so operators can see active generation, pending generation, last validation time, and freshness immediately
- [x] define failure behavior for generation validation so the previous generation keeps serving, the failed generation is recorded, and freshness is not falsely advanced
- [x] make prepared-index repair rebuild and validate a new generation before switching serving state, instead of mutating the live generation in place
- [x] audit the write paths in `src/index.ts`, the checkpoint flow, and the restore flow so every code mutation records which files must be refreshed
- [x] after `checkpoint`, synchronously refresh the prepared index so file records, identifier records, chunk artifacts, code-structure artifacts, exact-query state, and embeddings are all regenerated before the write returns
- [x] after `restore`, perform the same synchronous refresh for all restored files so restored filesystem truth becomes query-visible without a manual reindex
- [x] mark the active serving generation dirty immediately after a write, switch it back to fresh only after the new generation validates, and mark it blocked with a loud error if automatic refresh fails
- [x] make prepared-index validation reject dirty or blocked active generations so stale exact and related queries fail loudly instead of answering from mismatched filesystem truth
- [x] expose explicit freshness state on prepared MCP query responses and verify that `symbol`, `word`, `search`, and `research` all see post-write truth without a manual reindex

## maintenance

- [x] expose the full engine cleanly through the planned CLI and UX layers once the fast-path, indexing, retrieval, structure, and research primitives were stable
- [x] create the human CLI under `cli/`
- [x] visualize restore points, hubs, cluster data, tree data, and repo health in the CLI
- [x] build the human CLI with Charm's Bubble Tea stack
- [x] ship backend commands such as `contextplus index`, `validate-index`, `status`, `changes`, `cluster`, and machine-readable `bridge` subcommands
- [x] add a create-hub flow for humans in the CLI
- [x] include CLI build and installation in `install-contextplus.sh` and expose the global `contextplus-ui` command
- [x] add Node bridge commands with machine-readable output for index health, hubs, restore points, git status, and cluster data
- [x] add a project-local Go toolchain path via Pixi so the Bubble Tea CLI can build without requiring a global Go install
- [x] add a dashboard snapshot / non-interactive verification mode for the CLI so it can be tested directly
- [x] make the CLI able to initialize and index a repo, report Ollama runtime state, watch for code changes, and trigger loud background reindexing
- [x] add the animated CLI magician companion to the dashboard
- [x] bootstrap a fresh Context+ full index for this repository
- [x] validate the prepared full index after indexing
- [x] verify `.contextplus/state/index.sqlite` and generated durable artifacts directly on disk
- [x] reorder the remaining v1 items so query-ranked hubs, explicit search retrieval modes, stronger lint scoring, and vector-database-backed embedding/search storage land before the old roadmap step 21
- [x] finish roadmap step 21 by extending `find_hub` with query-ranked keyword, semantic, and blended hub discovery
- [x] finish roadmap step 22 by exposing explicit `retrieval_mode` controls on the unified `search` surface
- [x] finish roadmap step 23 by adding stronger `lint` repo/file scoring and reporting on top of deterministic diagnostics
- [x] finish roadmap step 24 by moving persisted embedding/search storage onto sqlite vector collections
- [x] verify roadmap steps 21-24 directly with build, focused suites, broader index/search suites, a real full reindex on this repository, sqlite inspection, and direct built-tool outputs
- [x] remove the stale `checkpoint` v1 backlog item after deciding it is not part of the product direction
- [x] stop generating empty legacy `.contextplus/` directories during bootstrap
- [x] remove obsolete sqlite-migration-era `.contextplus/` directories on reindex
- [x] update tests and docs to reflect the minimal populated `.contextplus/` layout
- [x] verify fresh indexing and reindex cleanup only leave directories that are actually used
- [x] run a fresh full Context+ index for this repository through the MCP tool
- [x] verify the refreshed `.contextplus/state/index.sqlite` and generated durable artifacts directly on disk
- [x] update the shared `contextplus-mcp` skill with current best-practice indexing and query workflow guidance
- [x] verify the shared skill text matches the repo-local Context+ instructions for indexing and prepared-index use

## v1

- [x] rename tools for better meaning
  - [x] rename semantic_navigate to cluster
  - [x] rename get_context_tree to tree
  - [x] rename semantic_identifier_search and semantic_code_search (merged) to search
  - [x] rename get_file_skeleton to skeleton
  - [x] rename get_blast_radius to blast_radius
  - [x] rename run_static_analysis to lint
  - [x] rename propose_commit to checkpoint
  - [x] rename list_restore_points to restore_points
  - [x] rename undo_change to restore
  - [x] rename get_feature_hub to find_hub
- [x] create a new tool called index that initializes the project by creating a context tree and .contextplus folder
  - [x] use .contextplus/hubs for feature hubs
  - [x] use .contextplus/embeddings for storing file and symbol embeddings
  - [x] use .contextplus/config for configuration files
- [x] extend `restore` so it can restore to a specific checkpoint point with the shipped `restore_points` -> `restore(point_id)` UX
- [x] make `find_hub` return the all-hubs context when called with no parameters

## maintenance

- [x] audit `TODO.md` against the current codebase and recent roadmap commits, then move stale completed items out of the active TODO
- [x] re-verify roadmap step 20 against the current real benchmark harness and public `evaluate` surface after later roadmap drift
- [x] confirm the shipped evaluation report still exposes hot exact-query latency, related-search latency, broad-research latency, estimated token cost, and hybrid exact-vs-related efficiency
- [x] re-run the direct step 20 verification pass with the focused evaluation suite, a direct built evaluation run, the full main test suite, and the landing production build
- [x] commit the verified step 20 follow-up work
- [x] finish roadmap step 20 by extending the evaluation suite to measure hot exact-query latency, related-search latency, broad-research latency, estimated token cost, and hybrid exact-vs-related task efficiency
- [x] verify roadmap step 20 directly with the focused evaluation suite, a direct built evaluation run, the full main test suite, and the landing production build
- [x] commit the verified step 20 work
- [x] re-verify roadmap step 19 against the current shipped search-routing behavior and public research guidance after later roadmap drift
- [x] confirm `search(intent='exact')` still uses the fast substrate, `search(intent='related')` still stays on ranked discovery, and `research` remains the broad-context tool on the built server
- [x] re-run the direct step 19 verification pass with the built-server MCP routing test, a live built-server routing probe on this repository, Context+ blast-radius/lint checks, build, the full main test suite, and the landing production build
- [x] commit the verified step 19 follow-up work
- [x] re-verify roadmap step 18 against the current shipped MCP surface, built exact-query runtime, and landing copies after later roadmap drift
- [x] confirm the tiny exact-query MCP tool set still exposes `symbol`, `word`, `outline`, `deps`, `status`, and `changes` without additional public-surface drift
- [x] re-run the direct step 18 verification pass with the built-server MCP integration test, a live built-server MCP probe on this repository, build, the full main test suite, and the landing production build
- [x] commit the verified step 18 follow-up work
- [x] re-verify roadmap step 17 against the current prepared-index pipeline and exact-query surface after later roadmap drift
- [x] fix local dependency resolution for runtime `.js` import specifiers so the active-generation structure artifact and exact-query dependency graph resolve TypeScript source files correctly
- [x] re-run the direct step 17 verification pass with active-generation sqlite inspection, built exact-query dependency lookups, Context+ lint, focused exact-query coverage, build, and the full main test suite
- [x] commit the verified step 17 follow-up work
- [x] re-verify roadmap step 16 against the current shipped MCP surface and landing copies after later roadmap drift
- [x] sync the landing tool examples, mirrored instructions, and public tool labels with the current `search` and `research` contract
- [x] re-run the direct step 16 verification pass and move the follow-up back out of `TODO.md`
- [x] finish roadmap step 19 by routing `search` by explicit intent so exact questions use the fast substrate, related-item discovery stays on ranked search, and `research` is documented as the broad-context tool
- [x] verify roadmap step 19 directly with a built-server MCP routing test, build, the full main test suite, Context+ blast-radius/lint checks, and the landing production build
- [x] commit the verified step 19 work
- [x] finish roadmap step 18 by exposing the fast exact-query substrate through tiny public MCP tools for exact symbol lookup, word lookup, file outlines, dependency tracing, git status, and git changes
- [x] verify roadmap step 18 directly with a built-server MCP integration test, build, the full main test suite, and the landing production build
- [x] commit the verified step 18 work
- [x] finish roadmap step 17 by adding a fast exact-query substrate over the prepared full index with hot in-memory caches for exact symbol lookup, word lookup, file outlines, reverse dependencies, and git-backed change/status tracking
- [x] verify roadmap step 17 directly with Context+ lint, a focused exact-query test, build, and the full main test suite
- [x] commit the verified step 17 work
- [x] expand the roadmap before the former step 17 to add a `codedb`-inspired fast exact-query phase that reduces tokens without removing Context+ intelligence features
- [x] align `TODO.md` and the ExecPlan so the next implementation phase is the fast-path plus escalation stack, and move the CLI/UX milestone to step 21
- [x] commit the verified roadmap expansion
- [x] remove dead landing files and redundant bun lockfiles after confirming npm is the canonical package manager for this repo
- [x] verify the removed landing component/assets and deleted bun lockfiles have no remaining repo references, then rebuild and rerun the test suite
- [x] commit the verified repo cleanup
- [x] audit the published docs, landing copies, and shared `contextplus-mcp` skill after steps 13-16 so they match the shipped tool surface and removed memory features
- [x] remove stale memory references and stale roadmap text from the server description, ExecPlan, and shared skill, and verify the active public docs no longer mention deleted search/research knobs
- [x] commit the verified repo-side documentation sync
- [x] finish roadmap step 16 by removing public weight-tuning knobs from `search`, collapsing `research` to a query-only public interface, and aligning the landing tool examples with the shipped MCP surface
- [x] verify roadmap step 16 directly with build, the full test suite, Context+ blast-radius/lint checks, and source sweeps that prove the removed public knobs are gone from the active tool boundary
- [x] commit the verified step 16 work
- [x] finish roadmap step 15 by adding a deterministic evaluation suite and public `evaluate` benchmark tool for retrieval, navigation, freshness, speed, and research output quality
- [x] verify roadmap step 15 directly with build, focused evaluation coverage, the full test suite, and a direct `evaluate` run against the built tool
- [x] commit the verified step 15 work
- [x] finish roadmap step 14 by hardening prepared-index validation, crash-only query behavior, and explicit repair commands
- [x] verify roadmap step 14 directly with build, targeted reliability/query suites, the full test suite, and a real index validation plus repair cycle
- [x] commit the verified step 14 work
- [x] finish roadmap step 13 by adding a unified `research` tool that aggregates ranked code hits, related files, subsystem summaries, and hub context from the prepared full-engine artifacts
- [x] verify roadmap step 13 directly with build, focused research coverage, the full test suite, a real full index run on the repository, and a direct `research` query against this repository
- [x] commit the verified step 13 work
- [x] evaluate removing the current memory graph and memory MCP tools after deciding the feature should not be part of the product
- [x] drop roadmap steps 11 and 12 as forward product goals after deciding memory and ACP features are not worth their token and codebase cost for this project direction
- [x] remove the dropped step 11 memory subsystem from the runtime, tests, and mirrored docs
- [x] verify the repository still builds and tests cleanly without the removed memory subsystem
- [x] commit the verified step 11 removal
- [x] finish roadmap step 10 by generating persisted hub suggestions and feature-group candidates automatically from clusters, structure graphs, and file FEATURE tags
- [x] verify roadmap step 10 directly with focused hub-suggestion and feature-hub coverage, the index integration suite, and a real full index run plus sqlite inspection
- [x] finish roadmap step 06 by expanding the persisted structure artifact into a richer per-file and per-module graph with symbol records, file-to-symbol mappings, ownership edges, module summaries, and module import edges
- [x] verify roadmap step 06 directly with targeted structure-index tests, the index integration suite, the full test suite, a real full index run, and direct sqlite inspection of the richer structure state
- [x] finish roadmap step 05 by replacing size-plus-mtime refresh checks with content hashes for file and identifier artifacts, content-hash-plus-chunk-content-hash reuse for chunk artifacts, and dependency-aware structure invalidation
- [x] verify roadmap step 05 directly with targeted invalidation tests, the full test suite, a real full index run, and direct sqlite inspection of the updated invalidation contract
- [x] finish roadmap step 04 by persisting hybrid chunk and identifier retrieval indexes with lexical term maps plus dense embedding references in sqlite
- [x] verify roadmap step 04 directly with build, the full test suite, a real full index run, and direct sqlite inspection of hybrid retrieval artifacts
- [x] finish roadmap step 03 by promoting chunk-level AST indexing into a first-class sqlite-backed artifact contract
- [x] verify roadmap step 03 directly with build, the full test suite, a real full index run, and direct sqlite inspection of persisted chunk artifacts
- [x] run a fresh Context+ full index for this repository through the MCP tool
- [x] verify the refreshed `.contextplus/state/index.sqlite` and durable artifacts directly on disk
- [x] complete the sqlite-only follow-up migration so `.contextplus/state/index.sqlite` becomes the single authoritative machine-state store
- [x] migrate the remaining file-backed machine state into sqlite, including restore-point manifest, restore-point backups, context-tree export, and embedding caches
- [x] delete legacy json and cache artifacts during bootstrap and verify they stay absent after a real full index run and an MCP `index` run
- [x] finish roadmap step 02.5 by moving the durable full-engine index substrate onto sqlite-backed local storage under `.contextplus/state/index.sqlite`
- [x] verify roadmap step 02.5 directly with build, tests, a real full index run, and direct sqlite artifact inspection
- [x] finish roadmap step 02 by splitting the indexing pipeline into durable rerunnable stages with persisted dependencies and strict core prerequisites for `full`
- [x] verify roadmap step 02 directly with build, tests, a real full index run, and on-disk inspection of `.contextplus/config/index-stages.json`
- [x] create an ExecPlan for the 17-step full-engine roadmap and keep it updated as implementation proceeds
- [x] finish roadmap step 01 by locking the `index(core)` and `index(full)` contract, persisted artifact schemas, invalidation rules, and failure semantics
- [x] verify roadmap step 01 directly with build, tests, and a real full index run
- [x] remove references to the previous repo-local storage location from the `contextplus-mcp` skill and repo instruction mirrors so docs only describe `.contextplus`
- [x] rerun Context+ full indexing for this repository and verify the refreshed `.contextplus` artifacts on disk
- [x] update the `contextplus-mcp` skill to document the current full-mode indexing features and require `full` unless the user or repo-local manual explicitly asks for `core`
- [x] implement the full-engine indexing contract and make `full` the primary indexing mode
- [x] persist full-engine indexing artifacts beyond the current file and identifier indexes
- [x] verify the new indexing mode by running the index workflow and checking the generated `.contextplus` artifacts
- [x] read the relevant `claude-context` and `contextplus` `v2` repo surfaces to identify what a best-in-class full engine is still missing
- [x] add a strict dependency-ordered roadmap for the best full engine to `TODO.md`
- [x] rerun the Context+ `index` workflow for this repository
- [x] verify `.contextplus/config/index-status.json`, `.contextplus/embeddings/file-search-index.json`, and `.contextplus/embeddings/identifier-search-index.json` were refreshed and present after indexing
- [x] make `index` perform a real full search index build instead of only bootstrap state
  - [x] make `index` eagerly build and persist both file and identifier indexes under `.contextplus/`
  - [x] store index metadata and current phase in `.contextplus/config` so indexing state is inspectable
  - [x] add a lightweight indexing status surface or status file for long-running or background indexing
  - [x] add progress logging during indexing with counts, phase updates, and elapsed progress
  - [x] make later `search` runs perform cheap incremental refreshes for changed files instead of rebuilding everything
- [x] remove the old repo-local index state from the previous storage location
- [x] create a fresh `.contextplus` index for this repository using the Context+ `index` workflow
- [x] verify the generated `.contextplus` layout and manifests match the documented project state
- [x] update the `contextplus-mcp` skill so it explicitly covers repo-local instruction precedence for reindex tasks
- [x] remove the remaining old-storage handling from runtime ignore logic
- [x] verify runtime code and focused tests no longer depend on the previous storage layout
- [x] remove the blanket no-comments policy from repo instructions and mirrored landing instructions
- [x] allow ordinary post-header comments in `checkpoint` while keeping header, feature, and size checks
- [x] rebuild `lint` so it runs valid native commands and reports practical repo-rule findings
- [x] verify the updated lint and checkpoint behavior with targeted suites and the full main test run
- [x] finish roadmap step 07 by building a unified ranking engine that combines file, chunk, identifier, and structure evidence over the persisted sqlite artifacts
- [x] verify roadmap step 07 directly with the focused unified-ranking test and a clean full-index rerun on the repository
- [x] finish roadmap step 08 by routing the public `search` surface through the unified ranking engine and simplifying the search contract around file, symbol, and mixed result types
- [x] verify roadmap step 08 directly with focused canonical-search coverage and a real full-index plus canonical-search run on the repository
- [x] finish roadmap step 09 by persisting semantic clusters, cluster labels, related-file graphs, and subsystem summaries as full-index sqlite artifacts
- [x] verify roadmap step 09 directly with focused cluster-artifact and semantic-navigate coverage plus a real full-index and cluster render on the repository

## phase 31 completed

- [x] Rename the shipped product and commands from Context+ / `contextplus` / `contextplus-ui` to the context++ brand with `contextplusplus` and `contextplusplus-cli` as the executable surfaces across package metadata, install/build entrypoints, generated config output, MCP metadata, and human CLI labels.
- [x] Keep the repo-local machine state contract under `.contextplus/` intact while migrating only the user-facing product and command surface.
- [x] Update the landing/docs layer so the repo stops shipping mixed Context+ and context++ branding.
- [x] Create README-ready image artifacts that explain the contextplusplus-cli surface and serving model visually.
- [x] Generate benchmark artifacts from the real evaluation harness and use them in deeper README benchmark documentation.

## rename refinement completed

- [x] Finish the public rename pass so actual command, binary, config, and UI surfaces use `contextplusplus` / `contextplusplus-cli`, while `context++` remains product branding only in prose and reading-only labels.
- [x] Remove lingering `++` command names from CLI-visible text, generated artifacts, install/build entrypoints, and repo-local completion notes.
- [x] Verify the rename directly with root build/tests, Go CLI build/tests, landing build, and a repository grep sweep for stale actual-surface names.

## cli usability refinement completed

- [x] Make the human CLI panes usable in small and large terminals by adding real scrolling and windowing where rows can overflow, instead of truncating boxes with unreachable content.
- [x] Move command discovery to `/`, keep `Esc` returning to the previous view, and preserve direct execution into the correct destination view.
- [x] Add section-local search for file-heavy and index-heavy blocks so operators can narrow lists and tables without endless scrolling.
- [x] Restore the magician pet as a visible stable part of the CLI header across layouts.
- [x] Verify the CLI behavior directly with focused Go UI tests, the full Go CLI build and test suite, and a built snapshot render.

## cli simplification and index health refinement completed

- [x] Replace the five-pane default dashboard with a single main panel plus a compact activity strip so the human CLI behaves like an on-demand terminal tool instead of a wall of always-open boxes.
- [x] Make `/` open a real command palette that still shows matches while the query starts with a slash, support `/exit` for quitting, and stop binding plain `q` to quit.
- [x] Keep file-heavy sections searchable in place and preserve detail/back navigation with `Enter` and `Esc`.
- [x] Remove the shell-script parser failure from the prepared-index path so `install-contextplusplus.sh` no longer poisons the initial index state.
- [x] Verify the updated CLI and refreshed index directly with focused Go UI tests, the full Go CLI suite, a TypeScript build, a targeted tree-sitter test run, a built snapshot render, and a fresh full index on this repository.

## activity shell refinement completed

- [x] Change the default human CLI boot screen from the 8-row overview summary to an activity-first slash-command shell.
- [x] Make slash commands the primary navigation surface with explicit entries like `/overview` and `/index`, and keep the slash editable instead of hard-coding it as an unremovable prompt.
- [x] Keep the magician pet visible inside the main activity shell while preserving direct detail/back navigation for content windows.
- [x] Verify the updated slash-command flow directly with focused Go UI tests, the full Go CLI suite, and rebuilt snapshot renders.

## slash-only interaction refinement completed

- [x] Remove the remaining plain-letter action bindings from the human CLI so normal typing no longer triggers hidden tasks.
- [x] Move the remaining operator actions onto slash commands instead of single-letter shortcuts.
- [x] Keep command suggestions hidden until the input starts with `/`, make the suggestion list scrollable/selectable, and preserve narrow-window rendering.
- [x] Verify directly that letters like `e`, `q`, and related keys remain normal input with focused Go UI tests, the full Go CLI suite, and rebuilt snapshot renders.

## activity shell polish completed

- [x] Remove the duplicate top cat/header clutter from the human CLI and leave a single pet inside the activity window.
- [x] Move `contextplusplus-cli` into the activity title line and remove the extra explanatory header and activity filler text.
- [x] Keep right-arrow from jumping into an empty detail state on the activity screen when there is no actionable command context.
- [x] Wrap long current-status text within the activity shell instead of letting it run past the usable pane width.
- [x] Verify the activity shell directly with focused Go UI tests, the full Go CLI suite, and rebuilt snapshot renders.

## magician runtime title completed

- [x] Show a grey live magician status next to `contextplusplus-cli` in the activity title line.
- [x] Render `The magician is resting` when no active model-backed work is running.
- [x] Render `The magician is using '<model>' for <activity>` when a model is running for the current active job.
- [x] Verify the title-line status directly with focused Go UI tests and a rebuilt CLI snapshot render.

## ascii block centering completed

- [x] Fix the operator-console ASCII mascot centering by treating the magician as one fixed-width multiline block inside the activity-shell container instead of centering each line independently.
- [x] Add a regression that proves the centered magician keeps one consistent container offset across all rendered frame rows.

## girl magician sprite completed

- [x] Replace the old line-art magician with an in-place animated ASCII sprite based on the three provided girl-magician reference poses.
- [x] Keep the reference-image background transparent by encoding the mascot as palette-indexed frame masks and rendering only the character pixels into terminal ASCII.
- [x] Update UI regression coverage so the new sprite renderer, transparent palette conversion, and centered activity-shell placement stay verified.

## compact braille magician completed

- [x] Compress the girl-magician terminal sprite into roughly 8 real CLI rows by replacing the coarse double-glyph block renderer with a masked braille renderer.
- [x] Keep the sprite visually dense in a much smaller footprint by upsampling the source mask into braille subpixels before terminal rendering.
- [x] Update regressions so the compact output is verified for 8-line height, narrow width, dense braille glyph usage, and stable centering.

## high fidelity half-block magician completed

- [x] Replace the lossy braille renderer with a truecolor half-block sprite renderer so the eyes, hair, hood trim, and arm poses keep exact source pixels inside the same 8-line CLI height.
- [x] Widen the source frame masks so the final terminal outline more closely matches the provided reference images instead of collapsing facial and costume detail.
- [x] Verify the updated likeness with focused UI tests, a rebuilt `scplus-cli` snapshot render, and a generated visual sprite preview image for manual inspection.

## readme-generator skill completed

- [x] Create a reusable `readme-generator` Codex skill under the default skills directory that instructs agents to deeply inspect a codebase before writing an exhaustive `README.md`.
- [x] Tailor the `readme-generator` skill so it covers local development, architecture understanding, and environment/setup documentation while intentionally omitting troubleshooting, deployment, and testing sections.
- [x] Validate the new `readme-generator` skill with the skill-creator validator and record the completed goal in `TODO_COMPLETED.md`.

## repository readme rewrite completed

- [x] Rewrite the repository root `README.md` with the `readme-generator` structure so it accurately documents scplus for local development, architecture understanding, environment configuration, and operational commands.
- [x] Use Context+ discovery plus direct file inspection to replace stale README claims with the current branding, storage contract, setup flow, and command surface reflected by the codebase and architecture docs.
- [x] Verify the rewritten `README.md` against the repository manifests and docs, then move this goal from `TODO.md` to `TODO_COMPLETED.md`.

## repository readme expansion completed

- [x] Expand the repository root `README.md` into a substantially more in-depth install-first guide that restores missing contextual detail from the previous README while staying aligned with the current codebase.
- [x] Document the full MCP tool surface, bridge/local automation surface, human CLI command surface, supported client init/config flows, and Codex TOML configuration in the README.
- [x] Correct the model wording in the README to reflect that the Ollama models were downloaded from official upstream models and then locally modified to extend context window configuration, rather than presented as bespoke model families.
- [x] Verify the expanded README against source files, the previous README content, and the install script workflow, then move this goal from `TODO.md` to `TODO_COMPLETED.md`.

## repository readme cli surface completion completed

- [x] Expand the README command documentation again so the documented CLI surfaces match the current direct `scplus-mcp` subcommands, bridge commands, persistent `bridge-serve` controls, and direct `scplus-cli` subcommands.
- [x] Add the interactive `scplus-cli` operator command catalog and keybindings so the human CLI surface is documented as an actual command surface rather than only as a launcher.
- [x] Re-verify the README against `src/cli/commands.ts`, `cli/cmd/scplus-cli/main.go`, and `cli/internal/ui/model.go` so the listed commands and actions correspond to live source.

## ascii magician likeness refinement completed

- [x] Rebuild the girl-magician animation on a consistent `16x16` source grid so the compressed CLI sprite keeps two distinct eyes, a visible center face split, and a silhouette closer to the provided PNG references.
- [x] Replace the half-block pixel look with a compact square ASCII renderer that uses colored ASCII glyphs, mirrored movement frames, and blinking or winking eye variants.
- [x] Verify the final likeness with focused UI tests, a rebuilt live `scplus-cli snapshot` render, and generated ASCII preview images inspected against the reference character.

## dense ascii magician container completed

- [x] Rework the CLI girl-magician renderer around a dense square inner canvas so the sprite keeps the PNG silhouette, distinct eyes, and colored ASCII glyphs instead of coarse pixel blocks.
- [x] Keep the mascot constrained to about eight visible CLI lines while centering a denser inner projection backed by a `64x64` virtual canvas and a compact visible ASCII container.
- [x] Verify the refined mascot through focused UI tests, a rebuilt live `scplus-cli snapshot`, and palette preview inspection of the resulting ASCII render.

## real provider cluster json repair completed

- [x] Harden structured chat JSON parsing so malformed provider output no longer aborts semantic cluster generation immediately.
- [x] Add an explicit provider-repair retry plus local malformed-JSON recovery for repeated missing-comma and truncation cases in structured chat responses.
- [x] Reduce semantic cluster descriptor verbosity and scale its token budget with cluster count so the real Ollama-backed `index` flow can complete on `/home/cesar514/Documents/agent_programming/infinite_tower_reloaded`.
- [x] Verify the change with `npm run build`, focused Node test coverage, a real `node build/index.js index /home/cesar514/Documents/agent_programming/infinite_tower_reloaded` run, and follow-up `validate-index` plus `doctor` checks on that same repo.

## broken symlink traversal repair completed

- [x] Eliminate traversal crashes from dangling symlinks so repository walking no longer throws `ENOENT` when a symlink target is missing.
- [x] Harden watch snapshot scanning so disappearing or broken paths are skipped instead of failing backend refresh logic.
- [x] Add regression coverage for walker traversal and bridge doctor/index behavior against fixtures containing broken symlinks.
- [x] Verify the fix with `npm run build`, targeted Node tests, and real `index`, `validate-index`, and `doctor` runs on `/home/cesar514/Documents/agent_programming/kalshi_botter_reloaded`.

## unborn head doctor repair completed

- [x] Eliminate `fatal: bad revision 'HEAD'` crashes from repo status and changes logic when a git repository has been initialized but has no first commit yet.
- [x] Preserve the existing `HEAD`-based diff behavior for normal repos while switching unborn repos to safe `git diff --cached` plus worktree diff handling.
- [x] Add regression coverage proving bridge doctor works in a no-commit git repo after indexing.
- [x] Verify the fix with `npm run build`, focused bridge tests, and real `doctor` plus `status` runs on `/home/cesar514/Documents/agent_programming/todoer-cli`.
