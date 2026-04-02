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
