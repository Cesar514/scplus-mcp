# Phase 20 Real Benchmark Harness

This ExecPlan must be maintained in accordance with `/home/cesar514/.codex/.agent/PLANS.md`.

## Purpose / Big Picture

After this change, the `evaluate` tool will stop pretending that a tiny synthetic toy repository proves large-repo or operator-grade quality. Instead, it will build several deterministic benchmark repositories that exercise the real behaviors Context+ claims to support: exact lookup, related search, dependency reasoning, hub discovery, freshness after writes, restore correctness, validation of good and bad prepared states, and latency distributions for exact, related, and broad research queries. A user can see the change working by running the evaluation suite and reading a report that names each scenario, reports the golden-query accuracy metrics, and shows p50/p95/p99 latencies rather than a single synthetic timing.

## Progress

- [x] (2026-04-02 01:37Z) Read the existing synthetic-only harness in `src/tools/evaluation.ts`, the current test in `test/main/evaluation.test.mjs`, and the active Phase 20 checklist in `TODO.md`.
- [x] (2026-04-02 01:46Z) Replaced the synthetic-only fixture flow with named scenario builders for small/smoke, medium, large monorepo, polyglot, ignored/generated, broken-state, and rename-heavy freshness coverage.
- [x] (2026-04-02 01:46Z) Added golden operator questions and aggregate scoring for exact lookup, related search, symbol resolution, dependency accuracy, hub quality, freshness reliability, restore correctness, and validation false-positive/false-negative rates.
- [x] (2026-04-02 01:46Z) Added latency distributions for exact, related, and research queries, plus scenario summaries and retained clustering/tree-sitter reporting.
- [x] (2026-04-02 01:47Z) Updated `test/main/evaluation.test.mjs`, the `evaluate` descriptions in `README.md` and `src/index.ts`, and the Phase 20 TODO files.
- [x] (2026-04-02 01:50Z) Ran direct built-runtime verification, `npm run build`, `node --test test/main/evaluation.test.mjs`, `npm test`, and `pixi run test-cli`.

## Surprises & Discoveries

- Observation: The current benchmark harness only builds one tiny repo via `writeFixtureRepo()` and reuses it for every metric, so the report cannot substantiate any claim about polyglot repos, monorepos, ignored trees, broken states, or rename-heavy freshness.
  Evidence: `src/tools/evaluation.ts` currently defines only `writeFixtureRepo()` and one `runEvaluationSuite()` flow that always indexes a repo under `src/auth`, `src/ui`, `src/api`, and `docs`.

- Observation: The public report contract is still tightly coupled to the old synthetic suite names (`Retrieval quality`, `Hybrid efficiency`, `Artifact freshness`), so the phase needs a report shape change rather than just more fixtures.
  Evidence: `test/main/evaluation.test.mjs` asserts `Evaluation suite: default` and the old category names directly.

## Decision Log

- Decision: Replace the old evaluation report contract instead of keeping a compatibility wrapper.
  Rationale: The project rules explicitly prefer clean architecture over compatibility shims, and Phase 20 requires materially different evidence than the synthetic-only report can express.
  Date/Author: 2026-04-02 / Codex

- Decision: Keep the tiny synthetic repo only as the "small/smoke" scenario inside the real suite.
  Rationale: The old fixture is still useful as a fast sanity check, but it cannot remain the primary benchmark gate.
  Date/Author: 2026-04-02 / Codex

## Outcomes & Retrospective

The final harness now measures seven deterministic scenario classes instead of one toy repo. The report exposes 22 golden operator questions, validation true-positive/true-negative accounting, stale-after-write and restore failure rates, and p50/p95/p99 latency distributions for exact, related, and research queries. The built-runtime proof showed `suite: "real-benchmark"`, all seven scenario kinds, `validationFalseNegativeRate: 0`, and `staleAfterWriteFailureRate: 0`, which is exactly the behavioral evidence the old synthetic report could not provide.

## Context and Orientation

The evaluation entry point lives in `src/tools/evaluation.ts`. Today it creates one temporary repository, indexes it, runs a few search and hub queries, mutates one file, reindexes, and prints a report. The file also contains the public `EvaluationReport` type, the report formatter `formatEvaluationReport()`, and the top-level `runEvaluation()` string wrapper used by the MCP/server tool surface.

Exact-query utilities such as `lookupExactSymbol()`, `lookupPathCandidates()`, `lookupWord()`, and `getDependencyInfo()` live in `src/tools/exact-query.ts`. These are the Layer A deterministic queries and are the right source for exact lookup, word lookup, outline, and dependency checks.

Related search routing lives in `src/tools/query-intent.ts`. `buildSearchByIntentReport()` is the easiest structured surface for exact-vs-related checks and provides access to related-search diagnostics.

Broad subsystem research lives in `src/tools/research.ts`. `buildResearchReport()` returns structured code hits, file cards, module cards, related context, subsystem hits, and hub hits, which is stronger than string-matching the rendered report.

Prepared-index validation lives in `src/tools/index-reliability.ts`. `validatePreparedIndex()` is the source of truth for positive and negative validation checks. It can be used on valid indexed repos and on deliberately broken prepared states to compute false-positive and false-negative rates.

Checkpoint and restore correctness use `buildCheckpointReport()` from `src/tools/propose-commit.ts`, plus `listRestorePoints()` and `restorePoint()` from `src/git/shadow.ts`. These are the right write-path surfaces for proving post-write freshness and restore correctness.

The evaluation test lives in `test/main/evaluation.test.mjs`. It currently asserts the old synthetic report and must be rewritten to validate the new real-harness structure.

## Plan of Work

First, replace the contents of `src/tools/evaluation.ts` with a scenario-driven harness. Define small helper types for scenario definitions, scenario summaries, golden questions, latency distributions, validation quality, and freshness quality. Add deterministic repository builders for the required scenario classes:

The small/smoke scenario should preserve the old toy repo shape and serve as the minimal sanity check.

The medium scenario should create a realistic TypeScript service repo with several interacting features and at least one manual hub file.

The large monorepo scenario should create multiple app/service/package folders with shared modules, cross-package imports, and at least one manual or suggested hub target.

The polyglot scenario should mix several supported languages (for example TypeScript, Python, Rust, and Go) with valid headers and feature tags so the parser and index see a real multi-language codebase.

The ignored/generated scenario should create a valid repo plus `.gitignore` entries and ignored/generated directories whose contents must not dominate the prepared file manifest or search results.

The broken-state scenario should start from a valid indexed repo, deliberately delete or corrupt a required prepared artifact, and then validate that the repo is reported invalid.

The rename-heavy freshness scenario should apply several writes and renames, reindex or refresh as appropriate, and track whether old symbols disappear and new symbols become searchable without stale leakage. It should also run one checkpoint/restore cycle and verify the file contents and search results return to the last known good state.

Next, define a deterministic golden-question set inside `src/tools/evaluation.ts`. Each entry should name the scenario, the query surface being exercised, and the expected file/symbol/dependency/hub outcome. Use these goldens to compute aggregate categories for exact lookup accuracy, related-search relevance, symbol resolution accuracy, dependency graph accuracy, hub suggestion quality, and optional research-card checks where they materially strengthen the evidence. Count how many goldens passed and include the total question count in the report.

Then add latency sampling helpers. For each valid scenario, run several exact, related, and broad research queries and record durations. Compute p50, p95, and p99 from the collected samples. Keep clustering benchmarks and tree-sitter runtime stats in the report so the previously completed phases remain visible.

Finally, update `test/main/evaluation.test.mjs` to assert the new scenario count, category totals, validation rate fields, latency percentiles, clustering output, and tree-sitter stats. Update user-facing descriptions of `evaluate` in `README.md` and `src/index.ts` so they describe the real multi-scenario benchmark suite instead of the old synthetic-only benchmark.

## Concrete Steps

Work from the repository root `/home/cesar514/Documents/agent_programming/contextplus`.

1. Edit `src/tools/evaluation.ts` to add the scenario builders, structured scenario runner, latency helpers, and new report formatter.
2. Edit `test/main/evaluation.test.mjs` to match the new report shape and rendered output.
3. Update `README.md` and `src/index.ts` `evaluate` descriptions.
4. Update `TODO.md` and `TODO_COMPLETED.md` once Phase 20 verifies cleanly.
5. Run:

    npm run build
    node --test test/main/evaluation.test.mjs
    npm test
    pixi run test-cli

6. Run a direct built-runtime proof that imports `build/tools/evaluation.js`, executes `runEvaluationSuite()`, and prints the scenario names plus at least one latency distribution and one validation-rate field.

Expected final behavior includes a report whose first lines show `Evaluation suite: real-benchmark`, a scenario section naming the required benchmark targets, category sections for the new accuracy metrics, and explicit `p50/p95/p99` latency lines.

## Validation and Acceptance

Acceptance is behavioral, not just structural.

Running the evaluation suite on the built runtime must produce a report that includes all required scenario classes: small/smoke, medium, large monorepo, polyglot, ignored/generated, broken-state, and rename-heavy freshness coverage.

The structured report must include:

- scenario summaries with validation outcomes;
- exact lookup, related search, symbol resolution, dependency accuracy, and hub-quality categories;
- freshness reliability with stale-after-write and restore failure rates;
- validation quality with false-positive and false-negative rates;
- exact, related, and research latency distributions including p50, p95, and p99;
- clustering and tree-sitter reporting.

`test/main/evaluation.test.mjs` must fail before the implementation and pass after it. `npm test` and `pixi run test-cli` must also pass.

## Idempotence and Recovery

The evaluation suite only creates temporary repositories under the system temp directory and removes them in `finally` blocks, so it is safe to rerun. If a scenario fails during development, rerun the focused evaluation test after fixing that scenario before rerunning the full suite. If a partially edited report contract breaks the test suite, revert only the affected files and reapply the edits coherently.

## Artifacts and Notes

The final direct proof should print a short JSON object similar to:

    {
      "suite": "real-benchmark",
      "scenarioNames": ["small-smoke", "medium", "large-monorepo", "polyglot", "ignored-generated", "broken-state", "rename-freshness"],
      "exactP50Ms": 1.23,
      "validationFalseNegativeRate": 0
    }

This is the proof that the built runtime, not just the source tree, exposes the new real benchmark harness.

Observed proof after implementation:

    {
      "suite": "real-benchmark",
      "scenarioNames": [
        "small-smoke",
        "medium",
        "large-monorepo",
        "polyglot",
        "ignored-generated",
        "broken-state",
        "rename-freshness"
      ],
      "exactLatency": {
        "sampleCount": 5,
        "p50Ms": 3.3,
        "p95Ms": 4.26,
        "p99Ms": 4.26,
        "maxMs": 4.26
      },
      "validationFalseNegativeRate": 0,
      "staleAfterWriteFailureRate": 0,
      "goldenQuestionCount": 22
    }

## Interfaces and Dependencies

In `src/tools/evaluation.ts`, keep exporting:

    export interface EvaluationReport { ... }
    export async function runEvaluationSuite(): Promise<EvaluationReport>
    export function formatEvaluationReport(report: EvaluationReport): string
    export async function runEvaluation(): Promise<string>

The `EvaluationReport` interface must be expanded to include scenario summaries, the new accuracy categories, freshness reliability, validation quality, and latency distributions. Use existing repository surfaces rather than inventing new infrastructure:

- `indexCodebase()` from `src/tools/index-codebase.ts`
- `validatePreparedIndex()` from `src/tools/index-reliability.ts`
- `lookupExactSymbol()`, `lookupPathCandidates()`, `lookupWord()`, `getDependencyInfo()` from `src/tools/exact-query.ts`
- `buildSearchByIntentReport()` from `src/tools/query-intent.ts`
- `buildResearchReport()` from `src/tools/research.ts`
- `getFeatureHub()` from `src/tools/feature-hub.ts`
- `buildCheckpointReport()` from `src/tools/propose-commit.ts`
- `listRestorePoints()` and `restorePoint()` from `src/git/shadow.ts`

When this plan changes, add a note below describing what changed and why.

Change note: Initial plan created for Phase 20 after confirming the existing evaluation harness is still synthetic-only and the report contract must change to express real scenario coverage, validation rates, freshness reliability, and latency distributions.

Change note: Updated after implementation to record the completed scenario-based harness, the new verification commands, and the observed built-runtime proof.
