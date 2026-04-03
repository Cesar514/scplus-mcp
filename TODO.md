# TODO List

```markdown
## v1.5 Goal

- [ ] {Make Context+ serve only a last-known-good validated index generation through one persistent backend shared by MCP and the human CLI, with no silent degradation, no hidden fallback behavior, low steady-state latency after initialization, and a real operator console over the full engine.}

## v1.5 Non-Negotiable Rules

- [ ] {Enforce the greenfield rule across all v1.5 work: prefer loud fatal errors over silent fallback, partial success, misleading empty results, or success-shaped default behavior that hides a broken state.}
- [ ] {Remove silent parser, retrieval, indexing, bridge, caching, and UI fallback paths unless a framework-forced default must remain, and in those rare cases require an explicit `// FALLBACK` marker immediately before the line plus a matching operator-visible degraded-state signal.}
- [ ] {Treat the active serving generation as the product contract: no partial rebuild state, stale writes, half-migrated schema state, or mixed-generation artifacts may leak into live search, exact lookup, research output, or operator views.}
- [ ] {Keep MCP and the human CLI on one backend truth source so they cannot drift in cache state, watcher ownership, job queue state, generation freshness, embedding-provider state, or repair status.}
- [ ] {Do not claim large-repo readiness, low-token superiority, or production-grade trust until real-repo benchmarks, observability, and no-fallback correctness gates pass.}

## v1.5 Execution Order

- [ ] {Finish the serving contract, generation isolation, and post-write freshness guarantees before major UI expansion so the operator console renders stable truth rather than unstable intermediate state.}
- [ ] {Finish backend unification and bridge parity before building advanced TUI actions so the UI does not become another thin subprocess shell over only a subset of the engine.}
- [ ] {Finish no-fallback correctness fixes before spending time on cosmetic UX work or additional feature surfaces.}
- [ ] {Finish steady-state retrieval and vector-write performance work before claiming the project is optimized after initialization.}
- [ ] {Finish real benchmark and observability work before publishing strong performance claims or using those claims to guide broader product direction.}
- [ ] {Keep documentation, instructions, roadmap, and shipped behavior synchronized at every milestone so agents and humans are never guided by stale control documents.}

## Serving Contract and Generation Safety

- [ ] {Introduce an explicit active-generation pointer in the durable state so the query path always reads from one fully validated generation and never from a partially rebuilt in-progress generation.}
- [ ] {Make all reindex, repair, refresh, and post-write update flows build into a new candidate generation first, validate that generation completely, and only then atomically promote it to active status.}
- [ ] {Persist generation metadata that records generation id, mode, schema version, artifact versions, creation timestamp, validation timestamp, and whether the generation is active, staging, failed, or superseded.}
- [ ] {Ensure every public query surface can report which generation it read from so correctness audits and operator debugging can trace stale or broken results directly.}
- [ ] {Block promotion of a generation if any required artifact, vector namespace, text artifact, version contract, or stage-completion contract is missing or inconsistent.}
- [ ] {Preserve the last validated generation when a new build fails so the engine can continue serving stable data instead of dropping into a broken or empty state.}
- [ ] {Add direct tests that prove a failed rebuild cannot corrupt the currently active generation and cannot expose partial artifacts to search or exact-query tools.}

## Post-Write Freshness and Delta Correctness

- [ ] {Define a formal post-write freshness contract for `checkpoint`, `restore`, and any other write-capable workflow so changed files are either refreshed immediately or surfaced as explicitly dirty until refresh completes.}
- [ ] {After `checkpoint`, trigger deterministic delta refresh of the fast exact-query substrate, file manifest state, identifier state, affected chunk state, and affected vector entries for only the touched files plus their structure dependents.}
- [ ] {After `restore`, trigger the same deterministic delta refresh path and explicitly invalidate any stale in-memory cache entries before the next query can observe them.}
- [ ] {Track a per-file and per-generation dirty-state ledger so the system can distinguish clean exact-query state from stale semantic state instead of pretending all artifacts are equally fresh.}
- [ ] {Make every public query path surface freshness metadata when it is serving with dirty dependent artifacts, and fail loudly when the freshness contract is violated rather than silently serving stale answers.}
- [ ] {Add focused tests for same-size content changes, restore-driven reversions, rename/move refresh behavior, and dependency-driven downstream invalidation after local import or export changes.}

## Backend Unification and Shared Service Core

- [ ] {Refactor the runtime so MCP and the human CLI talk to one long-lived backend service process rather than one long-lived MCP server plus repeated per-command subprocess invocations for the CLI.}
- [ ] {Move caches, prepared-state readers, embedding-provider state, watcher state, job scheduling, and generation-tracking logic into one shared backend core that exposes multiple transports instead of duplicating process boundaries.}
- [ ] {Replace the current Go backend client shell-out pattern with a persistent local RPC or bridge channel so repeated UI actions do not pay repeated Node startup, module load, and cache warmup costs.}
- [ ] {Define one explicit bridge contract for commands, progress events, logs, degraded-state signals, and structured errors so the CLI and MCP use the same backend semantics.}
- [ ] {Ensure watcher ownership exists in exactly one place so the CLI, MCP runtime, and future operator tools cannot race each other or trigger duplicate reindex jobs.}
- [ ] {Add integration tests that prove MCP and CLI see the same generation id, dirty-state markers, validation status, and repair outcomes when attached to the same repository.}

## Bridge Parity and Surface Completeness

- [ ] {Bring bridge parity to the full engine by exposing the same essential surfaces currently available through MCP, including `symbol`, `word`, `outline`, `deps`, `search`, `research`, `lint`, `blast_radius`, `checkpoint`, and `restore`.}
- [ ] {Ensure the bridge returns structured JSON payloads for exact results, related search, research summaries, lint reports, blast-radius results, and restore actions rather than only plain text blocks.}
- [ ] {Keep one canonical argument contract per tool so MCP, bridge, and human CLI commands cannot drift on parameter names, optional flags, or result structure.}
- [ ] {Add parity tests that compare MCP and bridge behavior for the same repository query and assert that both transports return equivalent structured outcomes for exact and related questions.}
- [ ] {Audit every CLI-only or MCP-only feature and either unify it behind the shared service contract or remove the divergence if it does not add real product value.}

## No-Fallback Correctness Hardening

- [ ] {Audit the parser layer and remove silent parser degradation paths so grammar-load failures, parse failures, and unsupported-language paths become explicit degraded or fatal states rather than invisible regex substitutions.}
- [ ] {Require parser failures to record which file, which parser backend, and which reason caused degradation, and expose that information through diagnostics instead of hiding it in transient logs.}
- [ ] {Audit retrieval fallbacks so missing vectors, missing lexical state, empty hybrid indexes, or stale caches cannot quietly degrade into lower-fidelity answers without an explicit degraded-state result.}
- [ ] {Audit repair and validation paths so query tools never perform hidden rebuild-like behavior when a prepared index is broken; they must either serve the last-known-good generation or fail loudly with repair guidance.}
- [ ] {Audit UI fallback behavior so empty screens, loading placeholders, and partial panels cannot mislead the operator into believing the backend is healthy when the backend is actually stale or degraded.}
- [ ] {Maintain a repository-wide inventory of every allowed fallback path, why it still exists, what observable signal it emits, and what conditions would permit its later removal.}

## Query Hot Path Performance

- [ ] {Replace whole-corpus hybrid scanning with candidate-first retrieval so related search no longer scores every persisted document for every query once the index has been initialized.}
- [ ] {Add a lexical candidate generator, ideally FTS5 or an equivalent inverted-index layer, that can quickly narrow the file and identifier candidate set before semantic reranking begins.}
- [ ] {Refactor hybrid retrieval so semantic reranking operates only on the candidate subset produced by lexical, structure, or hub priors rather than on `Object.values(state.documents)` for the full corpus.}
- [ ] {Refactor dense embedding search so it no longer loops over every vector entry in memory for each query when a smaller candidate shortlist can be assembled first.}
- [ ] {Tune candidate-set widths explicitly and record p50, p95, and p99 latency tradeoffs so the default search settings are evidence-based rather than intuition-based.}
- [ ] {Add direct large-repo stress tests that prove exact lookup remains fast and related search remains bounded as repository size grows.}

## Vector Persistence and Embedding Performance

- [ ] {Replace full namespace rewrites in the embedding save path with delta `upsertVectorEntries` plus explicit removal of deleted ids so refresh cost scales with changed content rather than total corpus size.}
- [ ] {Stop loading complete vector namespaces into memory for every serving path unless they are actually needed for a bounded candidate set.}
- [ ] {Investigate moving stored vectors from JSON text blobs to a more efficient binary or compact representation once the delta-write path is stable and benchmarked.}
- [ ] {Add explicit vector collection metadata that records provider, model, dimensions, embedding contract version, and generation id so cross-provider cache reuse fails loudly and correctly.}
- [ ] {Track vector refresh hit rate, miss rate, bytes written, entries rewritten, and average refresh cost so embedding maintenance can be optimized as an observable subsystem rather than guessed at.}
- [ ] {Remove ad hoc background embedding behavior from hot paths and make embedding refresh an explicit scheduled or triggered service responsibility with visible progress and error reporting.}

## Exact Query Layer Hardening

- [ ] {Ensure the fast exact-query substrate remains the first choice for deterministic navigation questions and never regresses into invoking the heavier ranked engine when an exact answer is sufficient.}
- [ ] {Add direct accuracy tests for symbol lookup disambiguation, outline correctness, dependency tracing, git status summaries, and git change summaries across rename, delete, and conflict scenarios.}
- [ ] {Audit exact-path result formatting so low-token answers stay compact while still carrying enough structured metadata for automation and UI rendering.}
- [ ] {Expose explicit reason codes for exact-path misses so the system can distinguish not-found, stale-index, unsupported-language, and dirty-generation failures.}

## Unified Ranking and Research Quality

- [ ] {Add explanation metadata to ranked results so operators and agents can inspect which evidence sources contributed to a result score, such as exact lexical hits, identifier overlap, chunk similarity, structure priors, or hub priors.}
- [ ] {Remove brittle heuristics from unified ranking, including metadata shortcuts that can misclassify entities based on label strings rather than explicit typed contracts.}
- [ ] {Add calibration tests that measure whether `search` exact intent reliably avoids expensive related-search paths and whether related-search queries still surface the expected files and symbols.}
- [ ] {Strengthen `research` verification so broad subsystem reports are checked for source grounding, duplication control, and stable output structure across rebuilds.}
- [ ] {Add a debug mode for ranking inspection that exposes candidate counts, evidence weights, and rerank decisions without requiring ad hoc code edits.}

## Parser and Structure Layer Performance

- [ ] {Pool or reuse Tree-sitter parser instances where safe so the indexing and refresh path does not pay avoidable parser construction cost per file.}
- [ ] {Remove redundant grammar-file reads before `Parser.Language.load()` if the underlying library already performs the necessary loading work.}
- [ ] {Measure parser throughput by language and file size and record parse-failure frequency so parser regressions become visible in observability and benchmarks.}
- [ ] {Audit regex fallback helpers and any brace-based heuristics for range extraction so they are either removed or explicitly marked as degraded approximations with tests that show their limits.}

## Watchers, Jobs, and Scheduling

- [ ] {Refactor the watcher so file bursts collapse into one well-scoped refresh or rebuild job instead of repeatedly triggering broad full-index work.}
- [ ] {Add a real job queue with explicit states such as queued, running, blocked, superseded, succeeded, and failed so backend work is inspectable and deterministic.}
- [ ] {Cancel or supersede stale refresh jobs when a newer file-change batch makes earlier work irrelevant, while preserving audit logs for why jobs were dropped.}
- [ ] {Distinguish delta refresh jobs from full rebuild jobs in both scheduling and operator reporting so the product does not feel noisy or randomly expensive.}
- [ ] {Expose current job queue state, active job, generation target, and pending dirty files through both diagnostics and the human CLI.}
- [ ] {Add tests for watcher storms, repeated file rewrites, directory renames, and overlapping manual index plus auto-refresh workflows.}

## Operator Console and Human CLI

- [ ] {Redesign `contextplus-ui` around structured panes rather than mostly raw text dumps so operators can browse lists, inspect details, and take actions without losing context.}
- [ ] {Split `cli/internal/ui/model.go` into smaller state, update, action, and rendering files once the operator console interaction model stabilizes so the UI no longer depends on an elevated lint size cap.}
- [ ] {Make the overview screen scrollable and status-driven, not just a static card layout, and ensure all major panels support structured data rather than one large string render.}
- [ ] {Replace monolithic text views with list, table, or tree widgets for hubs, restore points, search results, jobs, and diagnostics, with a preview pane for the selected item.}
- [ ] {Add a command palette so operators can trigger index, validate, repair, exact search, related search, research, restore, and hub workflows from one consistent entrypoint.}
- [ ] {Add keyboard-driven filter, search-inside-results, and navigation history so the console becomes a real operator tool rather than a dashboard-only view.}
- [ ] {Expose lint, blast radius, restore, checkpoint, and exact-query actions directly in the console once bridge parity is complete.}
- [ ] {Add explicit degraded-state, generation-state, and freshness badges in the UI so the operator always knows whether the visible data is current, stale, or fallback-limited.}
- [ ] {Fix watcher lifecycle issues in the UI, including any double-close or repeated-close paths, and ensure shutdown is idempotent and panic-free.}

## Documentation and Instruction Truth Sync

- [ ] {Synchronize `README.md`, `TODO.md`, `TODO_COMPLETED.md`, `plans/full-engine-roadmap.md`, `INSTRUCTIONS.md`, and any remote instruction endpoint so they all describe the same current tool surface, storage contract, and roadmap reality.}
- [ ] {Migrate repository source-file headers to the structured `summary:` / `FEATURE:` / `inputs:` / `outputs:` schema now enforced by lint and checkpoint validation, then rerun full-repo lint under that contract.}
- [ ] {Remove stale references to dropped memory and ACP features from every public and repo-local instruction source if those features are no longer part of the product direction.}
- [ ] {Remove stale references to deleted legacy storage layouts, JSON mirrors, or migration-era directories where the live product now uses sqlite-only durable state.}
- [ ] {Ensure version numbers agree across package metadata, MCP server metadata, release notes, and operator-visible banners.}
- [ ] {Add a maintenance rule that no milestone is considered complete until all control documents and shipped behavior match.}

## Observability and Diagnostics

- [ ] {Add structured metrics for indexing stage duration, refresh duration, parser throughput, candidate counts, ranking latency, vector refresh writes, cache hits, cache misses, and degraded-state frequency.}
- [ ] {Expose p50, p95, and p99 latency for exact queries, related search, and research generation in both benchmark output and operator diagnostics.}
- [ ] {Log explicit reasons for every degraded or fatal state, including parser failures, missing artifacts, invalid generations, bridge errors, and watcher scheduling drops.}
- [ ] {Add one diagnostic command that dumps generation state, dirty-state ledger, active jobs, cache readiness, vector collection metadata, and parser health in a machine-readable form.}
- [ ] {Ensure observability data can be surfaced through MCP, bridge, and UI without requiring direct SQLite inspection or code edits.}

## Benchmarking and Validation

- [ ] {Keep the synthetic evaluation suite, but add a real-repo benchmark tier covering small, medium, large, and polyglot repositories plus at least one intentionally broken or messy repository shape.}
- [ ] {Split `src/tools/evaluation.ts` into smaller scenario and report modules once the real benchmark surface settles so the harness no longer depends on an elevated lint size cap.}
- [ ] {Create a golden question set for exact navigation, related discovery, dependency tracing, and subsystem research so regressions are measured against stable expectations rather than ad hoc spot checks.}
- [ ] {Benchmark initialization cost separately from steady-state query cost so the project can intentionally accept heavier upfront preparation while still enforcing fast post-init serving.}
- [ ] {Add regression gates for same-size file edits, rename-heavy diffs, delete-heavy diffs, and restore-driven rewinds so refresh behavior is verified under realistic repository churn.}
- [ ] {Add large-repo memory and latency tracking to prove that the exact-query substrate stays cheap and that related search remains bounded after the candidate-first rewrite.}
- [ ] {Refuse to label the engine optimized after initialization until those benchmark gates pass and are kept current in CI or a reproducible local benchmark flow.}

## Release and Quality Gates

- [ ] {Define a v1.5 release gate that requires passing build, full test suite, bridge parity suite, generation-safety suite, post-write freshness suite, observability checks, and the real-repo benchmark pack.}
- [ ] {Define a repository acceptance checklist for every milestone: shipped behavior exists, tests pass, docs are current, version metadata is synchronized, and the roadmap reflects reality.}
- [ ] {Prevent new public tool additions during v1.5 unless they clearly improve codebase context quality and do not delay the serving, parity, correctness, and performance work above.}
- [ ] {Audit feature sprawl after v1.5 and remove or merge overlapping surfaces that do not materially improve agent or operator outcomes.}

## Later Backlog

- [ ] {Audit tool and parameter sprawl after v1.5 and remove overengineered surfaces that do not materially improve agent context quality, steady-state latency, or operator trust.}
- [ ] {Consider more advanced semantic or ANN retrieval backends only after the candidate-first rewrite, delta vector writes, and real benchmark pack prove the remaining bottleneck actually justifies the added complexity.}
- [ ] {Add any net-new `researchplus` or broader product features only after the v1.5 serving, parity, performance, correctness, and operator-console gaps above are closed.}
- [ ] {Revisit optional advanced automation, richer planning overlays, or additional operator workflows only after the core engine becomes a stable, benchmarked, and truth-synchronized daily-use system.}
```
