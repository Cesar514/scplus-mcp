# Phase 19 ExecPlan: Query Engine Stack

This ExecPlan must be maintained in accordance with `/home/cesar514/.codex/.agent/PLANS.md`.

## Purpose / Big Picture

After this change, Context+ will stop reconstructing high-level research summaries every time a user asks a broad question. Instead, full indexing will precompute a dedicated explanation substrate that turns low-level structure, cluster, and hub artifacts into agent-ready summaries for files, modules, subsystems, and hubs. A user will be able to run `research` and receive output that is still grounded in the exact and candidate layers, but whose descriptive context comes from durable explanation cards stored in SQLite and validated as part of the serving contract.

The visible proof is twofold. First, a fresh `index --mode=full` run will persist a new `query-explanation-index` artifact and expose it through the full manifest. Second, `research` and the bridge `research` payload will include explanation-card content such as file purpose, public API summaries, dependency neighborhood summaries, ownership summaries, hot-path summaries, and change-risk notes without rebuilding those descriptions on demand from raw cluster or hub state.

## Progress

- [x] 2026-04-02 12:13Z Read the active `TODO.md`, the Context+ skill instructions, `INSTRUCTIONS.md`, and the indexing/research/query surfaces that Phase 19 must change.
- [x] 2026-04-02 12:13Z Add a durable query-engine explanation artifact, wire it into the full-index pipeline and manifest, and make it part of prepared-index validation.
- [x] 2026-04-02 12:13Z Rewrite `research` and bridge-facing research payloads to consume the explanation artifact instead of reconstructing subsystem and hub narratives on demand.
- [x] 2026-04-02 12:13Z Add direct verification for the new artifact and explanation-backed `research`, update `TODO.md` / `TODO_COMPLETED.md`, and commit the phase.

## Surprises & Discoveries

- Observation: The repository already has enough durable Layer B ingredients for Phase 19. `src/tools/full-index-artifacts.ts` persists code-structure, hybrid retrieval, semantic cluster, and hub suggestion artifacts, but `src/tools/research.ts` still recomputes most explanation-layer summaries on demand.
  Evidence: `buildResearchReport()` currently loads `semantic-cluster-index`, `code-structure-index`, and `hub-suggestion-index`, then scores subsystem and hub hits inline.

- Observation: The full-artifacts stage is the correct place to build Layer C because it already owns chunk, structure, cluster, and hub generation for `full` mode.
  Evidence: `ensureFullIndexArtifacts()` in `src/tools/full-index-artifacts.ts` already runs chunk, hybrid, structure, cluster, and hub work in order before writing `full-index-manifest`.

## Decision Log

- Decision: Add one new persisted `query-explanation-index` artifact instead of spreading explanation summaries across existing structure, cluster, and hub artifacts.
  Rationale: Phase 19 is specifically about formalizing the three-layer query stack. A dedicated artifact makes Layer C explicit, versioned, and independently inspectable.
  Date/Author: 2026-04-02 / Codex

- Decision: Keep the exact and candidate layers where they already live, but formalize them through a query-engine contract embedded in the explanation artifact and the full manifest.
  Rationale: Layer A and Layer B are already real code paths. The missing piece is an explicit contract plus a durable explanation layer that downstream tools can consume directly.
  Date/Author: 2026-04-02 / Codex

## Outcomes & Retrospective

Phase 19 landed as one new prepared artifact, `query-explanation-index`, plus a contract bump that makes the explanation layer part of the full prepared index. `research` now keeps candidate generation in the unified ranker but renders explanation-backed file, module, subsystem, and hub context from the persisted explanation cards instead of reconstructing those summaries inline. The remaining Phase 20+ work is now about benchmarking, observability, and the operator-console rewrite rather than query-stack formalization itself.

## Context and Orientation

The full-index pipeline lives in `src/tools/full-index-artifacts.ts`. It currently builds chunk artifacts, warms chunk embeddings, refreshes hybrid chunk and identifier retrieval indexes, refreshes the structure index, refreshes semantic clusters, refreshes hub suggestions, and then writes `full-index-manifest`.

The durable indexing contract lives in `src/tools/index-contract.ts`. It defines the index phases, stage outputs, artifact version, contract version, and the `FullArtifactManifest` shape. Any new prepared artifact that should be part of the serving contract must be added there.

Prepared-index validation lives in `src/tools/index-reliability.ts`. It determines which artifacts must exist for `full` mode by parsing stage outputs from the contract, then validates the full manifest against the current contract and artifact version.

Broad research output lives in `src/tools/research.ts`. It currently loads the raw cluster, structure, and hub suggestion artifacts and derives related files, subsystem hits, and hub hits every time `buildResearchReport()` runs. That is the behavior this phase replaces with a precomputed explanation substrate.

The bridge and human CLI both expose `research` through `src/cli/commands.ts`, so any shape added to `ResearchReport` will flow into operator-facing payloads immediately.

An “explanation artifact” in this repository means a persisted SQLite-backed index artifact whose purpose is not candidate retrieval but high-level, agent-ready summaries. The new artifact will store deterministic cards for files, modules, subsystems, and hubs, plus a query-engine contract describing Layer A (exact deterministic substrate), Layer B (candidate generation substrate), and Layer C (explanation substrate).

## Plan of Work

Create a new module at `src/tools/query-engine.ts`. This module will define the Layer A/Layer B/Layer C contract, the persisted explanation artifact types, and the functions to load and refresh the new `query-explanation-index` artifact. The refresh path will read the existing structure, semantic cluster, and hub suggestion artifacts plus manual hub markdown, then derive deterministic explanation cards.

Update `src/core/index-database.ts` so `query-explanation-index` is a first-class artifact key. Update `src/tools/index-contract.ts` to add a new `explanation-scan` phase, include the new artifact in the `full-artifacts` stage outputs, and extend `FullArtifactManifest` with the new artifact path and explanation counts. Bump the artifact and contract versions because the prepared-index contract changes.

Update `src/tools/full-index-artifacts.ts` so `ensureFullIndexArtifacts()` refreshes the explanation artifact after hub suggestions and before writing the manifest. Extend its stats and progress reporting so the explanation stage is visible and the manifest carries explanation counts.

Update `src/tools/index-codebase.ts` and `src/tools/index-stages.ts` so the new `explanation-scan` phase appears in status and progress output. This keeps the operator-visible pipeline aligned with the new contract.

Rewrite `src/tools/research.ts` so it loads `query-explanation-index` and uses it for related context, subsystem context, hub context, and explanation-card rendering. The only on-demand ranking work should remain the Layer B unified search. The report should expose explanation cards in structured form and render them in text form.

Update the tests that validate indexing, reliability, research, and bridge payloads. Add direct assertions that `query-explanation-index` exists in SQLite, that the full manifest references it, and that `research` output contains explanation-card content. Then update `TODO.md` and `TODO_COMPLETED.md` so Phase 19 leaves only incomplete future work in `TODO.md`.

## Concrete Steps

Run these commands from `/home/cesar514/Documents/agent_programming/contextplus`.

1. Build and focused-test the query-engine changes:

    npm run build
    node --test test/main/index.test.mjs test/main/research.test.mjs test/main/cli-bridge.test.mjs test/main/index-reliability.test.mjs

   Expect the focused suites to pass and the new tests to confirm that `query-explanation-index` is persisted and used by `research`.

2. Run the full repository verification:

    npm test
    pixi run test-cli

   Expect the Node suite and the Go CLI suite to pass.

3. Run a direct built-artifact proof in a temp repository:

    node --input-type=module

   In that script, create a small repo, run `indexCodebase({ mode: "full" })`, inspect `.contextplus/state/index.sqlite` for `query-explanation-index`, then run `buildResearchReport()` and show that its explanation cards come from the persisted artifact.

## Validation and Acceptance

Acceptance is behavioral, not structural.

`index --mode=full` must now persist `query-explanation-index` into SQLite, and the active full manifest must name it explicitly. `validatePreparedIndex({ mode: "full" })` must fail if that artifact is missing because it is now part of the prepared serving contract.

`research` must still return ranked code hits, related context, subsystem context, and hub context, but the descriptive parts of that report must come from durable explanation cards. The output must contain explanation-card content such as file purpose, public API summaries, dependency-neighborhood summaries, hot-path summaries, ownership summaries, and change-risk notes. The bridge `research` payload must expose those cards in structured form for operator-facing consumers.

## Idempotence and Recovery

The explanation artifact refresh is safe to rerun because it is derived deterministically from existing prepared full-mode artifacts plus current manual hub markdown. If a run fails, rerun `npm run build` and the focused tests after fixing the issue. If the prepared state becomes invalid during development, rerun `node build/index.js repair_index --target full` or rerun `index --mode=full`.

## Artifacts and Notes

The most important proof artifact at the end of this phase is the `query-explanation-index` row in `.contextplus/state/index.sqlite`. The second most important proof is a `research` report whose explanation-card sections match that persisted data rather than being reconstructed from raw cluster and hub state.

## Interfaces and Dependencies

In `src/tools/query-engine.ts`, define:

    export interface QueryLayerDescriptor
    export interface QueryEngineContract
    export interface RelatedContextCard
    export interface FileExplanationCard
    export interface ModuleExplanationCard
    export interface SubsystemExplanationCard
    export interface HubExplanationCard
    export interface PersistedQueryExplanationState
    export interface QueryExplanationStats
    export async function loadQueryExplanationState(rootDir: string): Promise<PersistedQueryExplanationState>
    export async function refreshQueryExplanationState(rootDir: string, options?): Promise<{ state: PersistedQueryExplanationState; stats: QueryExplanationStats }>

In `src/tools/research.ts`, update `ResearchReport` so it includes explanation-layer data for the top-ranked files and modules, and load those cards from `loadQueryExplanationState()` instead of deriving them directly from raw structure/cluster/hub artifacts.

In `src/tools/index-contract.ts`, extend `FullArtifactManifest` with the explanation artifact path and counts, and include `query-explanation-index` in the `full-artifacts` stage outputs.

Revision note: created this ExecPlan at implementation start so the artifact contract, consumer rewrite, and verification path are explicit before patching.
Revision note: updated after implementation to mark all progress items complete and record the landed explanation-artifact outcome.
