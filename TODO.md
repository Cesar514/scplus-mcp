# TODO List

## instructions

ai agents may update this file to remove completed work, keep the backlog accurate, and add newly discovered remaining tasks for the current goal

## current goal

- [ ] finish roadmap step 06 and verify it directly
- [ ] commit the verified step 06 work

## full engine roadmap (ordered)

- [ ] 06. persist richer code-structure artifacts per file and module, including imports, exports, call graphs, ownership edges, and file-to-symbol mappings
- [ ] 07. build a unified ranking engine that can combine chunk, file, identifier, lexical, semantic, structural, and memory evidence in one search surface
- [ ] 08. make `search` the canonical query entrypoint over those precomputed artifacts and remove overlapping or weaker search surfaces after callers are migrated
- [ ] 09. persist semantic clusters, cluster labels, related-file graphs, and subsystem summaries as `full` artifacts instead of generating them only on demand
- [ ] 10. generate hub suggestions and feature-group candidates automatically from clusters, structure graphs, and feature tags so humans and agents get higher-level maps for free
- [ ] 11. replace the current memory store with the planned graph-plus-markdown-plus-vector memory system and make memory writes update embeddings and relations automatically
- [ ] 12. integrate ACP and external session memories into the same graph so research and retrieval can blend local code, durable memory, and imported agent history
- [ ] 13. add a unified `research` surface that aggregates code retrieval, structure artifacts, memory, ACP context, and related-context discovery in one tool
- [ ] 14. harden indexing and query reliability with crash-only behavior, explicit repair commands, artifact-version checks, snapshot/index consistency validation, and no silent fallbacks
- [ ] 15. add evaluation and benchmarking for retrieval quality, navigation quality, reindex speed, artifact freshness, and agent-answer quality so changes are measured instead of vibe-judged
- [ ] 16. simplify the public tool surface only after the full engine exists, deleting superseded tools and parameters instead of keeping overlapping abstractions alive
- [ ] 17. expose the full engine cleanly through the planned CLI and UX layers only after the underlying indexing, retrieval, structure, memory, and research primitives are stable

## v1

- [ ] move persisted embedding/search storage to a vector database once the eager indexing pipeline is solid
- [ ] rename tools for better meaning
  - [ ] rename get_feature_hub to find_hub and change its functionality to return rankings or relevant hubs based on a search query with options for semantic or keyword search or both
    - [ ] add parameter to search for data in hubs by semantic meaning or keyword match or both
    - [ ] add parameter optionality so if no parameters are provided, it returns context of all hubs in the project
  - [ ] create delete_memory tool that deletes nodes or relationships in the memory graph
  - [ ] prune_stale_links tool should be removed as i want it to be done automatically by the system when any memory tools are called and before graph is accessed
- [ ] extend the unified `search` tool with explicit filtering modes for semantic, keyword, or both
- [ ] extend `lint` with stronger repo-rule checking and project/file scoring where it is still genuinely useful
- [ ] extend `checkpoint` with clearer long-worksession checkpoint behavior if shadow checkpoints need more functionality
- [ ] extend `restore` so it can restore to a specific checkpoint point with the exact UX you want
- [ ] create a new memory system that uses a graph database and md files and vector database for storing memories
  - [ ] add tool for updating memories with new information that updates the embeddings depending on the changes made to the content and the agent should use this instead of directly updating the content in the file
  - [ ] update other tools to use the new memory system too, alongside with tools that save nodes and edges automatically and creates embeddings automatically when a new node or edge is created or deleted

---

## v2

code update:

- [ ] list overengineered tools and parameters that could be removed for better context
- [ ] remove overengineered tools and parameters
- [ ] remove vibeslop code (if any)
- [ ] remove ollama bugs and spam for embeddings with a smarter embedding generation system that continuously watches for file changes and updates embeddings in the background, only init one time in the project and then its automatically watched

new features:

- [ ] ctx+ cli in cli/ folder
  - [ ] visualize memory graphs, unto commits, hubs in the cli
  - [ ] use charm's tui library - bubble or tea
  - [ ] features like `contextplus index`
  - [ ] visualize context tree, undo commits, hubs list, and more in the cli
  - [ ] create hubs option from the cli for humans
- [ ] acp features (maybe that we can list all sessions and memories from all agents, like opencode, copilot, claude, codex into one generalized list)
  - [ ] improved memory search from acp
  - [ ] load session memoies from acp into the memory graph
  - [ ] cli: see all sessions of all agents in list and add semantic search in cli
  - [ ] cli: see all memories of all agents in list and add semantic search in cli
  - [ ] use .contextplus/external_memories for storing acp imported memories and sessions
- [ ] faster and cleaner agent protocol access
- [ ] faster tool execution and cleaner outputs and better error handling and reporting with suggestions like "this tool failed, you can do this instead, it will work the same"
- [ ] better treesitter support and tools for using it to understand code structure and semantics better
- [ ] add these features to be visualized in the cli
- [ ] add researchplus tools and features
