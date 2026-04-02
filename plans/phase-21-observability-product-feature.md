# Phase 21 Observability As A Product Feature

This ExecPlan must be maintained in accordance with `/home/cesar514/.codex/.agent/PLANS.md`.

## Purpose / Big Picture

After this change, an operator can ask Context+ why indexing or query work feels slow or stale and get a concrete answer from the product itself. The `doctor` report, bridge JSON, backend logs, and the current human CLI overview will all expose the same runtime truth for index-stage timings, cache reuse, vector integrity, refresh failures, stale-generation age, and watcher scheduler state. The observable behavior is that a real repo run now reports measurable throughput and queue state instead of only generic “running” or “complete” text.

## Progress

- [x] 2026-04-02 16:13Z Read the active `TODO.md`, the repo-local `INSTRUCTIONS.md`, and the shared Context+ MCP skill guidance to confirm the Phase 21 scope and workflow constraints.
- [x] 2026-04-02 16:20Z Inspected the current doctor, index, embeddings, hybrid retrieval, write freshness, backend session, Go bridge client, and TUI rendering paths to locate the observability write surfaces.
- [ ] 2026-04-02 16:22Z Add persisted index-run observability for durable stage timings plus files-per-second, chunks-per-second, and embeds-per-second metrics.
- [ ] 2026-04-02 16:22Z Add runtime cache and retrieval observability for embedding process-cache hits, vector loads, parser reuse, and lexical-candidate aggregation before rerank.
- [ ] 2026-04-02 16:22Z Add integrity and scheduler observability for vector coverage, parse failures by language, fallback counts, stale-generation age, refresh failures, queue depth, deduped paths, superseded jobs, and full-rebuild reasons.
- [ ] 2026-04-02 16:22Z Surface the unified observability contract through `doctor`, machine-readable bridge JSON, backend job and watcher logs, and the current TUI overview and plain doctor renderer.
- [ ] 2026-04-02 16:22Z Add focused regressions plus direct runtime verification, then move Phase 21 out of `TODO.md`, record it in `TODO_COMPLETED.md`, and commit the verified work.

## Surprises & Discoveries

- Observation: The current persistent backend already owns enough watcher state to expose queue depth and superseded-job counts without changing the transport model.
  Evidence: `src/cli/backend-core.ts` already tracks `pendingPaths`, `queuedWatchIndex`, and `indexRunning`; only durable counters and snapshots are missing.

- Observation: The current `doctor` report already contains vector coverage and tree-sitter aggregate stats, so Phase 21 can extend an existing operator report instead of inventing a second health surface.
  Evidence: `src/cli/reports.ts` already gathers `inspectHybridVectorCoverage(rootDir)` and `getTreeSitterRuntimeStats()`.

## Decision Log

- Decision: Persist index-run observability inside the existing `index-status` artifact instead of adding a separate sqlite artifact.
  Rationale: Stage timings and throughput belong to the latest run summary that operators already inspect through `index-status`, and keeping them there avoids another contract to validate.
  Date/Author: 2026-04-02 / Codex

- Decision: Keep backend scheduler observability in the backend session layer and feed it into the shared doctor report rather than trying to infer it from repo artifacts.
  Rationale: Queue depth, superseded jobs, and deduped watch batches are live process facts, not durable index facts.
  Date/Author: 2026-04-02 / Codex

- Decision: Treat the machine-readable debug JSON surface as the structured `doctor` payload exposed by the bridge and CLI JSON mode.
  Rationale: The repo already has a typed doctor payload; extending that contract is cheaper and clearer than shipping a second overlapping debug command.
  Date/Author: 2026-04-02 / Codex

## Outcomes & Retrospective

This section will be updated after implementation and verification complete. The expected outcome is that Phase 21 adds measurable operator truth without introducing a second observability subsystem or hidden fallback behavior.

## Context and Orientation

The current operator-facing health surface lives in `src/cli/reports.ts`, which exports `buildDoctorReport(rootDir)` and the `BridgeDoctorReport` type. That report is rendered as human text in `src/cli/commands.ts`, serialized as JSON for bridge consumers, decoded into Go structs in `cli/internal/backend/client.go`, and shown in the TUI overview and plain doctor view in `cli/internal/ui/model.go`.

The durable indexing entrypoint is `src/tools/index-codebase.ts`. It already owns progress callbacks and writes the persisted `index-status` artifact through helpers in `src/tools/index-stages.ts`. The status artifact currently records broad counts, but it does not record durable stage durations or throughput metrics.

The runtime cache and retrieval hot paths live in `src/core/embeddings.ts`, `src/core/tree-sitter.ts`, and `src/tools/hybrid-retrieval.ts`. Tree-sitter already tracks parser creation, reuse, grammar loads, and parse failures by language. The embeddings layer has a process cache keyed by root, generation, and namespace, but it does not yet expose cache hit and miss counters. Hybrid retrieval already reports lexical candidate counts per query, but it does not keep aggregate runtime counters that operators can inspect after the query completes.

The persistent watcher and index job ownership lives in `src/cli/backend-core.ts`. That file already tracks pending changed paths, whether a queued watch-triggered reindex exists, and whether an index is in flight. Phase 21 needs to turn those live facts into durable scheduler observability fields that `doctor`, logs, and the TUI can render.

`TODO.md` declares the required Phase 21 outcomes: stage timings, cache observability, integrity observability, scheduler observability, and surfacing all of that through doctor, JSON, logs, and the human CLI status area. `TODO_COMPLETED.md` records the prior phases and must receive Phase 21 once verification passes.

## Plan of Work

First, extend the durable index status contract so the latest completed run records explicit stage timings and throughput summaries. This work belongs in `src/tools/index-codebase.ts` and `src/tools/index-stages.ts`. `indexCodebase()` will measure the elapsed time for each durable stage (`bootstrap`, `file-search`, `identifier-search`, and `full-artifacts`) and store derived throughput such as files per second, chunks per second, and embeds per second in the status artifact. `src/tools/index-contract.ts` will be updated so persisted artifact versioning reflects the new status shape.

Second, add runtime observability snapshots for the hot cache and query paths. In `src/core/embeddings.ts`, add exported runtime stats for process-cache hits and misses, vector entry hits and misses, sqlite namespace loads, sqlite by-id loads, and generation invalidations. In `src/tools/hybrid-retrieval.ts`, add exported aggregate search stats per source so doctor can report lexical candidate counts before rerank. Reuse the existing tree-sitter stats in `src/core/tree-sitter.ts` instead of duplicating parser counters.

Third, add integrity observability. `src/tools/semantic-search.ts` and `src/tools/write-freshness.ts` will record refresh-failure counters and last failure details whenever file-search refresh or post-write refresh blocks. `src/cli/reports.ts` will compute stale-generation age from `activeGenerationValidatedAt`, include parse failures by language from the tree-sitter language stats, and include an explicit fallback-count metric for the current runtime contract.

Fourth, add scheduler observability in `src/cli/backend-core.ts`. The backend session will maintain live counters for queue depth, max queue depth, deduped watch-path events, watch batches emitted, superseded queued jobs, canceled jobs, and recent full-rebuild reasons. The session will also emit concise structured log lines when it queues, supersedes, or completes a rebuild, so the log panel can show why heavy work happened.

Fifth, surface the unified observability contract. `src/cli/reports.ts` will gather the persisted status metrics plus the live runtime snapshots into `BridgeDoctorReport`. `src/cli/commands.ts` will render a new observability section in the human doctor output. `cli/internal/backend/client.go` will extend the Go JSON structs so the TUI can read the new fields, and `cli/internal/ui/model.go` plus `cli/internal/ui/model_test.go` will update the overview and plain doctor renderers to display the new status lines.

Finally, add focused regressions for the new counters and report fields, run direct runtime proof on a temporary repo, update `TODO.md` and `TODO_COMPLETED.md`, and commit the verified Phase 21 work.

## Concrete Steps

From the repository root `/home/cesar514/Documents/agent_programming/contextplus`, run the following as work progresses:

    npm run build

    node --test test/main/index-codebase.test.mjs test/main/cli-bridge.test.mjs

    node --test test/main/embeddings.test.mjs test/main/hybrid-retrieval.test.mjs

    pixi run test-cli

    npm test

For direct runtime proof after the code is in place, run a temporary repo scenario with the built artifacts. Index the temp repo, run `bridge doctor --root <temp-repo>`, toggle the watcher or trigger a file change through the persistent backend, and confirm the JSON contains non-empty observability fields for stage timings, cache stats, integrity stats, and scheduler state. Update this section with the exact command transcript and observed numbers once verification is complete.

## Validation and Acceptance

Acceptance is behavior, not just types. The phase is complete when all of the following are true:

The built `doctor` JSON payload includes a dedicated observability section with stage timings, throughput, cache stats, integrity stats, and scheduler stats. The human `doctor` output and the TUI overview both render a concise summary from the same data.

An actual index run on a temp repo produces non-zero stage timings and at least one throughput metric in the doctor payload. A query run updates cache or lexical-candidate counters so the payload demonstrates live runtime activity rather than static zeros only.

The persistent backend emits log or job messages that mention queue or rebuild reasons when watch-triggered work is queued or superseded. The bridge and CLI test suite must pass, and the new focused tests must prove the added observability fields and counters are present and correctly updated.

## Idempotence and Recovery

These edits are safe to repeat. The durable status artifact is overwritten by each new index run, and the runtime counters can be reset by a fresh process start. If a code change breaks the new report contract, rerun the focused Node tests first to isolate whether the failure is in persisted status, runtime counters, or JSON rendering. If needed, revert only the Phase 21 edits with normal git workflows; no destructive repo cleanup is required.

## Artifacts and Notes

Expected direct proof after implementation should look like the following shape:

    {
      "observability": {
        "indexing": {
          "stages": {
            "file-search": { "durationMs": 123, "filesPerSecond": 45.6 }
          }
        },
        "caches": {
          "embeddings": { "processCacheHits": 3, "processCacheMisses": 1 }
        },
        "integrity": {
          "staleGenerationAgeMs": 250,
          "refreshFailures": { "fileSearch": 0, "writeRefresh": 0 }
        },
        "scheduler": {
          "queueDepth": 0,
          "supersededJobs": 1
        }
      }
    }

This JSON shape is illustrative; the exact nested field names may change during implementation, but the final report must carry all four categories and concrete numeric values.

## Interfaces and Dependencies

In `src/tools/index-codebase.ts`, extend the indexing status contract with explicit observability types and a runtime recorder that produces per-stage timings and throughput values. The durable `IndexStatus` type in `src/tools/index-stages.ts` must include those new fields so `loadIndexStatus()` and `saveIndexStatus()` preserve them.

In `src/core/embeddings.ts`, define exported runtime-stat interfaces and accessors for cache hits, misses, sqlite loads, and invalidations. The end state must include a stable getter that `src/cli/reports.ts` can call without mutating cache state.

In `src/tools/hybrid-retrieval.ts`, define exported runtime-stat interfaces and a getter that summarize lexical candidate counts before rerank, rerank candidate counts, and final result counts for both chunk and identifier retrieval.

In `src/tools/semantic-search.ts` and `src/tools/write-freshness.ts`, define exported runtime-stat getters that expose refresh-failure counts and last failure details.

In `src/cli/backend-core.ts`, define a stable scheduler snapshot interface and a getter on `BackendRootSession` or `BackendCore` so `doctor` can retrieve queue depth, deduped batch counts, superseded jobs, canceled jobs, and recent full-rebuild reasons for a root.

In `src/cli/reports.ts`, extend `BridgeDoctorReport` with a top-level `observability` object that combines indexing, cache, integrity, and scheduler data. `src/cli/commands.ts`, `cli/internal/backend/client.go`, and `cli/internal/ui/model.go` must all agree on that JSON shape by the end of the phase.

Plan revision note: created on 2026-04-02 to execute Phase 21 as a single observability contract spanning persisted status, runtime caches, integrity counters, and backend scheduler state.
