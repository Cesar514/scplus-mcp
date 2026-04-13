// Completed tasks for the current goal. \
// Format: [x] <timestamp> <task> \
// Example: [x] 2026-04-05T20:39:27Z Verify the completed-task log is sorted newest-first using 24-hour HH:MM:SS UTC timestamps. \

[x] 2026-04-05T21:39:27Z Reformat the old todo list from `TODO.bak` into the current numbered `TODO.md` format and keep the imported items as the active backlog. \
[x] 2026-04-13T11:31:45Z Review `Lints_wip.md` and map the feasible rules onto the current `src/tools/static-analysis.ts` design. \
[x] 2026-04-13T11:31:45Z Implement additional strict lint rules in `src/tools/static-analysis.ts` without breaking the existing lint report surface. \
[x] 2026-04-13T11:31:45Z Add automated coverage for the new rule findings in `test/main/static-analysis.test.mjs`. \
[x] 2026-04-13T11:31:45Z Build the project and run the targeted static-analysis tests to verify the requested lint behavior. \
[x] 2026-04-13T11:40:38Z Implement `max_file_loc` as true non-comment LOC counting in `src/tools/static-analysis.ts`. \
[x] 2026-04-13T11:40:38Z Implement `function_header_3_lines` for parser-supported callables across the supported source languages. \
[x] 2026-04-13T11:40:38Z Expand static-analysis tests to prove the new rules fire across TypeScript, Python, Go, Java, Rust, and C++. \
[x] 2026-04-13T11:40:38Z Rebuild and rerun targeted static-analysis tests after the smarter lint changes. \
[x] 2026-04-13T11:41:57Z Increase the static-analysis maximum line length from 100 to 150 characters. \
[x] 2026-04-13T11:41:57Z Update the static-analysis tests so line-length coverage matches the new 150-character threshold. \
[x] 2026-04-13T11:41:57Z Rebuild and rerun the targeted static-analysis test suite to verify the new threshold. \
[x] 2026-04-13T11:49:37Z Implement `max_nesting_depth` as a real AST-backed static-analysis rule in the tree-sitter lint path. \
[x] 2026-04-13T11:49:37Z Add automated coverage proving `max_nesting_depth` fires across the supported source languages under nested control flow. \
[x] 2026-04-13T11:49:37Z Rebuild and rerun the targeted static-analysis test suite to verify the new nesting-depth rule. \
[x] 2026-04-13T11:55:40Z Implement `public_api_requires_doc` in `src/tools/static-analysis.ts` for public or exported functions, methods, and classes. \
[x] 2026-04-13T11:55:40Z Add automated coverage for `public_api_requires_doc` and align the changed exported APIs in this repo with the new rule. \
[x] 2026-04-13T11:55:40Z Rebuild, rerun the targeted static-analysis tests, and run the lint report against the changed repo files to verify the rule in this repository. \
[x] 2026-04-13T12:00:10Z Implement `typed_public_interfaces` in `src/tools/static-analysis.ts` for public APIs in languages with explicit type syntax. \
[x] 2026-04-13T12:00:10Z Add automated coverage for `typed_public_interfaces` across the supported public-API languages. \
[x] 2026-04-13T12:00:10Z Rebuild, rerun the targeted static-analysis tests, and verify the new rule against real repo files. \
[x] 2026-04-13T12:05:14Z Implement `no_generic_catch` as an AST-backed cross-language static-analysis rule for broad catch handlers that swallow failures. \
[x] 2026-04-13T12:05:14Z Add automated coverage for `no_generic_catch` across the supported catch-capable languages. \
[x] 2026-04-13T12:05:14Z Rebuild, rerun the targeted static-analysis tests, and verify the new catch rule against real repo files. \
[x] 2026-04-13T12:19:39Z Implement `no_global_mutable_state` in `src/tools/static-analysis.ts` for obvious top-level mutable runtime state across the supported languages. \
[x] 2026-04-13T12:19:39Z Add automated coverage for `no_global_mutable_state` across the supported language set. \
[x] 2026-04-13T12:19:39Z Rebuild, rerun the targeted static-analysis tests, and verify the new rule against real repo files. \
[x] 2026-04-13T12:53:01Z Implement `max_cognitive_complexity` in `src/tools/static-analysis.ts` using the existing AST control-flow path. \
[x] 2026-04-13T12:53:01Z Add automated coverage for `max_cognitive_complexity` across the supported language set. \
[x] 2026-04-13T12:53:01Z Rebuild, rerun the targeted static-analysis tests, and verify the new rule against a real repo file. \
[x] 2026-04-13T13:04:45Z Implement `no_duplicate_blocks` in `src/tools/static-analysis.ts` with low-noise duplicate block detection for the supported source files. \
[x] 2026-04-13T13:04:45Z Add automated coverage for `no_duplicate_blocks` in `test/main/static-analysis.test.mjs`. \
[x] 2026-04-13T13:04:45Z Rebuild, rerun the targeted static-analysis tests, and verify the new duplicate-block rule against a real repo file. \
[x] 2026-04-13T13:07:47Z Verify the repository lint target and run the strongest available lint check for the current goal. \
[x] 2026-04-13T13:07:47Z Inspect the highest-signal lint findings and gather file/line references for the report. \
[x] 2026-04-13T13:19:21Z Refactor `cli/internal/backend/client.go` to remove duplicate wrappers and reduce complexity without changing the CLI/backend protocol. \
[x] 2026-04-13T13:19:21Z Refactor `cli/cmd/scplus-cli/main.go` to reduce complexity and satisfy structural lint rules without changing command behavior. \
[x] 2026-04-13T13:19:21Z Refactor `src/tools/static-analysis.ts` to satisfy its own lint rules while preserving the lint report behavior. \
[x] 2026-04-13T13:19:21Z Refactor `test/main/static-analysis.test.mjs` to remove duplicate fixture blocks while preserving rule coverage. \
[x] 2026-04-13T13:19:21Z Rebuild and rerun targeted lint and tests for the four files until the goal is verified. \
[x] 2026-04-13T13:19:21Z Narrow or remove the `function-header-3-lines` rule path in `src/tools/static-analysis-core.ts` while preserving the stronger public API doc requirements. \
[x] 2026-04-13T13:19:21Z Update the static-analysis test suite to match the new `function-header-3-lines` behavior. \
[x] 2026-04-13T13:19:21Z Rebuild, rerun the static-analysis tests, and verify that repo-wide `function-header-3-lines` findings drop to zero. \
[x] 2026-04-13T14:43:53Z Restore the `function-header-3-lines` logic in `src/tools/static-analysis-core.ts` and align its non-trivial LOC threshold with the current counter so headerless real functions are flagged again. \
[x] 2026-04-13T14:43:53Z Restore the `function-header-3-lines` test coverage in `test/main/static-analysis-suite.test.mjs` for missing and valid structured function headers. \
[x] 2026-04-13T14:43:53Z Rebuild and rerun the static-analysis tests to verify the restored rule behaves correctly. \
[x] 2026-04-13T14:46:45Z Run the strongest available repository-wide lint scan and capture the aggregate severity and score output. \
[x] 2026-04-13T14:46:45Z Inspect the worst offending files individually and record the highest-signal rule clusters with file and line references. \
[x] 2026-04-13T15:08:18Z Re-enumerate every remaining script file that still reports the `function-header-3-lines` lint rule after the manual header passes so the next edits use the current state. \
[x] 2026-04-13T14:59:12Z Add the required 3-line structured function headers to the warned helpers in `src/tools/static-analysis-core.ts`. \
[x] 2026-04-13T14:59:12Z Rerun the targeted lint check for `src/tools/static-analysis-core.ts` and verify the `function-header-3-lines` warnings are gone there. \
[x] 2026-04-13T16:13:54Z Add the required 3-line structured function headers to the warned functions in `src/core/chat.ts`, `src/core/runtime-locks.ts`, `src/tools/full-index-artifacts.ts`, `src/tools/semantic-search.ts`, `src/tools/feature-hub.ts`, and `src/tools/hub-suggestions.ts`, including manual function-shaped refactors where the rule would not attach to constructors or object methods. \
[x] 2026-04-13T16:13:54Z Rerun targeted lint on the six edited files and verify that `function-header-3-lines` no longer appears in those files. \
[x] 2026-04-13T16:13:54Z Recount the remaining repository-wide script files with `function-header-3-lines` findings so the next manual pass uses the current backlog. \
[x] 2026-04-13T16:25:31Z Add the required 3-line structured function headers to the warned functions in `src/tools/research.ts`, `src/tools/semantic-identifiers.ts`, `src/core/tree-sitter.ts`, `src/tools/index-codebase.ts`, `src/tools/cluster-artifacts.ts`, `src/tools/index-stages.ts`, and `src/tools/unified-ranking.ts`, including manual factory-function refactors where constructors were blocking the rule. \
[x] 2026-04-13T16:25:31Z Rerun targeted lint on the seven edited files and verify that `function-header-3-lines` no longer appears in those files except the remaining parser edge case inside `src/tools/index-codebase.ts`'s nested `persistProgress` helper. \
[x] 2026-04-13T16:25:31Z Recount the remaining repository-wide script files with `function-header-3-lines` findings and confirm the backlog is down to 180 findings across 8 files. \
[x] 2026-04-13T16:46:30Z Finish the remaining manual `function-header-3-lines` pass in `test/main/bridge-serve.test.mjs`, `src/tools/index-codebase.ts`, `src/tools/hybrid-retrieval.ts`, `src/tools/query-engine.ts`, `src/tools/exact-query.ts`, `src/tools/evaluation.ts`, `src/core/index-database.ts`, and `src/core/embeddings.ts`, including method-to-helper and constructor-to-factory refactors where the rule would not attach cleanly. \
[x] 2026-04-13T16:46:30Z Rerun targeted lint for the final edited files and the repo-wide recount, and verify that script-file `function-header-3-lines` findings are now zero. \
