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
