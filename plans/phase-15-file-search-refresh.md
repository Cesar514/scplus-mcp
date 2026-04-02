# Phase 15 File Search Refresh ExecPlan

This ExecPlan must be maintained in accordance with `/home/cesar514/.codex/.agent/PLANS.md`.

## Purpose / Big Picture

After this change, the file-search refresh path can no longer silently drop files from the persisted search index when document construction fails. The user-visible outcome is that `search`, `ensureFileSearchIndex`, and refresh-triggered embedding work now fail loudly with explicit per-file diagnostics when an indexed file would disappear or when document construction fails, while the previously persisted file-search state remains intact.

## Progress

- [x] (2026-04-02 16:43Z) Audited `src/tools/semantic-search.ts` and confirmed the omission bug exists in both `refreshPersistedFileSearchState()` and `refreshFileSearchEmbeddings()` because `buildSearchDocumentForFile()` returned `null` for both ignored files and real failures.
- [x] (2026-04-02 16:54Z) Replaced the `null` document-build contract with a typed result, added `FileSearchRefreshError`, and made refresh fail loudly when a file would silently disappear or when document construction fails.
- [x] (2026-04-02 16:57Z) Added regressions for oversized indexed files and supported-source parse failures, both proving the persisted file-search state is preserved when refresh is blocked.
- [x] (2026-04-02 17:15Z) Verified the new refresh contract with targeted tests, the full repository suite, the Go CLI suite, and a direct built-artifact failure demo before moving Phase 15 out of `TODO.md`.

## Surprises & Discoveries

- Observation: The omission bug was not limited to the main refresh path. `refreshFileSearchEmbeddings()` also filtered failed documents out silently.
  Evidence: The previous implementation did `docs.filter((doc): doc is SearchDocument => doc !== null)` and kept going.

- Observation: The existing semantic-search tests already persisted the sqlite-backed file-search artifact, which made it straightforward to verify that blocked refreshes leave the previously indexed document untouched.
  Evidence: `test/main/semantic-search.test.mjs` already reads `file-search-index` directly from `.contextplus/state/index.sqlite`.

## Decision Log

- Decision: Use a loud thrown error (`FileSearchRefreshError`) rather than a success-shaped blocked result.
  Rationale: Repo policy is crash-only for this greenfield project. A failed refresh must stop the operation and surface the exact files and reasons rather than returning a partially successful state.
  Date/Author: 2026-04-02 / Codex

- Decision: Distinguish three document-build outcomes: indexed, ignored, and failed.
  Rationale: The core bug came from conflating “this file is intentionally not part of file search” with “we tried to build it and failed.” The refresh logic needs that distinction to avoid silent omission.
  Date/Author: 2026-04-02 / Codex

## Outcomes & Retrospective

Phase 15 is narrowly about correctness of the persisted file-search refresh contract. The repository now blocks file-search refresh with `FileSearchRefreshError` whenever an indexed file would disappear or when document construction fails, and the persisted sqlite artifact stays at the last known good state in those cases. The direct built-artifact proof for this phase showed `notes.md` failing loudly after exceeding the size limit while the persisted content remained `# proof\n\nsmall content\n`.

## Context and Orientation

`src/tools/semantic-search.ts` builds and refreshes the persisted file-search index. `buildSearchDocumentForFile()` is the gate that turns a path into a `SearchDocument`. Before this phase it returned `null` both for files that should be ignored and for real failures such as read or parse errors. `refreshPersistedFileSearchState()` then only re-added changed files when the returned document was truthy, so an indexed file could silently disappear from `nextFiles`.

The same ambiguity also existed in `refreshFileSearchEmbeddings()`, which filtered away `null` results and embedded only the remaining documents. That meant background embedding refreshes could also skip broken files silently.

## Plan of Work

Edit `src/tools/semantic-search.ts` so document construction returns a typed result with explicit `indexed`, `ignored`, and `failed` states. Add a `FileSearchRefreshError` that carries the root path and a list of failing files. In the main refresh loop, keep ignored files ignored only when they were never part of the persisted index; if a previously indexed file would now disappear, treat that as a refresh failure. In both refresh paths, collect the failing files and throw once with a diagnostic that names each path and reason. Do not save the new persisted state when failures exist.

Extend `test/main/semantic-search.test.mjs` with two regressions: one where an indexed markdown file grows past the embed-size limit and one where a previously indexed supported source file hits a synthetic parser failure. In both cases, assert that refresh throws `FileSearchRefreshError` and that the previously persisted sqlite artifact still contains the older indexed document.

## Concrete Steps

From the repository root:

1. Edit `src/tools/semantic-search.ts`.
2. Edit `test/main/semantic-search.test.mjs`.
3. Run `npm run build`.
4. Run `node --test test/main/semantic-search.test.mjs test/main/invalidation.test.mjs`.
5. Run the full verification sequence in `Validation and Acceptance`.
6. Update `TODO.md` and `TODO_COMPLETED.md`.

## Validation and Acceptance

Acceptance requires all of the following:

- A previously indexed file cannot disappear from the file-search index without throwing a loud error.
- The thrown error includes the file path and the reason.
- The persisted file-search artifact remains at the last known good state when refresh is blocked.
- The broader repository suites still pass.

Run from the repository root:

    npm run build
    node --test test/main/semantic-search.test.mjs test/main/invalidation.test.mjs
    npm test
    pixi run test-cli
    node --input-type=module <direct file-search refresh failure proof>

The direct proof should show `FileSearchRefreshError` with the target path in the message.

## Idempotence and Recovery

These edits are safe to rerun. If the targeted tests fail, rebuild first so `build/` matches source, then rerun the specific suite. If a refresh failure is thrown during manual verification, that is the intended outcome for this phase; inspect the error details rather than treating it as an infrastructure failure.

## Artifacts and Notes

Important files for this phase:

    src/tools/semantic-search.ts
    test/main/semantic-search.test.mjs

Revision note: created this ExecPlan because Phase 15 changes a persisted indexing contract and the repository requires a self-contained plan for non-trivial refactors.
Revision note: updated after verification to record the shipped `FileSearchRefreshError` contract, the direct runtime proof, and completion of the TODO migration for Phase 15.
