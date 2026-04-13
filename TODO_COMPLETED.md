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
