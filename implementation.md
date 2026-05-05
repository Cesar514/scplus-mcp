# Bounded Watcher Migration Implementation Checklist

## Goal

Migrate repository change detection to a single backend-owned, bounded scanner that can cover very large repositories without creating unbounded `inotify_add_watch` pressure, duplicate watcher owners, or parallel refresh storms.

## Success Criteria

- [ ] No default runtime path recursively adds native filesystem watches for every directory in a repository.
- [ ] Exactly one backend session owns repository change detection for a root.
- [ ] CLI, MCP, indexing refresh, and embedding refresh consume the same backend change batches.
- [ ] Large repositories are scanned with explicit per-tick budgets for directories, files, elapsed time, and filesystem concurrency.
- [ ] Every included file is eventually checked without requiring a native watch for its parent directory.
- [ ] Watch-triggered jobs are capped to one active job plus one superseding queued plan.
- [ ] Overflow and scan failures are loud, explicit, and mark prepared state dirty or blocked.
- [ ] Tests prove no recursive native watch explosion, no duplicate owners, no unbounded job launch, and eventual large-repo coverage.

## Phase 1: Remove Competing Native Watch Sources

- [ ] Audit all watcher entrypoints:
  - [ ] `cli/internal/watcher/watcher.go`
  - [ ] `src/core/embedding-tracker.ts`
  - [ ] `src/cli/backend-core-session.ts`
  - [ ] CLI UI watcher toggle paths in `cli/internal/ui/model.go`
  - [ ] backend client watch calls in `cli/internal/backend/client_api.go`
- [ ] Confirm the Go CLI no longer starts or imports `cli/internal/watcher` in production code.
- [ ] Delete `cli/internal/watcher` if it is unused outside tests.
- [ ] If any native watcher must remain temporarily, add a hard cap before watch registration:
  - [ ] Count directories before adding native watches.
  - [ ] Fail with a fatal error when the count exceeds `SCPLUS_MAX_NATIVE_WATCH_DIRS`.
  - [ ] Do not partially watch a repo.
- [ ] Change MCP default embedding tracker behavior so it does not start a recursive `fs.watch`.
- [ ] Remove `SCPLUS_EMBED_TRACKER=lazy` from generated configs once embeddings consume backend batches.

## Phase 2: Centralize Watch Ownership In Backend Session

- [ ] Keep `BackendRootSession` as the only owner of per-root change detection.
- [ ] Preserve the existing repo watcher lock:
  - [ ] kind: `watcher`
  - [ ] holder: backend session
  - [ ] takeover only for known stale or competing scplus-owned processes
- [ ] Make `setWatchEnabled(true)` idempotent for an already enabled session.
- [ ] Ensure `BackendCore` returns the same session for repeated calls for the same root.
- [ ] Add diagnostics that show:
  - [ ] watcher owner
  - [ ] scanner mode
  - [ ] scan cursor position
  - [ ] pending path count
  - [ ] active job
  - [ ] queued job
  - [ ] last scan error
  - [ ] last overflow reason

## Phase 3: Replace Full Recursive Polling With A Bounded Scanner

- [ ] Introduce a scanner state module, for example `src/cli/backend-scan-state.ts`.
- [ ] Persist scanner state in `.scplus/state/index.sqlite`, not JSON side files.
- [ ] Store at minimum:
  - [ ] normalized repository root
  - [ ] active scan generation
  - [ ] directory queue
  - [ ] file manifest
  - [ ] directory manifest
  - [ ] ignore-rule hash
  - [ ] last full coverage timestamp
  - [ ] last cursor checkpoint
  - [ ] last scan failure
- [ ] Replace `scanSnapshot()` full-tree recursion with budgeted scan ticks.
- [ ] Add scanner budgets:
  - [ ] `SCPLUS_SCAN_MAX_DIRS_PER_TICK`
  - [ ] `SCPLUS_SCAN_MAX_FILES_PER_TICK`
  - [ ] `SCPLUS_SCAN_MAX_MS_PER_TICK`
  - [ ] `SCPLUS_SCAN_STAT_CONCURRENCY`
  - [ ] `SCPLUS_SCAN_RESCAN_INTERVAL_MS`
- [ ] Validate all budget environment values at startup.
- [ ] Throw a fatal configuration error for invalid budget values.
- [ ] Never silently coerce invalid budget values to safe-looking defaults.
- [ ] Use repo defaults only when the environment variable is absent.
- [ ] Track scan cursor progress so every included directory is eventually visited.
- [ ] When a directory is created, enqueue it for discovery.
- [ ] When a directory is removed, remove its manifest subtree and emit changed paths.
- [ ] When ignore rules change, require a full scanner rebuild and mark prepared state dirty.

## Phase 4: Preserve Full Coverage For Huge Repositories

- [ ] Build an initial manifest by walking the repo in bounded ticks.
- [ ] Emit progress events during initial scanner bootstrap:
  - [ ] discovered directories
  - [ ] discovered files
  - [ ] skipped ignored directories
  - [ ] elapsed time
- [ ] Do not claim watcher enabled until the scanner can persist its bootstrap cursor.
- [ ] Allow watcher state to be `bootstrapping`, `enabled`, `blocked`, or `disabled`.
- [ ] During bootstrap, accumulate discovered changes but do not launch repeated refreshes.
- [ ] After bootstrap, flush one consolidated refresh or full rebuild plan.
- [ ] Add a periodic complete coverage pass over the manifest.
- [ ] Record `lastFullCoverageAt` after every complete pass.
- [ ] Expose stale coverage in diagnostics if a full pass exceeds the configured interval.

## Phase 5: Keep Job Scheduling Bounded

- [ ] Preserve the existing single active backend job invariant.
- [ ] Preserve one superseding queued watch plan while an active job is running.
- [ ] Collapse repeated watch batches into the queued plan.
- [ ] Deduplicate pending paths before planning.
- [ ] Add a hard pending path cap:
  - [ ] `SCPLUS_WATCH_MAX_PENDING_PATHS`
  - [ ] If exceeded, clear path detail and mark the queued plan as a full rebuild.
  - [ ] Emit a loud overflow event with the exact cap and observed count.
- [ ] Add a hard batch emission cap:
  - [ ] Do not stream massive path arrays to the UI.
  - [ ] Include `truncated=true`, `totalChangedPathCount`, and a sample.
- [ ] Do not drop changes silently.
- [ ] On scanner failure, stop the watcher, release the watcher lock, and mark freshness blocked.

## Phase 6: Integrate Embedding Refresh With Backend Change Batches

- [ ] Remove recursive `fs.watch` startup from `startEmbeddingTracker`.
- [ ] Replace the embedding tracker with a backend event consumer.
- [ ] Feed changed relative paths from watch plans into:
  - [ ] `refreshFileSearchEmbeddings`
  - [ ] `refreshIdentifierEmbeddings`
- [ ] Keep embedding refresh batch limits separate from scanner limits.
- [ ] Make embedding refresh failures loud:
  - [ ] emit backend job error
  - [ ] log exact failed batch
  - [ ] mark semantic artifacts dirty or blocked
- [ ] Do not swallow embedding refresh errors with success-shaped output.
- [ ] Ensure manual `repair_index` and `index` still rebuild embeddings without depending on watcher state.

## Phase 7: Update CLI And MCP Surfaces

- [ ] Keep CLI watcher toggle wired to backend `watch-set`.
- [ ] Remove any UI assumption that watching means native fsnotify is active.
- [ ] Show scanner status in the CLI footer or doctor panel.
- [ ] Add doctor fields for:
  - [ ] scanner mode
  - [ ] native watch count
  - [ ] scanner queue size
  - [ ] full coverage age
  - [ ] pending overflow state
- [ ] Update bridge `watch-state` events to include scanner status.
- [ ] Update `README.md` and architecture docs after behavior changes.
- [ ] Update generated MCP config snippets to avoid enabling native embedding watcher defaults.

## Phase 8: Tests

- [ ] Add unit tests for scanner budget parsing and invalid environment errors.
- [ ] Add scanner tests for:
  - [ ] initial bounded bootstrap
  - [ ] eventual full coverage
  - [ ] file create
  - [ ] file update
  - [ ] file delete
  - [ ] directory create
  - [ ] directory delete
  - [ ] ignored directory skip
  - [ ] ignore-rule change requiring full rebuild
- [ ] Add scheduler tests for:
  - [ ] one active job
  - [ ] one queued superseding watch job
  - [ ] pending path dedupe
  - [ ] pending path overflow to full rebuild
  - [ ] active manual index plus watch changes
  - [ ] scanner failure blocking freshness
- [ ] Add regression tests proving no production path imports or starts `cli/internal/watcher`.
- [ ] Add embedding tests proving embedding refresh consumes backend batches without starting `fs.watch`.
- [ ] Add bridge tests proving watch events still stream through `bridge-serve`.
- [ ] Add large fixture tests with many directories and low scan budgets.
- [ ] Add a test or instrumentation hook proving native watch count remains zero by default.

## Phase 9: Verification Commands

- [ ] Run TypeScript build.
- [ ] Run Go tests for CLI packages.
- [ ] Run targeted backend watcher and bridge tests.
- [ ] Run targeted embedding tracker tests.
- [ ] Run static-analysis lint for changed source files.
- [ ] Run a large-repo simulation with strict budgets:
  - [ ] thousands of directories
  - [ ] thousands of files
  - [ ] low max dirs per tick
  - [ ] low max files per tick
  - [ ] concurrent file writes during active index
- [ ] Verify diagnostics show:
  - [ ] zero native watch count by default
  - [ ] bounded scanner progress
  - [ ] one active or queued job
  - [ ] eventual full coverage timestamp

## Phase 10: Cleanup

- [ ] Delete obsolete watcher tests once the Go watcher package is removed.
- [ ] Delete obsolete environment variables tied to recursive embedding watching.
- [ ] Remove stale docs that mention frontend-owned or Go-owned watcher behavior.
- [ ] Ensure `TODO.md` contains only incomplete tasks.
- [ ] Add completed migration tasks to `TODO_COMPLETED.md` as each implementation phase is finished.

## Non-Goals

- [ ] Do not raise Linux inotify limits as the main solution.
- [ ] Do not partially watch a repository when caps are exceeded.
- [ ] Do not keep parallel native watcher systems for CLI, MCP, and embeddings.
- [ ] Do not add compatibility shims for old watcher behavior.
- [ ] Do not silently ignore scanner, embedding, or refresh failures.
