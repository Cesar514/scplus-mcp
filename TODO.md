# TODO List

## instructions

ai agents may update this file to remove completed work, keep the backlog accurate, and add newly discovered remaining tasks for the current goal

## current goal

- [ ] finish roadmap step 21 and verify it directly
- [ ] commit the verified step 21 work

## full engine roadmap (ordered)

- [ ] 21. expose the full engine cleanly through the planned CLI and UX layers only after the underlying fast-path, indexing, retrieval, structure, and research primitives are stable

## v1

- [ ] move persisted embedding/search storage to a vector database once the eager indexing pipeline is solid
- [ ] rename tools for better meaning
  - [ ] extend `find_hub` so it returns rankings or relevant hubs based on a search query with options for semantic or keyword search or both
    - [ ] add parameter to search for data in hubs by semantic meaning or keyword match or both
    - [ ] add search result ranking for matching hubs instead of only direct name/path resolution
- [ ] extend the unified `search` tool with explicit filtering modes for semantic, keyword, or both
- [ ] extend `lint` with stronger repo-rule checking and project/file scoring where it is still genuinely useful
- [ ] extend `checkpoint` with clearer long-worksession checkpoint behavior if shadow checkpoints need more functionality

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
