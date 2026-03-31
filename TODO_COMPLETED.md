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

- [x] make `index` perform a real full search index build instead of only bootstrap state
  - [x] make `index` eagerly build and persist both file and identifier indexes under `.contextplus/`
  - [x] store index metadata and current phase in `.contextplus/config` so indexing state is inspectable
  - [x] add a lightweight indexing status surface or status file for long-running or background indexing
  - [x] add progress logging during indexing with counts, phase updates, and elapsed progress
  - [x] make later `search` runs perform cheap incremental refreshes for changed files instead of rebuilding everything
- [x] remove the legacy repo-local index state that still lives under `.mcp_data`
- [x] create a fresh `.contextplus` index for this repository using the Context+ `index` workflow
- [x] verify the generated `.contextplus` layout and manifests match the documented project state
- [x] update the `contextplus-mcp` skill so it explicitly covers legacy index cleanup and repo-local instruction precedence for reindex tasks
- [x] remove the remaining legacy `.mcp_data` handling from runtime ignore logic
- [x] update the memory-graph tests to create `.contextplus/memories` fixtures instead of `.mcp_data`
- [x] verify runtime code and focused tests no longer depend on `.mcp_data`
- [x] remove the blanket no-comments policy from repo instructions and mirrored landing instructions
- [x] allow ordinary post-header comments in `checkpoint` while keeping header, feature, and size checks
- [x] rebuild `lint` so it runs valid native commands and reports practical repo-rule findings
- [x] verify the updated lint and checkpoint behavior with targeted suites and the full main test run
