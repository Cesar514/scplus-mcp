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
