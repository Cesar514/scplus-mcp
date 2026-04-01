# Full Engine Roadmap

This ExecPlan must be maintained in accordance with `/home/cesar514/.codex/.agent/PLANS.md`.

## Purpose / Big Picture

After this program is complete, Context+ will have a real full-engine mode rather than a partial indexing foundation. An agent will be able to prepare a repository once, then query a unified set of durable artifacts that cover files, identifiers, chunks, code structure, semantic clusters, hubs, and research context. The user-visible outcome is that `index` in `full` mode will produce the full durable context substrate, a new fast exact-query layer will answer common agent navigation questions with much lower token and latency cost, `search` and `research` will escalate from that fast path when deeper understanding is needed, and the system will provide explicit repair, evaluation, and operational guarantees instead of a loose collection of partially overlapping tools.

The work is large enough that it must be delivered in validated increments. Each roadmap step below is a milestone. Every milestone must end with direct verification, an atomic git commit, and an update to this plan and the repo TODO files before the next milestone starts.

## Progress

- [x] (2026-03-31 19:19Z) Created the ExecPlan and aligned it with the existing 17-step roadmap in `TODO.md`.
- [x] (2026-03-31 19:34Z) Completed Step 01. Added a shared indexing contract module, versioned persisted schema metadata, explicit invalidation semantics, explicit failure semantics, and direct test coverage for those fields.
- [x] (2026-03-31 19:35Z) Completed Step 02. Split the indexing pipeline into durable rerunnable stages, persisted stage state in `.contextplus/config/index-stages.json`, and added direct rerun coverage that enforces `core` prerequisites before `full-artifacts`.
- [x] (2026-04-01 10:39Z) Completed Step 02.5. Moved the durable index substrate into `.contextplus/state/index.sqlite`, made SQLite the authoritative storage contract, and kept inspectable JSON mirrors for direct artifact inspection.
- [x] (2026-04-01 12:55Z) Completed the sqlite-only follow-up migration. Removed JSON mirror persistence, migrated restore-point state, restore-point backups, embedding caches, and context-tree storage into SQLite, and made bootstrap delete legacy artifact files before rebuilding.
- [x] (2026-04-01 14:20Z) Completed Step 03. Extracted chunk indexing into its own first-class module with explicit artifact/state/progress contracts, added direct chunk-index tests for symbol chunks, fallback chunks, and embedding-cache reuse, and verified the persisted chunk contract in SQLite after a real full index run.
- [x] (2026-04-01 15:15Z) Completed Step 04. Added sqlite-backed hybrid chunk and identifier retrieval indexes with lexical term maps plus dense embedding-cache references, surfaced their progress/status in full indexing, and verified the persisted hybrid artifacts and ranking behavior directly.
- [x] (2026-04-01 18:11Z) Completed Step 05. Replaced size-plus-mtime refresh checks with content hashes for file and identifier artifacts, content-hash-plus-chunk-content-hash reuse for chunk artifacts, and dependency-aware structure invalidation driven by local import hashes, then verified both same-size content changes and dependent-file refresh behavior directly.
- [x] (2026-04-01 19:06Z) Completed Step 06. Expanded the structure artifact into a richer graph-backed substrate with per-file module metadata, normalized symbol records, file-to-symbol mappings, ownership edges, module summaries, and module import edges, then verified the persisted shape directly.
- [x] (2026-04-01 19:45Z) Completed Step 07. Added a unified ranking engine that combines persisted file, chunk, identifier, and structure evidence into one scoreable file/symbol result set, then verified it with focused ranking tests and a real full-index rerun.
- [x] (2026-04-01 20:03Z) Completed Step 08. Routed the public `search` surface through the unified ranking engine, simplified the search contract to `file` / `symbol` / `mixed`, and verified canonical output directly.
- [x] (2026-04-01 20:24Z) Completed Step 09. Persisted semantic clusters, related-file graphs, and subsystem summaries into sqlite as full-engine artifacts, then switched `cluster` to render those artifacts directly.
- [x] (2026-04-01 21:35Z) Completed Step 10. Persisted hub suggestions and feature-group candidates from the cluster tree, related-file graph, structure graph, and file FEATURE tags, then materialized suggested markdown hubs under `.contextplus/hubs/suggested/` and verified them through sqlite plus `find_hub`.
- [x] (2026-04-01 22:05Z) Dropped the former Step 11 and Step 12 product milestones. The product direction no longer treats memory and ACP features as core roadmap goals because TODO plus code comments are sufficient memory for this project direction.
- [x] (2026-04-01 13:56Z) Completed Step 13. Added a unified `research` tool surface that aggregates ranked code hits, structure-backed related files, subsystem summaries, and hub context from the prepared full-engine artifacts, then verified it with focused coverage, the full suite, a real full index run, and a direct repository research query.
- [x] (2026-04-01 14:55Z) Completed Step 14. Added prepared-index validation and repair tools, enforced crash-only prepared-index checks in query surfaces, preserved handwritten hub browsing when no prepared full index exists, and verified direct repair behavior plus the full suite.
- [x] (2026-04-01 15:40Z) Completed Step 15. Added a deterministic `evaluate` benchmark suite over a synthetic fixture repo, measured initial and refresh index timings, verified retrieval/navigation/research quality plus artifact freshness, and exposed it through the public tool surface.
- [x] (2026-04-01 16:12Z) Completed Step 16. Removed public weight-tuning knobs from `search`, collapsed the public `research` surface to a query-only interface, aligned the landing examples with the shipped MCP contract, and verified the simplified boundary with build, tests, Context+ blast-radius/lint checks, and source sweeps.
- [x] (2026-04-01 17:05Z) Expanded the roadmap before the former Step 17 after comparing Context+ against `codedb`. The next phase now adds a fast exact-query layer and low-token primitives before the CLI/UX milestone so Context+ can reduce agent token cost without sacrificing higher-order codebase understanding.
- [x] (2026-04-01 17:37Z) Completed Step 17. Added a fast exact-query substrate over the prepared full index with hot in-memory caches for exact symbol lookup, word lookup, file outlines, reverse dependencies, and git-backed change/status tracking, then verified it with focused coverage, build, and the full suite.
- [x] (2026-04-01 18:02Z) Completed Step 18. Exposed the fast substrate through tiny public MCP tools for exact symbol lookup, word lookup, file outlines, dependency tracing, git status, and git changes, then verified the real built server with MCP integration coverage, the full suite, and the landing production build.
- [x] (2026-04-01 18:18Z) Completed Step 19. Routed `search` by explicit intent so exact questions use the fast substrate while related discovery stays on the ranked engine, tightened `research` docs around broad subsystem understanding, and verified the built server routing behavior plus the full suite and landing build.
- [ ] Step 20. Extend evaluation to benchmark hot-query latency, estimated token cost, and end-to-end task efficiency for the hybrid fast-path plus intelligence stack.
- [ ] Step 21. Expose the full engine cleanly through the CLI and UX layers.

## Surprises & Discoveries

- Observation: The repo already has a meaningful partial full-mode foundation.
  Evidence: `src/tools/index-codebase.ts` already defaults to `full`, and `src/tools/full-index-artifacts.ts` persists chunk and code-structure artifacts under `.contextplus/derived`.

- Observation: The current runtime and docs still describe the system as an eager indexing pipeline plus incremental refresh, not as a fully staged engine.
  Evidence: `src/tools/index-codebase.ts`, `src/tools/semantic-search.ts`, `src/tools/semantic-identifiers.ts`, `README.md`, and `INSTRUCTIONS.md` describe persisted indexes and refresh behavior, but there is no stage manifest or formal artifact schema module yet.

- Observation: The persisted on-disk artifacts needed a fresh rewrite before the new contract fields became visible during verification.
  Evidence: The first artifact inspection still saw older schema fields, but a completed `node build/index.js index --mode=full` run rewrote the files with version 3 metadata and contract fields.

- Observation: The staged pipeline benefits from explicit stage-state persistence rather than inferring progress from individual artifact files.
  Evidence: Step 02 added `.contextplus/config/index-stages.json`, and direct verification showed durable stage dependencies, stage-local run counts, and completed-state gating for `full-artifacts`.

- Observation: The JSON-mirror transition step made the final sqlite-only migration straightforward once the remaining file-backed subsystems were enumerated.
  Evidence: After Step 02.5, the remaining file-backed state was isolated to restore-point manifests and backup payloads, context-tree text export, and embedding caches.

## Decision Log

- Decision: Put the long-running program into `plans/full-engine-roadmap.md` under version control before making further large edits.
  Rationale: The user asked for 17 verified, sequential, commit-backed milestones. This requires a living execution document rather than ad hoc chat-only planning.
  Date/Author: 2026-03-31 / Codex

- Decision: Treat the existing “full mode” as a foundation that must now be formalized rather than replaced.
  Rationale: The current code already persists file, identifier, chunk, and structure artifacts. Step 01 should lock and formalize these contracts instead of rewriting them blindly.
  Date/Author: 2026-03-31 / Codex

- Decision: Version the formalized persisted artifacts as schema version 3 and the new explicit contract as contract version 1.
  Rationale: The older partial full-mode foundation already used version 2 metadata, so the new formalized contract needs a distinguishable on-disk schema step.
  Date/Author: 2026-03-31 / Codex

- Decision: Persist stage orchestration state as its own artifact instead of folding rerun metadata into `index-status.json` alone.
  Rationale: Step 02 needs durable rerunnable stages and dependency gating; a dedicated stage-state file is the simplest explicit representation and can be validated independently of transient status fields.
  Date/Author: 2026-03-31 / Codex

- Decision: Make SQLite authoritative for durable index state, but keep JSON mirrors as exported projections during the transition.
  Rationale: Step 02.5 needs one explicit repo-local database substrate for future retrieval and ranking work, but preserving inspectable mirrors avoids breaking current workflows and strengthens direct verification.
  Date/Author: 2026-04-01 / Codex

- Decision: Finish the migration by deleting mirror persistence instead of keeping a long-lived hybrid model.
  Rationale: The best full-engine architecture needs one source of truth. SQLite-only persistence removes drift risk, simplifies later ranking and repair logic, and matches the user goal of a fully migrated local engine.
  Date/Author: 2026-04-01 / Codex

- Decision: Drop memory and ACP features from the forward roadmap and treat TODO plus code comments as the primary durable project memory.
  Rationale: The user decided those features are not worth the token cost, maintenance cost, or codebase surface area for this project direction. Future roadmap work should optimize for code retrieval, structure, reliability, evaluation, and simpler tool surfaces instead.
  Date/Author: 2026-04-01 / Codex

- Decision: Insert a `codedb`-inspired fast exact-query phase before the CLI/UX milestone instead of treating the current ranked and research surfaces as sufficient.
  Rationale: The project goal is both lower agent token cost and better codebase understanding. That requires preserving Context+ intelligence while adding a low-latency, low-token execution layer for exact lookups and status queries, then teaching the richer tools to escalate from it instead of bypassing it.
  Date/Author: 2026-04-01 / Codex

- Decision: Define the new escalation model by query intent instead of a simplistic always-fast-first ladder.
  Rationale: Some editing tasks begin with related-pattern discovery rather than exact lookup, so the roadmap and public guidance must distinguish exact questions, related-item search, and broad research explicitly.
  Date/Author: 2026-04-01 / Codex

## Outcomes & Retrospective

This plan is now the controlling implementation document for the revised program. Steps 01, 02, 02.5, the sqlite-only follow-up migration, Step 03, Step 04, Step 05, Step 06, Step 07, Step 08, Step 09, Step 10, Step 13, Step 14, Step 15, Step 16, Step 17, Step 18, and Step 19 are complete and verified. The former Step 11 and Step 12 were dropped as product goals, and the memory subsystem was removed from the codebase. Step 20 is now next and will measure whether the new hybrid exact-plus-intelligence stack actually improves latency and token efficiency without regressing understanding quality.

## Context and Orientation

The current indexing and query code lives in these files:

- `src/index.ts`: the MCP and CLI entrypoint. It registers the `index`, `tree`, `search`, `research`, `cluster`, hub, and edit tools.
- `src/tools/index-codebase.ts`: the top-level indexing pipeline. It writes the `.contextplus/config` files and runs file, identifier, and full derived artifact builders.
- `src/tools/research.ts`: the unified research report builder over ranking, structure, cluster, and hub artifacts.
- `src/tools/semantic-search.ts`: the file-level search indexer and query surface.
- `src/tools/semantic-identifiers.ts`: the identifier-level search indexer and query surface.
- `src/tools/full-index-artifacts.ts`: the current chunk and code-structure artifact builder used only in `full` mode.
- `src/core/project-layout.ts`: the path contract for `.contextplus`.
- `README.md` and `INSTRUCTIONS.md`: the main mirrored user-facing and repo-local documentation that must stay consistent with behavior.
- `test/main/index.test.mjs`: the main integration-level test coverage for `index`.

In this repository, a “contract” means the stable shape of the durable on-disk artifacts and the explicit runtime semantics for how they are created, refreshed, invalidated, or repaired. A “stage” means one rerunnable slice of the indexing pipeline that reads prior durable state, writes one coherent output artifact, and can be retried safely. “Full mode” means the richer indexing path. “Core mode” means the minimal durable prerequisite set that every later full artifact depends on.

The repo already uses `.contextplus/` as its only durable project-state root. The working branch is `main`, with `origin` configured. Existing uncommitted work from prior milestones is present in the tree and must be incorporated carefully rather than discarded.

## Plan of Work

Step 01 introduced an explicit indexing contract module and schema definitions rather than leaving the shapes embedded informally across multiple files. The work defined the artifact version, index modes, stage names, failure states, persisted paths, and invalidation fingerprints in one place, then migrated `src/tools/index-codebase.ts` and `src/tools/full-index-artifacts.ts` to use those shared types. The docs and mirrored skill text were tightened so the persisted contract metadata is described consistently.

Step 02 refactored the pipeline into separately rerunnable stages without changing the durable meaning of the Step 01 artifacts. The pipeline now persists stage records and can rerun individual stages with explicit dependency checks.

Step 02.5 moved the durable indexing substrate onto sqlite-backed local storage so later retrieval, refresh, and ranking work can build on one explicit transactional store instead of only scattered JSON artifacts.

The sqlite-only follow-up completed the transition by migrating the remaining file-backed machine state into SQLite and deleting the legacy artifact files during bootstrap and reindex flows.

Step 03 strengthened chunk indexing itself so chunk artifacts now have a clearer first-class contract and more explicit AST-oriented semantics than the previous helper-oriented full-artifact path. Step 04 turned that chunk and identifier substrate into a stronger hybrid retrieval layer with persisted lexical and dense retrieval state. Step 05 completed the stronger invalidation layer by moving refresh logic onto content hashes and dependency-aware structure recomputation. Step 06 expanded the structure substrate into a real module graph with ownership and symbol mappings so ranking and canonical search can consume stable graph artifacts instead of inferring them on demand. Step 07 added the unified ranking layer that can combine file, chunk, identifier, and structure evidence into one scoreable result set. Step 08 moved the public `search` surface onto that unified ranker and removed the older split search contract from the MCP boundary. Step 09 persisted semantic clusters, related-file neighborhoods, and subsystem summaries so the `cluster` tool now renders durable full-index artifacts instead of recomputing them on demand. Step 13 then added the `research` surface on top of those durable artifacts so one tool can now combine top code hits, related files, subsystem summaries, and hubs without rebuilding context on demand. The roadmap was then simplified by dropping the memory- and ACP-centered milestones. Step 17 has now added the `codedb`-style fast exact-query layer underneath Context+ intelligence. The next phase must expose tiny exact-query tools, then route exact questions, related discovery, and broad research through the right layer instead of treating all agent uncertainty the same way.

Each later step must be implemented the same way: minimal coherent slice, direct verification, commit, plan update, TODO update, then move on.

## Concrete Steps

From the repository root:

1. Keep this plan current as milestones progress.
2. For Step 14, add explicit validation and repair paths for stale or incompatible artifacts, keeping failures loud and crash-only instead of silently rebuilding partial state in query tools.
3. Update the tests so reliability failures are detected directly and repair commands prove the system returns to a valid state cleanly.
4. Run the build, focused reliability coverage, full tests, and a real full index run plus repair/validation verification on this repository.
5. Commit Step 14 with a message that names the reliability-hardening milestone.

Verification transcript used for Step 01:

    npm run build
    npm test
    node build/index.js index --mode=full

The observed outcome for Step 01 was a passing build, a passing test suite, and durable `.contextplus` files whose schema fields match the Step 01 contract.

Verification transcript used for Step 02:

    npm run build
    npm test
    node build/index.js index --mode=full

The observed outcome for Step 02 was a passing build, a passing test suite including direct rerun coverage for individual stages, and a durable `.contextplus/config/index-stages.json` file whose `full-artifacts` record depends on completed `bootstrap`, `file-search`, and `identifier-search` stages.

Verification transcript used for Step 02.5:

    npm run build
    npm test
    node build/index.js index --mode=full

The observed outcome for Step 02.5 was a passing build, a passing test suite with direct SQLite assertions, a durable `.contextplus/state/index.sqlite` database populated with the authoritative index artifacts, and exported JSON mirrors that matched the database-backed contract.

## Validation and Acceptance

For every roadmap step, acceptance requires:

1. The intended behavior exists and is exercised directly.
2. The relevant tests pass.
3. The docs that describe the changed behavior are updated.
4. The ExecPlan and `TODO.md` / `TODO_COMPLETED.md` reflect reality.
5. The step is committed before the next step begins.

For Step 01 specifically, acceptance means:

- `index(core)` and `index(full)` semantics are explicitly defined in shared code, not only implied across scattered interfaces.
- persisted artifact files include stable versioned metadata and stage information that can be asserted in tests
- invalidation and failure semantics are described in code and docs
- `test/main/index.test.mjs` asserts the contract fields
- `node build/index.js index --mode=full` produces contract-compliant artifacts on disk

For Step 02 specifically, acceptance means:

- `index` orchestrates named reusable stage runners instead of one monolithic inline pipeline
- `.contextplus/config/index-stages.json` persists durable stage metadata, dependencies, supported modes, and stage outputs
- rerunning `full-artifacts` without completed core prerequisites fails loudly
- direct rerun tests cover stage dependency enforcement and successful independent stage execution
- `node build/index.js index --mode=full` writes completed stage records on disk

For Step 02.5 specifically, acceptance means:

- the authoritative durable index substrate lives at `.contextplus/state/index.sqlite`
- config, status, stage, file-search, identifier, chunk, structure, and full-manifest state are persisted through SQLite as the source of truth
- inspectable JSON mirrors are still exported under `.contextplus/config/`, `.contextplus/embeddings/`, and `.contextplus/derived/`
- direct tests assert SQLite-backed storage behavior instead of JSON-only persistence
- `node build/index.js index --mode=full` produces a populated SQLite database and matching exported mirrors

## Idempotence and Recovery

The work is intended to be repeated safely. Re-running `index` should refresh durable artifacts rather than corrupt them. If a milestone fails verification, do not commit it. Fix the failure, rerun verification, and update this plan before attempting the commit again.

Because the user requested a commit after each step, the rollback path is a normal git revert or a local checkout to the previous step commit. For MCP-authored file edits inside the repo, the existing shadow restore-point system remains available, but git commits are the primary milestone boundary here.

## Artifacts and Notes

Important current artifacts and commands:

    .contextplus/state/index.sqlite
    sqlite:index_artifacts/project-config
    sqlite:index_artifacts/index-status
    sqlite:index_artifacts/file-search-index
    sqlite:index_artifacts/identifier-search-index
    sqlite:index_artifacts/chunk-search-index
    sqlite:index_artifacts/hybrid-chunk-index
    sqlite:index_artifacts/hybrid-identifier-index
    sqlite:index_artifacts/code-structure-index
    sqlite:index_artifacts/full-index-manifest

Current verification commands:

    npm run build
    npm test
    node build/index.js index --mode=full

## Interfaces and Dependencies

Step 01 must end with explicit shared interfaces for:

- index modes: `core` and `full`
- stage names for the indexing pipeline
- persisted config and status schemas
- persisted full-artifact manifest schema
- invalidation fingerprint semantics

These interfaces should live in the indexing domain alongside `src/tools/index-codebase.ts` and `src/tools/full-index-artifacts.ts`, and they should be imported by the callers rather than redefined in place.

The implementation must continue using the current project-local TypeScript toolchain, the existing Ollama-based embedding stack in `src/core/embeddings.ts`, and the existing parser and walker modules. No new environment manager or external service should be introduced during Step 06.

Plan revision note: Created the initial ExecPlan to govern the 17-step full-engine implementation program and to require one verified commit per roadmap step.
