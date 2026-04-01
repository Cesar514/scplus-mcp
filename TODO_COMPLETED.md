# TODO Completed

## v1

- [x] rename tools for better meaning
  - [x] rename semantic_navigate to cluster
  - [x] rename get_context_tree to tree
  - [x] rename semantic_identifier_search and semantic_code_search (merged) to search
  - [x] rename get_file_skeleton to skeleton
  - [x] rename get_blast_radius to blast_radius
  - [x] rename run_static_analysis to lint
  - [x] rename propose_commit to checkpoint
  - [x] rename list_restore_points to restore_points
  - [x] rename undo_change to restore
  - [x] rename upsert_memory_node to create_memory
  - [x] rename search_memory_graph to search_memory
  - [x] rename retrieve_with_traversal to explore_memory
  - [x] add_interlinked_context to bulk_memory
- [x] create a new tool called index that initializes the project by creating a context tree and .contextplus folder
  - [x] use .contextplus/hubs for feature hubs
  - [x] use .contextplus/embeddings for storing file and symbol embeddings
  - [x] use .contextplus/config for configuration files
  - [x] use .contextplus/memories for memory graph data

## maintenance

- [x] finish roadmap step 04 by persisting hybrid chunk and identifier retrieval indexes with lexical term maps plus dense embedding references in sqlite
- [x] verify roadmap step 04 directly with build, the full test suite, a real full index run, and direct sqlite inspection of hybrid retrieval artifacts
- [x] finish roadmap step 03 by promoting chunk-level AST indexing into a first-class sqlite-backed artifact contract
- [x] verify roadmap step 03 directly with build, the full test suite, a real full index run, and direct sqlite inspection of persisted chunk artifacts
- [x] run a fresh Context+ full index for this repository through the MCP tool
- [x] verify the refreshed `.contextplus/state/index.sqlite` and durable artifacts directly on disk
- [x] complete the sqlite-only follow-up migration so `.contextplus/state/index.sqlite` becomes the single authoritative machine-state store
- [x] migrate the remaining file-backed machine state into sqlite, including the memory graph, restore-point manifest, restore-point backups, context-tree export, and embedding caches
- [x] delete legacy json and cache artifacts during bootstrap and verify they stay absent after a real full index run and an MCP `index` run
- [x] finish roadmap step 02.5 by moving the durable full-engine index substrate onto sqlite-backed local storage under `.contextplus/state/index.sqlite`
- [x] verify roadmap step 02.5 directly with build, tests, a real full index run, and direct sqlite artifact inspection
- [x] finish roadmap step 02 by splitting the indexing pipeline into durable rerunnable stages with persisted dependencies and strict core prerequisites for `full`
- [x] verify roadmap step 02 directly with build, tests, a real full index run, and on-disk inspection of `.contextplus/config/index-stages.json`
- [x] create an ExecPlan for the 17-step full-engine roadmap and keep it updated as implementation proceeds
- [x] finish roadmap step 01 by locking the `index(core)` and `index(full)` contract, persisted artifact schemas, invalidation rules, and failure semantics
- [x] verify roadmap step 01 directly with build, tests, and a real full index run
- [x] remove references to the previous repo-local storage location from the `contextplus-mcp` skill and repo instruction mirrors so docs only describe `.contextplus`
- [x] rerun Context+ full indexing for this repository and verify the refreshed `.contextplus` artifacts on disk
- [x] update the `contextplus-mcp` skill to document the current full-mode indexing features and require `full` unless the user or repo-local manual explicitly asks for `core`
- [x] implement the full-engine indexing contract and make `full` the primary indexing mode
- [x] persist full-engine indexing artifacts beyond the current file and identifier indexes
- [x] verify the new indexing mode by running the index workflow and checking the generated `.contextplus` artifacts
- [x] read the relevant `claude-context` and `contextplus` `v2` repo surfaces to identify what a best-in-class full engine is still missing
- [x] add a strict dependency-ordered roadmap for the best full engine to `TODO.md`
- [x] rerun the Context+ `index` workflow for this repository
- [x] verify `.contextplus/config/index-status.json`, `.contextplus/embeddings/file-search-index.json`, and `.contextplus/embeddings/identifier-search-index.json` were refreshed and present after indexing
- [x] make `index` perform a real full search index build instead of only bootstrap state
  - [x] make `index` eagerly build and persist both file and identifier indexes under `.contextplus/`
  - [x] store index metadata and current phase in `.contextplus/config` so indexing state is inspectable
  - [x] add a lightweight indexing status surface or status file for long-running or background indexing
  - [x] add progress logging during indexing with counts, phase updates, and elapsed progress
  - [x] make later `search` runs perform cheap incremental refreshes for changed files instead of rebuilding everything
- [x] remove the old repo-local index state from the previous storage location
- [x] create a fresh `.contextplus` index for this repository using the Context+ `index` workflow
- [x] verify the generated `.contextplus` layout and manifests match the documented project state
- [x] update the `contextplus-mcp` skill so it explicitly covers repo-local instruction precedence for reindex tasks
- [x] remove the remaining old-storage handling from runtime ignore logic
- [x] update the memory-graph tests to create `.contextplus/memories` fixtures in the current storage layout
- [x] verify runtime code and focused tests no longer depend on the previous storage layout
- [x] remove the blanket no-comments policy from repo instructions and mirrored landing instructions
- [x] allow ordinary post-header comments in `checkpoint` while keeping header, feature, and size checks
- [x] rebuild `lint` so it runs valid native commands and reports practical repo-rule findings
- [x] verify the updated lint and checkpoint behavior with targeted suites and the full main test run
