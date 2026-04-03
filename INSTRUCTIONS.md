# Context+ MCP - Agent Instructions

## Purpose

You are equipped with the Context+ MCP server. It gives you structural awareness of the entire codebase without reading every file. Follow this workflow strictly to conserve context and maximize accuracy.

## Architecture

The MCP server is built with TypeScript and communicates over stdio using the Model Context Protocol SDK. It has four layers:

**Core Layer** (`src/core/`):

- `parser.ts` - Multi-language symbol extraction via strict tree-sitter analysis with explicit parse failures instead of silent parser fallback.
- `tree-sitter.ts` - Pooled WASM grammar loader for the supported tree-sitter language set.
- `walker.ts` - Gitignore-aware recursive directory traversal with depth and target path control.
- `embeddings.ts` - Provider-backed embedding engine with generation-aware sqlite vector persistence and cosine similarity search.

**Tools Layer** (`src/tools/`):

- `context-tree.ts` - Token-aware structural tree with symbol line ranges and Level 0/1/2 pruning.
- `file-skeleton.ts` - Function signatures with line ranges, without reading full bodies.
- `exact-query.ts` - Prepared exact-query substrate for `symbol`, `word`, `outline`, `deps`, `status`, and `changes`.
- `query-intent.ts` / `unified-ranking.ts` - Intent routing plus canonical ranking across file, chunk, identifier, and structure evidence.
- `semantic-search.ts` / `semantic-identifiers.ts` / `semantic-navigate.ts` - Related retrieval and semantic navigation over persisted full-index artifacts.
- `research.ts` / `query-engine.ts` - Broad repository research and explanation artifacts over the prepared query engine.
- `blast-radius.ts` - Symbol usage tracer across the entire codebase.
- `static-analysis.ts` - Native linter runner (tsc, eslint, py_compile, cargo check, go vet) plus repo/file scoring from Context+ rule findings.
- `propose-commit.ts` / `write-freshness.ts` - Guarded writes plus synchronous post-write refresh and explicit freshness enforcement.
- `feature-hub.ts` - Obsidian-style feature hub navigator with bundled skeleton views.

**CLI / Backend Layer** (`src/cli/`):

- `backend-core.ts` - Shared long-lived backend core used by MCP and the human CLI.
- `commands.ts` / `reports.ts` - Human CLI and `bridge-serve` command surfaces over the shared backend state.
- `backend-core-helpers.ts` / `command-utils.ts` - Shared scheduler, doctor, and command formatting helpers.

**Core Layer** (continued):

- `hub.ts` - Wikilink parser for `[[path]]` links, cross-link tags, hub discovery, orphan detection.

**Git Layer** (`src/git/`):

- `shadow.ts` - Shadow restore point system for undo without touching git history.

**Entry Point**: `src/index.ts` registers the public MCP tools and starts the stdio transport. The Go operator console talks to the same backend state through the persistent local `bridge-serve` JSON-line protocol instead of a separate indexing engine.

## Environment Variables

| Variable                                | Default            | Description                                                   |
| --------------------------------------- | ------------------ | ------------------------------------------------------------- |
| `OLLAMA_EMBED_MODEL`                    | `qwen3-embedding:0.6b-32k` | Embedding model name                                          |
| `OLLAMA_API_KEY`                        | (empty)            | Cloud auth (auto-detected by SDK)                             |
| `OLLAMA_CHAT_MODEL`                     | `nemotron-3-nano:4b-128k` | Chat model for cluster labeling                               |
| `CONTEXTPLUS_EMBED_BATCH_SIZE`          | `8`                | Embedding batch per GPU call (hard-capped to 5-10)            |
| `CONTEXTPLUS_EMBED_TRACKER`             | `true`             | Enable realtime embedding updates for changed files/functions |
| `CONTEXTPLUS_EMBED_TRACKER_MAX_FILES`   | `8`                | Max changed files per tracker tick (hard-capped to 5-10)      |
| `CONTEXTPLUS_EMBED_TRACKER_DEBOUNCE_MS` | `700`              | Debounce before applying tracker refresh                      |

Project state lives under `.contextplus/`. Run `index` to materialize the repo-local layout, config snapshot, indexing status, persisted stage state, restore-point manifest, context-tree export, vector collections, and persisted file/identifier/chunk/structure/cluster search state. The authoritative durable machine state lives only in `.contextplus/state/index.sqlite`. In a clean sqlite-only bootstrap, Context+ only needs populated on-disk directories such as `.contextplus/state/` and generated `.contextplus/hubs/suggested/`; obsolete legacy directories like `.contextplus/config/`, `.contextplus/embeddings/`, `.contextplus/checkpoints/`, and `.contextplus/derived/` are removed during bootstrap instead of being recreated empty. `index` defaults to `full` mode, which persists first-class AST chunk artifacts, hybrid chunk and identifier retrieval indexes, richer code-structure artifacts, semantic cluster artifacts, and hub-suggestion artifacts in SQLite in addition to the core file and identifier indexes. Dense retrieval now writes to sqlite `vector_collections`/`vector_entries` instead of artifact-shaped embedding-cache rows, and cache reuse includes the embed provider/model identity so changing the embedding backend invalidates stale vectors immediately. The structure layer now stores per-file imports, exports, calls, symbols, dependency paths, normalized symbol records, file-to-symbol mappings, ownership edges, module summaries, and module import edges so later ranking and canonical search can query a stable graph instead of rebuilding one ad hoc. The hybrid retrieval artifacts store lexical term maps plus embedding keys so lexical and dense evidence can be combined from durable state instead of rebuilt ad hoc, the unified ranking layer combines file, chunk, identifier, and structure evidence into one scoreable result set, the cluster artifacts persist labeled subsystem trees, related-file graphs, and subsystem summaries for the `cluster` tool, and the hub-suggestion artifact turns those persisted clusters, structure graphs, and feature tags into suggested markdown hubs and feature-group candidates under `.contextplus/hubs/suggested/`. Related `search` now exposes `retrieval_mode` values of `semantic`, `keyword`, or `both`; `find_hub` can rank hubs for a free-text query with the same semantic/keyword/both split; and `lint` now reports repo/file scoring alongside rule findings. Prepared queries read only from one active validated generation, while reindex and repair flows build a pending generation and only promote it after validation succeeds. Refresh uses content hashes for file and identifier artifacts, content-hash-plus-chunk-content-hash reuse for chunk artifacts, dependency hashes for structure artifacts so import-linked files are recomputed when local dependencies change, and a full rerun refreshes the persisted semantic clustering artifacts. `checkpoint` and `restore` mark the active serving generation dirty, run a synchronous refresh, and move it back to `fresh` only after the new generation validates; if refresh fails, serving freshness becomes `blocked` and prepared query surfaces fail loudly instead of answering from stale state. Legacy JSON and cache artifacts are deleted during bootstrap so the database remains the only source of truth. The persisted config, status, stage state, and full-artifact manifest carry explicit contract metadata for supported modes, stage order, sqlite-only storage, invalidation rules, and crash-only failure semantics. Later `search`, `cluster`, and `find_hub` calls query the prepared artifacts instead of rebuilding them on demand, while the realtime tracker keeps ignoring `.contextplus/`.
Run `validate_index` when you need an explicit consistency report for a prepared index. If a required artifact is missing, stale, or version-incompatible, run `repair_index` with `core`, `full`, or a stage target such as `full-artifacts` to rebuild exactly that slice and revalidate it.

## Fast Execute Mode (Mandatory)

Default to execution-first behavior. Use minimal tokens, minimal narration, and maximum tool leverage.

1. Skip long planning prose. Start with lightweight scoping: `tree` and `skeleton`.
2. Run independent discovery operations in parallel whenever possible (for example, multiple searches/reads).
3. Prefer structural tools over full-file reads to conserve context.
4. Before modifying or deleting symbols, run `blast_radius`.
5. Write changes through `checkpoint` only.
6. Run `lint` once after edits, or once per changed module for larger refactors.

### Execution Rules

1. Think less, execute sooner: make the smallest safe change that can be validated quickly.
2. Do not serialize 10 independent commands; batch parallelizable reads/searches.
3. If a command fails, avoid blind retry loops. Diagnose once, pivot strategy, continue.
4. Cap retry attempts for the same failing operation to 1-2 unless new evidence appears.
5. Keep outputs concise: short status updates, no verbose reasoning dumps.

### Token-Efficiency Rules

1. Treat 100 effective tokens as better than 1000 vague tokens.
2. Use high-signal tool calls first (`symbol`, `word`, `outline`, `deps`, `status`, `changes`, `skeleton`, `tree`, `blast_radius`).
3. Read full file bodies only when signatures/structure are insufficient.
4. Avoid repeated scans of unchanged areas.
5. Prefer direct edits + deterministic validation over extended speculative analysis.

## Strict Formatting Rules

### File Header (Mandatory)

Every supported source file MUST start with a leading comment header block. The header must include:

```
// summary: Regex-based symbol extraction for multi-language AST parsing
// FEATURE: Core parsing layer for structural code analysis
// inputs: Source file contents and language-specific parser availability
// outputs: Structured symbols, ranges, and explicit parser failures
```

- `summary:` describes what the file does in specific terms.
- `FEATURE: <name>` links the file to its primary feature area.
- `inputs:` describes the main inputs, dependencies, or prerequisites.
- `outputs:` describes the main outputs, side effects, or produced data.

### Comment Policy

Use comments when they clarify non-obvious behavior. Avoid stale or noisy comments that only restate the code.

### Code Ordering

Strict order within every file:

1. Imports
2. Enums
3. Interfaces / Types
4. Constants
5. Functions / Classes

### Abstraction Thresholds

- **Under 20 lines, used once**: INLINE it. Do not extract into a function.
- **Under 20 lines, used multiple times**: Extract into a reusable function.
- **Over 30 lines**: Extract into its own function or file.
- **Max nesting**: 3-4 levels. Flatten deep nesting.
- **Max file length**: 500-1000 lines. Split larger files.
- **Max files per directory**: 10. Use subdirectories for organization.

### Variable Discipline

- No redundant intermediate variables. Chain calls: `c = g(f(a))` instead of `b = f(a); c = g(b)`.
- Exception: Keep intermediate variables that represent distinct, meaningful states.
- Remove all unused variables, imports, and files before finishing.

## Tool Reference

| Tool                         | When to Use                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `index`                      | Build or refresh repo-local `.contextplus/` state. Full mode is the default and persists the authoritative sqlite index substrate at `.contextplus/state/index.sqlite`, including file, identifier, chunk, structure, restore-point, and context-tree state with no JSON mirrors. |
| `validate_index`             | Validate that the prepared sqlite-backed index is present, version-compatible, and internally consistent for `core` or `full` mode. |
| `repair_index`               | Repair a broken prepared index by rerunning the full pipeline or a specific durable stage, then validate the repaired state. |
| `tree`                       | Start of every task. Map files + symbols with line ranges.                         |
| `cluster`                    | Browse persisted semantic clusters, subsystem summaries, and related files from the full index. |
| `skeleton`                   | MUST run before full reads. Get signatures + line ranges first.                    |
| `symbol`                     | Use for exact symbol-name lookups when you already know the identifier you want. |
| `word`                       | Use for tiny indexed word or short-phrase lookup before escalating to broader search. |
| `outline`                    | Use for compact imports/exports/symbol outlines of a known file. |
| `deps`                       | Use for direct and reverse dependency tracing of a known indexed file. |
| `status`                     | Use for tiny git worktree summaries instead of broader repository inspection. |
| `changes`                    | Use for changed-file summaries and line-range hunks, optionally scoped to one file. |
| `search`                     | Route repository search by explicit intent. Use `intent` = `exact` for deterministic fast-substrate answers and `intent` = `related` for ranked discovery. `search_type` stays `file`, `symbol`, or `mixed`, and related search also accepts `retrieval_mode` = `semantic`, `keyword`, or `both`. |
| `research`                   | Use only for broad subsystem understanding after exact lookup and related-item search are no longer enough. |
| `evaluate`                   | Run the built-in real benchmark harness across small, medium, monorepo, polyglot, ignored-tree, broken-state, and rename-freshness scenarios. Reports golden-query accuracy, validation rates, freshness reliability, and p50/p95/p99 query latency. |
| `blast_radius`               | Before deleting or modifying any symbol.                                           |
| `lint`                       | After writing code. Catch dead code deterministically and review the repo/file score output. |
| `checkpoint`                 | The ONLY way to save files. Validates before writing.                              |
| `restore_points`             | See undo history.                                                                  |
| `restore`                    | Revert a bad AI change without touching git.                                       |
| `find_hub`                   | Browse handwritten hubs plus suggested hubs and feature groups from the full index. It can also rank hubs for a free-text query and find orphaned files. |
## Anti-Patterns to Avoid

1. Reading entire files without checking the skeleton first.
2. Deleting functions without checking blast radius.
3. Creating small helper functions that are only used once.
4. Writing noisy comments that do not improve comprehension.
5. Wrapping simple logic in 10 layers of abstraction or nesting.
6. Leaving unused imports or variables after a refactor.
7. Creating more than 10 files in a single directory.
8. Writing files longer than 1000 lines.
9. Running independent commands sequentially when they can be parallelized.
10. Repeating failed terminal commands without changing inputs or approach.

## Priority Reminder

Execute ASAP with the least tokens possible.
Use structural/context tools strategically, then patch and validate.
Avoid over-planning unless the task is ambiguous or high-risk.
