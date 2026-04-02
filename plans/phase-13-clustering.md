# Phase 13 Clustering ExecPlan

This ExecPlan must be maintained in accordance with `/home/cesar514/.codex/.agent/PLANS.md`.

## Purpose / Big Picture

After this change, full indexing can build semantic cluster artifacts for much larger repositories without paying the current spectral-clustering cost of a full affinity matrix, normalized Laplacian, and eigen decomposition. The user-visible behavior stays the same: `cluster`, `research`, hub suggestions, and subsystem summaries still work, but clustering now uses a scalable deterministic centroid algorithm and the benchmark report includes explicit medium and large clustering timings.

## Progress

- [x] (2026-04-02 15:04Z) Audited `src/core/clustering.ts`, `src/tools/cluster-artifacts.ts`, and the clustering tests to confirm the current bottleneck is the spectral pipeline and to map the artifact outputs that must stay stable.
- [x] (2026-04-02 15:18Z) Replaced the spectral clustering core with deterministic farthest-seed cosine k-means in `src/core/clustering.ts` and rewired `src/tools/cluster-artifacts.ts` to use it.
- [x] (2026-04-02 15:42Z) Added medium and large clustering benchmarks to `src/tools/evaluation.ts`, expanded clustering tests, and verified the built benchmark and full repository suites before moving Phase 13 out of `TODO.md`.

## Surprises & Discoveries

- Observation: The cluster artifact builder already separates the clustering result from the artifact shape, so the algorithm swap can stay isolated to `src/core/clustering.ts` plus a one-line import change in `src/tools/cluster-artifacts.ts`.
  Evidence: `buildHierarchy()` in `src/tools/cluster-artifacts.ts` only consumes `{ indices: number[] }[]` and derives labels, summaries, and path patterns separately.

- Observation: The current benchmark suite did not measure clustering cost at all, even though Phase 13 requires medium and large measurements.
  Evidence: `src/tools/evaluation.ts` measured indexing, exact search, related search, and research timings, but had no clustering benchmark fields before this phase.

## Decision Log

- Decision: Replace the spectral algorithm with deterministic cosine k-means seeded by farthest-point selection instead of trying to optimize the existing matrix decomposition.
  Rationale: The current problem is the cost shape itself. Deterministic centroid clustering changes the scaling from full-matrix and eigen decomposition work to bounded iterative assignment and centroid updates, while keeping the output contract simple.
  Date/Author: 2026-04-02 / Codex

- Decision: Keep the semantic cluster artifact schema stable and add benchmark visibility through `src/tools/evaluation.ts` instead of changing downstream consumers.
  Rationale: `research`, `semantic-navigate`, hub suggestions, and the full-index manifest already depend on the persisted cluster artifact shape. Preserving that shape keeps the phase scoped to the algorithm and measurement changes.
  Date/Author: 2026-04-02 / Codex

## Outcomes & Retrospective

This phase is scoped to the clustering bottleneck, not the broader query engine or TUI work. The repository now stops using spectral clustering as the default strategy, retains semantic cluster artifacts with the same downstream interface, and reports medium and large clustering timings in the evaluation suite. The direct built benchmark measured `400` vectors in `8.22ms` and `2400` vectors in `34.91ms`, which is the concrete proof recorded for this phase.

## Context and Orientation

`src/core/clustering.ts` is the algorithm module used by full indexing. Before this phase it built an all-pairs similarity matrix, transformed that into a normalized Laplacian, ran eigen decomposition, and then ran k-means over the resulting eigenvectors. That is expensive because the matrix grows with every pair of files and the eigen decomposition becomes the dominant cost as the repository grows.

`src/tools/cluster-artifacts.ts` builds the persisted semantic cluster artifact. It takes files from the persisted file-search index, gets embeddings, runs the clustering algorithm, and then derives user-facing labels, related-file edges, and subsystem summaries from those groups. The downstream tools `src/tools/semantic-navigate.ts`, `src/tools/research.ts`, and `src/tools/hub-suggestions.ts` all read the persisted artifact rather than recomputing clustering.

`src/tools/evaluation.ts` is the benchmark surface used to make performance claims visible. Phase 13 requires adding direct medium and large clustering measurements there so the repo has an observable benchmark instead of a claim in `TODO.md` only.

## Plan of Work

Replace the spectral implementation in `src/core/clustering.ts` with a deterministic scalable algorithm that only needs repeated centroid assignment and centroid recomputation. Normalize vectors once, seed centroids with farthest-point selection, iterate cosine-based assignments for a bounded number of rounds, compact empty clusters away, and return the same `ClusterResult[]` shape that the artifact builder already consumes.

Update `src/tools/cluster-artifacts.ts` to import the new clustering function name while leaving the persisted artifact shape unchanged. This preserves labels, path patterns, subsystem summaries, and related-file neighborhoods.

Expand the direct tests in `test/main/clustering.test.mjs` so they validate correctness on both small semantic examples and larger synthetic vector sets. Extend `src/tools/evaluation.ts` and `test/main/evaluation.test.mjs` so the evaluation report includes explicit medium and large clustering timings and cluster counts.

Finish by moving Phase 13 from `TODO.md` to `TODO_COMPLETED.md`, then run the strongest available verification: build, focused clustering and artifact tests, the full evaluation suite, the full repository test suite, a direct benchmark command against the built clustering module, and a clean git status before committing.

## Concrete Steps

From the repository root:

1. Edit `src/core/clustering.ts` to remove the spectral implementation and replace it with deterministic centroid clustering.
2. Edit `src/tools/cluster-artifacts.ts` to import and call the new clustering function.
3. Edit `test/main/clustering.test.mjs` to cover both semantic correctness and larger vector-set coverage.
4. Edit `src/tools/evaluation.ts` and `test/main/evaluation.test.mjs` to record clustering benchmark timings.
5. Update `TODO.md` and `TODO_COMPLETED.md`.
6. Run the validation commands in `Validation and Acceptance`.

## Validation and Acceptance

Acceptance requires all of the following:

- The clustering core no longer imports or uses `ml-matrix`, an affinity matrix, a normalized Laplacian, or eigen decomposition.
- `cluster`, `research`, and persisted cluster artifacts still work because the artifact shape remains stable.
- The evaluation report includes explicit medium and large clustering timings and cluster counts.
- A direct built-artifact benchmark over synthetic medium and large vector sets completes and reports finite timings.

Run from the repository root:

    npm run build
    node --test test/main/clustering.test.mjs test/main/cluster-artifacts.test.mjs test/main/evaluation.test.mjs
    npm test
    pixi run test-cli
    node --input-type=module <direct clustering benchmark script>

The direct benchmark should print two finite timings, one for a medium vector set and one for a large vector set, plus the resulting cluster counts.

## Idempotence and Recovery

These edits are safe to repeat. If a clustering test fails, rerun `npm run build` first so the `build/` tree matches the current sources, then rerun the specific failing test. If the evaluation report shape changes, update both `src/tools/evaluation.ts` and `test/main/evaluation.test.mjs` together so the report and its assertions stay synchronized.

## Artifacts and Notes

Important files for this phase:

    src/core/clustering.ts
    src/tools/cluster-artifacts.ts
    src/tools/evaluation.ts
    test/main/clustering.test.mjs
    test/main/cluster-artifacts.test.mjs
    test/main/evaluation.test.mjs

Revision note: created this ExecPlan to satisfy the repository requirement that significant refactors be implemented from a self-contained plan, because Phase 13 changes both the clustering algorithm and the benchmark surface.
Revision note: updated after implementation and verification to record the shipped deterministic clustering algorithm, benchmark measurements, and completion of the TODO migration for Phase 13.
