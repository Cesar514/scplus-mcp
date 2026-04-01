# TODO List

## instructions

ai agents may update this file to remove completed work, keep the backlog accurate, and add newly discovered remaining tasks for the current goal

## current goal

- [ ] finish roadmap step 20 and verify it directly
- [ ] commit the verified step 20 work

## full engine roadmap (ordered)

- [x] 13. add a unified `research` surface that aggregates code retrieval, structure artifacts, clusters, hubs, and related-context discovery in one tool
- [x] 14. harden indexing and query reliability with crash-only behavior, explicit repair commands, artifact-version checks, snapshot/index consistency validation, and no silent fallbacks
- [x] 15. add evaluation and benchmarking for retrieval quality, navigation quality, reindex speed, artifact freshness, and agent-answer quality so changes are measured instead of vibe-judged
- [x] 16. simplify the public tool surface only after the full engine exists, deleting superseded tools and parameters instead of keeping overlapping abstractions alive
- [x] 17. add a fast exact-query substrate on top of the prepared index with hot in-memory caches for symbol lookup, word lookup, file outlines, reverse dependencies, and change/status tracking so agents can answer common navigation questions without paying full ranked-search cost
- [x] 18. expose that substrate through tiny low-token MCP primitives such as `outline`, `word`, `deps`, `status`, and `changes`, with deterministic structured outputs designed for the agent execution loop rather than broad discovery
- [x] 19. refactor `search` and `research` around explicit query intent so exact questions use the fast substrate, related-item and pattern discovery uses ranked `search`, and broad subsystem understanding uses `research`
- [ ] 20. extend evaluation and benchmarking to measure hot-query latency, estimated token cost, and end-to-end task efficiency for the new fast-path plus intelligence hybrid, proving that token reduction does not regress codebase understanding quality
- [ ] 21. expose the full engine cleanly through the planned CLI and UX layers only after the underlying fast-path, indexing, retrieval, structure, and research primitives are stable

## v1

- [ ] move persisted embedding/search storage to a vector database once the eager indexing pipeline is solid
- [ ] rename tools for better meaning
  - [ ] rename get_feature_hub to find_hub and change its functionality to return rankings or relevant hubs based on a search query with options for semantic or keyword search or both
    - [ ] add parameter to search for data in hubs by semantic meaning or keyword match or both
    - [ ] add parameter optionality so if no parameters are provided, it returns context of all hubs in the project
- [ ] extend the unified `search` tool with explicit filtering modes for semantic, keyword, or both
- [ ] extend `lint` with stronger repo-rule checking and project/file scoring where it is still genuinely useful
- [ ] extend `checkpoint` with clearer long-worksession checkpoint behavior if shadow checkpoints need more functionality
- [ ] extend `restore` so it can restore to a specific checkpoint point with the exact UX you want

---

## v2

code update:

- [ ] list overengineered tools and parameters that could be removed for better context
- [ ] remove overengineered tools and parameters
- [ ] remove vibeslop code (if any)
- [ ] remove ollama bugs and spam for embeddings with a smarter embedding generation system that continuously watches for file changes and updates embeddings in the background, only init one time in the project and then its automatically watched

new features:

- [ ] ctx+ cli in cli/ folder
  - [ ] visualize undo commits, hubs in the cli
  - [ ] use charm's tui library - bubble or tea
  - [ ] features like `contextplus index`
  - [ ] visualize context tree, undo commits, hubs list, and more in the cli
  - [ ] create hubs option from the cli for humans
- [ ] faster and cleaner agent protocol access
- [ ] faster tool execution and cleaner outputs and better error handling and reporting with suggestions like "this tool failed, you can do this instead, it will work the same"
- [ ] better treesitter support and tools for using it to understand code structure and semantics better
- [ ] add these features to be visualized in the cli
- [ ] add researchplus tools and features
