# Full Engine Roadmap

This ExecPlan must be maintained in accordance with `/home/cesar514/.codex/.agent/PLANS.md`.

## Purpose / Big Picture

After this program is complete, Context+ will have a real full-engine mode rather than a partial indexing foundation. An agent will be able to prepare a repository once, then query a unified set of durable artifacts that cover files, identifiers, chunks, code structure, semantic clusters, memory, and research context. The user-visible outcome is that `index` in `full` mode will produce the full durable context substrate, `search` will become the canonical query surface over that substrate, and the system will provide explicit repair, evaluation, and operational guarantees instead of a loose collection of partially overlapping tools.

The work is large enough that it must be delivered in validated increments. Each roadmap step below is a milestone. Every milestone must end with direct verification, an atomic git commit, and an update to this plan and the repo TODO files before the next milestone starts.

## Progress

- [x] (2026-03-31 19:19Z) Created the ExecPlan and aligned it with the existing 17-step roadmap in `TODO.md`.
- [x] (2026-03-31 19:34Z) Completed Step 01. Added a shared indexing contract module, versioned persisted schema metadata, explicit invalidation semantics, explicit failure semantics, and direct test coverage for those fields.
- [x] (2026-03-31 19:35Z) Completed Step 02. Split the indexing pipeline into durable rerunnable stages, persisted stage state in `.contextplus/config/index-stages.json`, and added direct rerun coverage that enforces `core` prerequisites before `full-artifacts`.
- [ ] Step 03. Add chunk-level AST indexing as a first-class artifact.
- [ ] Step 04. Add hybrid retrieval indexes for chunks and symbols with lexical plus dense scoring.
- [ ] Step 05. Add stronger incremental refresh with file hashes, chunk hashes, and dependency-aware invalidation.
- [ ] Step 06. Persist richer code-structure artifacts per file and module.
- [ ] Step 07. Build a unified ranking engine across chunk, file, identifier, lexical, semantic, structural, and memory evidence.
- [ ] Step 08. Make `search` the canonical query entrypoint over the precomputed artifacts.
- [ ] Step 09. Persist semantic clusters, cluster labels, related-file graphs, and subsystem summaries.
- [ ] Step 10. Generate hub suggestions and feature-group candidates automatically.
- [ ] Step 11. Replace the current memory store with the planned graph-plus-markdown-plus-vector memory system.
- [ ] Step 12. Integrate ACP and external session memories into the same graph.
- [ ] Step 13. Add a unified `research` tool surface across code, structure, memory, and ACP.
- [ ] Step 14. Harden indexing and query reliability with crash-only repairable behavior.
- [ ] Step 15. Add evaluation and benchmarking for retrieval, freshness, speed, and answer quality.
- [ ] Step 16. Simplify the public tool surface by deleting superseded interfaces.
- [ ] Step 17. Expose the full engine cleanly through the CLI and UX layers.

## Surprises & Discoveries

- Observation: The repo already has a meaningful partial full-mode foundation.
  Evidence: `src/tools/index-codebase.ts` already defaults to `full`, and `src/tools/full-index-artifacts.ts` persists chunk and code-structure artifacts under `.contextplus/derived`.

- Observation: The current runtime and docs still describe the system as an eager indexing pipeline plus incremental refresh, not as a fully staged engine.
  Evidence: `src/tools/index-codebase.ts`, `src/tools/semantic-search.ts`, `src/tools/semantic-identifiers.ts`, `README.md`, and `INSTRUCTIONS.md` describe persisted indexes and refresh behavior, but there is no stage manifest or formal artifact schema module yet.

- Observation: The persisted on-disk artifacts needed a fresh rewrite before the new contract fields became visible during verification.
  Evidence: The first artifact inspection still saw older schema fields, but a completed `node build/index.js index --mode=full` run rewrote the files with version 3 metadata and contract fields.

- Observation: The staged pipeline benefits from explicit stage-state persistence rather than inferring progress from individual artifact files.
  Evidence: Step 02 added `.contextplus/config/index-stages.json`, and direct verification showed durable stage dependencies, stage-local run counts, and completed-state gating for `full-artifacts`.

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

## Outcomes & Retrospective

This plan is now the controlling implementation document for the 17-step program. Steps 01 and 02 are complete and verified. Step 03 is next and will focus on promoting chunk-level AST indexing from a derived helper to a first-class artifact with explicit durable semantics.

## Context and Orientation

The current indexing and query code lives in these files:

- `src/index.ts`: the MCP and CLI entrypoint. It registers the `index`, `tree`, `search`, `cluster`, memory, and edit tools.
- `src/tools/index-codebase.ts`: the top-level indexing pipeline. It writes the `.contextplus/config` files and runs file, identifier, and full derived artifact builders.
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

Step 03 will strengthen chunk indexing itself so chunk artifacts have a clearer first-class contract and more explicit AST-oriented semantics than the current helper-oriented full-artifact path.

Each later step must be implemented the same way: minimal coherent slice, direct verification, commit, plan update, TODO update, then move on.

## Concrete Steps

From the repository root:

1. Keep this plan current as milestones progress.
2. For Step 03, formalize chunk-level AST indexing as its own durable artifact surface rather than only a byproduct of the current full-artifact builder.
3. Update the tests to assert the chunk-artifact contract directly.
4. Run the build and test suite, then run `node build/index.js index --mode=full` and inspect the generated `.contextplus` chunk artifacts.
5. Commit Step 03 with a message that names the chunk-indexing milestone.

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

## Idempotence and Recovery

The work is intended to be repeated safely. Re-running `index` should refresh durable artifacts rather than corrupt them. If a milestone fails verification, do not commit it. Fix the failure, rerun verification, and update this plan before attempting the commit again.

Because the user requested a commit after each step, the rollback path is a normal git revert or a local checkout to the previous step commit. For MCP-authored file edits inside the repo, the existing shadow restore-point system remains available, but git commits are the primary milestone boundary here.

## Artifacts and Notes

Important current artifacts and commands:

    .contextplus/config/project.json
    .contextplus/config/index-status.json
    .contextplus/embeddings/file-search-index.json
    .contextplus/embeddings/identifier-search-index.json
    .contextplus/derived/chunk-search-index.json
    .contextplus/derived/code-structure-index.json
    .contextplus/derived/full-index-manifest.json

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

The implementation must continue using the current project-local TypeScript toolchain, the existing Ollama-based embedding stack in `src/core/embeddings.ts`, and the existing parser and walker modules. No new environment manager or external service should be introduced during Step 03.

Plan revision note: Created the initial ExecPlan to govern the 17-step full-engine implementation program and to require one verified commit per roadmap step.
